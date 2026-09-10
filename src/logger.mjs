import { appendFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { recordDiagnosticEvent } from "./diagnostics.mjs";

export function logPath(env = process.env) {
  const root = env.MOMO_PROXY_HOME || env.MOMO_BRIDGE_HOME || join(homedir(), ".momoapi-proxy");
  return join(root, "proxy.log");
}

function writeLog(line, env = process.env) {
  try {
    const target = logPath(env);
    mkdirSync(dirname(target), { recursive: true });
    appendFileSync(target, line + "\n", "utf8");
  } catch {}
  try {
    console.log(line);
  } catch {}
}

function safeLogValue(value) {
  return String(value || "")
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, "Bearer [redacted]")
    .replace(/data:[^;,\s]+(?:;[^,\s]*)?;base64,[A-Za-z0-9+/=\r\n]+/gi, "[inline data redacted]")
    .replace(/(?:sk|momo)[-_][A-Za-z0-9_-]{16,}/gi, "[credential redacted]")
    .replace(/[A-Za-z0-9+/]{512,}={0,2}/g, "[large opaque data redacted]")
    .slice(0, 1000);
}

export function logInfo(message, meta = null, env = process.env) {
  const timestamp = new Date().toISOString();
  const metaStr = meta ? " " + JSON.stringify(meta) : "";
  writeLog(`[${timestamp}] [INFO] ${message}${metaStr}`, env);
}

export function logError(title, error, env = process.env) {
  const timestamp = new Date().toISOString();
  const errMsg = safeLogValue(error?.stack || error?.message || error);
  writeLog(`[${timestamp}] [ERROR] ${title}: ${errMsg}`, env);
  recordDiagnosticEvent({
    event: "proxy_crash",
    errorCode: error?.code || String(title || "proxy_error").toLowerCase().replace(/[^a-z0-9]+/g, "_"),
  }, { env });
}

export function logRequest({ method, url, model, status, elapsedMs, error, errorCode, ip, toolsCount, toolCalls, requestBytes, outboundBytes, imageCount, imageBytes, policyAction, inputTokens, outputTokens, totalTokens }, env = process.env) {
  const timestamp = new Date().toISOString();
  const modelTag = model ? ` [${safeLogValue(model)}]` : "";
  const statusTag = status != null ? ` -> HTTP ${status}` : "";
  const timeTag = elapsedMs != null ? ` (${elapsedMs}ms)` : "";
  const errorTag = error ? ` [ERROR: ${safeLogValue(error)}]` : "";
  const ipTag = ip ? ` [${ip}]` : "";
  const toolsTag = toolsCount != null ? ` [tools:${toolsCount}]` : "";
  const callsTag = Array.isArray(toolCalls) && toolCalls.length > 0
    ? ` [executed:${toolCalls.map((c) => c.name || c).join(",")}]`
    : "";
  const requestBytesTag = Number.isFinite(requestBytes) ? ` [request-bytes:${requestBytes}]` : "";
  const outboundBytesTag = Number.isFinite(outboundBytes) ? ` [outbound-bytes:${outboundBytes}]` : "";
  const mediaTag = Number.isFinite(imageCount) || Number.isFinite(imageBytes)
    ? ` [images:${Number.isFinite(imageCount) ? imageCount : 0}/${Number.isFinite(imageBytes) ? imageBytes : 0}B]`
    : "";
  const policyTag = policyAction ? ` [policy:${String(policyAction).slice(0, 160)}]` : "";
  const line = `[${timestamp}]${ipTag} ${method} ${url}${modelTag}${toolsTag}${callsTag}${requestBytesTag}${outboundBytesTag}${mediaTag}${policyTag}${statusTag}${timeTag}${errorTag}`;
  writeLog(line, env);
  const businessRoute = /^(?:(?:\/v1)?\/(?:responses|chat\/completions|images(?:\/|$)|messages|models(?:\/|$))|\/internal\/images(?:\/|$))/i.test(String(url || ""));
  if (businessRoute && Number(status) >= 400) {
    recordDiagnosticEvent({
      event: "proxy_request_error",
      route: url,
      model,
      status,
      errorCode: errorCode || (Number.isFinite(status) ? `http_${status}` : "request_error"),
      requestBytes,
      outboundBytes,
      imageCount,
      imageBytes,
      inputTokens,
      outputTokens,
      totalTokens,
      latencyMs: elapsedMs,
      policyAction,
    }, { env });
  }
}

export function readRecentLogs(lines = 100, env = process.env) {
  const target = logPath(env);
  if (!existsSync(target)) return [];
  try {
    const content = readFileSync(target, "utf8");
    const allLines = content.split(/\r?\n/).filter(Boolean);
    return allLines.slice(-lines);
  } catch {
    return [];
  }
}
