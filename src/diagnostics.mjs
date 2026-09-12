import { randomUUID } from "node:crypto";
import { arch, platform } from "node:os";
import { join } from "node:path";
import { statSync } from "node:fs";
import { appHome } from "./config.mjs";
import { getCurrentVersion } from "./updater.mjs";
import { activeLoggingRuntime, defaultLoggingRuntime, diagnosticEventPath, getLoggingMetrics } from "./logging-runtime.mjs";
import { readRotatingLogTail } from "./log-tail.mjs";

let runtimeContext = null;
const DIAGNOSTIC_EVENTS = new Set(["proxy_crash", "proxy_request_error", "proxy_start_error", "proxy_sync_error",
  "proxy_update_check_error", "proxy_update_error"]);

// Kept for callers that imported these counters. Runtime writer metrics are authoritative.
export const diagnosticsState = { localRecorded: 0, dropped: 0 };

export function legacyDiagnosticPath(env = process.env) { return join(appHome(env), "diagnostic-events.jsonl"); }
export function diagnosticPath(env = process.env) { return diagnosticEventPath(env); }
export function readRecentDiagnostics(lines = 100, env = process.env) { return readRecentDiagnosticReport(lines, env).lines; }
export function readRecentDiagnosticReport(lines = 100, env = process.env) {
  return readRotatingLogTail(diagnosticPath(env), lines, { legacyTarget: legacyDiagnosticPath(env) });
}

function safeText(value, maxLength = 160) {
  if (value == null) return undefined;
  const normalized = String(value).toWellFormed()
    .replace(/Bearer\s+[^\s]+/gi, "Bearer [redacted]")
    .replace(/(?:sk|momo)[-_][A-Za-z0-9_-]{12,}/gi, "[credential redacted]")
    .replace(/[A-Za-z0-9+/]{256,}={0,2}/g, "[opaque data redacted]")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim();
  return normalized ? normalized.slice(0, maxLength) : undefined;
}

function safeInteger(value, max = Number.MAX_SAFE_INTEGER) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return undefined;
  return Math.min(max, Math.trunc(number));
}

export function normalizeDiagnosticEvent(input = {}, { now = new Date(), version = getCurrentVersion() } = {}) {
  const status = safeInteger(input.status, 599);
  return {
    schema_version: 2, event_id: safeText(input.eventId, 64) || randomUUID(), event: safeText(input.event, 64) || "proxy_error",
    created_at: now.toISOString(), proxy_version: safeText(input.proxyVersion, 32) || version,
    platform: safeText(input.platform, 24) || platform(), arch: safeText(input.arch, 24) || arch(),
    route: safeText(input.route, 96), model: safeText(input.model, 128), status,
    error_code: safeText(input.errorCode, 96)?.toLowerCase().replace(/[^a-z0-9_.:-]+/g, "_"),
    request_bytes: safeInteger(input.requestBytes), outbound_bytes: safeInteger(input.outboundBytes),
    image_count: safeInteger(input.imageCount, 10_000), image_bytes: safeInteger(input.imageBytes),
    input_tokens: safeInteger(input.inputTokens), output_tokens: safeInteger(input.outputTokens), total_tokens: safeInteger(input.totalTokens),
    latency_ms: safeInteger(input.latencyMs, 24 * 60 * 60 * 1000), policy_action: safeText(input.policyAction, 160),
  };
}

function compactEvent(event) {
  return Object.fromEntries(Object.entries(event).filter(([, value]) => value !== undefined && value !== null && value !== ""));
}

export function configureDiagnostics({ settings, env = process.env, runtime } = {}) {
  runtimeContext = settings ? { settings, env, runtime } : null;
}

export function recordDiagnosticEvent(input, { env = process.env, settings, runtime } = {}) {
  const activeEnv = settings ? env : runtimeContext?.env;
  const saved = settings || runtimeContext?.settings;
  const selectedRuntime = runtime || runtimeContext?.runtime || activeLoggingRuntime();
  if (!saved || !activeEnv || saved.diagnosticsEnabled === false) return null;
  const event = compactEvent(normalizeDiagnosticEvent(input));
  if (!DIAGNOSTIC_EVENTS.has(event.event)) return null;
  if (event.event === "proxy_request_error" && event.status !== 413 && event.status !== 429 && !(event.status >= 500 && event.status <= 599)) return null;
  let accepted = false;
  try { accepted = (selectedRuntime || defaultLoggingRuntime(activeEnv)).enqueueDiagnostic(JSON.stringify(event)); } catch {}
  if (accepted) diagnosticsState.localRecorded++; else diagnosticsState.dropped++;
  return event;
}

export function getDiagnosticsMetrics(env = process.env, { runtime } = {}) {
  const logging = getLoggingMetrics({ env, runtime: runtime || runtimeContext?.runtime });
  let localFileBytes = 0;
  for (const target of [diagnosticPath(env), diagnosticPath(env) + ".1"]) {
    try { localFileBytes += statSync(target).size; } catch {}
  }
  return {
    localRecorded: logging.diagnostic.accepted,
    dropped: logging.diagnostic.rejectedInvalid + logging.diagnostic.rejectedOversize + logging.diagnostic.rejectedCapacity
      + logging.diagnostic.rejectedClosed + logging.diagnostic.writeFailed + logging.diagnostic.shutdownDropped,
    mode: "local-only", localFileBytes, pendingRecords: logging.diagnostic.pendingRecords, written: logging.diagnostic.written,
  };
}
