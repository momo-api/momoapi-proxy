import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { arch, platform } from "node:os";
import { dirname, join } from "node:path";
import { appHome, readSettings } from "./config.mjs";
import { getCurrentVersion } from "./updater.mjs";

const MAX_EVENT_FILE_BYTES = 2 * 1024 * 1024;
const MAX_EVENT_LINES = 1_000;
const MAX_BATCH_SIZE = 20;
const REPORTABLE_STATUS = new Set([413, 429]);
const REPORTABLE_EVENTS = new Set([
  "proxy_crash",
  "proxy_request_error",
  "proxy_start_error",
  "proxy_sync_error",
  "proxy_update_check_error",
  "proxy_update_error",
]);
let runtimeContext = null;

export const telemetryState = {
  localRecorded: 0,
  queued: 0,
  sent: 0,
  failed: 0,
  dropped: 0,
  lastFlushAt: null,
  lastErrorCode: null,
};

export function diagnosticPath(env = process.env) {
  return join(appHome(env), "diagnostic-events.jsonl");
}

export function telemetryQueuePath(env = process.env) {
  return join(appHome(env), "telemetry-queue.jsonl");
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
    installation_id: safeText(input.installationId, 64),
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
    telemetryState.dropped += Math.max(0, lines.length - kept.length);
  } catch {}
}

function readJsonLines(target) {
  if (!existsSync(target)) return [];
  try {
    return readFileSync(target, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

export function configureTelemetry({ settings, env = process.env } = {}) {
  runtimeContext = settings ? { settings, env } : null;
}

export function isReportableDiagnostic(event) {
  if (!event || !REPORTABLE_EVENTS.has(event.event)) return false;
  return REPORTABLE_STATUS.has(event.status) || Number(event.status) >= 500 || event.status == null;
}

export function recordDiagnosticEvent(input, { env = process.env, settings } = {}) {
  const activeEnv = settings ? env : runtimeContext?.env;
  const saved = settings || runtimeContext?.settings;
  if (!saved || !activeEnv) return null;
  if (saved.diagnosticsEnabled === false) return null;
  const event = compactEvent(normalizeDiagnosticEvent({ ...input, installationId: input?.installationId || saved.installationId }));
  try {
    appendBoundedJsonLine(diagnosticPath(activeEnv), event);
    telemetryState.localRecorded += 1;
  } catch {
    telemetryState.dropped += 1;
  }
  if (saved.telemetryEnabled !== false && isReportableDiagnostic(event)) {
    try {
      appendBoundedJsonLine(telemetryQueuePath(activeEnv), event);
      telemetryState.queued += 1;
    } catch {
      telemetryState.dropped += 1;
    }
  }
  return event;
}

function telemetryEndpoint(settings) {
  if (settings.telemetryEndpoint) return settings.telemetryEndpoint;
  const endpoint = String(settings.endpoint || "https://momoapi.us").replace(/\/$/, "").replace(/\/v1$/, "");
  return endpoint + "/api/proxy/telemetry";
}

function removeQueuedEvents(target, sentIds) {
  const remaining = readJsonLines(target).filter((event) => !sentIds.has(event.event_id));
  writeFileSync(target, remaining.map((event) => JSON.stringify(event)).join("\n") + (remaining.length ? "\n" : ""), { encoding: "utf8", mode: 0o600 });
}

export async function flushTelemetryQueue({ settings, env = process.env, fetchImpl = fetch } = {}) {
  const saved = settings || runtimeContext?.settings || (() => { try { return readSettings(env); } catch { return {}; } })();
  if (saved.telemetryEnabled === false || !saved.apiKey) return { sent: 0, skipped: true };
  const target = telemetryQueuePath(env);
  const events = readJsonLines(target).slice(0, MAX_BATCH_SIZE);
  if (events.length === 0) return { sent: 0, queued: 0 };

  let response;
  try {
    response = await fetchImpl(telemetryEndpoint(saved), {
      method: "POST",
      headers: {
        authorization: "Bearer " + saved.apiKey,
        "content-type": "application/json",
        "user-agent": "momoapi-proxy/" + getCurrentVersion(),
      },
      body: JSON.stringify({ schema_version: 1, events }),
      signal: typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(10_000) : undefined,
    });
  } catch (error) {
    telemetryState.failed += 1;
    telemetryState.lastErrorCode = safeText(error?.code || error?.name || "network_error", 96);
    return { sent: 0, queued: readJsonLines(target).length, error: telemetryState.lastErrorCode };
  }

  if (!response.ok) {
    telemetryState.failed += 1;
    telemetryState.lastErrorCode = "http_" + response.status;
    if (response.status === 400 || response.status === 413) {
      removeQueuedEvents(target, new Set(events.map((event) => event.event_id)));
      telemetryState.dropped += events.length;
    }
    return { sent: 0, queued: readJsonLines(target).length, status: response.status };
  }

  removeQueuedEvents(target, new Set(events.map((event) => event.event_id)));
  telemetryState.sent += events.length;
  telemetryState.lastFlushAt = new Date().toISOString();
  telemetryState.lastErrorCode = null;
  return { sent: events.length, queued: readJsonLines(target).length };
}

export function getTelemetryMetrics(env = process.env) {
  return {
    ...telemetryState,
    queueDepth: readJsonLines(telemetryQueuePath(env)).length,
  };
}

export function startTelemetryReporter({ settings, env = process.env, fetchImpl = fetch, initialDelayMs = 15_000, intervalMs = 5 * 60_000, scheduleImpl = setTimeout, clearScheduleImpl = clearTimeout } = {}) {
  let stopped = false;
  let timer = null;
  let failures = 0;
  const run = async () => {
    if (stopped) return;
    const result = await flushTelemetryQueue({ settings, env, fetchImpl });
    failures = result.error || result.status ? failures + 1 : 0;
    const delay = failures > 0 ? Math.min(30 * 60_000, 30_000 * (2 ** Math.min(failures - 1, 6))) : intervalMs;
    timer = scheduleImpl(run, delay);
    if (timer.unref) timer.unref();
  };
  timer = scheduleImpl(run, Math.max(0, initialDelayMs));
  if (timer.unref) timer.unref();
  return {
    flush: () => flushTelemetryQueue({ settings, env, fetchImpl }),
    stop: () => { stopped = true; if (timer) clearScheduleImpl(timer); },
  };
}
