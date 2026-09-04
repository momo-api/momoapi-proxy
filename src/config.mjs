import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

export const DEFAULT_ENDPOINT = "https://momoapi.us";

export function appHome(env = process.env) {
  return env.MOMO_PROXY_HOME || env.MOMO_BRIDGE_HOME || env.MOMO_SWITCH_HOME || join(homedir(), ".momoapi-proxy");
}

export function settingsPath(env = process.env) {
  const primary = join(appHome(env), "settings.json");
  if (existsSync(primary)) return primary;
  const legacy1 = join(homedir(), ".momo-codex-bridge", "settings.json");
  if (existsSync(legacy1)) return legacy1;
  const legacy2 = join(homedir(), ".momo-codex-switch", "settings.json");
  if (existsSync(legacy2)) return legacy2;
  return primary;
}

export function readSettings(env = process.env) {
  const file = settingsPath(env);
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`Cannot parse ${file}: ${error.message}`);
  }
}

export function writeSettings(settings, env = process.env) {
  const directory = appHome(env);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = settingsPath(env);
  writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  try { chmodSync(file, 0o600); } catch { /* Windows has no POSIX permissions. */ }
  return file;
}

export function newLocalToken() {
  return randomBytes(32).toString("base64url");
}

export function resolveSettings(env = process.env) {
  const saved = readSettings(env);
  const apiKey = env.MOMO_API_KEY || saved.apiKey;
  const localToken = env.MOMO_BRIDGE_TOKEN || env.MOMO_SWITCH_TOKEN || saved.localToken;
  if (!apiKey) throw new Error("MOMO API key is not configured. Run setup with --api-key.");
  if (!localToken) throw new Error("MOMO Switch local token is not configured. Run setup again.");
  return {
    endpoint: (env.MOMO_API_ENDPOINT || env.MOMO_ENDPOINT || saved.endpoint || DEFAULT_ENDPOINT).replace(/\/$/, ""),
    apiKey,
    localToken,
    port: Number(env.MOMO_BRIDGE_PORT || env.MOMO_SWITCH_PORT || saved.port || 18789),
    host: "127.0.0.1",
    syncIntervalMinutes: Number(saved.syncIntervalMinutes || 60),
    desktopAliases: saved.desktopAliases !== false,
    autostart: saved.autostart !== false,
    lastSyncTime: saved.lastSyncTime || null,
    lastSyncStatus: saved.lastSyncStatus || null,
    lastError: saved.lastError || null,
  };
}
