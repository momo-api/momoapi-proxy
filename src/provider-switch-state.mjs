import { createHash } from "node:crypto";

const MAX_TRACKED_THREADS = 512;
const MAX_THREAD_ID_CHARS = 8192;
const routesByThread = new Map();

function safeThreadId(request) {
  const value = request?.headers?.["x-codex-parent-thread-id"]
    || request?.headers?.["thread-id"]
    || request?.headers?.["session-id"]
    || request?.headers?.session_id;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= MAX_THREAD_ID_CHARS ? trimmed : null;
}

function threadHash(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

/**
 * Track only a bounded anonymous thread hash and the last protocol family.
 * Raw thread/session identifiers are never retained or logged.
 */
export function observeProviderRoute(request, currentProtocol) {
  const rawThreadId = safeThreadId(request);
  const protocol = typeof currentProtocol === "string" ? currentProtocol : "";
  if (!rawThreadId || !protocol) {
    return { threadHash: null, previousProtocol: null, currentProtocol: protocol || null, switched: false };
  }

  const hash = threadHash(rawThreadId);
  const previousProtocol = routesByThread.get(hash) || null;
  return {
    threadHash: hash,
    previousProtocol,
    currentProtocol: protocol,
    switched: Boolean(previousProtocol && previousProtocol !== protocol),
  };
}

/** Commit only routes that reached a successful upstream protocol response. */
export function commitProviderRoute(route) {
  const hash = route?.threadHash;
  const protocol = route?.currentProtocol;
  if (typeof hash !== "string" || !/^[a-f0-9]{16}$/.test(hash) || typeof protocol !== "string" || !protocol) return false;
  routesByThread.delete(hash);
  routesByThread.set(hash, protocol);
  while (routesByThread.size > MAX_TRACKED_THREADS) routesByThread.delete(routesByThread.keys().next().value);
  return true;
}

export function resetProviderRouteStateForTests() {
  routesByThread.clear();
}
