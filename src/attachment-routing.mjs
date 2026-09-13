import { createHash, randomUUID } from "node:crypto";

const MIB = 1024 * 1024;
const DATA_URL_RE = /^data:([^;,]+)(?:;[^,]*)?;base64,([A-Za-z0-9+/=\r\n\t ]+)$/i;
const SHA256_RE = /^[a-f0-9]{64}$/;

const MIME_EXTENSIONS = new Map([
  ["image/png", "png"], ["image/jpeg", "jpg"], ["image/gif", "gif"], ["image/webp", "webp"], ["image/avif", "avif"], ["image/svg+xml", "svg"],
  ["application/pdf", "pdf"], ["text/plain", "txt"], ["text/markdown", "md"], ["text/csv", "csv"], ["application/json", "json"],
  ["text/xml", "xml"], ["application/xml", "xml"], ["text/html", "html"],
  ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "docx"],
  ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "xlsx"],
  ["application/vnd.openxmlformats-officedocument.presentationml.presentation", "pptx"],
  ["application/msword", "doc"], ["application/vnd.ms-excel", "xls"], ["application/vnd.ms-powerpoint", "ppt"],
  ["application/zip", "zip"], ["application/octet-stream", "bin"],
]);

function routeError(statusCode, code, message, details = {}) {
  return Object.assign(new Error(message), { statusCode, code, details });
}

function positiveMb(value, fallback, max) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= max ? parsed : fallback;
}

export function resolveAttachmentPolicy(settings = {}) {
  const supplied = settings.attachmentAssets && typeof settings.attachmentAssets === "object" ? settings.attachmentAssets : {};
  const maxFileBytes = Math.floor(positiveMb(process.env.MOMO_ATTACHMENT_MAX_FILE_MB ?? supplied.maxFileMb, 50, 50) * MIB);
  const maxBatchBytes = Math.floor(positiveMb(process.env.MOMO_ATTACHMENT_MAX_BATCH_MB ?? supplied.maxBatchMb, 100, 100) * MIB);
  const inlineImageBytes = Math.min(maxFileBytes, Math.floor(positiveMb(process.env.MOMO_ATTACHMENT_INLINE_IMAGE_MB ?? supplied.inlineImageMb, 6, 8) * MIB));
  const inlineFileBytes = Math.min(maxFileBytes, Math.floor(positiveMb(process.env.MOMO_ATTACHMENT_INLINE_FILE_MB ?? supplied.inlineFileMb, 2, 8) * MIB));
  return {
    // resolveSettings writes the explicit default. Keeping raw library/test
    // settings opt-in avoids surprising callers that bypass configuration.
    enabled: supplied.enabled === true,
    maxFileBytes,
    maxBatchBytes: Math.max(maxFileBytes, maxBatchBytes),
    inlineImageBytes,
    inlineFileBytes,
    // Context media accounting uses Base64/JSON bytes. Keeping decoded inline
    // media below 5.5 MiB leaves room under the 8 MiB context-media envelope.
    inlineBatchBytes: Math.min(maxBatchBytes, Math.floor(positiveMb(process.env.MOMO_ATTACHMENT_INLINE_BATCH_MB ?? supplied.inlineBatchMb, 5.5, 18) * MIB)),
    uploadTimeoutMs: Math.floor(Math.min(600_000, Math.max(10_000, Number(supplied.uploadTimeoutMs) || 180_000))),
  };
}

function normalizeMimeType(value) {
  const mimeType = String(value || "application/octet-stream").split(";", 1)[0].trim().toLowerCase();
  return mimeType === "image/jpg" ? "image/jpeg" : mimeType;
}

function startsWith(bytes, signature) {
  return bytes.length >= signature.length && signature.every((byte, index) => bytes[index] === byte);
}

function sniffKind(bytes) {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "jpeg";
  if (bytes.length >= 6 && ["GIF87a", "GIF89a"].includes(bytes.toString("ascii", 0, 6))) return "gif";
  if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "webp";
  if (bytes.length >= 12 && bytes.toString("ascii", 4, 8) === "ftyp") {
    const brands = bytes.subarray(8, Math.min(bytes.length, 64)).toString("ascii");
    if (brands.includes("avif") || brands.includes("avis")) return "avif";
  }
  if (bytes.length >= 5 && bytes.toString("ascii", 0, 5) === "%PDF-") return "pdf";
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) || startsWith(bytes, [0x50, 0x4b, 0x05, 0x06]) || startsWith(bytes, [0x50, 0x4b, 0x07, 0x08])) return "zip";
  if (startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return "ole";
  const prefix = bytes.subarray(0, Math.min(bytes.length, 4096)).toString("utf8").replace(/^\uFEFF/, "").trimStart().toLowerCase();
  if (prefix.startsWith("<svg") || (prefix.startsWith("<?xml") && prefix.includes("<svg"))) return "svg";
  if (!bytes.includes(0)) return "text";
  return "unknown";
}

function zipEntryNames(bytes) {
  const eocdSignature = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
  const searchStart = Math.max(0, bytes.length - 65_557);
  const eocd = bytes.lastIndexOf(eocdSignature);
  if (eocd < searchStart || eocd + 22 > bytes.length) return null;
  const entryCount = bytes.readUInt16LE(eocd + 10);
  const centralBytes = bytes.readUInt32LE(eocd + 12);
  const centralOffset = bytes.readUInt32LE(eocd + 16);
  if (entryCount === 0xffff || centralOffset + centralBytes > eocd || entryCount > 16_384) return null;
  const names = new Set();
  let cursor = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > eocd || bytes.readUInt32LE(cursor) !== 0x02014b50) return null;
    const nameBytes = bytes.readUInt16LE(cursor + 28);
    const extraBytes = bytes.readUInt16LE(cursor + 30);
    const commentBytes = bytes.readUInt16LE(cursor + 32);
    const end = cursor + 46 + nameBytes + extraBytes + commentBytes;
    if (nameBytes === 0 || nameBytes > 4096 || end > eocd) return null;
    names.add(bytes.toString("utf8", cursor + 46, cursor + 46 + nameBytes).replace(/\\/g, "/").toLowerCase());
    cursor = end;
  }
  return cursor === centralOffset + centralBytes ? names : null;
}

function validateSignature(mimeType, bytes) {
  const kind = sniffKind(bytes);
  const expected = new Map([
    ["image/png", "png"], ["image/jpeg", "jpeg"], ["image/gif", "gif"], ["image/webp", "webp"], ["image/avif", "avif"], ["image/svg+xml", "svg"],
    ["application/pdf", "pdf"], ["application/zip", "zip"],
    ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "zip"],
    ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "zip"],
    ["application/vnd.openxmlformats-officedocument.presentationml.presentation", "zip"],
    ["application/msword", "ole"], ["application/vnd.ms-excel", "ole"], ["application/vnd.ms-powerpoint", "ole"],
  ]).get(mimeType);
  if (expected && kind !== expected) return false;
  if (mimeType.startsWith("application/vnd.openxmlformats-officedocument.")) {
    const names = zipEntryNames(bytes);
    if (!names?.has("[content_types].xml")) return false;
    if (mimeType.endsWith("wordprocessingml.document")) return names.has("word/document.xml");
    if (mimeType.endsWith("spreadsheetml.sheet")) return names.has("xl/workbook.xml");
    if (mimeType.endsWith("presentationml.presentation")) return names.has("ppt/presentation.xml");
  }
  if (mimeType.startsWith("text/") || mimeType === "application/json" || mimeType === "application/xml") return kind === "text" || kind === "svg";
  if (mimeType === "application/octet-stream") return kind !== "unknown";
  return MIME_EXTENSIONS.has(mimeType);
}

export function parseInlineAttachment(dataUrl, { maxFileBytes = 50 * MIB, maxBatchBytes = 100 * MIB } = {}) {
  if (typeof dataUrl !== "string") return null;
  const match = DATA_URL_RE.exec(dataUrl);
  if (!match) return null;
  const mimeType = normalizeMimeType(match[1]);
  const encoded = match[2].replace(/[\r\n\t ]/g, "");
  if (!encoded || encoded.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
    throw routeError(400, "attachment_invalid_base64", "Attachment contains invalid Base64 data.");
  }
  const padding = encoded.endsWith("==") ? 2 : (encoded.endsWith("=") ? 1 : 0);
  const estimatedBytes = Math.floor(encoded.length * 3 / 4) - padding;
  if (estimatedBytes > maxFileBytes) {
    throw routeError(413, "attachment_file_too_large", `Attachment exceeds the ${Math.floor(maxFileBytes / MIB)} MiB single-file limit.`, { actualBytes: estimatedBytes, maxFileBytes, maxBatchBytes });
  }
  const bytes = Buffer.from(encoded, "base64");
  const canonical = bytes.toString("base64").replace(/=+$/, "");
  if (!bytes.length || canonical !== encoded.replace(/=+$/, "")) {
    throw routeError(400, "attachment_invalid_base64", "Attachment contains invalid Base64 data.");
  }
  if (!validateSignature(mimeType, bytes)) {
    throw routeError(400, "attachment_signature_mismatch", "Attachment MIME type does not match its file signature.", { mimeType });
  }
  return {
    bytes,
    byteLength: bytes.length,
    mimeType,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    isImage: mimeType.startsWith("image/"),
  };
}

function currentTurnStart(items, kind) {
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index];
    if (item?.role === "user" || (kind === "responses" && item?.type === "input_text")) return index;
  }
  return 0;
}

function markerPart(kind, descriptor) {
  const text = `[historical attachment ${descriptor.assetId} omitted: remote asset reference unavailable]`;
  return kind === "chat" ? { type: "text", text } : { type: "input_text", text };
}

function storedAssetMetadata(value) {
  const asset = value?.momo_asset;
  if (!asset || typeof asset !== "object") return null;
  const assetId = String(asset.asset_id || "");
  const sha256 = String(asset.sha256 || "").toLowerCase();
  const objectKey = String(asset.object_key || "");
  const bytes = Number(asset.bytes);
  const mimeType = normalizeMimeType(asset.mime_type);
  if (assetId !== `asset_${sha256}` || !SHA256_RE.test(sha256) || !/^chat-temp\/u_[a-f0-9]{12}\//.test(objectKey)) return null;
  if (!Number.isSafeInteger(bytes) || bytes <= 0 || !MIME_EXTENSIONS.has(mimeType)) return null;
  return {
    asset_id: assetId, object_key: objectKey, sha256, bytes, mime_type: mimeType,
    file_name: String(asset.file_name || value.filename || "attachment").slice(0, 160),
  };
}

function collectRecords(payload, kind, policy) {
  const items = kind === "chat" ? payload.messages : payload.input;
  if (!Array.isArray(items)) return [];
  const boundary = currentTurnStart(items, kind);
  const records = [];

  const visit = (value, replace, topIndex) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach((nested, index) => visit(nested, (replacement) => { value[index] = replacement; }, topIndex));
      return;
    }

    let dataUrl = null;
    let fileName = typeof value.filename === "string" ? value.filename : null;
    let contentKind = null;
    if (value.type === "input_image") {
      dataUrl = typeof value.image_url === "string" ? value.image_url : value.image_url?.url;
      contentKind = "image";
    } else if (value.type === "image_url") {
      dataUrl = typeof value.image_url === "string" ? value.image_url : value.image_url?.url;
      contentKind = "image";
    } else if (value.type === "input_file") {
      dataUrl = value.file_data;
      contentKind = "file";
    } else if (value.type === "file" && value.file && typeof value.file === "object") {
      dataUrl = value.file.file_data;
      fileName = value.file.filename || fileName;
      contentKind = "file";
    }

    const isCurrent = topIndex >= boundary;
    const stored = storedAssetMetadata(value);
    const remoteUrl = contentKind === "image"
      ? (typeof value.image_url === "string" ? value.image_url : value.image_url?.url)
      : (contentKind === "file" ? (value.file_url || value.file?.file_url) : null);
    if (stored && typeof remoteUrl === "string" && (/^https:\/\//i.test(remoteUrl) || remoteUrl === `asset:${stored.asset_id}`)) {
      if (stored.bytes > policy.maxFileBytes) {
        if (!isCurrent) { replace(markerPart(kind, { assetId: stored.asset_id })); return; }
        throw routeError(413, "attachment_file_too_large", `Attachment exceeds the ${Math.floor(policy.maxFileBytes / MIB)} MiB single-file limit.`, { actualBytes: stored.bytes, maxFileBytes: policy.maxFileBytes, maxBatchBytes: policy.maxBatchBytes });
      }
      records.push({
        bytes: null, byteLength: stored.bytes, mimeType: stored.mime_type, sha256: stored.sha256,
        assetId: stored.asset_id, fileName: stored.file_name, kind: stored.mime_type.startsWith("image/") ? "image" : "file",
        isImage: stored.mime_type.startsWith("image/"), isCurrent, shouldOffload: true, storedMetadata: stored,
        replaceWithMarker() { replace(markerPart(kind, this)); },
        replaceWithAsset(downloadUrl, metadata) {
          if (value.type === "input_image") value.image_url = downloadUrl;
          else if (value.type === "image_url") value.image_url = { ...(value.image_url && typeof value.image_url === "object" ? value.image_url : {}), url: downloadUrl };
          else if (value.type === "input_file") value.file_url = downloadUrl;
          else if (value.type === "file") value.file.file_url = downloadUrl;
          value.momo_asset = {
            asset_id: metadata.asset_id, object_key: metadata.object_key, sha256: metadata.sha256,
            bytes: metadata.bytes, mime_type: metadata.mime_type, file_name: metadata.file_name,
          };
        },
      });
      return;
    }

    let descriptor;
    try {
      descriptor = parseInlineAttachment(dataUrl, policy);
    } catch (error) {
      if (!isCurrent && Number.isInteger(error?.statusCode) && error.statusCode >= 400 && error.statusCode < 500) {
        replace(markerPart(kind, { assetId: "unavailable" }));
        return;
      }
      throw error;
    }
    if (descriptor) {
      const effectiveKind = descriptor.isImage ? "image" : contentKind;
      const extension = MIME_EXTENSIONS.get(descriptor.mimeType) || "bin";
      const safeFileName = String(fileName || `${effectiveKind || "attachment"}-${descriptor.sha256.slice(0, 12)}.${extension}`).slice(0, 160);
      records.push({
        ...descriptor,
        assetId: `asset_${descriptor.sha256}`,
        fileName: safeFileName,
        kind: effectiveKind,
        isCurrent,
        shouldOffload: descriptor.byteLength > (descriptor.isImage ? policy.inlineImageBytes : policy.inlineFileBytes),
        replaceWithMarker() { replace(markerPart(kind, this)); },
        replaceWithAsset(downloadUrl, metadata) {
          if (value.type === "input_image") value.image_url = downloadUrl;
          else if (value.type === "image_url") value.image_url = { ...(value.image_url && typeof value.image_url === "object" ? value.image_url : {}), url: downloadUrl };
          else if (value.type === "input_file") { delete value.file_data; value.file_url = downloadUrl; }
          else if (value.type === "file") { delete value.file.file_data; value.file.file_url = downloadUrl; }
          value.momo_asset = {
            asset_id: metadata.asset_id, object_key: metadata.object_key, sha256: metadata.sha256,
            bytes: metadata.bytes, mime_type: metadata.mime_type, file_name: metadata.file_name,
          };
        },
      });
      return;
    }

    for (const [key, nested] of Object.entries(value)) {
      if (key === "momo_asset") continue;
      if (nested && typeof nested === "object") visit(nested, (replacement) => { value[key] = replacement; }, topIndex);
    }
  };

  items.forEach((item, index) => visit(item, (replacement) => { items[index] = replacement; }, index));
  return records;
}

async function shortResponseText(response, limit = 64 * 1024) {
  if (!response?.body) return "";
  const chunks = [];
  let total = 0;
  for await (const chunk of response.body) {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk);
    const remaining = Math.max(0, limit - total);
    if (remaining > 0) chunks.push(bytes.subarray(0, remaining));
    total += bytes.length;
    if (total >= limit) {
      try { await response.body.cancel?.(); } catch {}
      break;
    }
  }
  return Buffer.concat(chunks).toString("utf8");
}

function safeHttpsUrl(value, field) {
  try {
    const parsed = new URL(String(value || ""));
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) throw new Error();
    return parsed.href;
  } catch {
    throw routeError(502, "attachment_storage_invalid_response", `Attachment storage returned an invalid ${field}.`);
  }
}

async function requestJson(fetchImpl, url, init, signal) {
  const response = await fetchImpl(url, { ...init, signal });
  const text = await shortResponseText(response);
  let payload;
  try { payload = text ? JSON.parse(text) : {}; } catch { payload = {}; }
  if (!response.ok) {
    const message = String(payload?.error?.message || payload?.error || `Attachment storage HTTP ${response.status}`)
      .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, "Bearer [redacted]")
      .replace(/https:\/\/[^\s"']+/gi, "[storage URL redacted]")
      .replace(/data:[^;,\s]+(?:;[^,\s]*)?;base64,[A-Za-z0-9+/=\r\n]+/gi, "[inline data redacted]")
      .slice(0, 500);
    const upstreamCode = typeof payload?.code === "string" ? payload.code : "attachment_storage_error";
    const safeStatus = upstreamCode.startsWith("attachment_") && Number.isInteger(response.status)
      ? response.status
      : (response.status === 413 ? 413 : 502);
    throw routeError(safeStatus, upstreamCode, message);
  }
  return payload;
}

function uploadApiBase(settings) {
  const configured = settings.attachmentAssets?.apiBaseUrl || process.env.MOMO_ATTACHMENT_UPLOAD_BASE_URL || settings.endpoint;
  return String(configured || "").replace(/\/+$/, "").replace(/\/v1$/, "");
}

function safeUploadHeaders(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const headers = {};
  for (const [name, nested] of Object.entries(value)) {
    const lower = name.toLowerCase();
    if (lower !== "content-type" && lower !== "content-length" && !lower.startsWith("x-amz-")) continue;
    if (typeof nested === "string" && nested.length <= 4096) headers[name] = nested;
  }
  return headers;
}

async function resignAsset({ metadata, settings, fetchImpl, signal }) {
  const payload = await requestJson(fetchImpl, `${uploadApiBase(settings)}/api/uploads/resign`, {
    method: "POST",
    headers: { authorization: `Bearer ${settings.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ objectKey: metadata.object_key, contentType: metadata.mime_type }),
  }, signal);
  return safeHttpsUrl(payload.downloadUrl, "download URL");
}

async function uploadAsset({ record, batchId, settings, fetchImpl, signal, store }) {
  const purpose = record.isImage ? "chat-image" : "chat-document";
  const intent = await requestJson(fetchImpl, `${uploadApiBase(settings)}/api/uploads/presign`, {
    method: "POST",
    headers: { authorization: `Bearer ${settings.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      fileName: record.fileName, contentType: record.mimeType, size: record.byteLength, purpose,
      requestId: batchId, batchId, sha256: record.sha256,
    }),
  }, signal);
  const uploadUrl = safeHttpsUrl(intent.uploadUrl, "upload URL");
  const downloadUrl = safeHttpsUrl(intent.downloadUrl, "download URL");
  if (intent.assetId && intent.assetId !== record.assetId) {
    throw routeError(502, "attachment_storage_invalid_response", "Attachment storage returned a mismatched asset id.");
  }
  const uploadHeaders = safeUploadHeaders(intent.uploadHeaders);
  const upload = await fetchImpl(uploadUrl, { method: "PUT", headers: uploadHeaders, body: record.bytes, signal });
  if (!upload.ok) {
    await shortResponseText(upload).catch(() => "");
    throw routeError(502, "attachment_upload_failed", `Attachment upload failed with HTTP ${upload.status}.`);
  }
  const objectKey = String(intent.objectKey || "");
  if (!/^chat-temp\/u_[a-f0-9]{12}\//.test(objectKey)) {
    throw routeError(502, "attachment_storage_invalid_response", "Attachment storage returned an invalid object key.");
  }
  const metadata = await store.put({
    asset_id: record.assetId, object_key: objectKey, sha256: record.sha256, bytes: record.byteLength,
    mime_type: record.mimeType, file_name: record.fileName,
  });
  return { metadata, downloadUrl };
}

function metadataMatchesRecord(metadata, record) {
  return metadata && metadata.sha256 === record.sha256 && metadata.bytes === record.byteLength
    && normalizeMimeType(metadata.mime_type) === record.mimeType;
}

export function stripAttachmentMetadata(value) {
  if (Array.isArray(value)) return value.map(stripAttachmentMetadata);
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const [key, nested] of Object.entries(value)) {
    if (key === "momo_asset") continue;
    out[key] = stripAttachmentMetadata(nested);
  }
  return out;
}

export async function assetizeAttachments(payload, settings, { kind = "responses", targetProtocol = kind, fetchImpl = fetch, signal, store } = {}) {
  const policy = resolveAttachmentPolicy(settings);
  if (!policy.enabled || !store) return { payload, trace: { attachmentCount: 0, uploadedCount: 0, resignedCount: 0, uploadedBytes: 0 } };
  const timeoutSignal = AbortSignal.timeout(policy.uploadTimeoutMs);
  const effectiveSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  const trace = { attachmentCount: 0, currentAttachmentBytes: 0, uploadedCount: 0, resignedCount: 0, uploadedBytes: 0 };
  try {
    const records = collectRecords(payload, kind, policy);
    const current = records.filter((record) => record.isCurrent);
    const currentFiles = current.filter((record) => !record.isImage);
    const totalBytes = current.reduce((sum, record) => sum + record.byteLength, 0);
    trace.attachmentCount = records.length;
    trace.currentAttachmentBytes = totalBytes;
    if (totalBytes > policy.maxBatchBytes) {
      throw routeError(413, "attachment_batch_too_large", `Current-turn attachments exceed the ${Math.floor(policy.maxBatchBytes / MIB)} MiB batch limit.`, { actualBytes: totalBytes, maxFileBytes: policy.maxFileBytes, maxBatchBytes: policy.maxBatchBytes });
    }
    let retainedInlineBytes = 0;
    for (const record of current) {
      if (record.shouldOffload) continue;
      if (retainedInlineBytes + record.byteLength <= policy.inlineBatchBytes) {
        retainedInlineBytes += record.byteLength;
      } else {
        record.shouldOffload = true;
      }
    }
    const currentOffloadedFiles = currentFiles.filter((record) => record.shouldOffload);
    if (targetProtocol === "chat" && currentOffloadedFiles.length > 0) {
      throw routeError(400, "attachment_url_unsupported", "This Chat Completions model route does not support file URL attachments. Use a Responses, Gemini, or supported Claude model.");
    }
    if (targetProtocol === "claude" && currentOffloadedFiles.some((record) => record.mimeType !== "application/pdf")) {
      throw routeError(400, "attachment_url_unsupported", "Claude URL attachments currently support PDF files only.");
    }

    const batchId = `codex-${randomUUID()}`;
    const resolved = new Map();
    let uploadedCount = 0;
    let resignedCount = 0;
    let uploadedBytes = 0;

    for (const record of records) {
      const duplicate = resolved.get(record.sha256);
      if (duplicate) { record.replaceWithAsset(duplicate.downloadUrl, duplicate.metadata); continue; }
      if (!record.isCurrent && record.shouldOffload
        && (targetProtocol === "chat" || (targetProtocol === "claude" && !record.isImage && record.mimeType !== "application/pdf"))) {
        record.replaceWithMarker();
        continue;
      }

      let metadata = record.storedMetadata || await store.getBySha256(record.sha256) || null;
      if (metadata && !metadataMatchesRecord(metadata, record)) metadata = null;
      let downloadUrl = null;
      if (!record.isCurrent) {
        if (!metadata) { record.replaceWithMarker(); continue; }
        try {
          downloadUrl = await resignAsset({ metadata, settings, fetchImpl, signal: effectiveSignal });
          resignedCount += 1;
          trace.resignedCount = resignedCount;
          resolved.set(record.sha256, { metadata, downloadUrl });
          record.replaceWithAsset(downloadUrl, metadata);
        } catch {
          record.replaceWithMarker();
        }
        continue;
      }

      if (!record.shouldOffload) continue;
      if (metadata) {
        try {
          downloadUrl = await resignAsset({ metadata, settings, fetchImpl, signal: effectiveSignal });
          resignedCount += 1;
          trace.resignedCount = resignedCount;
        } catch (error) {
          if (!record.isCurrent) { record.replaceWithMarker(); continue; }
          metadata = null;
        }
      }

      if (!metadata) {
        if (!record.isCurrent) { record.replaceWithMarker(); continue; }
        if (!record.bytes) {
          throw routeError(409, "attachment_asset_unavailable", "Attachment asset metadata exists but neither its remote object nor original bytes are available. Reattach the file.");
        }
        const uploaded = await uploadAsset({ record, batchId, settings, fetchImpl, signal: effectiveSignal, store });
        metadata = uploaded.metadata;
        downloadUrl = uploaded.downloadUrl;
        uploadedCount += 1;
        uploadedBytes += record.byteLength;
        trace.uploadedCount = uploadedCount;
        trace.uploadedBytes = uploadedBytes;
      }

      const entry = { metadata, downloadUrl };
      resolved.set(record.sha256, entry);
      record.replaceWithAsset(downloadUrl, metadata);
    }

    return {
      payload,
      trace,
    };
  } catch (error) {
    let outgoing = error;
    if (timeoutSignal.aborted && !signal?.aborted && !Number.isInteger(error?.statusCode)) {
      outgoing = routeError(504, "attachment_upload_timeout", "Attachment upload exceeded its local deadline.");
    }
    if (outgoing && typeof outgoing === "object") {
      try { outgoing.attachmentTrace = trace; } catch {}
    }
    throw outgoing;
  }
}

export function stableAttachmentFingerprintObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const asset = value.momo_asset;
  if (!asset || typeof asset !== "object" || !/^asset_[a-f0-9]{64}$/.test(String(asset.asset_id || ""))) return null;
  const copy = { ...value, momo_asset: {
    asset_id: asset.asset_id, sha256: SHA256_RE.test(String(asset.sha256 || "")) ? asset.sha256 : undefined,
    bytes: Number.isSafeInteger(asset.bytes) ? asset.bytes : undefined, mime_type: asset.mime_type, file_name: asset.file_name,
  } };
  if (Object.hasOwn(copy, "image_url")) copy.image_url = `asset:${asset.asset_id}`;
  if (Object.hasOwn(copy, "file_url")) copy.file_url = `asset:${asset.asset_id}`;
  if (copy.file && typeof copy.file === "object") copy.file = { ...copy.file, file_url: `asset:${asset.asset_id}` };
  return copy;
}

export function checkpointAttachmentReferences(value) {
  if (Array.isArray(value)) {
    let changed = false;
    const mapped = value.map((nested, index) => {
      const replacement = checkpointAttachmentReferences(nested);
      if (replacement !== value[index]) changed = true;
      return replacement;
    });
    return changed ? mapped : value;
  }
  if (!value || typeof value !== "object") return value;
  const stable = stableAttachmentFingerprintObject(value);
  if (stable) {
    const reference = `asset:${stable.momo_asset.asset_id}`;
    if (Object.hasOwn(stable, "image_url")) {
      stable.image_url = typeof value.image_url === "object" && value.image_url
        ? { ...value.image_url, url: reference }
        : reference;
    }
    if (Object.hasOwn(stable, "file_url")) stable.file_url = reference;
    if (stable.file && typeof stable.file === "object") stable.file = { ...stable.file, file_url: reference };
    return Object.fromEntries(Object.entries(stable).map(([key, nested]) => [key, key === "momo_asset" ? nested : checkpointAttachmentReferences(nested)]));
  }
  let changed = false;
  const mapped = {};
  for (const [key, nested] of Object.entries(value)) {
    const replacement = checkpointAttachmentReferences(nested);
    mapped[key] = replacement;
    if (replacement !== nested) changed = true;
  }
  return changed ? mapped : value;
}
