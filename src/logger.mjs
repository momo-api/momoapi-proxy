import { appendFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

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

export function logInfo(message, meta = null, env = process.env) {
  const timestamp = new Date().toISOString();
  const metaStr = meta ? " " + JSON.stringify(meta) : "";
  writeLog(`[${timestamp}] [INFO] ${message}${metaStr}`, env);
}

export function logError(title, error, env = process.env) {
  const timestamp = new Date().toISOString();
  const errMsg = error?.stack || error?.message || String(error || "");
  writeLog(`[${timestamp}] [ERROR] ${title}: ${errMsg}`, env);
}

export function logRequest({ method, url, model, status, elapsedMs, error, ip, toolsCount, toolCalls }, env = process.env) {
  const timestamp = new Date().toISOString();
  const modelTag = model ? ` [${model}]` : "";
  const statusTag = status != null ? ` -> HTTP ${status}` : "";
  const timeTag = elapsedMs != null ? ` (${elapsedMs}ms)` : "";
  const errorTag = error ? ` [ERROR: ${error}]` : "";
  const ipTag = ip ? ` [${ip}]` : "";
  const toolsTag = toolsCount != null ? ` [tools:${toolsCount}]` : "";
  const callsTag = Array.isArray(toolCalls) && toolCalls.length > 0
    ? ` [executed:${toolCalls.map((c) => c.name || c).join(",")}]`
    : "";
  const line = `[${timestamp}]${ipTag} ${method} ${url}${modelTag}${toolsTag}${callsTag}${statusTag}${timeTag}${errorTag}`;
  writeLog(line, env);
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
