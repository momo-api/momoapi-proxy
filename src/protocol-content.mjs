export const INLINE_DATA_URL = /^data:([^;,]+)(?:;[^,]*)?;base64,([A-Za-z0-9+/=\r\n]+)$/i;

const LARGE_INLINE_TEXT = 100_000;

function dataImage(value) {
  if (typeof value !== "string") return null;
  const match = /^data:(image\/[A-Za-z0-9.+-]+);base64,([A-Za-z0-9+/=\r\n]+)$/.exec(value);
  if (!match) return null;
  return { kind: "base64", mimeType: match[1], data: match[2].replace(/[\r\n]/g, ""), url: value };
}

function inlineAttachment(value, filename) {
  if (typeof value !== "string") return null;
  const match = INLINE_DATA_URL.exec(value);
  if (!match || match[1].toLowerCase().startsWith("image/")) return null;
  return {
    marker: filename ? `[file: ${filename}]` : `[file: inline ${match[1]} data]`,
    native: {
      type: "input_file",
      ...(filename ? { filename } : {}),
      file_data: value,
    },
  };
}

export function attachmentFromPart(part) {
  if (!part || typeof part !== "object") return null;
  if (part.type === "input_file") {
    const filename = typeof part.filename === "string" && part.filename ? part.filename : null;
    const fileId = typeof part.file_id === "string" && part.file_id ? part.file_id : null;
    const fileData = typeof part.file_data === "string" && part.file_data ? part.file_data : null;
    const fileUrl = typeof part.file_url === "string" && part.file_url ? part.file_url : null;
    if (!fileId && !fileData && !fileUrl) return null;
    return {
      marker: filename ? `[file: ${filename}]` : (fileId ? `[file: ${fileId}]` : "[file: inline data]"),
      native: {
        type: "input_file",
        ...(filename ? { filename } : {}),
        ...(fileId ? { file_id: fileId } : {}),
        ...(fileData ? { file_data: fileData } : {}),
        ...(fileUrl ? { file_url: fileUrl } : {}),
      },
    };
  }
  if (part.type === "input_video" && typeof part.video_url === "string") {
    return { marker: "[video attachment omitted: unsupported by this model route]", native: null };
  }
  if (part.type === "input_audio" || part.type === "audio") {
    return { marker: "[audio attachment omitted: unsupported by this model route]", native: null };
  }
  if (part.type === "encrypted_content") {
    return { marker: "[encrypted content omitted]", native: null };
  }
  if (part.type === "resource" && part.resource && typeof part.resource === "object") {
    if (typeof part.resource.text === "string") return { marker: part.resource.text, native: null };
    const name = typeof part.resource.uri === "string" ? part.resource.uri : "embedded resource";
    return { marker: `[file: ${name}]`, native: null };
  }
  if (part.type === "resource_link" && typeof part.uri === "string") {
    return { marker: `[file: ${part.name || part.uri}]`, native: null };
  }
  const directUrl = typeof part.file_data === "string" ? part.file_data
    : (typeof part.file_url === "string" ? part.file_url
      : (typeof part.video_url === "string" ? part.video_url : null));
  return inlineAttachment(directUrl, typeof part.filename === "string" ? part.filename : undefined);
}

function looksLikeInlineBinary(value) {
  if (typeof value !== "string" || value.length <= LARGE_INLINE_TEXT) return false;
  if (/^data:[^,]+;base64,/i.test(value)) return true;
  if (/^(?:JVBERi0|UEsDB|iVBORw0KGgo|\/9j\/|R0lGOD|UklGR)/.test(value)) return true;
  const compact = value.replace(/[\r\n]/g, "");
  return compact.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(compact);
}

export function safePartJson(part) {
  return JSON.stringify(part, (key, nested) => {
    if (typeof nested !== "string") return nested;
    if (looksLikeInlineBinary(nested)) return "[inline binary data omitted from text]";
    if (nested.length > LARGE_INLINE_TEXT && key !== "text") return "[oversized non-text data omitted]";
    return nested;
  });
}

export function safeTextValue(value) {
  if (typeof value !== "string") return value;
  const attachment = inlineAttachment(value);
  if (attachment) return attachment.marker;
  return looksLikeInlineBinary(value) ? "[inline binary data omitted]" : value;
}

export function imageFromPart(part) {
  if (!part || typeof part !== "object") return null;
  const inline = part.inline_data || part.inlineData;
  const source = part.source;
  const rawData = typeof inline?.data === "string"
    ? inline.data
    : (source?.type === "base64" && typeof source.data === "string"
      ? source.data
      : (part.type === "image" && typeof part.data === "string" ? part.data : null));
  if (rawData) {
    const mimeType = inline?.mime_type || inline?.mimeType || source?.media_type || part.mimeType || part.mime_type || "image/png";
    return { kind: "base64", mimeType, data: rawData, url: `data:${mimeType};base64,${rawData}` };
  }
  const rawUrl = typeof part.image_url === "string"
    ? part.image_url
    : (typeof part.image_url?.url === "string"
      ? part.image_url.url
      : (source?.type === "url" && typeof source.url === "string" ? source.url : null));
  const embedded = dataImage(rawUrl);
  if (embedded) return embedded;
  if (/^https?:\/\//i.test(rawUrl || "")) {
    return { kind: "url", mimeType: part.mimeType || part.mime_type || "image/jpeg", url: rawUrl };
  }
  return null;
}

export function outputParts(value) {
  const text = [];
  const images = [];
  const attachments = [];
  const values = Array.isArray(value) ? value : [value];
  for (const part of values) {
    if (typeof part === "string") {
      const image = dataImage(part);
      if (image) images.push(image);
      else {
        const attachment = inlineAttachment(part);
        if (attachment) attachments.push(attachment);
        else if (looksLikeInlineBinary(part)) attachments.push({ marker: "[inline binary data omitted]", native: null });
        else text.push(part);
      }
      continue;
    }
    if (!part || typeof part !== "object") continue;
    const image = imageFromPart(part);
    if (image) {
      images.push(image);
      continue;
    }
    const attachment = attachmentFromPart(part);
    if (attachment) {
      attachments.push(attachment);
      continue;
    }
    if (typeof part.text === "string") {
      text.push(safeTextValue(part.text));
      continue;
    }
    text.push(safePartJson(part));
  }
  const explicitText = text.filter(Boolean).join("\n");
  const attachmentText = attachments.map((item) => item.marker).filter(Boolean).join("\n");
  const responseFallbackText = attachments.filter((item) => !item.native).map((item) => item.marker).filter(Boolean).join("\n");
  return {
    text: [explicitText, attachmentText].filter(Boolean).join("\n") || (images.length ? "[image output attached]" : ""),
    responseText: [explicitText, responseFallbackText].filter(Boolean).join("\n"),
    images,
    files: attachments.map((item) => item.native).filter(Boolean),
    hasText: text.some(Boolean),
  };
}

export function responsesToolOutput(value) {
  const output = outputParts(value);
  if (output.images.length === 0 && output.files.length === 0) return typeof value === "string" && !looksLikeInlineBinary(value) ? value : output.responseText;
  return [
    ...(output.responseText ? [{ type: "input_text", text: output.responseText }] : []),
    ...output.images.map((image) => ({ type: "input_image", image_url: image.url })),
    ...output.files,
  ];
}
