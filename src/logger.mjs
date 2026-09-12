import { join } from "node:path";
import { homedir } from "node:os";
import { recordDiagnosticEvent } from "./diagnostics.mjs";
import { defaultLoggingRuntime, requestEventPath } from "./logging-runtime.mjs";
import { readRotatingLogTail } from "./log-tail.mjs";

const MAX_TEXT = 1000;

export function legacyLogPath(env = process.env) {
  const root = env.MOMO_PROXY_HOME || env.MOMO_BRIDGE_HOME || join(homedir(), ".momoapi-proxy");
  return join(root, "proxy.log");
}

export function logPath(env = process.env) {
  return requestEventPath(env);
}

export function safeLogValue(value, maxLength = MAX_TEXT) {
  return String(value ?? "").toWellFormed()
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, "Bearer [redacted]")
    .replace(/data:[^;,\s]+(?:;[^,\s]*)?;base64,[A-Za-z0-9+/=\r\n]+/gi, "[inline data redacted]")
    .replace(/(?:sk|momo)[-_][A-Za-z0-9_-]{12,}/gi, "[credential redacted]")
    .replace(/[A-Za-z0-9+/]{256,}={0,2}/g, "[large opaque data redacted]")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim()
    .slice(0, maxLength);
}

function finiteInteger(value) {
  return Number.isFinite(value) ? Math.trunc(value) : undefined;
}

function compact(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null && item !== ""));
}

function safeToolAudit(toolAudit) {
  if (!toolAudit || typeof toolAudit !== "object") return undefined;
  const boundedList = (items) => Array.isArray(items) ? items.slice(0, 128).map((item) => compact({
    type: safeLogValue(item?.type, 32), nameHash: safeLogValue(item?.nameHash, 32),
  })) : undefined;
  return compact({
    topLevelTools: finiteInteger(toolAudit.topLevelTools), leafTools: finiteInteger(toolAudit.leafTools),
    tools: boundedList(toolAudit.tools), truncated: Boolean(toolAudit.truncated),
    choice: safeLogValue(toolAudit.choice, 24), choiceHash: safeLogValue(toolAudit.choiceHash, 32),
    calls: finiteInteger(toolAudit.calls), outputs: finiteInteger(toolAudit.outputs),
    unmatchedOutputs: finiteInteger(toolAudit.unmatchedOutputs),
    events: toolAudit.events && typeof toolAudit.events === "object" ? compact({
      upstream: boundedList(toolAudit.events.upstream), client: boundedList(toolAudit.events.client),
      missingClientCalls: finiteInteger(toolAudit.events.missingClientCalls),
      unexpectedClientCalls: finiteInteger(toolAudit.events.unexpectedClientCalls),
      truncated: Boolean(toolAudit.events.truncated),
    }) : undefined,
  });
}

function enqueue(record, env, runtime) {
  let line;
  try { line = JSON.stringify(compact(record)); } catch { return false; }
  return (runtime || defaultLoggingRuntime(env)).enqueueRequest(line);
}

export function logInfo(message, meta = null, env = process.env, { runtime } = {}) {
  let safeMeta;
  try { safeMeta = meta == null ? undefined : safeLogValue(JSON.stringify(meta), 2000); } catch { safeMeta = "[unserializable meta]"; }
  return enqueue({ schema_version: 2, created_at: new Date().toISOString(), level: "info", event: "proxy_info",
    message: safeLogValue(message), meta: safeMeta }, env, runtime);
}

export function logError(title, error, env = process.env, { runtime, settings } = {}) {
  const accepted = enqueue({ schema_version: 2, created_at: new Date().toISOString(), level: "error", event: "proxy_error",
    title: safeLogValue(title, 160), error: safeLogValue(error?.stack || error?.message || error) }, env, runtime);
  recordDiagnosticEvent({ event: "proxy_crash",
    errorCode: error?.code || String(title || "proxy_error").toLowerCase().replace(/[^a-z0-9]+/g, "_") },
  { env, settings, runtime });
  return accepted;
}

export function logRequest({ method, url, model, status, elapsedMs, error, errorCode, ip, toolsCount, toolCalls,
  requestBytes, outboundBytes, imageCount, imageBytes, policyAction, inputTokens, outputTokens, totalTokens, toolAudit },
  env = process.env, { runtime, settings } = {}) {
  const accepted = enqueue({
    schema_version: 2, created_at: new Date().toISOString(), level: error ? "error" : "info", event: "proxy_request",
    method: safeLogValue(method, 16), route: safeLogValue(url, 160), model: safeLogValue(model, 128),
    status: finiteInteger(status), latency_ms: finiteInteger(elapsedMs), error: error ? safeLogValue(error) : undefined,
    remote_ip: safeLogValue(ip, 96), tools_count: finiteInteger(toolsCount),
    executed_tools_count: Array.isArray(toolCalls) ? toolCalls.length : undefined,
    request_bytes: finiteInteger(requestBytes), outbound_bytes: finiteInteger(outboundBytes), image_count: finiteInteger(imageCount),
    image_bytes: finiteInteger(imageBytes), policy_action: safeLogValue(policyAction, 160), tool_audit: safeToolAudit(toolAudit),
  }, env, runtime);
  const businessRoute = /^(?:(?:\/v1)?\/(?:responses|chat\/completions|images(?:\/|$)|messages|models(?:\/|$))|\/internal\/images(?:\/|$))/i.test(String(url || ""));
  if (businessRoute && Number(status) >= 400) {
    recordDiagnosticEvent({ event: "proxy_request_error", route: url, model, status,
      errorCode: errorCode || (Number.isFinite(status) ? `http_${status}` : "request_error"), requestBytes, outboundBytes,
      imageCount, imageBytes, inputTokens, outputTokens, totalTokens, latencyMs: elapsedMs, policyAction },
    { env, settings, runtime });
  }
  return accepted;
}

export function readRecentLogs(lines = 100, env = process.env) { return readRecentLogReport(lines, env).lines; }
export function readRecentLogReport(lines = 100, env = process.env) {
  return readRotatingLogTail(logPath(env), lines, { legacyTarget: legacyLogPath(env) });
}
