import { randomUUID } from "node:crypto";
import { serializedBodyBytes } from "./context-policy.mjs";

const MIB = 1024 * 1024;
const INLINE_DATA_URL = /^data:([^;,]+)(?:;[^,]*)?;base64,[A-Za-z0-9+/=\r\n]+$/i;
const LARGE_INLINE_TEXT = 64 * 1024;
const MAX_COMPACT_LIMIT_BYTES = 64 * MIB;
const DEFAULT_RETAINED_USER_CHARS = 20_000 * 4;
const LOCAL_COMPACTION_PREFIX = "momo1:";
const MAX_LOCAL_COMPACTION_ENVELOPE_CHARS = 2 * MIB;

export const SUMMARY_PREFIX = "Another language model started to solve this problem and produced a summary of its thinking process. You also have access to the state of the tools that were used by that language model. Use this to build on the work that has already been done and avoid duplicating work. Here is the summary produced by the other language model, use the information in this summary to assist with your own analysis:";

export function encodeLocalCompaction(output) {
  return LOCAL_COMPACTION_PREFIX + Buffer.from(JSON.stringify(Array.isArray(output) ? output : []), "utf8").toString("base64");
}

export function decodeLocalCompaction(value) {
  if (typeof value !== "string" || !value.startsWith(LOCAL_COMPACTION_PREFIX)) return null;
  if (value.length > MAX_LOCAL_COMPACTION_ENVELOPE_CHARS) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value.slice(LOCAL_COMPACTION_PREFIX.length), "base64").toString("utf8"));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function configuredCompactLimit(settings = {}) {
  const raw = process.env.MOMO_COMPACT_BODY_LIMIT_MB ?? settings?.contextPolicy?.compactBodyLimitMb ?? 32;
  const mb = Number(raw);
  const valid = Number.isFinite(mb) && mb >= 18 && mb <= 64 ? mb : 32;
  return Math.min(Math.floor(valid * MIB), MAX_COMPACT_LIMIT_BYTES);
}

function clone(value) {
  return typeof structuredClone === "function"
    ? structuredClone(value)
    : JSON.parse(JSON.stringify(value));
}

function inlineMarker(value) {
  if (typeof value !== "string") return null;
  const match = INLINE_DATA_URL.exec(value);
  if (!match) return null;
  return match[1].toLowerCase().startsWith("image/")
    ? "[historical image omitted during compaction]"
    : "[historical inline attachment omitted during compaction]";
}

function trimText(value, maxChars, suffix) {
  if (typeof value !== "string" || value.length <= maxChars) return value;
  return value.slice(0, maxChars) + suffix;
}

function compactValue(value, { aggressive = false, depth = 0 } = {}) {
  if (depth > 64) return "[deep historical value omitted during compaction]";
  if (typeof value === "string") {
    const marker = inlineMarker(value);
    if (marker) return marker;
    const limit = aggressive ? 8_000 : LARGE_INLINE_TEXT;
    return trimText(value, limit, "\n[historical text truncated during compaction]");
  }
  if (Array.isArray(value)) return value.map((item) => compactValue(item, { aggressive, depth: depth + 1 }));
  if (!value || typeof value !== "object") return value;

  const out = {};
  for (const [key, nested] of Object.entries(value)) {
    // Provider-issued encrypted state is integrity-protected and must stay byte-identical.
    // If opaque state alone exceeds the compact ceiling, fall back to a local checkpoint
    // instead of corrupting it and sending a request the provider cannot validate.
    if (key === "encrypted_content") {
      out[key] = nested;
      continue;
    }
    if (typeof nested === "string" && (key === "data" || key === "file_data") && nested.length > LARGE_INLINE_TEXT) {
      out[key] = "[historical opaque data omitted during compaction]";
      continue;
    }
    out[key] = compactValue(nested, { aggressive, depth: depth + 1 });
  }
  return out;
}

function isUserItem(item) {
  return typeof item === "string" || (item && typeof item === "object" && (item.role === "user" || item.type === "input_text"));
}

function hasIntegrityProtectedOpaqueState(value, depth = 0) {
  if (depth > 64 || !value || typeof value !== "object") return false;
  if (typeof value.encrypted_content === "string" && value.encrypted_content.length > LARGE_INLINE_TEXT) return true;
  if (Array.isArray(value)) return value.some((item) => hasIntegrityProtectedOpaqueState(item, depth + 1));
  return Object.values(value).some((item) => hasIntegrityProtectedOpaqueState(item, depth + 1));
}

function currentTurnStart(input) {
  for (let index = input.length - 1; index >= 0; index--) {
    if (isUserItem(input[index])) return index;
  }
  return input.length;
}

function markerForHistoricalItem(item) {
  if (!item || typeof item !== "object") return { type: "message", role: "user", content: [{ type: "input_text", text: "[historical item omitted during compaction]" }] };
  if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
    return { ...item, output: "[historical tool output omitted during compaction]" };
  }
  if (item.type === "compaction" || item.type === "compaction_summary" || item.type === "context_compaction" || item.type === "reasoning") {
    return null;
  }
  if (item.type === "function_call") {
    return { ...item, arguments: "{}" };
  }
  if (item.type === "custom_tool_call") {
    return { ...item, input: "[historical tool input omitted during compaction]" };
  }
  return { type: "message", role: item.role === "assistant" ? "assistant" : "user", content: [{ type: item.role === "assistant" ? "output_text" : "input_text", text: "[historical message omitted during compaction]" }] };
}

/** Prepare a compact request without subjecting it to the normal 18 MiB outbound gate. */
export function prepareCompactPayload(payload, settings = {}) {
  const body = clone(payload && typeof payload === "object" ? payload : {});
  const input = Array.isArray(body.input) ? body.input : (body.input == null ? [] : [body.input]);
  const boundary = currentTurnStart(input);
  const rewritten = input
    .filter((item) => item?.type !== "compaction_trigger")
    .map((item, index) => index < boundary ? compactValue(item) : item);
  body.input = rewritten;
  delete body.stream;
  delete body.previous_response_id;

  const limitBytes = configuredCompactLimit(settings);
  let bytes = serializedBodyBytes(body);
  let markerizedItems = 0;
  if (bytes > limitBytes) {
    for (let index = 0; index < boundary && bytes > limitBytes; index++) {
      const marker = markerForHistoricalItem(body.input[index]);
      if (!marker) continue;
      body.input[index] = marker;
      markerizedItems += 1;
      if (markerizedItems % 8 === 0) bytes = serializedBodyBytes(body);
    }
    bytes = serializedBodyBytes(body);
  }
  if (bytes > limitBytes) {
    if (body.input.some((item) => hasIntegrityProtectedOpaqueState(item))) {
      const error = new Error(`Compact request contains integrity-protected opaque state and remains ${bytes} bytes, above the ${limitBytes}-byte compact limit.`);
      error.statusCode = 413;
      error.code = "compact_budget_exceeded";
      error.localCheckpointInput = body.input;
      throw error;
    }
    for (let index = Math.max(0, boundary); index < body.input.length && bytes > limitBytes; index++) {
      body.input[index] = compactValue(body.input[index], { aggressive: true });
      bytes = serializedBodyBytes(body);
    }
  }

  if (bytes > limitBytes) {
    const error = new Error(`Compact request remains ${bytes} bytes after safe history cleanup, above the ${limitBytes}-byte compact limit.`);
    error.statusCode = 413;
    error.code = "compact_budget_exceeded";
    error.details = { estimatedBytes: bytes, compactLimitBytes: limitBytes };
    error.localCheckpointInput = body.input;
    throw error;
  }
  return { payload: body, trace: { compactBytes: bytes, markerizedItems, policyAction: markerizedItems ? "compact_history_markerized" : "compact_history_sanitized" } };
}

/** Lightweight history rewrite for a normal Responses request that asks for server-side compaction. */
export function prepareContextManagedPayload(payload) {
  const body = clone(payload && typeof payload === "object" ? payload : {});
  const input = Array.isArray(body.input) ? body.input : (body.input == null ? [] : [body.input]);
  const boundary = currentTurnStart(input);
  body.input = input.map((item, index) => index < boundary ? compactValue(item) : item);
  return body;
}

function itemText(item) {
  if (typeof item === "string") return item;
  if (!item || typeof item !== "object") return "";
  if (typeof item.content === "string") return item.content;
  if (!Array.isArray(item.content)) return "";
  return item.content.map((part) => typeof part === "string" ? part : (typeof part?.text === "string" ? part.text : "")).join("");
}

export function extractCompactUserMessages(input) {
  if (!Array.isArray(input)) return [];
  return input.filter(isUserItem).map(itemText).filter((text) => text.trim().length > 0);
}

function compactMessage(text) {
  return { id: `msg_${randomUUID()}`, type: "message", role: "user", status: "completed", content: [{ type: "input_text", text }] };
}

function fixedCheckpoint(input) {
  const items = Array.isArray(input) ? input : [];
  const users = extractCompactUserMessages(items);
  const completed = items.filter((item) => item?.role === "assistant" || item?.type === "function_call" || item?.type === "custom_tool_call").length;
  const toolOutputs = items.filter((item) => item?.type === "function_call_output" || item?.type === "custom_tool_call_output").length;
  const latest = users.at(-1)?.trim().slice(-8_000) || "No user text was available.";
  return [
    "# MOMO proxy recovery checkpoint",
    "",
    `- Prior input items: ${items.length}`,
    `- Prior assistant/tool-call items: ${completed}`,
    `- Prior tool-output items: ${toolOutputs}`,
    "- Historical binary attachments and oversized tool outputs were intentionally omitted.",
    "- Resume from the latest user request below; ask for missing facts instead of inventing them.",
    "",
    "## Latest user request",
    latest,
  ].join("\n");
}

export function buildLocalCompactResponse(model, input) {
  const users = extractCompactUserMessages(input);
  const selected = [];
  let remaining = DEFAULT_RETAINED_USER_CHARS;
  for (let index = users.length - 1; index >= 0 && remaining > 0; index--) {
    const text = users[index];
    if (text.length <= remaining) { selected.push(text); remaining -= text.length; }
    else { selected.push(text.slice(text.length - remaining)); break; }
  }
  selected.reverse();
  const output = [
    ...selected.map(compactMessage),
    compactMessage(`${SUMMARY_PREFIX}\n${fixedCheckpoint(input)}`),
  ];
  return {
    id: `resp_compact_${randomUUID()}`,
    object: "response.compaction",
    created_at: Math.floor(Date.now() / 1000),
    model,
    output,
  };
}

export function compactLockKey(request, payload) {
  const header = request?.headers?.["x-codex-parent-thread-id"] || request?.headers?.["thread-id"] || request?.headers?.["session-id"] || request?.headers?.session_id;
  if (typeof header === "string" && header.trim()) return `header:${header.trim()}`;
  if (typeof payload?.previous_response_id === "string" && payload.previous_response_id) return `previous:${payload.previous_response_id}`;
  return null;
}
