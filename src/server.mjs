import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { extractFunctions, parseDsmlCalls, restoreToolName, stripDsmlMarkup } from "./tools.mjs";
import {
  rewriteRoutedNamespaceToolsForUpstream,
  rewriteRoutedCustomToolsForUpstream,
  rewriteRoutedToolSearchForUpstream,
  restoreAllRoutedCallsInJson,
  createRoutedCustomToolRestoreBlockRewrite,
} from "./responses-compat.mjs";
import { ResponseStreamEmitter, completed, customToolEvents, functionEvents, parseSse, responseCreated, sseError, textEvents } from "./responses-sse.mjs";
import { logRequest } from "./logger.mjs";
import { getCurrentVersion } from "./updater.mjs";

const GEMINI_PREFIX = /^gemini-/;
const CLAUDE_PREFIX = /^claude-/;
const MUSE_PREFIX = /^muse-/;
const ALLOWED_CONTENT_TYPES = new Set(["input_text", "output_text", "input_image", "input_file"]);
const KNOWN_METADATA_TYPES = new Set([
  "session_meta", "event_msg", "task_started", "world_state", "turn_context",
  "item_completed", "token_count", "web_search_call", "task_complete",
  "thread_settings_applied", "compacted", "turn_aborted", "inter_agent_communication_metadata",
  "agent_message"
]);

const GEMINI_REASONING_MAP = {
  none: "",
  minimal: "LOW",
  low: "LOW",
  medium: "MEDIUM",
  high: "HIGH",
  xhigh: "HIGH",
  max: "HIGH",
  ultra: "HIGH",
};

const CLAUDE_REASONING_BUDGETS = {
  minimal: 1024,
  low: 2048,
  medium: 4048,
  high: 8192,
  xhigh: 16384,
  max: 24576,
  ultra: 32768,
};
const MAX_CACHED_CALLS = 512;
export const metricsState = {
  startedAt: Date.now(),
  resetTime: new Date().toISOString(),
  requestsTotal: 0,
  requestsSuccess: 0,
  requestsFailed: 0,
  activeRequests: 0,
  activeSse: 0,
  ttfbHistory: [],
  maxRssBytes: 0,
  isDraining: false,
};

export function recordTtfb(ms) {
  metricsState.ttfbHistory.push(ms);
  if (metricsState.ttfbHistory.length > 500) metricsState.ttfbHistory.shift();
}

export function calculatePercentile(arr, p) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx];
}

export function resetMetrics() {
  metricsState.startedAt = Date.now();
  metricsState.resetTime = new Date().toISOString();
  metricsState.requestsTotal = 0;
  metricsState.requestsSuccess = 0;
  metricsState.requestsFailed = 0;
  metricsState.activeRequests = 0;
  metricsState.activeSse = 0;
  metricsState.ttfbHistory = [];
  metricsState.maxRssBytes = 0;
  metricsState.isDraining = false;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function json(response, status, body, headers = {}) {
  response.writeHead(status, { "content-type": "application/json", ...headers });
  response.end(JSON.stringify(body));
}

export function getMaxRequestBodyBytes(settings = {}) {
  const envVal = process.env.MOMO_MAX_REQUEST_BODY_MB;
  const configVal = settings.maxRequestBodyMb;
  const mb = parseInt(envVal || configVal || "64", 10);
  const validMb = (isNaN(mb) || mb < 1 || mb > 256) ? 64 : mb;
  return validMb * 1024 * 1024;
}

export async function bodyOf(request, settings = {}) {
  const maxBytes = getMaxRequestBodyBytes(settings);
  const chunks = [];
  let totalLength = 0;

  for await (const chunk of request) {
    totalLength += chunk.length;
    if (totalLength > maxBytes) {
      const err = new Error("Payload Too Large: request body exceeds limit of " + (maxBytes / (1024 * 1024)) + "MB.");
      err.statusCode = 413;
      err.code = "payload_too_large";
      throw err;
    }
    chunks.push(chunk);
  }

  const raw = Buffer.concat(chunks, totalLength).toString("utf8");
  try {
    return JSON.parse(raw);
  } catch {
    const err = new Error("Request body must be valid JSON.");
    err.statusCode = 400;
    err.code = "invalid_json";
    throw err;
  }
}
function authorized(request, settings) {
  const auth = request.headers.authorization;
  if (auth) {
    if (auth === "Bearer " + settings.localToken || auth === "Bearer " + settings.apiKey || auth === "Bearer momo-local-key") {
      return true;
    }
    return false;
  }

  // When requires_openai_auth = false without Authorization header, allow loopback connections
  const remote = request.socket?.remoteAddress;
  const isLoopback = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1" || !remote;
  if (settings.host === "127.0.0.1" && isLoopback) return true;
  return false;
}

function upstreamHeaders(settings, contentType = "application/json") {
  return { authorization: "Bearer " + settings.apiKey, "content-type": contentType };
}

export function resolveTargetModel(model) {
  if (GEMINI_PREFIX.test(model)) return { targetModel: model, protocol: "gemini" };
  if (CLAUDE_PREFIX.test(model)) return { targetModel: model, protocol: "claude" };
  if (MUSE_PREFIX.test(model) || model === "gpt-5.6-sol" || model === "gpt-5.6-luna" || model.endsWith("-sol") || model.endsWith("-luna") || model.endsWith("-responses")) {
    return { targetModel: model, protocol: "responses" };
  }
  return { targetModel: model, protocol: "chat" };
}

function customInput(value) {
  let raw = "";
  if (typeof value === "string") raw = value;
  else if (typeof value?.input === "string") raw = value.input;
  else if (typeof value?.command === "string") raw = value.command;
  else if (typeof value?.cmd === "string") raw = value.cmd;
  else if (typeof value?.patch === "string") return value.patch;
  else raw = typeof value === "object" && value !== null ? JSON.stringify(value) : String(value ?? "");

  raw = raw.trim();
  if (raw.startsWith("*** Begin Patch")) return raw;
  if (!raw) return "";

  // Auto-wrap bare shell commands / scripts into valid Codex V8 isolate JavaScript
  const isJs = raw.startsWith("await ") || raw.startsWith("tools.") || raw.startsWith("const ") || raw.startsWith("let ") || raw.startsWith("var ") || raw.startsWith("function ") || raw.startsWith("return ") || raw.startsWith("/*") || raw.startsWith("//") || raw.startsWith("try {");
  if (!isJs) {
    return `await tools.exec_command({ command: ${JSON.stringify(raw)} });`;
  }
  return raw;
}

function parseJsonSafe(value, fallback = {}) {
  if (typeof value === "object" && value !== null) return value;
  if (typeof value === "string") {
    try { return JSON.parse(value); } catch { return { raw: value }; }
  }
  return fallback;
}

function rememberCall(calls, callId, value) {
  calls.set(callId, { createdAt: Date.now(), ...value });
  while (calls.size > MAX_CACHED_CALLS) {
    const oldest = calls.keys().next().value;
    if (oldest === undefined) break;
    calls.delete(oldest);
  }
}

function dataImage(value) {
  if (typeof value !== "string") return null;
  const match = /^data:(image\/[A-Za-z0-9.+-]+);base64,([A-Za-z0-9+/=\r\n]+)$/.exec(value);
  if (!match) return null;
  return { kind: "base64", mimeType: match[1], data: match[2].replace(/[\r\n]/g, ""), url: value };
}

const INLINE_DATA_URL = /^data:([^;,]+)(?:;[^,]*)?;base64,([A-Za-z0-9+/=\r\n]+)$/i;
const LARGE_INLINE_TEXT = 100_000;

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

function attachmentFromPart(part) {
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

function safePartJson(part) {
  return JSON.stringify(part, (key, nested) => {
    if (typeof nested !== "string") return nested;
    if (looksLikeInlineBinary(nested)) return "[inline binary data omitted from text]";
    if (nested.length > LARGE_INLINE_TEXT && key !== "text") return "[oversized non-text data omitted]";
    return nested;
  });
}

function safeTextValue(value) {
  if (typeof value !== "string") return value;
  const attachment = inlineAttachment(value);
  if (attachment) return attachment.marker;
  return looksLikeInlineBinary(value) ? "[inline binary data omitted]" : value;
}

function imageFromPart(part) {
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

function outputParts(value) {
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

function responsesToolOutput(value) {
  const output = outputParts(value);
  if (output.images.length === 0 && output.files.length === 0) return typeof value === "string" && !looksLikeInlineBinary(value) ? value : output.responseText;
  return [
    ...(output.responseText ? [{ type: "input_text", text: output.responseText }] : []),
    ...output.images.map((image) => ({ type: "input_image", image_url: image.url })),
    ...output.files,
  ];
}

function geminiOutputParts(value, name, callId) {
  const output = outputParts(value);
  const functionResponse = {
    name,
    response: { result: output.text },
    ...(callId ? { id: callId } : {}),
  };
  return [
    { functionResponse },
    ...output.images.map(geminiImagePart),
    ...output.files.map(geminiFilePart).filter(Boolean),
  ];
}

function geminiImagePart(image) {
  return image.kind === "url"
    ? { text: `[image: ${image.url}]` }
    : { inline_data: { mime_type: image.mimeType, data: image.data } };
}

function geminiFilePart(file) {
  if (!file || typeof file !== "object") return null;
  if (typeof file.file_data === "string") {
    const match = INLINE_DATA_URL.exec(file.file_data);
    if (match) {
      return {
        inline_data: {
          mime_type: match[1],
          data: match[2].replace(/[\r\n]/g, ""),
        },
      };
    }
  }
  return null;
}

function claudeImagePart(image) {
  return {
    type: "image",
    source: image.kind === "url"
      ? { type: "url", url: image.url }
      : { type: "base64", media_type: image.mimeType, data: image.data },
  };
}

function claudeFilePart(file) {
  if (!file || typeof file !== "object" || typeof file.file_data !== "string") return null;
  const match = INLINE_DATA_URL.exec(file.file_data);
  if (!match || match[1].toLowerCase() !== "application/pdf") return null;
  return {
    type: "document",
    source: {
      type: "base64",
      media_type: match[1],
      data: match[2].replace(/[\r\n]/g, ""),
    },
    ...(typeof file.filename === "string" && file.filename ? { title: file.filename } : {}),
  };
}

function claudeToolResultContent(value) {
  const output = outputParts(value);
  const documents = output.files.map(claudeFilePart).filter(Boolean);
  if (output.images.length === 0 && documents.length === 0) return output.text;
  const safeText = output.responseText || (output.images.length ? "[image output attached]" : "");
  return [
    ...(safeText ? [{ type: "text", text: safeText }] : []),
    ...output.images.map(claudeImagePart),
    ...documents,
  ];
}

function geminiUsage(usage) {
  if (!usage || typeof usage !== "object") return undefined;
  const inputTokens = Number(usage.promptTokenCount || 0);
  const outputTokens = Number(usage.candidatesTokenCount || 0);
  const totalTokens = Number(usage.totalTokenCount || inputTokens + outputTokens);
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: totalTokens,
    input_tokens_details: { cached_tokens: Number(usage.cachedContentTokenCount || 0) },
    output_tokens_details: { reasoning_tokens: Number(usage.thoughtsTokenCount || 0) },
  };
}

export function buildClaudeMessages(input, calls) {
  const items = asArray(input);
  const hasOnlyToolResults = items.length > 0 && items.every((i) => i && (i.type === "function_call_output" || i.type === "custom_tool_call_output"));
  const firstCallId = hasOnlyToolResults ? items[0].call_id : null;
  const knownFirst = firstCallId ? calls?.get(firstCallId) : null;

  if (hasOnlyToolResults && knownFirst?.claudeMessages) {
    const messages = structuredClone(knownFirst.claudeMessages);
    const assistantContent = [];
    const seenCallIds = new Set();
    for (const item of items) {
      const callId = item.call_id || firstCallId;
      if (!callId || seenCallIds.has(callId)) continue;
      const known = calls?.get(callId);
      if (known?.toolUseBlock) {
        assistantContent.push(structuredClone(known.toolUseBlock));
      } else {
        assistantContent.push({
          type: "tool_use",
          id: callId,
          name: known?.name || item.name || "tool",
          input: known?.arguments || {},
        });
      }
      seenCallIds.add(callId);
    }
    messages.push({ role: "assistant", content: assistantContent });
    messages.push({
      role: "user",
      content: items.map((item) => ({
        type: "tool_result",
        tool_use_id: item.call_id || firstCallId,
        content: claudeToolResultContent(item.output),
      })),
    });
    return messages;
  }

  const messages = [];
  let currentRole = null;
  let currentContent = [];

  function flush() {
    if (currentRole && currentContent.length > 0) {
      messages.push({
        role: currentRole,
        content: currentContent.length === 1 && typeof currentContent[0] === "string"
          ? currentContent[0]
          : currentContent,
      });
      currentRole = null;
      currentContent = [];
    }
  }

  for (const item of items) {
    if (!item) continue;
    if (typeof item === "string") {
      if (currentRole && currentRole !== "user") flush();
      currentRole = "user";
      currentContent.push({ type: "text", text: safeTextValue(item) });
      continue;
    }
    if (typeof item !== "object") continue;
    if (item.type && KNOWN_METADATA_TYPES.has(item.type)) continue;

    if (item.type === "message" || item.role) {
      const role = item.role === "assistant" ? "assistant" : "user";
      if (currentRole && currentRole !== role) flush();
      currentRole = role;
      const rawParts = Array.isArray(item.content) ? item.content : [item.content];
      for (const part of rawParts) {
        if (!part) continue;
        if (typeof part === "string") {
          currentContent.push({ type: "text", text: safeTextValue(part) });
        } else if (part.type === "input_text" || part.type === "output_text" || part.type === "text") {
          if (part.text) currentContent.push({ type: "text", text: safeTextValue(part.text) });
        } else {
          const image = imageFromPart(part);
          if (image) {
            currentContent.push(claudeImagePart(image));
          } else {
            const attachment = attachmentFromPart(part);
            if (attachment) {
              const document = claudeFilePart(attachment.native);
              currentContent.push(document || { type: "text", text: attachment.marker });
            }
          }
        }
      }
      continue;
    }

    if (item.type === "function_call" || item.type === "custom_tool_call") {
      if (currentRole && currentRole !== "assistant") flush();
      currentRole = "assistant";
      const known = calls?.get(item.call_id);
      const name = known?.name || item.name || "tool";
      const args = known?.arguments || parseJsonSafe(item.arguments || item.input);
      currentContent.push({
        type: "tool_use",
        id: item.call_id || ("call_" + randomUUID()),
        name,
        input: typeof args === "object" && args !== null ? args : { value: args },
      });
      continue;
    }

    if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
      if (currentRole && currentRole !== "user") flush();
      currentRole = "user";
      currentContent.push({
        type: "tool_result",
        tool_use_id: item.call_id || "call_unknown",
        content: claudeToolResultContent(item.output),
      });
      continue;
    }
  }

  flush();
  return messages.length ? messages : [{ role: "user", content: "Continue." }];
}

export function buildGeminiContents(input, calls) {
  const items = asArray(input);
  const historyCalls = new Map();
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    if (item.type !== "function_call" && item.type !== "custom_tool_call") continue;
    if (!item.call_id) continue;
    const known = calls?.get(item.call_id);
    historyCalls.set(item.call_id, {
      name: known?.name || item.name || "tool",
      arguments: known?.arguments || parseJsonSafe(item.arguments || item.input),
      geminiFunctionCallPart: known?.geminiFunctionCallPart,
    });
  }
  const lookupCall = (callId) => calls?.get(callId) || historyCalls.get(callId);
  const hasOnlyToolResults = items.length > 0 && items.every((i) => i && (i.type === "function_call_output" || i.type === "custom_tool_call_output"));
  const replayBase = hasOnlyToolResults
    ? items.map((item) => lookupCall(item.call_id)).find((known) => known?.geminiContents)
    : null;
  if (replayBase) {
    const contents = structuredClone(replayBase.geminiContents);
    const callParts = [];
    const responseParts = [];
    const emittedCallIds = new Set();
    for (const item of items) {
      const known = lookupCall(item.call_id);
      if (!known && !item.name) {
        const output = outputParts(item.output);
        responseParts.push(
          { text: `[tool result without matching function call: ${item.call_id || "call_unknown"}]\n${output.text}` },
          ...output.images.map(geminiImagePart),
        );
        continue;
      }
      const callId = item.call_id;
      const name = known?.name || item.name || "tool";
      if (!emittedCallIds.has(callId)) {
        const callPart = known?.geminiFunctionCallPart
          ? structuredClone(known.geminiFunctionCallPart)
          : { functionCall: { name, args: known?.arguments || {} } };
        if (callPart.functionCall && callId) callPart.functionCall.id = callId;
        callParts.push(callPart);
        emittedCallIds.add(callId);
      }
      responseParts.push(...geminiOutputParts(item.output, name, callId));
    }
    if (callParts.length > 0) contents.push({ role: "model", parts: callParts });
    if (responseParts.length > 0) contents.push({ role: "user", parts: responseParts });
    return contents;
  }

  const contents = [];
  let currentRole = null;
  let currentParts = [];

  function flush() {
    if (currentRole && currentParts.length > 0) {
      contents.push({ role: currentRole, parts: currentParts });
      currentRole = null;
      currentParts = [];
    }
  }

  for (const item of items) {
    if (!item) continue;
    if (typeof item === "string") {
      if (currentRole && currentRole !== "user") flush();
      currentRole = "user";
      currentParts.push({ text: safeTextValue(item) });
      continue;
    }
    if (typeof item !== "object") continue;
    if (item.type && KNOWN_METADATA_TYPES.has(item.type)) continue;

    if (item.type === "message" || item.role) {
      const role = item.role === "assistant" ? "model" : "user";
      if (currentRole && currentRole !== role) flush();
      currentRole = role;
      const rawParts = Array.isArray(item.content) ? item.content : [item.content];
      for (const part of rawParts) {
        if (!part) continue;
        if (typeof part === "string") {
          currentParts.push({ text: safeTextValue(part) });
        } else if (part.type === "input_text" || part.type === "output_text" || part.type === "text") {
          if (part.text) currentParts.push({ text: safeTextValue(part.text) });
        } else {
          const image = imageFromPart(part);
          if (image) currentParts.push(geminiImagePart(image));
          else {
            const attachment = attachmentFromPart(part);
            if (attachment) {
              const nativePart = geminiFilePart(attachment.native);
              currentParts.push(nativePart || { text: attachment.marker });
            }
          }
        }
      }
      continue;
    }

    if (item.type === "function_call" || item.type === "custom_tool_call") {
      if (currentRole && currentRole !== "model") flush();
      currentRole = "model";
      const known = lookupCall(item.call_id);
      if (known?.geminiFunctionCallPart) {
        currentParts.push(structuredClone(known.geminiFunctionCallPart));
      } else {
        const name = known?.name || item.name || "tool";
        const args = known?.arguments || parseJsonSafe(item.arguments || item.input);
        currentParts.push({
          functionCall: {
            name,
            args: typeof args === "object" && args !== null ? args : { value: args },
            ...(item.call_id ? { id: item.call_id } : {}),
          },
        });
      }
      continue;
    }

    if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
      if (currentRole && currentRole !== "user") flush();
      currentRole = "user";
      const known = lookupCall(item.call_id);
      if (!known && !item.name) {
        const output = outputParts(item.output);
        currentParts.push(
          { text: `[tool result without matching function call: ${item.call_id || "call_unknown"}]\n${output.text}` },
          ...output.images.map(geminiImagePart),
        );
        continue;
      }
      const name = known?.name || item.name || "tool";
      currentParts.push(...geminiOutputParts(item.output, name, item.call_id));
      continue;
    }
  }

  flush();
  return contents.length ? contents : [{ role: "user", parts: [{ text: "Continue." }] }];
}

function geminiRequest(request, model, calls) {
  const functions = extractFunctions(request);
  const contents = buildGeminiContents(request.input, calls);
  const body = { contents };
  if (request.instructions) body.systemInstruction = { parts: [{ text: safeTextValue(String(request.instructions)) }] };
  if (functions.length) body.tools = [{ functionDeclarations: functions.map(({ name, description, parameters }) => ({ name, description, parameters })) }];
  const rawEffort = request.reasoning_effort || request.model_reasoning_effort || request.reasoning?.effort;
  if (rawEffort) {
    const level = GEMINI_REASONING_MAP[String(rawEffort).toLowerCase()];
    if (level) {
      body.generationConfig = {
        ...(body.generationConfig || {}),
        thinkingConfig: { thinkingLevel: level },
      };
    }
  }
  return { body, functions };
}

function claudeRequest(request, model, calls) {
  const functions = extractFunctions(request);
  const messages = buildClaudeMessages(request.input, calls);
  const rawEffort = String(request.reasoning_effort || request.model_reasoning_effort || request.reasoning?.effort || "").toLowerCase();
  const isThinkingModel = model.includes("-thinking") || Boolean(rawEffort);
  const budget = CLAUDE_REASONING_BUDGETS[rawEffort] || 4048;
  const maxTokens = Math.max(8192, budget + 8192);

  return {
    body: {
      model,
      max_tokens: maxTokens,
      stream: true,
      ...(request.instructions ? { system: safeTextValue(String(request.instructions)) } : {}),
      messages,
      ...(functions.length ? { tools: functions.map(({ name, description, parameters }) => ({ name, description, input_schema: parameters })) } : {}),
      ...(isThinkingModel ? { thinking: { type: "enabled", budget_tokens: budget } } : {}),
    },
    functions,
  };
}

function writeSse(response, chunks) {
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "x-accel-buffering": "no" });
  for (const chunk of chunks) response.write(chunk);
  response.end();
}

async function* streamSseLines(body) {
  if (!body) return;
  if (typeof body === "string") {
    for (const data of parseSse(body)) yield data;
    return;
  }
  let buffer = "";
  for await (const chunk of body) {
    buffer += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = blocks.pop() || "";
    for (const block of blocks) {
      const dataLine = block.split(/\r?\n/).find((l) => l.startsWith("data:"));
      if (!dataLine) continue;
      const jsonStr = dataLine.slice(5).trim();
      if (!jsonStr || jsonStr === "[DONE]") continue;
      try { yield JSON.parse(jsonStr); } catch {}
    }
  }
  if (buffer.trim()) {
    const dataLine = buffer.split(/\r?\n/).find((l) => l.startsWith("data:"));
    if (dataLine) {
      const jsonStr = dataLine.slice(5).trim();
      if (jsonStr && jsonStr !== "[DONE]") {
        try { yield JSON.parse(jsonStr); } catch {}
      }
    }
  }
}

function initSseResponse(response) {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    "connection": "keep-alive",
    "x-accel-buffering": "no"
  });
}

export function normalizeResponsesPayload(payload) {
  const normalized = { ...payload };
  const rawInput = Array.isArray(normalized.input) ? normalized.input : [];
  const cleanInput = [];
  const loadedToolSpecs = [];

  if (Array.isArray(payload.tools)) {
    loadedToolSpecs.push(...payload.tools);
  }

  for (const item of rawInput) {
    if (!item) continue;
    if (typeof item === "string") {
      cleanInput.push({
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: safeTextValue(item) }],
      });
      continue;
    }
    if (typeof item !== "object") continue;

    if (item.type === "additional_tools") {
      if (Array.isArray(item.tools)) {
        loadedToolSpecs.push(...item.tools);
      }
      cleanInput.push(item);
      continue;
    }

    if (item.type === "reasoning") {
      cleanInput.push({
        type: "reasoning",
        ...(item.id ? { id: item.id } : {}),
        summary: Array.isArray(item.summary) ? item.summary : [],
        content: [],
      });
      continue;
    }

    if (item.type && KNOWN_METADATA_TYPES.has(item.type)) continue;

    if (item.type === "input_text") {
      cleanInput.push({
        type: "message",
        role: "user",
        content: [{ ...item, text: safeTextValue(item.text) }],
      });
      continue;
    }

    if (item.type === "function_call_output") {
      cleanInput.push({
        type: "function_call_output",
        call_id: item.call_id || "call_unknown",
        output: responsesToolOutput(item.output),
      });
      continue;
    }

    if (item.type === "custom_tool_call_output") {
      cleanInput.push({
        type: "custom_tool_call_output",
        call_id: item.call_id || "call_unknown",
        output: responsesToolOutput(item.output),
      });
      continue;
    }

    if (item.type === "function_call") {
      cleanInput.push({
        type: "function_call",
        call_id: item.call_id || "call_unknown",
        name: item.name || "unknown",
        arguments: typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments ?? {}),
      });
      continue;
    }

    if (item.type === "custom_tool_call") {
      cleanInput.push({
        type: "custom_tool_call",
        call_id: item.call_id || "call_unknown",
        name: item.name || "unknown",
        input: typeof item.input === "string" ? item.input : JSON.stringify(item.input ?? ""),
      });
      continue;
    }

    const role = item.role || (item.type === "message" ? "user" : null);
    if (role) {
      let content = [];
      if (typeof item.content === "string") {
        const contentType = role === "assistant" ? "output_text" : "input_text";
        content = [{ type: contentType, text: safeTextValue(item.content) }];
      } else if (Array.isArray(item.content)) {
        for (const part of item.content) {
          if (!part) continue;
          if (typeof part === "string") {
            const contentType = role === "assistant" ? "output_text" : "input_text";
            content.push({ type: contentType, text: safeTextValue(part) });
          } else if (typeof part === "object") {
            if (ALLOWED_CONTENT_TYPES.has(part.type)) {
              if ((part.type === "input_text" || part.type === "output_text") && typeof part.text === "string") {
                content.push({ ...part, text: safeTextValue(part.text) });
              } else {
                content.push(part);
              }
            } else if (part.text && !part.type) {
              const contentType = role === "assistant" ? "output_text" : "input_text";
              content.push({ type: contentType, text: part.text });
            }
          }
        }
      }

      if (content.length === 0 && role === "assistant") {
        content = [{ type: "output_text", text: "" }];
      }

      if (content.length > 0) {
        cleanInput.push({
          type: "message",
          role,
          content,
        });
      }
      continue;
    }
  }

  normalized.input = cleanInput;

  // Build tools conforming strictly to OpenCodex buildTools
  if (loadedToolSpecs.length > 0) {
    const builtTools = [];
    const seenNames = new Set();

    const pushFn = (t) => {
      const name = t.name || t.function?.name;
      if (!name || seenNames.has(name)) return;
      seenNames.add(name);
      builtTools.push({
        type: "function",
        name,
        description: t.description || t.function?.description || "",
        parameters: t.parameters || t.function?.parameters || { type: "object", properties: {} },
        ...(t.strict !== undefined ? { strict: t.strict } : {}),
      });
    };

    const pushCustom = (t) => {
      const name = t.name;
      if (!name || seenNames.has(name)) return;
      seenNames.add(name);
      const inputDescription = name === "exec"
        ? "JavaScript source for unified exec. Use await tools.exec_command(...) for shell commands and text(...) to return textual output; do not provide a bare shell command."
        : (name === "apply_patch"
          ? "Raw tool input. For apply_patch, begin exactly with `*** Begin Patch` (no trailing `***`), then use its standard patch envelope."
          : "Raw freeform input for this tool.");
      builtTools.push({
        type: "function",
        name,
        description: t.description || "",
        parameters: {
          type: "object",
          properties: {
            input: {
              type: "string",
              description: inputDescription,
            },
          },
          required: ["input"],
        },
      });
    };

    for (const t of loadedToolSpecs) {
      if (!t || typeof t !== "object") continue;
      if (t.type === "namespace" && Array.isArray(t.tools)) {
        for (const inner of t.tools) {
          if (!inner || typeof inner !== "object") continue;
          if (inner.type === "custom") pushCustom(inner);
          else pushFn(inner);
        }
        continue;
      }
      if (t.type === "custom") {
        pushCustom(t);
        continue;
      }
      pushFn(t);
    }
    normalized.tools = builtTools;
  } else {
    delete normalized.tools;
  }

  if (normalized.tools && normalized.tools.length > 0) {
    normalized.tool_choice = normalized.tool_choice || "auto";
  }

  const rawEffort = normalized.reasoning_effort || normalized.model_reasoning_effort || normalized.reasoning?.effort;
  if (rawEffort) {
    let effort = String(rawEffort).toLowerCase();
    if (effort === "ultra") effort = "xhigh";
    normalized.reasoning = { effort };
    delete normalized.reasoning_effort;
    delete normalized.model_reasoning_effort;
  }
  return normalized;
}

export function buildOpenAIChatMessages(input, instructions) {
  const messages = [];
  if (instructions && String(instructions).trim().length > 0) {
    messages.push({ role: "system", content: safeTextValue(String(instructions).trim()) });
  }

  const items = asArray(input);
  let pendingToolCalls = [];
  let seenCallIds = new Set();
  let mintedIdSeq = 0;

  const mintId = () => {
    let id = "";
    do {
      id = `call_minted_${++mintedIdSeq}`;
    } while (seenCallIds.has(id));
    seenCallIds.add(id);
    return id;
  };

  const flushPendingToolCalls = () => {
    if (pendingToolCalls.length === 0) return;
    for (const call of pendingToolCalls) {
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: `[codex-bridge] tool execution recorded for "${call.name}".`,
      });
    }
    pendingToolCalls = [];
  };

  for (const item of items) {
    if (!item) continue;
    if (typeof item === "string") {
      flushPendingToolCalls();
      messages.push({ role: "user", content: safeTextValue(item) });
      continue;
    }
    if (typeof item !== "object") continue;

    if (item.type === "agent_message" && Array.isArray(item.content)) {
      const textParts = item.content
        .filter((c) => c && (c.type === "input_text" || c.type === "text") && typeof c.text === "string")
        .map((c) => safeTextValue(c.text));
      if (textParts.length > 0) {
        flushPendingToolCalls();
        messages.push({ role: "user", content: textParts.join("\n\n") });
      }
      continue;
    }

    if (item.type && KNOWN_METADATA_TYPES.has(item.type)) continue;

    if (item.type === "message" || item.role) {
      const role = item.role === "assistant" ? "assistant" : (item.role === "developer" || item.role === "system" ? "system" : "user");
      const output = outputParts(item.content);
      const textContent = output.text;
      if (role === "assistant") {
        flushPendingToolCalls();
        messages.push({ role: "assistant", content: textContent });
      } else if (role === "system") {
        messages.push({ role: "system", content: textContent });
      } else {
        flushPendingToolCalls();
        messages.push({
          role: "user",
          content: output.images.length > 0
            ? [
              ...(textContent ? [{ type: "text", text: textContent }] : []),
              ...output.images.map((image) => ({ type: "image_url", image_url: { url: image.url } })),
            ]
            : (textContent || "Continue."),
        });
      }
      continue;
    }

    if (item.type === "function_call" || item.type === "custom_tool_call") {
      const callId = item.call_id || mintId();
      seenCallIds.add(callId);
      const name = item.name || "tool";
      let argsStr = "{}";
      if (item.type === "custom_tool_call") {
        argsStr = JSON.stringify({ input: typeof item.input === "string" ? item.input : JSON.stringify(item.input || "") });
      } else {
        argsStr = typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments || {});
      }

      const toolCallObj = {
        id: callId,
        type: "function",
        function: { name, arguments: argsStr },
      };
      const lastMsg = messages[messages.length - 1];
      if (lastMsg && lastMsg.role === "assistant") {
        lastMsg.tool_calls = lastMsg.tool_calls || [];
        lastMsg.tool_calls.push(toolCallObj);
      } else {
        messages.push({
          role: "assistant",
          content: "",
          tool_calls: [toolCallObj],
        });
      }
      pendingToolCalls.push({ id: callId, name });
      continue;
    }

    if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
      const callId = item.call_id || "call_unknown";
      const output = outputParts(item.output);
      const textOutput = output.text;
      const matchIdx = pendingToolCalls.findIndex((c) => c.id === callId);
      if (matchIdx >= 0) {
        pendingToolCalls.splice(matchIdx, 1);
      } else {
        const hasMatchingToolCall = messages.some((m) => m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.some((tc) => tc.id === callId));
        if (!hasMatchingToolCall) {
          messages.push({
            role: "assistant",
            content: "",
            tool_calls: [{ id: callId, type: "function", function: { name: "tool", arguments: "{}" } }],
          });
        }
      }
      messages.push({
        role: "tool",
        tool_call_id: callId,
        content: textOutput,
      });
      if (output.images.length > 0) {
        messages.push({
          role: "user",
          content: [
            { type: "text", text: `[image output from tool ${callId}]` },
            ...output.images.map((image) => ({ type: "image_url", image_url: { url: image.url } })),
          ],
        });
      }
      continue;
    }
  }

  flushPendingToolCalls();
  return messages.length > 0 ? messages : [{ role: "user", content: "Continue." }];
}

export async function bridgeChatCompletionsToResponses(response, settings, payload, fetchImpl, signal) {
  const functions = extractFunctions(payload);
  const messages = buildOpenAIChatMessages(payload.input || [], payload.instructions);
  
  const chatBody = {
    model: payload.model,
    messages,
    stream: true,
  };

  if (functions.length > 0) {
    chatBody.tools = functions.map((f) => ({
      type: "function",
      function: {
        name: f.name,
        description: f.description,
        parameters: f.parameters,
      },
    }));
    chatBody.tool_choice = payload.tool_choice || "auto";
  }

  const rawEffort = payload.reasoning_effort || payload.model_reasoning_effort || payload.reasoning?.effort;
  if (rawEffort) {
    chatBody.reasoning_effort = String(rawEffort).toLowerCase();
  }

  const upstream = await fetchImpl(settings.endpoint + "/v1/chat/completions", {
    method: "POST",
    headers: upstreamHeaders(settings),
    body: JSON.stringify(chatBody),
    signal,
  });

  if (!upstream.ok) {
    const errText = await upstream.text();
    let errMessage = errText;
    try {
      const parsed = JSON.parse(errText);
      errMessage = parsed.error?.message || parsed.message || errText;
    } catch {}
    initSseResponse(response);
    const respId = "resp_err_" + randomUUID();
    response.write(responseCreated(payload.model, respId).data);
    for (const ev of textEvents(respId, 0, "\n\n[MOMO API Error " + upstream.status + "]: " + errMessage)) {
      response.write(ev);
    }
    response.write(sseError(errMessage, "http_" + upstream.status));
    response.write(completed(respId, payload.model, []));
    return response.end();
  }

  initSseResponse(response);
  const emitter = new ResponseStreamEmitter(response, payload.model);
  emitter.start();

  let fullAccumulatedText = "";
  const toolCallsByIndex = new Map();

  for await (const data of streamSseLines(upstream.body || (await upstream.text()))) {
    const choice = data.choices?.[0];
    if (!choice) continue;

    const deltaContent = choice.delta?.content;
    if (deltaContent) {
      fullAccumulatedText += deltaContent;
      if (!fullAccumulatedText.includes("<｜｜DSML｜｜") && !fullAccumulatedText.includes("<||DSML||") && !fullAccumulatedText.includes("<tool_calls>") && !fullAccumulatedText.includes("<invoke ")) {
        emitter.writeTextDelta(deltaContent);
      }
    }

    if (Array.isArray(choice.delta?.tool_calls)) {
      for (const tc of choice.delta.tool_calls) {
        const idx = tc.index ?? 0;
        let existing = toolCallsByIndex.get(idx);
        if (!existing) {
          existing = { id: tc.id || ("call_" + randomUUID()), name: "", arguments: "" };
          toolCallsByIndex.set(idx, existing);
        }
        if (tc.id) existing.id = tc.id;
        if (tc.function?.name) existing.name += tc.function.name;
        if (tc.function?.arguments) existing.arguments += tc.function.arguments;
      }
    }
  }

  const hasDsml = fullAccumulatedText.includes("<｜｜DSML｜｜") || fullAccumulatedText.includes("<||DSML||") || fullAccumulatedText.includes("<tool_calls>") || fullAccumulatedText.includes("<invoke ");
  if (hasDsml) {
    const dsmlCalls = parseDsmlCalls(fullAccumulatedText);
    const cleanText = stripDsmlMarkup(fullAccumulatedText).trim();
    if (cleanText) {
      emitter.writeTextDelta(cleanText);
    }
    for (const call of dsmlCalls) {
      const mapped = restoreToolName(call.name, functions);
      if (mapped.kind === "custom") {
        emitter.writeCustomToolCall({ name: mapped.originalName, input: customInput(call.arguments) });
      } else {
        emitter.writeFunctionCall({ name: mapped.originalName, arguments: call.arguments || {} });
      }
    }
  }

  if (toolCallsByIndex.size > 0) {
    for (const [, call] of toolCallsByIndex.entries()) {
      const mapped = restoreToolName(call.name, functions);
      let parsedArgs = {};
      try {
        parsedArgs = JSON.parse(call.arguments);
      } catch {
        parsedArgs = call.arguments;
      }

      if (mapped.kind === "custom") {
        const inputVal = typeof parsedArgs === "object" && parsedArgs !== null && typeof parsedArgs.input === "string"
          ? parsedArgs.input
          : customInput(parsedArgs);
        emitter.writeCustomToolCall({ callId: call.id, name: mapped.originalName, input: inputVal });
      } else {
        emitter.writeFunctionCall({ callId: call.id, name: mapped.originalName, arguments: parsedArgs });
      }
    }
  }

  emitter.complete();
}

async function forwardResponses(request, response, settings, payload, fetchImpl, signal) {
  // 1. Lower tool_search to standard function
  const { body: searchBody, names: searchNames } = rewriteRoutedToolSearchForUpstream(payload);
  // 2. Lower custom tools (exec, etc.) to standard functions
  const { body: customBody, names: customNames } = rewriteRoutedCustomToolsForUpstream(searchBody);
  // 3. Lower namespace tools (e.g. personal:codex-canvas) to flat functions
  const { body: nsBody, aliases: nsAliases } = rewriteRoutedNamespaceToolsForUpstream(customBody);
  // 4. Normalize schema for upstream OpenAI Responses endpoint
  const cleanPayload = normalizeResponsesPayload(nsBody);
  const upstream = await fetchImpl(settings.endpoint + "/v1/responses", { method: "POST", headers: upstreamHeaders(settings), body: JSON.stringify({ ...cleanPayload, stream: true }), signal });
  if (!upstream.ok) {
    // Seamless fallback to /v1/chat/completions if upstream /v1/responses returns 400/404/500
    return bridgeChatCompletionsToResponses(response, settings, cleanPayload, fetchImpl, signal);
  }
  initSseResponse(response);
  if (!upstream.body) return response.end();

  const allCustomNames = new Set(["exec", "apply_patch", ...customNames, ...searchNames]);
  const customToolBlockRewrite = createRoutedCustomToolRestoreBlockRewrite(allCustomNames);
  const functions = extractFunctions(payload);
  let hasDsml = false;
  let fullAccumulatedText = "";
  let currentResponseId = "resp_" + randomUUID();
  let buffer = "";

  for await (const chunk of upstream.body) {
    const textChunk = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    buffer += textChunk;
    const blocks = buffer.split("\n\n");
    buffer = blocks.pop() || "";

    for (const block of blocks) {
      if (!block.trim()) continue;
      const lines = block.split("\n");
      const dataLine = lines.find((l) => l.trim().startsWith("data:"));
      let json = null;
      let rawJsonStr = null;
      if (dataLine) {
        rawJsonStr = dataLine.trim().slice(5).trim();
        const jsonStr = rawJsonStr;
        if (jsonStr && jsonStr !== "[DONE]") {
          try { json = JSON.parse(jsonStr); } catch {}
        }
      }

      if (json) {
        if (json.type === "response.created" && json.response?.id) {
          currentResponseId = json.response.id;
        }
        if (json.type === "response.output_text.delta" && typeof json.delta === "string") {
          fullAccumulatedText += json.delta;
          if (fullAccumulatedText.includes("<｜｜DSML｜｜") || fullAccumulatedText.includes("<||DSML||") || fullAccumulatedText.includes("<tool_calls>") || fullAccumulatedText.includes("<invoke ")) {
            hasDsml = true;
            continue;
          }
        }
        if (json.type === "response.completed" && hasDsml) {
          const dsmlCalls = parseDsmlCalls(fullAccumulatedText);
          const cleanText = stripDsmlMarkup(fullAccumulatedText).trim();
          const emitter = new ResponseStreamEmitter(response, cleanPayload.model, currentResponseId);
          if (cleanText) {
            emitter.writeTextDelta(cleanText);
            emitter.flushTextMessage();
          }
          for (const call of dsmlCalls) {
            const mapped = restoreToolName(call.name, functions);
            if (mapped.kind === "custom") {
              emitter.writeCustomToolCall({ name: mapped.originalName, input: customInput(call.arguments) });
            } else {
              emitter.writeFunctionCall({ name: mapped.originalName, arguments: call.arguments || {} });
            }
          }
          emitter.complete();
          return;
        }

        if (!hasDsml) {
          let transformedBlock = block;
          if (nsAliases && nsAliases.size > 0 && rawJsonStr) {
            const restoredJsonStr = restoreAllRoutedCallsInJson(rawJsonStr, nsAliases, null);
            if (restoredJsonStr !== rawJsonStr) {
              const rewrittenLines = lines.map((l) => l.trim().startsWith("data:") ? "data: " + restoredJsonStr : l);
              transformedBlock = rewrittenLines.join("\n");
            }
          }
          const outputBlocks = customToolBlockRewrite(transformedBlock);
          for (const outBlock of outputBlocks) {
            response.write(outBlock + "\n\n");
          }
          continue;
        }
      }

      if (!hasDsml) {
        const outputBlocks = customToolBlockRewrite(block);
        for (const outBlock of outputBlocks) {
          response.write(outBlock + "\n\n");
        }
      }
    }
  }
  if (buffer.trim() && !hasDsml) {
    const outputBlocks = customToolBlockRewrite(buffer);
    for (const outBlock of outputBlocks) {
      response.write(outBlock);
    }
  }
  response.end();
}

async function bridgeGemini(response, settings, payload, calls, fetchImpl, signal) {
  const { body, functions } = geminiRequest(payload, payload.model, calls);
  const endpoint = settings.endpoint + "/v1beta/models/" + encodeURIComponent(payload.model) + ":streamGenerateContent?alt=sse";
  const upstream = await fetchImpl(endpoint, { method: "POST", headers: upstreamHeaders(settings), body: JSON.stringify(body), signal });
  if (!upstream.ok) {
    const errText = await upstream.text();
    let errMessage = errText;
    try {
      const parsed = JSON.parse(errText);
      errMessage = parsed.error?.message || parsed.message || errText;
    } catch {}
    initSseResponse(response);
    const respId = "resp_err_" + randomUUID();
    response.write(responseCreated(payload.model, respId).data);
    for (const ev of textEvents(respId, 0, "\n\n[MOMO Gemini Error " + upstream.status + "]: " + errMessage)) {
      response.write(ev);
    }
    response.write(sseError(errMessage, "http_" + upstream.status));
    response.write(completed(respId, payload.model, []));
    return response.end();
  }
  initSseResponse(response);
  const emitter = new ResponseStreamEmitter(response, payload.model);
  emitter.start();
  let usage;

  for await (const data of streamSseLines(upstream.body || (await upstream.text()))) {
    const root = data?.response && typeof data.response === "object" ? data.response : data;
    if (root?.usageMetadata) usage = geminiUsage(root.usageMetadata);
    for (const part of root?.candidates?.[0]?.content?.parts || []) {
      if (part.text) {
        emitter.writeTextDelta(part.text);
      }
      if (part.functionCall) {
        const mapped = restoreToolName(part.functionCall.name, functions);
        const upstreamCallId = typeof part.functionCall.id === "string" && part.functionCall.id
          ? part.functionCall.id
          : undefined;
        const callId = upstreamCallId && !calls.has(upstreamCallId) ? upstreamCallId : undefined;
        const tool = mapped.kind === "custom"
          ? emitter.writeCustomToolCall({ callId, name: mapped.originalName, input: customInput(part.functionCall.args) })
          : emitter.writeFunctionCall({ callId, name: mapped.originalName, arguments: part.functionCall.args || {} });
        rememberCall(calls, tool.callId, {
          name: mapped.name,
          originalName: mapped.originalName,
          kind: mapped.kind,
          arguments: part.functionCall.args || {},
          geminiContents: body.contents,
          geminiFunctionCallPart: structuredClone(part),
        });
      }
    }
  }
  emitter.complete(usage);
}

async function bridgeClaude(response, settings, payload, calls, fetchImpl, signal) {
  const { body, functions } = claudeRequest(payload, payload.model, calls);
  const upstream = await fetchImpl(settings.endpoint + "/v1/messages", { method: "POST", headers: { ...upstreamHeaders(settings), "anthropic-version": "2023-06-01" }, body: JSON.stringify(body), signal });
  if (!upstream.ok) {
    const errText = await upstream.text();
    let errMessage = errText;
    try {
      const parsed = JSON.parse(errText);
      errMessage = parsed.error?.message || parsed.message || errText;
    } catch {}
    initSseResponse(response);
    const respId = "resp_err_" + randomUUID();
    response.write(responseCreated(payload.model, respId).data);
    for (const ev of textEvents(respId, 0, "\n\n[MOMO Claude Error " + upstream.status + "]: " + errMessage)) {
      response.write(ev);
    }
    response.write(sseError(errMessage, "http_" + upstream.status));
    response.write(completed(respId, payload.model, []));
    return response.end();
  }
  initSseResponse(response);
  const emitter = new ResponseStreamEmitter(response, payload.model);
  emitter.start();

  const toolBlocks = new Map();
  for await (const data of streamSseLines(upstream.body || (await upstream.text()))) {
    if (data.type === "content_block_delta" && data.delta?.type === "text_delta") {
      emitter.writeTextDelta(data.delta.text);
    }
    if (data.type === "content_block_start" && data.content_block?.type === "tool_use") {
      toolBlocks.set(data.index, { id: data.content_block.id, name: data.content_block.name, input: data.content_block.input || {}, partialJson: "" });
    }
    if (data.type === "content_block_delta" && data.delta?.type === "input_json_delta") {
      const block = toolBlocks.get(data.index);
      if (block) block.partialJson += data.delta.partial_json || "";
    }
    if (data.type === "content_block_stop" && toolBlocks.has(data.index)) {
      const block = toolBlocks.get(data.index);
      toolBlocks.delete(data.index);
      let argumentsValue = block.input;
      if (block.partialJson) {
        try { argumentsValue = JSON.parse(block.partialJson); } catch { argumentsValue = block.partialJson; }
      }
      const mapped = restoreToolName(block.name, functions);
      const tool = mapped.kind === "custom"
        ? emitter.writeCustomToolCall({ callId: block.id, name: mapped.originalName, input: customInput(argumentsValue) })
        : emitter.writeFunctionCall({ callId: block.id, name: mapped.originalName, arguments: argumentsValue });
      rememberCall(calls, tool.callId, {
        name: mapped.name,
        originalName: mapped.originalName,
        kind: mapped.kind,
        arguments: argumentsValue,
        claudeMessages: body.messages,
        toolUseBlock: { type: "tool_use", id: block.id, name: block.name, input: argumentsValue },
      });
    }
  }
  emitter.complete();
}

async function forwardChatCompletions(request, response, settings, payload, fetchImpl, signal) {
  const upstream = await fetchImpl(settings.endpoint + "/v1/chat/completions", {
    method: "POST",
    headers: upstreamHeaders(settings),
    body: JSON.stringify(payload),
    signal,
  });

  response.statusCode = upstream.status;
  for (const [key, val] of upstream.headers.entries()) {
    const lower = key.toLowerCase();
    if (lower !== "content-length" && lower !== "content-encoding" && lower !== "transfer-encoding" && lower !== "connection") {
      response.setHeader(key, val);
    }
  }

  if (upstream.body) {
    if (typeof upstream.body.getReader === "function") {
      const reader = upstream.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          response.write(value);
        }
      } finally {
        reader.releaseLock();
      }
    } else {
      for await (const chunk of upstream.body) {
        response.write(chunk);
      }
    }
  } else {
    const text = await upstream.text();
    response.write(text);
  }
  response.end();
}

export function createMomoSwitch(settings, { fetchImpl = fetch } = {}) {
  const calls = new Map();
  const activeSockets = new Set();
  const activeSseEmitters = new Set();
  const activeAbortControllers = new Set();
  let serverInstance = null;

  const server = createServer(async (request, response) => {
    const t0 = Date.now();
    let firstByteRecorded = false;

    // 记录 TTFB (首字节写入时间)
    const originalWrite = response.write.bind(response);
    const originalEnd = response.end.bind(response);

    response.write = function (...args) {
      if (!firstByteRecorded) {
        firstByteRecorded = true;
        recordTtfb(Date.now() - t0);
      }
      return originalWrite(...args);
    };

    response.end = function (...args) {
      if (!firstByteRecorded) {
        firstByteRecorded = true;
        recordTtfb(Date.now() - t0);
      }
      return originalEnd(...args);
    };

    const abortController = new AbortController();
    activeAbortControllers.add(abortController);
    response.on("finish", () => activeAbortControllers.delete(abortController));
    response.on("close", () => activeAbortControllers.delete(abortController));
    const remoteIp = request.socket?.remoteAddress || "";
    let requestedModel = null;
    let finalStatus = 200;
    let isSse = false;

    // 统计活跃请求
    metricsState.requestsTotal++;
    metricsState.activeRequests++;

    const mem = process.memoryUsage();
    if (mem.rss > metricsState.maxRssBytes) metricsState.maxRssBytes = mem.rss;

    const cleanupActive = () => {
      metricsState.activeRequests = Math.max(0, metricsState.activeRequests - 1);
      if (isSse) {
        metricsState.activeSse = Math.max(0, metricsState.activeSse - 1);
      }
    };

    let cleanupDone = false;
    const finishCleanup = (success) => {
      if (!cleanupDone) {
        cleanupDone = true;
        cleanupActive();
        if (success) metricsState.requestsSuccess++;
        else metricsState.requestsFailed++;
      }
    };

    response.on("finish", () => finishCleanup(response.statusCode < 400));
    response.on("close", () => {
      if (!response.writableEnded) {
        abortController.abort();
        finishCleanup(false);
      }
    });

    const rawUrl = request.url || "/";
    const pathname = rawUrl.split("?")[0].replace(/\/+$/, "") || "/";
    const isInternal = pathname.startsWith("/internal/");

    // 严禁对内部端点暴露公共 CORS headers
    if (!isInternal) {
      response.setHeader("Access-Control-Allow-Origin", "*");
      response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS, PUT, DELETE");
      response.setHeader("Access-Control-Allow-Headers", "*");

      if (request.method === "OPTIONS") {
        response.writeHead(204);
        return response.end();
      }
    } else if (request.method === "OPTIONS") {
      // 内部端点直接拒绝 OPTIONS 探测
      response.writeHead(403);
      return response.end();
    }

    try {
      const rawUrl = request.url || "/";
      const pathname = rawUrl.split("?")[0].replace(/\/+$/, "") || "/";

      // 1. healthz
      if (request.method === "GET" && (pathname === "/healthz" || pathname === "/health")) {
        if (metricsState.isDraining) {
          logRequest({ method: "GET", url: pathname, status: 503, elapsedMs: Date.now() - t0, ip: remoteIp });
          return json(response, 503, { ok: false, status: "draining", service: "momo-codex-bridge", version: getCurrentVersion() });
        }
        logRequest({ method: "GET", url: pathname, status: 200, elapsedMs: Date.now() - t0, ip: remoteIp });
        return json(response, 200, { ok: true, service: "momo-codex-bridge", version: getCurrentVersion(), host: settings.host, port: settings.port });
      }

      // 2. internal shutdown
      if (request.method === "POST" && pathname === "/internal/shutdown") {
        const isLocal = remoteIp === "127.0.0.1" || remoteIp === "::1" || remoteIp === "::ffff:127.0.0.1";
        const headerToken = request.headers["x-local-token"] || request.headers.authorization?.replace(/^Bearer\s+/i, "");
        if (!isLocal || (settings.localToken && headerToken !== settings.localToken)) {
          return json(response, 403, { error: "Forbidden: shutdown is restricted to authenticated loopback clients." });
        }

        if (metricsState.isDraining) {
          return json(response, 200, { ok: true, message: "Server already in draining state." });
        }

        metricsState.isDraining = true;
        json(response, 200, { ok: true, message: "Server draining initiated; terminating in up to 5s." });

        let shutdownFinished = false;
        const drainTimeoutMs = Number(settings.drainTimeoutMs || 5000);

        const finishShutdown = () => {
          if (shutdownFinished) return;
          shutdownFinished = true;

          // 终止尚未完成的上游 AbortController
          for (const ac of activeAbortControllers) {
            try { ac.abort(); } catch {}
          }
          activeAbortControllers.clear();

          // 规范格式未完结 SSE 写入 response.incomplete
          for (const emitter of activeSseEmitters) {
            try {
              emitter.response.write("event: response.incomplete\ndata: " + JSON.stringify({
                id: "resp_incomplete_" + Date.now(),
                object: "response",
                status: "incomplete",
                error: { message: "Server shutting down gracefully", type: "server_shutdown" }
              }) + "\n\n");
              emitter.response.end();
            } catch {}
          }
          activeSseEmitters.clear();

          if (serverInstance) {
            try { serverInstance.close(); } catch {}
          }

          for (const sock of activeSockets) {
            try { sock.destroy(); } catch {}
          }
          activeSockets.clear();

          if (process.env.NODE_ENV !== "test") {
            setTimeout(() => {
              try { process.exit(0); } catch {}
            }, 50);
          }
        };

        // 最长优雅等待截止时间
        const deadlineTimer = setTimeout(finishShutdown, drainTimeoutMs);
        if (deadlineTimer.unref) deadlineTimer.unref();

        return;
      }

      // 3. internal metrics
      if (request.method === "GET" && pathname === "/internal/metrics") {
        const isLocal = remoteIp === "127.0.0.1" || remoteIp === "::1" || remoteIp === "::ffff:127.0.0.1";
        const headerToken = request.headers["x-local-token"] || request.headers.authorization?.replace(/^Bearer\s+/i, "");
        if (!isLocal || (settings.localToken && headerToken !== settings.localToken)) {
          return json(response, 403, { error: "Forbidden: metrics are restricted to authenticated loopback clients." });
        }

        const curMem = process.memoryUsage();
        if (curMem.rss > metricsState.maxRssBytes) metricsState.maxRssBytes = curMem.rss;

        return json(response, 200, {
          ok: true,
          uptimeSeconds: Math.floor((Date.now() - metricsState.startedAt) / 1000),
          resetTime: metricsState.resetTime,
          isDraining: metricsState.isDraining,
          requests: {
            total: metricsState.requestsTotal,
            success: metricsState.requestsSuccess,
            failed: metricsState.requestsFailed,
            active: metricsState.activeRequests,
            activeSse: metricsState.activeSse,
          },
          ttfbMs: {
            p50: calculatePercentile(metricsState.ttfbHistory, 0.5),
            p95: calculatePercentile(metricsState.ttfbHistory, 0.95),
            p99: calculatePercentile(metricsState.ttfbHistory, 0.99),
            samples: metricsState.ttfbHistory.length,
          },
          memory: {
            rssBytes: curMem.rss,
            heapUsedBytes: curMem.heapUsed,
            heapTotalBytes: curMem.heapTotal,
            externalBytes: curMem.external,
            arrayBuffersBytes: curMem.arrayBuffers,
            maxRssBytes: metricsState.maxRssBytes,
          },
          features: {
            dnsCache: { supported: false },
            connectionPooling: { supported: true, backend: "node-native-fetch" },
          },
          version: getCurrentVersion(),
        });
      }

      // 4. draining 期间拒绝任何新业务请求
      if (metricsState.isDraining) {
        finalStatus = 503;
        logRequest({ method: request.method, url: pathname, status: 503, elapsedMs: Date.now() - t0, error: "Server is draining", ip: remoteIp });
        return json(response, 503, { error: { message: "Server is draining for shutdown, please retry later.", type: "server_draining" } }, { "Retry-After": "5" });
      }

      // 5. 鉴权校验
      if (!authorized(request, settings)) {
        finalStatus = 401;
        logRequest({ method: request.method, url: pathname, status: 401, elapsedMs: Date.now() - t0, error: "Unauthorized", ip: remoteIp });
        return json(response, 401, { error: { message: "Invalid local MOMO Switch token.", type: "authentication_error" } });
      }

      // 6. models
      if (request.method === "GET" && (pathname === "/v1/models" || pathname === "/models")) {
        const upstream = await fetchImpl(settings.endpoint + "/v1/models", { headers: upstreamHeaders(settings), signal: abortController.signal });
        finalStatus = upstream.status;
        logRequest({ method: "GET", url: pathname, status: finalStatus, elapsedMs: Date.now() - t0, ip: remoteIp });
        return json(response, upstream.status, await upstream.json());
      }

      // 7. chat completions
      if (request.method === "POST" && (pathname === "/v1/chat/completions" || pathname === "/chat/completions")) {
        const payload = await bodyOf(request, settings);
        requestedModel = payload.model;
        await forwardChatCompletions(request, response, settings, payload, fetchImpl, abortController.signal);
        logRequest({ method: "POST", url: pathname, model: requestedModel, status: response.statusCode || 200, elapsedMs: Date.now() - t0, ip: remoteIp });
        return;
      }

      // 8. responses
      if (request.method === "POST" && (pathname === "/v1/responses" || pathname === "/responses")) {
        const payload = await bodyOf(request, settings);
        requestedModel = payload.model;
        if (!payload.model) {
          finalStatus = 400;
          logRequest({ method: "POST", url: pathname, status: 400, elapsedMs: Date.now() - t0, error: "model is required", ip: remoteIp });
          return json(response, 400, { error: { message: "model is required", type: "invalid_request_error" } });
        }
        const { targetModel, protocol } = resolveTargetModel(payload.model);
        const routedPayload = { ...payload, model: targetModel };

        isSse = true;
        metricsState.activeSse++;
        const sseHandle = { response };
        activeSseEmitters.add(sseHandle);
        response.on("finish", () => activeSseEmitters.delete(sseHandle));
        response.on("close", () => activeSseEmitters.delete(sseHandle));

        let handlerPromise;
        if (protocol === "responses") handlerPromise = forwardResponses(request, response, settings, routedPayload, fetchImpl, abortController.signal);
        else if (protocol === "chat") handlerPromise = bridgeChatCompletionsToResponses(response, settings, routedPayload, fetchImpl, abortController.signal);
        else if (protocol === "gemini") handlerPromise = bridgeGemini(response, settings, routedPayload, calls, fetchImpl, abortController.signal);
        else handlerPromise = bridgeClaude(response, settings, routedPayload, calls, fetchImpl, abortController.signal);

        await handlerPromise;
        logRequest({ method: "POST", url: pathname, model: requestedModel, status: response.statusCode || 200, elapsedMs: Date.now() - t0, ip: remoteIp });
        return;
      }

      finalStatus = 404;
      logRequest({ method: request.method, url: pathname, status: 404, elapsedMs: Date.now() - t0, ip: remoteIp });
      return json(response, 404, { error: { message: "Not found", type: "invalid_request_error" } });
    } catch (error) {
      if (abortController.signal.aborted) return;
      const rawUrl = request.url || "/";
      const pathname = rawUrl.split("?")[0].replace(/\/+$/, "") || "/";

      if (error.statusCode === 413) {
        logRequest({ method: request.method, url: pathname, status: 413, elapsedMs: Date.now() - t0, error: error.message, ip: remoteIp });
        return json(response, 413, { error: { message: error.message, type: "payload_too_large", code: "payload_too_large" } });
      }

      if (error.statusCode === 400) {
        logRequest({ method: request.method, url: pathname, status: 400, elapsedMs: Date.now() - t0, error: error.message, ip: remoteIp });
        return json(response, 400, { error: { message: error.message, type: "invalid_request_error", code: "invalid_json" } });
      }

      logRequest({ method: request.method, url: pathname, model: requestedModel, status: 502, elapsedMs: Date.now() - t0, error: error.message, ip: remoteIp });
      if (pathname === "/v1/responses" || pathname === "/responses") {
        if (!response.headersSent) initSseResponse(response);
        const respId = "resp_err_" + randomUUID();
        response.write(responseCreated(requestedModel || "unknown", respId).data);
        for (const ev of textEvents(respId, 0, "\n\n[MOMO Proxy Error]: " + error.message)) {
          response.write(ev);
        }
        response.write(sseError(error.message));
        response.write(completed(respId, requestedModel || "unknown", []));
        return response.end();
      }
      return json(response, 502, { error: { message: error.message, type: "server_error" } });
    }
  });

  serverInstance = server;

  server.on("connection", (socket) => {
    activeSockets.add(socket);
    socket.on("close", () => activeSockets.delete(socket));
  });

  return server;
}

export const createMomoBridge = createMomoSwitch;

export async function listen(settings, options = {}) {
  const server = createMomoSwitch(settings, options);
  await new Promise((resolve, reject) => server.once("error", reject).listen(settings.port, settings.host, resolve));
  return server;
}
