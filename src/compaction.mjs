import { randomUUID } from "node:crypto";
import { serializedBodyBytes } from "./context-policy.mjs";
import { checkpointAttachmentReferences } from "./attachment-routing.mjs";

const MIB = 1024 * 1024;
const INLINE_DATA_URL = /^data:([^;,]+)(?:;[^,]*)?;base64,[A-Za-z0-9+/=\r\n]+$/i;
const LARGE_INLINE_TEXT = 64 * 1024;
const MAX_COMPACT_LIMIT_BYTES = 64 * MIB;
const LOCAL_COMPACTION_PREFIX = "momo1:";
const MAX_LOCAL_COMPACTION_ENVELOPE_CHARS = 2 * MIB;
const MAX_LOCAL_COMPACTION_JSON_BYTES = 1024 * 1024;
const GEMINI_RECENT_HISTORICAL_USERS = 6;
const GEMINI_HISTORICAL_USER_CHARS = 2_000;
const GEMINI_HISTORICAL_ASSISTANT_CHARS = 1_500;

export const SUMMARY_PREFIX = "Another language model started to solve this problem and produced a summary of its thinking process. You also have access to the state of the tools that were used by that language model. Use this to build on the work that has already been done and avoid duplicating work. Here is the summary produced by the other language model, use the information in this summary to assist with your own analysis:";

export function encodeLocalCompaction(output) {
  const serialized = JSON.stringify(Array.isArray(output) ? output : []);
  if (Buffer.byteLength(serialized, "utf8") > MAX_LOCAL_COMPACTION_JSON_BYTES) {
    const error = new Error("Local compaction envelope exceeded the 1 MiB safety limit.");
    error.code = "local_compaction_envelope_too_large";
    throw error;
  }
  return LOCAL_COMPACTION_PREFIX + Buffer.from(serialized, "utf8").toString("base64");
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

function configuredHistoryReplayLimit(settings = {}) {
  const policy = settings?.contextPolicy && typeof settings.contextPolicy === "object" ? settings.contextPolicy : {};
  const explicit = Number(settings?.maxHistoricalReplayBytes ?? policy.maxHistoricalReplayBytes);
  if (Number.isFinite(explicit) && explicit >= 64 * 1024 && explicit <= 8 * MIB) return Math.floor(explicit);
  const rawMb = process.env.MOMO_MAX_HISTORICAL_REPLAY_MB
    ?? settings?.maxHistoricalReplayMb
    ?? policy.maxHistoricalReplayMb;
  const mb = Number(rawMb);
  if (Number.isFinite(mb) && mb >= 0.0625 && mb <= 8) return Math.floor(mb * MIB);
  return null;
}

function configuredProviderSwitchReplayLimit(settings = {}) {
  const policy = settings?.contextPolicy && typeof settings.contextPolicy === "object" ? settings.contextPolicy : {};
  const explicit = Number(settings?.providerSwitchReplayBytes ?? policy.providerSwitchReplayBytes);
  if (Number.isFinite(explicit) && explicit >= 64 * 1024 && explicit <= 2 * MIB) return Math.floor(explicit);
  const rawMb = process.env.MOMO_PROVIDER_SWITCH_REPLAY_MB
    ?? settings?.providerSwitchReplayMb
    ?? policy.providerSwitchReplayMb;
  const mb = Number(rawMb);
  if (Number.isFinite(mb) && mb >= 0.0625 && mb <= 2) return Math.floor(mb * MIB);
  return configuredHistoryReplayLimit(settings);
}

export function prefersLocalCompaction(settings = {}) {
  const policy = settings?.contextPolicy && typeof settings.contextPolicy === "object" ? settings.contextPolicy : {};
  const mode = String(process.env.MOMO_COMPACTION_MODE ?? settings?.compactionMode ?? policy.compactionMode ?? "local").toLowerCase();
  return mode !== "upstream";
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

function trimMiddleText(value, maxChars, marker = "\n[historical text truncated during compaction]\n") {
  if (typeof value !== "string" || value.length <= maxChars) return value;
  const available = Math.max(0, maxChars - marker.length);
  const head = Math.ceil(available / 2);
  const tail = Math.floor(available / 2);
  return value.slice(0, head) + marker + value.slice(value.length - tail);
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
  // Request bodies are request-scoped. Mutate this one in place instead of cloning
  // tens of MiB of Base64 immediately before replacing the historical copies.
  const body = payload && typeof payload === "object" ? payload : {};
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
  const oversized = bytes > limitBytes;
  let trackedBytes = bytes;
  const replaceInput = (index, item) => {
    // Request-scoped JSON data: array slots serialize undefined/holes as null.
    // Only measure the replaced slot, not the rest of a multi-MiB request.
    const slotBytes = (value) => Buffer.byteLength(JSON.stringify(value) ?? "null", "utf8");
    if (index < body.input.length) {
      trackedBytes += slotBytes(item) - slotBytes(body.input[index]);
    } else {
      const gaps = index - body.input.length;
      trackedBytes += slotBytes(item) + gaps * 5 + (body.input.length ? 1 : 0);
    }
    body.input[index] = item;
  };
  let markerizedItems = 0;
  if (bytes > limitBytes) {
    for (let index = 0; index < boundary && bytes > limitBytes; index++) {
      const marker = markerForHistoricalItem(body.input[index]);
      if (!marker) continue;
      replaceInput(index, marker);
      markerizedItems += 1;
      // Preserve the legacy eight-marker checkpoint: stopping after each slot
      // would retain a different set of historical items near the boundary.
      if (markerizedItems % 8 === 0) bytes = trackedBytes;
    }
    bytes = trackedBytes;
  }
  if (bytes > limitBytes) {
    if (body.input.some((item) => hasIntegrityProtectedOpaqueState(item))) {
      bytes = serializedBodyBytes(body);
      const error = new Error(`Compact request contains integrity-protected opaque state and remains ${bytes} bytes, above the ${limitBytes}-byte compact limit.`);
      error.statusCode = 413;
      error.code = "compact_budget_exceeded";
      error.localCheckpointInput = body.input;
      throw error;
    }
    for (let index = Math.max(0, boundary); index < body.input.length && bytes > limitBytes; index++) {
      replaceInput(index, compactValue(body.input[index], { aggressive: true }));
      bytes = trackedBytes;
    }
  }

  // Final exact accounting remains the safety gate and trace source; no size
  // estimate can admit a request above the compact limit.
  if (oversized) bytes = serializedBodyBytes(body);

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
  const body = payload && typeof payload === "object" ? payload : {};
  const input = Array.isArray(body.input) ? body.input : (body.input == null ? [] : [body.input]);
  const boundary = currentTurnStart(input);
  body.input = input.map((item, index) => index < boundary ? compactValue(item) : item);
  return body;
}

function itemText(item) {
  if (typeof item === "string") return item;
  if (!item || typeof item !== "object") return "";
  if (item.type === "input_text" && typeof item.text === "string") return item.text;
  if (typeof item.content === "string") return item.content;
  if (!Array.isArray(item.content)) return "";
  return item.content.map((part) => typeof part === "string" ? part : (typeof part?.text === "string" ? part.text : "")).join("");
}

export function extractCompactUserMessages(input) {
  if (!Array.isArray(input)) return [];
  return input.filter(isUserItem).map(itemText).filter((text) => text.trim().length > 0);
}

function fixedCheckpoint(input, { currentTurnAuthoritative = false } = {}) {
  const items = Array.isArray(input) ? input : [];
  const completed = items.filter((item) => item?.role === "assistant" || item?.type === "function_call" || item?.type === "custom_tool_call").length;
  const toolOutputs = items.filter((item) => item?.type === "function_call_output" || item?.type === "custom_tool_call_output").length;
  return [
    "# MOMO proxy historical checkpoint",
    "",
    `- Prior input items: ${items.length}`,
    `- Prior assistant/tool-call items: ${completed}`,
    `- Prior tool-output items: ${toolOutputs}`,
    "- This block is historical context only. It does not define the active task.",
    "- The active task is the last real user message retained after this checkpoint.",
    "- Historical binary attachments and oversized tool outputs were intentionally omitted.",
    "- This lossy history index is not a user request or evidence that a tool executed.",
    "- Follow retained system/developer constraints and the active task. Retained tool results are execution evidence.",
    ...(currentTurnAuthoritative
      ? ["- Historical messages are supporting context. Do not repeat a prior answer unless the active task explicitly asks for it."]
      : []),
    "- Older omitted state is unknown; do not claim it completed.",
  ].join("\n");
}

function compactHistoricalAssistant(item, { currentTurnAuthoritative = false } = {}) {
  const compacted = compactValue(item, { aggressive: true });
  const prefix = currentTurnAuthoritative
    ? "[historical completed assistant answer; supporting context only; do not repeat unless the active task asks]\n"
    : "[historical assistant context; not the active task]\n";
  if (typeof compacted?.content === "string") {
    const text = currentTurnAuthoritative
      ? trimMiddleText(compacted.content, GEMINI_HISTORICAL_ASSISTANT_CHARS)
      : compacted.content;
    compacted.content = prefix + text;
    return compacted;
  }
  if (Array.isArray(compacted?.content)) {
    const textPart = compacted.content.find((part) => part && typeof part === "object" && typeof part.text === "string");
    if (textPart) {
      const text = currentTurnAuthoritative
        ? trimMiddleText(textPart.text, GEMINI_HISTORICAL_ASSISTANT_CHARS)
        : textPart.text;
      textPart.text = prefix + text;
    }
    else compacted.content.unshift({ type: "output_text", text: prefix.trimEnd() });
  }
  return compacted;
}

function compactHistoricalUser(item, { currentTurnAuthoritative = false } = {}) {
  const original = itemText(item);
  const text = currentTurnAuthoritative
    ? trimMiddleText(original, GEMINI_HISTORICAL_USER_CHARS)
    : original;
  return {
    type: "message",
    role: "user",
    content: [{
      type: "input_text",
      text: "[historical user context; background only unless the current active task explicitly reopens it]\n" + text,
    }],
  };
}

export function buildLocalCompactResponse(_model, input, { requiredCallIds = new Set(), profile = "continuity" } = {}) {
  const items = Array.isArray(input) ? input : [];
  const currentTurnAuthoritative = profile === "gemini-current-turn";
  let latestUserIndex = -1;
  for (let index = items.length - 1; index >= 0; index--) {
    if (isUserItem(items[index]) && itemText(items[index]).trim()) {
      latestUserIndex = index;
      break;
    }
  }
  // In the Gemini replay profile the real current turn is appended outside this
  // historical slice, so every user message here is supporting history.
  const activeUserIndex = currentTurnAuthoritative ? -1 : latestUserIndex;
  const selected = new Map();
  const groups = new Map();
  const historicalUserIndices = items
    .map((item, index) => [item, index])
    .filter(([item, index]) => index !== activeUserIndex && isUserItem(item) && itemText(item).trim())
    .map(([, index]) => index);
  const retainedHistoricalUsers = new Set(currentTurnAuthoritative
    ? historicalUserIndices.slice(-GEMINI_RECENT_HISTORICAL_USERS)
    : historicalUserIndices);
  const isCall = (item) => item?.type === "function_call" || item?.type === "custom_tool_call";
  const isResult = (item) => item?.type === "function_call_output" || item?.type === "custom_tool_call_output";
  let bytes = 0;
  const add = (entries, required) => {
    const fresh = entries.filter(([index]) => !selected.has(index))
      .map(([index, item]) => [index, checkpointAttachmentReferences(item)]);
    const size = fresh.reduce((sum, [, item]) => sum + serializedBodyBytes(item), 0);
    if (bytes + size > (required ? 900_000 : 400_000)) {
      if (!required) return;
      const error = new Error("Checkpoint cannot safely retain required task and tool state within its budget. Supply an explicit handoff in a new task.");
      error.statusCode = 413;
      error.code = "checkpoint_state_budget_exceeded";
      throw error;
    }
    for (const [index, item] of fresh) selected.set(index, item);
    bytes += size;
  };
  // Keep instruction roles and task text intact; never silently tail-slice them.
  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    if (item?.type === "additional_tools") add([[index, item]], true);
    if (isUserItem(item) || item?.role === "developer" || item?.role === "system") {
      const text = item?.type === "input_text" ? item.text : itemText(item);
      if (text && (!isUserItem(item) || index === activeUserIndex || retainedHistoricalUsers.has(index))) {
        const retained = isUserItem(item) && index !== activeUserIndex
          ? compactHistoricalUser(item, { currentTurnAuthoritative })
          : { type: "message", role: item?.role || "user", content: [{ type: "input_text", text }] };
        add([[index, retained]], true);
      }
    }
    if ((isCall(item) || isResult(item)) && typeof item.call_id === "string") {
      const group = groups.get(item.call_id) || [];
      group.push([index, item]);
      groups.set(item.call_id, group);
    }
  }
  const orderedGroups = [...groups.entries()].sort((a, b) => b[1].at(-1)[0] - a[1].at(-1)[0]);
  let latestEvidence = false;
  const mandatory = new Set();
  for (const [id, entries] of orderedGroups) {
    const hasCall = entries.some(([, item]) => isCall(item));
    const hasResult = entries.some(([, item]) => isResult(item));
    const requiredForContinuity = !hasResult || requiredCallIds.has(id);
    const retainLatestCompletedEvidence = !currentTurnAuthoritative && !latestEvidence;
    if (hasCall && (requiredForContinuity || retainLatestCompletedEvidence)) {
      add(entries, true);
      mandatory.add(id);
      if (hasResult) latestEvidence = true;
    }
  }
  // Keep complete recent groups atomically, with exact names, arguments and IDs.
  if (!currentTurnAuthoritative) {
    for (const [id, entries] of orderedGroups) {
      if (!mandatory.has(id) && entries.some(([, item]) => isCall(item))) add(entries, false);
    }
  }
  let retainedAssistant = 0;
  for (let index = items.length - 1; index >= 0 && retainedAssistant < 1; index--) {
    if (items[index]?.role !== "assistant") continue;
    add([[index, compactHistoricalAssistant(items[index], { currentTurnAuthoritative })]], false);
    retainedAssistant++;
  }
  const output = [
    { type: "message", role: "assistant", content: [{ type: "output_text", text: fixedCheckpoint(items, { currentTurnAuthoritative }) }] },
    ...[...selected].sort((a, b) => a[0] - b[0]).map(([, item]) => item),
  ];
  return {
    id: `resp_compact_${randomUUID()}`,
    object: "response.compaction",
    created_at: Math.floor(Date.now() / 1000),
    output,
  };
}

/**
 * Bound a replayed Codex history before it reaches an upstream tokenizer.
 * Codex may privately retain old windows for model switching even when the
 * visible context counter is smaller. Preserve the current turn byte-for-byte
 * and replace only older items with a local checkpoint.
 */
export function prepareOversizedHistoryReplay(payload, settings = {}, options = {}) {
  const body = payload && typeof payload === "object" ? payload : {};
  const input = Array.isArray(body.input) ? body.input : (body.input == null ? [] : [body.input]);
  const hasUserTurn = input.some(isUserItem);
  // Some clients send only the tool-result delta after a tool call. It is the
  // current turn, not historical replay, and must never be checkpointed away.
  const configuredOverride = Number(options.limitBytes);
  const configuredLimit = Number.isFinite(configuredOverride) && configuredOverride >= 64 * 1024
    ? Math.floor(configuredOverride)
    : configuredHistoryReplayLimit(settings);
  // Codex owns normal conversation compaction and calls /responses/compact (or
  // sends compaction_trigger) when the target model reaches its token budget.
  // A byte-based replay ceiling is an opt-in emergency guard only; enabling one
  // by default would silently compete with Codex's token-aware state machine.
  if (!Number.isFinite(configuredLimit)) {
    return { payload: body, rewritten: false, originalBytes: 0, outboundBytes: 0, limitBytes: null };
  }
  const limitBytes = configuredLimit;
  if (!hasUserTurn) return { payload: body, rewritten: false, originalBytes: 0, outboundBytes: 0, limitBytes };
  const boundary = currentTurnStart(input);
  if (boundary <= 0) return { payload: body, rewritten: false, originalBytes: 0, outboundBytes: 0, limitBytes };

  const originalBytes = serializedBodyBytes(body);
  if (originalBytes <= limitBytes) {
    return { payload: body, rewritten: false, originalBytes, outboundBytes: originalBytes, limitBytes };
  }

  const history = input.slice(0, boundary);
  const currentTurn = input.slice(boundary);
  const requiredCallIds = new Set(currentTurn
    .filter((item) => item?.type === "function_call_output" || item?.type === "custom_tool_call_output")
    .map((item) => item.call_id));
  body.input = [...buildLocalCompactResponse(body.model, history, {
    requiredCallIds,
    profile: options.profile,
  }).output, ...currentTurn];
  return { payload: body, rewritten: true, originalBytes, outboundBytes: serializedBodyBytes(body), limitBytes };
}

export function prepareProviderSwitchHistoryReplay(payload, settings = {}) {
  return prepareOversizedHistoryReplay(payload, settings, { limitBytes: configuredProviderSwitchReplayLimit(settings) });
}

export function prepareGeminiHistoryReplay(payload, settings = {}, { providerSwitch = false } = {}) {
  return prepareOversizedHistoryReplay(payload, settings, {
    limitBytes: providerSwitch ? configuredProviderSwitchReplayLimit(settings) : configuredHistoryReplayLimit(settings),
    profile: "gemini-current-turn",
  });
}

export function compactLockKey(request, payload) {
  const header = request?.headers?.["x-codex-parent-thread-id"] || request?.headers?.["thread-id"] || request?.headers?.["session-id"] || request?.headers?.session_id;
  if (typeof header === "string" && header.trim()) return `header:${header.trim()}`;
  if (typeof payload?.previous_response_id === "string" && payload.previous_response_id) return `previous:${payload.previous_response_id}`;
  return null;
}
