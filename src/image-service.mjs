import { lookup } from "node:dns/promises";

const MAX_REFERENCE_BYTES = 20 * 1024 * 1024;
const IMAGE_MODELS = new Set(["gpt-image-2", "gpt-image-2-momoapi", "gemini-3.1-flash-image"]);
const ASPECT_RATIOS = ["1:1", "3:2", "2:3", "16:9", "9:16"];

const MODEL_RULES = {
  "gpt-image-2": {
    maxN: 1, maxReferenceImages: 1, operations: ["generate", "edit"],
    aspectRatios: ASPECT_RATIOS, resolutions: ["1k", "2k", "4k"],
    generateTransport: "images-generations", editTransport: "images-generations-reference",
  },
  "gpt-image-2-momoapi": {
    maxN: 4, maxReferenceImages: 4, operations: ["generate", "edit"],
    aspectRatios: ASPECT_RATIOS, resolutions: ["1k", "2k", "4k"],
    generateTransport: "images-generations", editTransport: "chat-completions-multimodal-stream",
  },
  "gemini-3.1-flash-image": {
    maxN: 1, maxReferenceImages: 1, operations: ["generate", "edit"],
    aspectRatios: ASPECT_RATIOS, resolutions: ["1k", "2k", "4k"],
    generateTransport: "images-generations", editTransport: "chat-completions-multimodal",
  },
};

function capability(model, displayName) {
  const rules = MODEL_RULES[model];
  return {
    id: model,
    display_name: displayName,
    operations: rules.operations,
    parameters: ["prompt", "n", "aspect_ratio", "resolution", "reference_images"],
    transports: { generate: rules.generateTransport, edit: rules.editTransport },
    limits: {
      max_n: rules.maxN,
      max_reference_images: rules.maxReferenceImages,
      aspect_ratios: rules.aspectRatios,
      resolutions: rules.resolutions,
      max_reference_bytes_each: MAX_REFERENCE_BYTES,
    },
    mask_edits: false,
  };
}

export const IMAGE_CAPABILITIES = {
  version: 2,
  models: [
    capability("gpt-image-2", "GPT Image 2"),
    capability("gpt-image-2-momoapi", "GPT Image 2 MOMO"),
    capability("gemini-3.1-flash-image", "Gemini 3.1 Flash Image"),
  ],
  defaults: { model: "gpt-image-2-momoapi", n: 1, aspect_ratio: "1:1", resolution: "1k" },
  notes: {
    gpt_aspect_ratio_aliases: {
      "16:9": "1536x1024 (3:2 output canvas)",
      "9:16": "1024x1536 (2:3 output canvas)",
    },
    gpt_resolution: "1k/2k/4k map to low/medium/high quality hints; they are not guaranteed output pixel dimensions.",
    gemini_resolution: "1k/2k/4k are sent as 1K/2K/4K image_size controls.",
    mask_edits: "Not exposed until the public route is verified end to end.",
  },
};

function fail(message, statusCode = 400, code = "invalid_request_error") {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function imageSignal(parentSignal, timeoutMs = 300000) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return parentSignal ? AbortSignal.any([parentSignal, timeoutSignal]) : timeoutSignal;
}

function asDataUrl(value) {
  return typeof value === "string" && /^data:image\/[A-Za-z0-9.+-]+;base64,/i.test(value) ? value : null;
}

function gptSizeFrom(aspectRatio) {
  return ({
    "1:1": "1024x1024",
    "3:2": "1536x1024",
    "16:9": "1536x1024",
    "2:3": "1024x1536",
    "9:16": "1024x1536",
  })[aspectRatio] || "1024x1024";
}

function gptQualityFrom(resolution) {
  if (resolution === "1k") return "low";
  if (resolution === "4k") return "high";
  return "medium";
}

export function normalizeImageRequest(input, operation = "generate") {
  if (!input || typeof input !== "object") throw fail("Image request must be a JSON object.");
  const model = typeof input.model === "string" && input.model.trim() ? input.model.trim() : IMAGE_CAPABILITIES.defaults.model;
  if (!IMAGE_MODELS.has(model)) throw fail("Unsupported image model: " + model);
  const rules = MODEL_RULES[model];
  if (!rules.operations.includes(operation)) throw fail("Model " + model + " does not support " + operation + ".");

  const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
  if (!prompt) throw fail("prompt is required.");
  if (prompt.length > 32000) throw fail("prompt is too long.");

  const n = input.n === undefined ? 1 : Number(input.n);
  if (!Number.isInteger(n) || n < 1 || n > rules.maxN) throw fail("n must be an integer between 1 and " + rules.maxN + " for " + model + ".");

  const aspectRatio = input.aspect_ratio || input.aspectRatio || IMAGE_CAPABILITIES.defaults.aspect_ratio;
  if (!rules.aspectRatios.includes(aspectRatio)) throw fail("Unsupported aspect_ratio for " + model + ": " + aspectRatio);

  const requestedResolution = input.resolution || input.imageSize || IMAGE_CAPABILITIES.defaults.resolution;
  const aliases = { low: "1k", medium: "2k", high: "4k", "1K": "1k", "2K": "2k", "4K": "4k" };
  const resolution = aliases[requestedResolution] || String(requestedResolution).toLowerCase();
  if (!rules.resolutions.includes(resolution)) throw fail("Unsupported resolution for " + model + ": " + requestedResolution);

  const references = input.reference_images || input.referenceImages || [];
  if (!Array.isArray(references)) throw fail("reference_images must be an array.");
  if (operation === "edit" && references.length === 0) throw fail("reference_images must contain at least one image for edit.");
  if (references.length > rules.maxReferenceImages) throw fail("reference_images supports at most " + rules.maxReferenceImages + " item(s) for " + model + ".");
  if (operation === "generate" && references.length > 0) throw fail("Use image_edit when reference_images are provided.");
  for (const reference of references) {
    if (typeof reference !== "string" || (!asDataUrl(reference) && !/^https?:\/\//i.test(reference))) {
      throw fail("reference_images must contain image data URLs or HTTPS URLs.");
    }
  }
  return { model, prompt, n, aspect_ratio: aspectRatio, resolution, reference_images: references, operation };
}

function decodeDataUrl(value) {
  const match = /^data:(image\/[A-Za-z0-9.+-]+);base64,([A-Za-z0-9+/=\r\n]+)$/i.exec(value || "");
  if (!match) return null;
  const base64 = match[2].replace(/[\r\n]/g, "");
  if (Math.floor(base64.length * 3 / 4) > MAX_REFERENCE_BYTES) throw fail("reference image is too large.", 400, "reference_image_error");
  const bytes = Buffer.from(base64, "base64");
  if (bytes.byteLength > MAX_REFERENCE_BYTES) throw fail("reference image is too large.", 400, "reference_image_error");
  return { mimeType: match[1].toLowerCase(), dataUrl: "data:" + match[1].toLowerCase() + ";base64," + base64 };
}

function validateReferenceUrl(value) {
  const parsed = new URL(value);
  if (parsed.protocol !== "https:") throw fail("reference image URLs must use HTTPS.");
  if (parsed.username || parsed.password) throw fail("reference image URLs must not contain credentials.");
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") ||
    hostname === "metadata.google.internal" || hostname.includes(":") ||
    /^127\.|^10\.|^192\.168\.|^169\.254\.|^0\./.test(hostname)
  ) throw fail("reference image URL host is not allowed.");
  const octets = hostname.split(".").map((part) => Number(part));
  if (octets.length === 4 && octets.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)) {
    if (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) throw fail("reference image URL host is not allowed.");
    throw fail("reference image URLs must use a hostname, not a raw IP address.");
  }
  return parsed;
}

function isForbiddenAddress(address) {
  const normalized = String(address || "").toLowerCase().replace(/^\[|\]$/g, "");
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized);
  if (mapped) return isForbiddenAddress(mapped[1]);
  if (normalized.includes(":")) {
    return normalized === "::" || normalized === "::1" || /^f[cd]/.test(normalized) || /^fe[89ab]/.test(normalized) || /^ff/.test(normalized);
  }
  const octets = normalized.split(".").map((part) => Number(part));
  if (octets.length !== 4 || !octets.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)) return true;
  return octets[0] === 0 || octets[0] === 10 || octets[0] === 127 || octets[0] >= 224 ||
    (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127) ||
    (octets[0] === 169 && octets[1] === 254) ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168);
}

async function assertPublicHostname(parsed, lookupImpl) {
  let addresses;
  try {
    addresses = await lookupImpl(parsed.hostname, { all: true, verbatim: true });
  } catch {
    throw fail("reference image URL hostname could not be resolved.", 400, "reference_image_error");
  }
  if (!Array.isArray(addresses) || addresses.length === 0 || addresses.some((entry) => isForbiddenAddress(entry?.address))) {
    throw fail("reference image URL resolved to a non-public address.", 400, "reference_image_error");
  }
}

async function responseBytesWithinLimit(response) {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REFERENCE_BYTES) throw fail("reference image is too large.", 400, "reference_image_error");
  if (!response.body?.getReader) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength > MAX_REFERENCE_BYTES) throw fail("reference image is too large.", 400, "reference_image_error");
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_REFERENCE_BYTES) throw fail("reference image is too large.", 400, "reference_image_error");
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

async function resolveReferenceDataUrls(request, fetchImpl, signal, lookupImpl) {
  const dataUrls = [];
  for (const reference of request.reference_images) {
    const decoded = decodeDataUrl(reference);
    if (decoded) {
      dataUrls.push(decoded.dataUrl);
      continue;
    }
    const parsed = validateReferenceUrl(reference);
    await assertPublicHostname(parsed, lookupImpl);
    const response = await fetchImpl(parsed, { redirect: "error", signal: imageSignal(signal, 60000) });
    if (!response.ok) throw fail("Unable to download reference image (HTTP " + response.status + ").", 400, "reference_image_error");
    const mimeType = (response.headers.get("content-type") || "").split(";", 1)[0].toLowerCase();
    if (!mimeType.startsWith("image/")) throw fail("reference image URL did not return an image.", 400, "reference_image_error");
    const bytes = await responseBytesWithinLimit(response);
    dataUrls.push("data:" + mimeType + ";base64," + bytes.toString("base64"));
  }
  return dataUrls;
}

function generationBody(request) {
  if (request.model === "gemini-3.1-flash-image") {
    return { model: request.model, prompt: request.prompt, n: request.n, size: request.aspect_ratio, quality: request.resolution.toUpperCase() };
  }
  return { model: request.model, prompt: request.prompt, n: request.n, size: gptSizeFrom(request.aspect_ratio), quality: gptQualityFrom(request.resolution) };
}

function multimodalContent(prompt, references) {
  return [{ type: "text", text: prompt }, ...references.map((url) => ({ type: "image_url", image_url: { url } }))];
}

function gptMomoEditBody(request, references) {
  const prompt = request.prompt + "\n\nOutput requirements: create exactly " + request.n + " edited image(s); canvas " +
    gptSizeFrom(request.aspect_ratio) + " (requested aspect " + request.aspect_ratio + "); " +
    request.resolution.toUpperCase() + " / " + gptQualityFrom(request.resolution) + " quality hint.";
  return { model: request.model, stream: true, messages: [{ role: "user", content: multimodalContent(prompt, references) }] };
}

function geminiEditBody(request, references) {
  return {
    model: request.model,
    messages: [{ role: "user", content: multimodalContent(request.prompt, references) }],
    modalities: ["text", "image"],
    extra_body: { google: { image_config: { aspect_ratio: request.aspect_ratio, image_size: request.resolution.toUpperCase() } } },
  };
}

function parseSseEvents(text) {
  const events = [];
  for (const frame of String(text || "").split(/\r?\n\r?\n/)) {
    const data = frame.split(/\r?\n/).filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart()).join("\n").trim();
    if (!data || data === "[DONE]") continue;
    try { events.push(JSON.parse(data)); } catch {}
  }
  return events;
}

function collectText(value, output, depth = 0) {
  if (depth > 12 || value === null || value === undefined) return;
  if (typeof value === "string") { output.push(value); return; }
  if (typeof value !== "object") return;
  if (Array.isArray(value)) { for (const item of value) collectText(item, output, depth + 1); return; }
  if (typeof value.content === "string") output.push(value.content);
  else if (value.content !== undefined) collectText(value.content, output, depth + 1);
  if (typeof value.text === "string") output.push(value.text);
}

function normalizeSsePayload(text) {
  const events = parseSseEvents(text);
  const deltas = [];
  for (const event of events) {
    for (const choice of Array.isArray(event?.choices) ? event.choices : []) {
      collectText(choice?.delta?.content, deltas);
      collectText(choice?.message?.content, deltas);
    }
  }
  return { content: deltas.join("") };
}

export function extractImageResults(payload) {
  const images = [];
  const taskIds = [];
  const seen = new Set();
  const addDataUrls = (value) => {
    const pattern = /data:(image\/[A-Za-z0-9.+-]+);base64,([A-Za-z0-9+/=\r\n]+)/gi;
    let match;
    while ((match = pattern.exec(value)) !== null) images.push({ b64_json: match[2].replace(/[\r\n]/g, ""), mime_type: match[1].toLowerCase() });
  };
  const visit = (value, depth = 0) => {
    if (depth > 12 || value === null || value === undefined) return;
    if (typeof value === "string") { addDataUrls(value); return; }
    if (typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    const url = [value.url, value.image_url, value.result_url].find((item) => typeof item === "string" && /^https?:\/\//i.test(item));
    const directBase64 = [value.b64_json, value.base64, value.image_base64, value.partial_image_b64].find((item) => typeof item === "string" && item.length > 0);
    const resultBase64 = typeof value.result === "string" && value.result.length > 256 && /^[A-Za-z0-9+/=\r\n]+$/.test(value.result) ? value.result : null;
    const b64Json = directBase64 || resultBase64;
    if (url || b64Json) images.push({ ...(url ? { url } : {}), ...(b64Json ? { b64_json: b64Json } : {}) });
    if (typeof value.task_id === "string") taskIds.push(value.task_id);
    for (const child of Array.isArray(value) ? value : Object.values(value)) visit(child, depth + 1);
  };
  visit(payload);
  const uniqueImages = images.filter((image, index, list) => list.findIndex((item) => item.url === image.url && item.b64_json === image.b64_json) === index);
  const rawStatus = typeof payload?.status === "string" ? payload.status : null;
  const terminal = ["failed", "error", "cancelled", "canceled", "expired"].includes(String(rawStatus || "").toLowerCase());
  const rawError = payload?.error?.message || payload?.error || payload?.failure_reason || payload?.fail_reason;
  const error = typeof rawError === "string" ? rawError.replace(/[\r\n]+/g, " ").slice(0, 1000) : null;
  return { images: uniqueImages, task_id: taskIds[0] || null, raw_status: rawStatus, terminal, ...(error ? { error } : {}) };
}

async function materializeImages(result, fetchImpl, signal, lookupImpl) {
  const images = [];
  for (const image of result.images) {
    if (image.b64_json || !image.url || !/^https?:\/\//i.test(image.url)) { images.push(image); continue; }
    try {
      const parsed = validateReferenceUrl(image.url);
      await assertPublicHostname(parsed, lookupImpl);
      const response = await fetchImpl(parsed, { redirect: "error", signal: imageSignal(signal, 60000) });
      if (!response.ok) { images.push(image); continue; }
      const mimeType = (response.headers.get("content-type") || "image/png").split(";", 1)[0];
      if (!mimeType.toLowerCase().startsWith("image/")) { images.push(image); continue; }
      const bytes = await responseBytesWithinLimit(response);
      images.push({ ...image, b64_json: bytes.toString("base64"), mime_type: mimeType });
    } catch { images.push(image); }
  }
  return { ...result, images };
}

async function readUpstreamPayload(upstream) {
  const text = await upstream.text();
  const contentType = upstream.headers.get("content-type") || "";
  if (contentType.includes("text/event-stream") || /^\s*data:/m.test(text)) return normalizeSsePayload(text);
  try { return JSON.parse(text); } catch {
    const looksLikeHtml = /<!doctype\s+html|<html[\s>]/i.test(text);
    const suffix = upstream.status === 524 ? " (Cloudflare timeout)" : "";
    const message = looksLikeHtml
      ? "Image upstream returned HTTP " + upstream.status + suffix + "."
      : (text || "Image upstream returned an empty response.").replace(/[\r\n]+/g, " ").slice(0, 1000);
    return { error: { message } };
  }
}

export async function generateImage({ settings, request, fetchImpl = fetch, lookupImpl = lookup, signal, operation = "generate" }) {
  const normalized = normalizeImageRequest(request, operation);
  const endpoint = String(settings.endpoint || "").replace(/\/+$/, "");
  let path = "/v1/images/generations";
  let body;
  if (operation === "generate") body = generationBody(normalized);
  else {
    const references = await resolveReferenceDataUrls(normalized, fetchImpl, signal, lookupImpl);
    if (normalized.model === "gpt-image-2") body = { ...generationBody(normalized), image_urls: references };
    else if (normalized.model === "gpt-image-2-momoapi") { path = "/v1/chat/completions"; body = gptMomoEditBody(normalized, references); }
    else { path = "/v1/chat/completions"; body = geminiEditBody(normalized, references); }
  }
  const upstream = await fetchImpl(endpoint + path, {
    method: "POST",
    headers: { authorization: "Bearer " + settings.apiKey, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: imageSignal(signal),
  });
  const payload = await readUpstreamPayload(upstream);
  if (!upstream.ok) throw fail(payload?.error?.message || "Image upstream returned HTTP " + upstream.status, upstream.status >= 400 && upstream.status < 500 ? upstream.status : 502, "image_upstream_error");
  return materializeImages(extractImageResults(payload), fetchImpl, signal, lookupImpl);
}

export async function getImageTask({ settings, taskId, fetchImpl = fetch, lookupImpl = lookup, signal }) {
  if (!/^[A-Za-z0-9._:-]{1,256}$/.test(taskId || "")) throw fail("Invalid task_id.");
  const endpoint = String(settings.endpoint || "").replace(/\/+$/, "");
  const upstream = await fetchImpl(endpoint + "/v1/images/generations/" + encodeURIComponent(taskId), {
    headers: { authorization: "Bearer " + settings.apiKey },
    signal: imageSignal(signal, 60000),
  });
  const payload = await readUpstreamPayload(upstream);
  if (!upstream.ok) throw fail(payload?.error?.message || "Image task returned HTTP " + upstream.status, upstream.status, "image_task_error");
  return materializeImages(extractImageResults(payload), fetchImpl, signal, lookupImpl);
}
