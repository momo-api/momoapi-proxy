import { createHash } from "node:crypto";

const MIB = 1024 * 1024;
const DATA_IMAGE_RE = /^data:(image\/[A-Za-z0-9.+-]+);base64,([A-Za-z0-9+/=\r\n]+)$/i;

export class ContextBudgetError extends Error {
  constructor(message, code, details = {}, trace = null) {
    super(message);
    this.name = "ContextBudgetError";
    this.statusCode = 413;
    this.code = code;
    this.details = details;
    this.contextTrace = trace;
  }
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function configuredBytes(settings, byteKey, mbKey, envKey, fallbackMb, { minMb = 0.0625, maxMb = 64 } = {}) {
  const policy = settings?.contextPolicy && typeof settings.contextPolicy === "object" ? settings.contextPolicy : {};
  const explicitBytes = finiteNumber(settings?.[byteKey] ?? policy[byteKey]);
  if (explicitBytes != null && explicitBytes >= 1024 && explicitBytes <= maxMb * MIB) return Math.floor(explicitBytes);

  const rawMb = process.env[envKey] ?? settings?.[mbKey] ?? policy[mbKey] ?? fallbackMb;
  const parsedMb = finiteNumber(rawMb);
  const validMb = parsedMb != null && parsedMb >= minMb && parsedMb <= maxMb ? parsedMb : fallbackMb;
  return Math.floor(validMb * MIB);
}

function configuredInteger(settings, key, envKey, fallback, min, max) {
  const policy = settings?.contextPolicy && typeof settings.contextPolicy === "object" ? settings.contextPolicy : {};
  const raw = process.env[envKey] ?? settings?.[key] ?? policy[key] ?? fallback;
  const parsed = Number.parseInt(String(raw), 10);
  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

export function getContextPolicy(settings = {}) {
  const hardLimitBytes = configuredBytes(
    settings,
    "outboundBodyHardLimitBytes",
    "outboundBodyHardLimitMb",
    "MOMO_OUTBOUND_BODY_HARD_LIMIT_MB",
    18,
    { maxMb: 18 },
  );
  const requestedSoft = configuredBytes(
    settings,
    "outboundBodySoftLimitBytes",
    "outboundBodySoftLimitMb",
    "MOMO_OUTBOUND_BODY_SOFT_LIMIT_MB",
    16,
    { maxMb: 18 },
  );
  const softLimitBytes = Math.min(requestedSoft, Math.max(1024, hardLimitBytes - 1024));

  return {
    softLimitBytes,
    hardLimitBytes,
    maxHistoricalImages: configuredInteger(settings, "maxHistoricalImages", "MOMO_MAX_HISTORICAL_IMAGES", 8, 0, 64),
    maxHistoricalImageBytes: configuredBytes(
      settings,
      "maxHistoricalImageBytes",
      "maxHistoricalImageBytesMb",
      "MOMO_MAX_HISTORICAL_IMAGE_BYTES_MB",
      4,
      { maxMb: 16 },
    ),
    maxCurrentTurnImageBytes: configuredBytes(
      settings,
      "maxCurrentTurnImageBytes",
      "maxCurrentTurnImageBytesMb",
      "MOMO_MAX_CURRENT_TURN_IMAGE_BYTES_MB",
      8,
      { maxMb: 18 },
    ),
    maxSingleImageBytes: configuredBytes(
      settings,
      "maxSingleImageBytes",
      "maxSingleImageBytesMb",
      "MOMO_MAX_SINGLE_CONTEXT_IMAGE_BYTES_MB",
      2,
      { maxMb: 18 },
    ),
  };
}

export function serializedBodyBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function dataImageDescriptor(value) {
  if (typeof value !== "string") return null;
  const match = DATA_IMAGE_RE.exec(value);
  if (!match) return null;
  const data = match[2].replace(/[\r\n]/g, "");
  return {
    mimeType: match[1].toLowerCase(),
    hash: createHash("sha256").update(data).digest("hex"),
    bodyBytes: Buffer.byteLength(value, "utf8"),
  };
}

function imageObjectDescriptor(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;

  const rawUrl = typeof value.image_url === "string"
    ? value.image_url
    : (typeof value.image_url?.url === "string" ? value.image_url.url : null);
  const fromUrl = dataImageDescriptor(rawUrl);
  if (fromUrl) return fromUrl;

  const inline = value.inline_data || value.inlineData;
  if (typeof inline?.data === "string" && String(inline.mime_type || inline.mimeType || "").toLowerCase().startsWith("image/")) {
    const data = inline.data.replace(/[\r\n]/g, "");
    return {
      mimeType: String(inline.mime_type || inline.mimeType).toLowerCase(),
      hash: createHash("sha256").update(data).digest("hex"),
      bodyBytes: Buffer.byteLength(inline.data, "utf8"),
    };
  }

  const source = value.source;
  if (source?.type === "base64" && typeof source.data === "string" && String(source.media_type || "").toLowerCase().startsWith("image/")) {
    const data = source.data.replace(/[\r\n]/g, "");
    return { mimeType: String(source.media_type).toLowerCase(), hash: createHash("sha256").update(data).digest("hex"), bodyBytes: Buffer.byteLength(source.data, "utf8") };
  }

  if (value.type === "image" && typeof value.data === "string") {
    const mimeType = String(value.mimeType || value.mime_type || "image/png").toLowerCase();
    const data = value.data.replace(/[\r\n]/g, "");
    return { mimeType, hash: createHash("sha256").update(data).digest("hex"), bodyBytes: Buffer.byteLength(value.data, "utf8") };
  }
  return null;
}

function isToolItem(item) {
  return item?.role === "tool" || item?.type === "function_call_output" || item?.type === "custom_tool_call_output";
}

function isUserItem(item, kind) {
  if (!item || typeof item !== "object") return false;
  if (item.role === "user") return true;
  return kind === "responses" && item.type === "input_text";
}

function replacementObject(kind, marker, isTopLevel) {
  if (kind === "chat") return { type: "text", text: marker };
  if (isTopLevel) {
    return { type: "message", role: "user", content: [{ type: "input_text", text: marker }] };
  }
  return { type: "input_text", text: marker };
}

function collectInlineImages(payload, kind) {
  const items = kind === "chat" ? payload.messages : payload.input;
  if (!Array.isArray(items)) return { records: [], currentTurnStart: 0 };

  let currentTurnStart = 0;
  for (let index = items.length - 1; index >= 0; index--) {
    if (isUserItem(items[index], kind)) {
      currentTurnStart = index;
      break;
    }
  }

  const records = [];
  const visit = (value, assign, topIndex, isTopLevel = false) => {
    const descriptor = imageObjectDescriptor(value);
    if (descriptor) {
      records.push({
        ...descriptor,
        topIndex,
        isCurrent: topIndex >= currentTurnStart,
        isTool: isToolItem(items[topIndex]),
        active: true,
        replace(marker) {
          if (!this.active) return;
          assign(replacementObject(kind, marker, isTopLevel));
          this.active = false;
        },
      });
      return;
    }

    if (typeof value === "string") {
      const stringDescriptor = dataImageDescriptor(value);
      if (!stringDescriptor) return;
      records.push({
        ...stringDescriptor,
        topIndex,
        isCurrent: topIndex >= currentTurnStart,
        isTool: isToolItem(items[topIndex]),
        active: true,
        replace(marker) {
          if (!this.active) return;
          assign(marker);
          this.active = false;
        },
      });
      return;
    }

    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index++) {
        visit(value[index], (replacement) => { value[index] = replacement; }, topIndex, false);
      }
      return;
    }

    if (value && typeof value === "object") {
      for (const key of Object.keys(value)) {
        visit(value[key], (replacement) => { value[key] = replacement; }, topIndex, false);
      }
    }
  };

  for (let index = 0; index < items.length; index++) {
    visit(items[index], (replacement) => { items[index] = replacement; }, index, true);
  }
  return { records, currentTurnStart };
}

function removeRecord(record, marker, trace, reason) {
  if (!record.active) return;
  record.replace(marker);
  trace.imageBytesRemoved += record.bodyBytes;
  trace.historicalImagesRemoved += 1;
  if (reason === "deduplicated") trace.imageDedupHits += 1;
  if (!trace.policyActions.includes(reason)) trace.policyActions.push(reason);
}

function mediaBudgetError(trace, policy, message) {
  return new ContextBudgetError(message, "media_budget_exceeded", {
    imageCount: trace.imageCount,
    currentTurnImageBytes: trace.currentTurnImageBytes,
    maxCurrentTurnImageBytes: policy.maxCurrentTurnImageBytes,
    maxSingleImageBytes: policy.maxSingleImageBytes,
    hardLimitBytes: policy.hardLimitBytes,
  }, trace);
}

export function prepareMediaPayload(payload, settings = {}, { kind = "responses", requestBytes = 0 } = {}) {
  const policy = getContextPolicy(settings);
  // The payload is request-scoped (or freshly normalized), so mutate it in place
  // instead of cloning tens of MiB of Base64 history before immediately pruning it.
  const body = payload;
  const { records } = collectInlineImages(body, kind);
  const originalBytes = records.length > 0 ? serializedBodyBytes(body) : 0;
  const current = records.filter((record) => record.isCurrent);
  const historical = records.filter((record) => !record.isCurrent);
  const trace = {
    requestBytes,
    originalOutboundBytes: originalBytes,
    outboundBytes: 0,
    maxOutboundBytes: 0,
    imageCount: records.length,
    imageBytes: records.reduce((sum, record) => sum + record.bodyBytes, 0),
    currentTurnImageBytes: current.reduce((sum, record) => sum + record.bodyBytes, 0),
    imageBytesRemoved: 0,
    imageBytesForwarded: 0,
    imageDedupHits: 0,
    historicalImagesRemoved: 0,
    softLimitHit: originalBytes > policy.softLimitBytes,
    hardLimitRejected: false,
    fallbackProtocol: null,
    policyActions: [],
  };

  const oversizedCurrent = current.find((record) => record.bodyBytes > policy.maxSingleImageBytes);
  if (oversizedCurrent) {
    throw mediaBudgetError(trace, policy, `Current-turn image exceeds the ${Math.floor(policy.maxSingleImageBytes / MIB)} MiB context-image limit.`);
  }
  if (trace.currentTurnImageBytes > policy.maxCurrentTurnImageBytes) {
    throw mediaBudgetError(trace, policy, `Current-turn images exceed the ${Math.floor(policy.maxCurrentTurnImageBytes / MIB)} MiB context-image budget.`);
  }

  // Current-turn images are protected. Historical duplicates of current images,
  // and older duplicates within history, are safe to omit.
  const seen = new Set(current.map((record) => record.hash));
  for (const record of [...historical].sort((a, b) => b.topIndex - a.topIndex)) {
    if (seen.has(record.hash)) {
      removeRecord(record, "[historical image omitted: duplicate]", trace, "deduplicated");
    } else {
      seen.add(record.hash);
    }
  }

  let keptHistorical = 0;
  let keptHistoricalBytes = 0;
  for (const record of [...historical].filter((item) => item.active).sort((a, b) => b.topIndex - a.topIndex)) {
    const exceedsCount = keptHistorical + 1 > policy.maxHistoricalImages;
    const exceedsBytes = keptHistoricalBytes + record.bodyBytes > policy.maxHistoricalImageBytes;
    if (exceedsCount || exceedsBytes) {
      const marker = record.isTool ? "[historical tool image omitted: budget]" : "[historical image omitted: budget]";
      removeRecord(record, marker, trace, "historical_media_budget");
      continue;
    }
    keptHistorical += 1;
    keptHistoricalBytes += record.bodyBytes;
  }

  // Text-only requests are admitted by serializeOutboundBody. Avoid serializing
  // a huge text history twice when there is no media lifecycle work to perform.
  let currentBytes = records.length > 0 ? serializedBodyBytes(body) : 0;
  if (currentBytes > policy.softLimitBytes) {
    trace.softLimitHit = true;
    const removable = historical
      .filter((record) => record.active)
      .sort((a, b) => Number(b.isTool) - Number(a.isTool) || a.topIndex - b.topIndex);
    let estimatedBytes = currentBytes;
    for (const record of removable) {
      const marker = record.isTool ? "[historical tool image omitted: outbound body budget]" : "[historical image omitted: outbound body budget]";
      removeRecord(record, marker, trace, "soft_limit_rewrite");
      // Use the known inline payload length to select a batch, then perform one
      // exact serialization. This avoids O(image_count * body_size) copying.
      estimatedBytes -= Math.max(0, record.bodyBytes - 256);
      if (estimatedBytes <= policy.softLimitBytes) break;
    }
    currentBytes = serializedBodyBytes(body);
  }

  trace.imageBytesForwarded = records.filter((record) => record.active).reduce((sum, record) => sum + record.bodyBytes, 0);
  trace.outboundBytes = currentBytes;
  trace.maxOutboundBytes = currentBytes;

  if (currentBytes > policy.hardLimitBytes) {
    trace.hardLimitRejected = true;
    const code = trace.imageBytesForwarded > 0 ? "media_budget_exceeded" : "context_budget_exceeded";
    throw new ContextBudgetError(
      `Request remains ${currentBytes} bytes after safe history cleanup, above the ${policy.hardLimitBytes}-byte outbound limit. Start a new thread or reduce large attachments.`,
      code,
      { estimatedBytes: currentBytes, hardLimitBytes: policy.hardLimitBytes, imageBytes: trace.imageBytesForwarded },
      trace,
    );
  }

  return { payload: body, trace, policy };
}

export function serializeOutboundBody(body, settings = {}, trace = null) {
  const policy = getContextPolicy(settings);
  const serialized = JSON.stringify(body);
  const bytes = Buffer.byteLength(serialized, "utf8");
  if (trace) {
    trace.outboundBytes = bytes;
    trace.maxOutboundBytes = Math.max(trace.maxOutboundBytes || 0, bytes);
    if (bytes > policy.softLimitBytes) trace.softLimitHit = true;
  }
  if (bytes > policy.hardLimitBytes) {
    if (trace) trace.hardLimitRejected = true;
    throw new ContextBudgetError(
      `Final upstream request is ${bytes} bytes, above the ${policy.hardLimitBytes}-byte outbound limit. Start a new thread or reduce large attachments.`,
      trace?.imageBytesForwarded > 0 ? "media_budget_exceeded" : "context_budget_exceeded",
      { estimatedBytes: bytes, hardLimitBytes: policy.hardLimitBytes, imageBytes: trace?.imageBytesForwarded || 0 },
      trace,
    );
  }
  return serialized;
}

export function shouldFallbackResponses(status, message = "") {
  if (status === 404) return true;
  if (status !== 400) return false;
  return /(?:not\s+found|unsupported|not\s+supported|unknown\s+(?:endpoint|route)|responses?\s+(?:api|endpoint).*(?:unavailable|unsupported))/i.test(String(message));
}
