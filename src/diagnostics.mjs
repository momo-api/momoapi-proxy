import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { arch, platform } from "node:os";
import { dirname, join } from "node:path";
import { appHome } from "./config.mjs";
import { getCurrentVersion } from "./updater.mjs";
import { readLogTail } from "./log-tail.mjs";

const MAX_EVENT_FILE_BYTES = 2 * 1024 * 1024;
const MAX_EVENT_LINES = 1_000;
let runtimeContext = null;

const DIAGNOSTIC_EVENTS = new Set([
  "proxy_crash",
  "proxy_request_error",
  "proxy_start_error",
  "proxy_sync_error",
  "proxy_update_check_error",
  "proxy_update_error",
]);

export const diagnosticsState = {
  localRecorded: 0,
  dropped: 0,
};

export function diagnosticPath(env = process.env) {
  return join(appHome(env), "diagnostic-events.jsonl");
}

export function readRecentDiagnostics(lines = 100, env = process.env) {
  return readRecentDiagnosticReport(lines, env).lines;
}

export function readRecentDiagnosticReport(lines = 100, env = process.env) {
  return readLogTail(diagnosticPath(env), lines);
}

function safeText(value, maxLength = 160) {
  if (value == null) return undefined;
  const normalized = String(value)
    .replace(/Bearer\s+[^\s]+/gi, "Bearer [redacted]")
    .replace(/(?:sk|momo)[-_][A-Za-z0-9_-]{12,}/gi, "[credential redacted]")
    .replace(/[A-Za-z0-9+/]{256,}={0,2}/g, "[opaque data redacted]")
    .replace(/[\r\n\t]+/g, " ")
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
    schema_version: 1,
    event_id: safeText(input.eventId, 64) || randomUUID(),
    event: safeText(input.event, 64) || "proxy_error",
    created_at: now.toISOString(),
    proxy_version: safeText(input.proxyVersion, 32) || version,
    platform: safeText(input.platform, 24) || platform(),
    arch: safeText(input.arch, 24) || arch(),
    route: safeText(input.route, 96),
    model: safeText(input.model, 128),
    status,
    error_code: safeText(input.errorCode, 96)?.toLowerCase().replace(/[^a-z0-9_.:-]+/g, "_"),
    request_bytes: safeInteger(input.requestBytes),
    outbound_bytes: safeInteger(input.outboundBytes),
    image_count: safeInteger(input.imageCount, 10_000),
    image_bytes: safeInteger(input.imageBytes),
    input_tokens: safeInteger(input.inputTokens),
    output_tokens: safeInteger(input.outputTokens),
    total_tokens: safeInteger(input.totalTokens),
    latency_ms: safeInteger(input.latencyMs, 24 * 60 * 60 * 1000),
    policy_action: safeText(input.policyAction, 160),
  };
}

function compactEvent(event) {
  return Object.fromEntries(Object.entries(event).filter(([, value]) => value !== undefined && value !== null && value !== ""));
}

function appendBoundedJsonLine(target, value) {
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  appendFileSync(target, JSON.stringify(value) + "\n", { encoding: "utf8", mode: 0o600 });
  try {
    if (statSync(target).size <= MAX_EVENT_FILE_BYTES) return;
    const lines = readFileSync(target, "utf8").split(/\r?\n/).filter(Boolean);
    const kept = lines.slice(-MAX_EVENT_LINES);
    writeFileSync(target, kept.join("\n") + (kept.length ? "\n" : ""), { encoding: "utf8", mode: 0o600 });
    diagnosticsState.dropped += Math.max(0, lines.length - kept.length);
  } catch {}
}

export function configureDiagnostics({ settings, env = process.env } = {}) {
  runtimeContext = settings ? { settings, env } : null;
}

export function recordDiagnosticEvent(input, { env = process.env, settings } = {}) {
  const activeEnv = settings ? env : runtimeContext?.env;
  const saved = settings || runtimeContext?.settings;
  if (!saved || !activeEnv) return null;
  if (saved.diagnosticsEnabled === false) return null;
  const event = compactEvent(normalizeDiagnosticEvent(input));
  if (!DIAGNOSTIC_EVENTS.has(event.event)) return null;
  if (event.event === "proxy_request_error" && event.status !== 413 && event.status !== 429 && !(event.status >= 500 && event.status <= 599)) return null;
  try {
    appendBoundedJsonLine(diagnosticPath(activeEnv), event);
    diagnosticsState.localRecorded += 1;
  } catch {
    diagnosticsState.dropped += 1;
  }
  return event;
}

export function getDiagnosticsMetrics(env = process.env) {
  let localFileBytes = 0;
  try { localFileBytes = statSync(diagnosticPath(env)).size; } catch {}
  return {
    ...diagnosticsState,
    mode: "local-only",
    localFileBytes,
  };
}
