import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { appHome, normalizeEndpoint, readSettings } from "./config.mjs";
import { codexHome } from "./catalog.mjs";

export const ROUTE_PROVIDER = "momo-route";
export const ROUTE_BEGIN = "# MOMOAPI_ROUTE_MANAGED_BEGIN";
export const ROUTE_END = "# MOMOAPI_ROUTE_MANAGED_END";
const ROUTE_MODE_PREFIX = "# MOMOAPI_ROUTE_MODE=";

function configPath(env) {
  return join(codexHome(env), "config.toml");
}

function tomlString(value) {
  return JSON.stringify(String(value));
}

function providerSectionName(line) {
  const match = String(line || "").trim().match(/^\[model_providers\.(?:"([^"]+)"|([A-Za-z0-9_-]+))\]$/);
  return match ? (match[1] || match[2]) : "";
}

function topLevelProvider(content) {
  for (const line of String(content || "").replace(/\r\n/g, "\n").split("\n")) {
    if (/^\s*\[/.test(line)) break;
    const match = line.match(/^\s*model_provider\s*=\s*["']([^"']+)["']/);
    if (match) return match[1];
  }
  return "";
}

function providerBaseUrl(content, provider) {
  let active = false;
  for (const line of String(content || "").replace(/\r\n/g, "\n").split("\n")) {
    const section = providerSectionName(line);
    if (section) {
      active = section === provider;
      continue;
    }
    if (/^\s*\[/.test(line)) active = false;
    if (!active) continue;
    const match = line.match(/^\s*base_url\s*=\s*["']([^"']+)["']/);
    if (match) return match[1];
  }
  return "";
}

function withoutManagedRoute(content) {
  const kept = [];
  let managed = false;
  for (const line of String(content || "").replace(/\r\n/g, "\n").split("\n")) {
    if (line.trim() === ROUTE_BEGIN) {
      managed = true;
      continue;
    }
    if (managed && line.trim() === ROUTE_END) {
      managed = false;
      continue;
    }
    if (!managed) kept.push(line);
  }
  return kept.join("\n").trim();
}

function withoutTopLevelProvider(content) {
  const kept = [];
  let topLevel = true;
  for (const line of String(content || "").replace(/\r\n/g, "\n").split("\n")) {
    if (/^\s*\[/.test(line)) topLevel = false;
    if (topLevel && /^\s*model_provider\s*=/.test(line)) continue;
    kept.push(line);
  }
  return kept.join("\n").trim();
}

function credentialCommand({ nodePath, cliPath, kind }) {
  return [
    `[model_providers.${ROUTE_PROVIDER}.auth]`,
    `command = ${tomlString(nodePath)}`,
    `args = [${tomlString(cliPath)}, "credential", ${tomlString(kind)}]`,
    "timeout_ms = 5000",
    "refresh_interval_ms = 0",
  ].join("\n");
}

function managedRouteBlock({ mode, baseUrl, nodePath, cliPath }) {
  return [
    ROUTE_BEGIN,
    ROUTE_MODE_PREFIX + mode,
    `[model_providers.${ROUTE_PROVIDER}]`,
    'name = "MOMO Route"',
    `base_url = ${tomlString(baseUrl)}`,
    'wire_api = "responses"',
    "",
    credentialCommand({ nodePath, cliPath, kind: mode === "proxy" ? "local" : "upstream" }),
    ROUTE_END,
  ].join("\n");
}

function atomicWrite(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = path + ".route-" + process.pid + "-" + randomUUID() + ".tmp";
  writeFileSync(temporary, content, { mode: 0o600 });
  try { chmodSync(temporary, 0o600); } catch {}
  try {
    renameSync(temporary, path);
  } catch (error) {
    try { unlinkSync(temporary); } catch {}
    throw error;
  }
}

function saveBackup(target, env) {
  if (!existsSync(target)) return { rollback: null, timestamped: null };
  const rollback = target + ".momo-route.bak";
  if (!existsSync(rollback)) copyFileSync(target, rollback);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const directory = join(codexHome(env), "backups", "momo-route-switch-" + stamp);
  mkdirSync(directory, { recursive: true });
  const timestamped = join(directory, "config.toml");
  copyFileSync(target, timestamped);
  return { rollback, timestamped };
}

function writeRouteState(value, env) {
  const path = join(appHome(env), "codex-route.json");
  mkdirSync(dirname(path), { recursive: true });
  atomicWrite(path, JSON.stringify(value, null, 2) + "\n");
  return path;
}

export function codexRouteStatus(env = process.env) {
  const target = configPath(env);
  if (!existsSync(target)) return { mode: "unconfigured", managed: false, provider: "", baseUrl: "", config: target };
  const content = readFileSync(target, "utf8");
  const marker = content.match(/^# MOMOAPI_ROUTE_MODE=(direct|proxy)$/m);
  const provider = topLevelProvider(content);
  const baseUrl = providerBaseUrl(content, provider);
  let mode = marker?.[1] || "custom";
  if (!marker) {
    if (/^https:\/\/momoapi\.us(?:\/v1)?\/?$/i.test(baseUrl)) mode = "direct";
    else if (/^http:\/\/(?:127\.0\.0\.1|localhost):\d+\/v1\/?$/i.test(baseUrl)) mode = "proxy";
  }
  return { mode, managed: content.includes(ROUTE_BEGIN), provider, baseUrl, config: target };
}

export function switchCodexRoute(mode, {
  env = process.env,
  nodePath = process.execPath,
  cliPath,
  settings = readSettings(env),
} = {}) {
  if (!new Set(["direct", "proxy"]).has(mode)) throw new Error("Codex route must be 'direct' or 'proxy'.");
  if (!cliPath) throw new Error("Codex route requires the proxy CLI path.");
  if (!settings?.apiKey) throw new Error("MOMO API key is not configured.");
  if (mode === "proxy" && !settings?.localToken) throw new Error("MOMO local proxy token is not configured.");

  const target = configPath(env);
  const original = existsSync(target) ? readFileSync(target, "utf8") : "";
  const backup = saveBackup(target, env);
  const cleaned = withoutTopLevelProvider(withoutManagedRoute(original));
  const endpoint = normalizeEndpoint(settings.endpoint || "https://momoapi.us");
  const directBaseUrl = /\/v1$/i.test(endpoint) ? endpoint : endpoint + "/v1";
  const baseUrl = mode === "proxy"
    ? `http://127.0.0.1:${Number(settings.port || 18789)}/v1`
    : directBaseUrl;
  const content = [
    `model_provider = ${tomlString(ROUTE_PROVIDER)}`,
    cleaned,
    managedRouteBlock({ mode, baseUrl, nodePath, cliPath }),
    "",
  ].filter((part) => part !== "").join("\n\n").replace(/\n{3,}/g, "\n\n");
  atomicWrite(target, content);
  const stateFile = writeRouteState({ mode, provider: ROUTE_PROVIDER, baseUrl, changedAt: new Date().toISOString(), backup: backup.timestamped }, env);
  return { mode, provider: ROUTE_PROVIDER, baseUrl, config: target, backup: backup.timestamped, rollback: backup.rollback, stateFile };
}

export function restoreCodexRoute(env = process.env) {
  const target = configPath(env);
  const rollback = target + ".momo-route.bak";
  if (!existsSync(rollback)) throw new Error("No pre-switch Codex configuration backup is available.");
  saveBackup(target, env);
  const content = readFileSync(rollback, "utf8");
  atomicWrite(target, content);
  const status = codexRouteStatus(env);
  writeRouteState({ ...status, restoredAt: new Date().toISOString() }, env);
  return { ...status, restored: target };
}

export function readCodexCredential(kind, env = process.env) {
  const settings = readSettings(env);
  if (kind === "local" && settings?.localToken) return settings.localToken;
  if (kind === "upstream" && settings?.apiKey) return settings.apiKey;
  throw new Error(kind === "local" ? "MOMO local proxy token is not configured." : "MOMO API key is not configured.");
}

export function resolveInstalledCliPath(currentCliPath, env = process.env) {
  const stable = join(appHome(env), "app", "bin", "momoapi-proxy.mjs");
  return existsSync(stable) ? stable : currentCliPath;
}
