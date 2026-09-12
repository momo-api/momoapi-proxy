import { createHash, randomUUID } from "node:crypto";

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeSessionValue(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 4096 || /[\u0000-\u001f\u007f]/.test(trimmed)) return null;
  return trimmed;
}

function deriveOpenCodeSessionId(seed) {
  const digest = createHash("sha256")
    .update("momoapi-proxy/opencode-go/session/v1\0")
    .update(seed)
    .digest("hex")
    .slice(0, 32);
  return `ocx_${digest}`;
}

function cachedOpenCodeSession(payload, calls) {
  for (const item of asArray(payload?.input)) {
    if (!item || typeof item !== "object" || !item.call_id) continue;
    const cached = safeSessionValue(calls?.get(item.call_id)?.openCodeSessionId);
    if (cached) return cached;
  }
  return null;
}

function firstConversationSeed(payload) {
  for (const item of asArray(payload?.input)) {
    if (typeof item === "string" && item.trim()) return `${payload?.model || ""}\0${item}`;
    if (!item || typeof item !== "object") continue;
    if (item.role === "user" || item.type === "message" || item.type === "input_text") {
      return `${payload?.model || ""}\0${JSON.stringify(item)}`;
    }
  }
  return null;
}

export function resolveOpenCodeSession(request, payload, calls) {
  const explicit = safeSessionValue(request?.headers?.["x-opencode-session"]);
  if (explicit) return explicit;

  const cached = cachedOpenCodeSession(payload, calls);
  if (cached) return cached;

  const parent = safeSessionValue(request?.headers?.["x-codex-parent-thread-id"]);
  const thread = safeSessionValue(request?.headers?.["thread-id"]);
  const session = safeSessionValue(request?.headers?.session_id || request?.headers?.["session-id"]);
  const specific = thread || session;
  const lane = parent && specific ? `${parent}\0${specific}` : (specific || parent);
  if (lane) return deriveOpenCodeSessionId(lane);

  const seed = firstConversationSeed(payload);
  return deriveOpenCodeSessionId(seed || randomUUID());
}
