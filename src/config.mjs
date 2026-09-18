import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

export const DEFAULT_ENDPOINT = "https://momoapi.us";

export function userHome(env = process.env) {
  return env.USERPROFILE || env.HOME || homedir();
}

export function normalizeEndpoint(value = DEFAULT_ENDPOINT) {
  const normalized = String(value || DEFAULT_ENDPOINT).replace(/\/+$/, "");
  let parsed;
  try {
    parsed = new URL(normalized);
  } catch {
    throw Object.assign(new Error("MOMO API endpoint must be a valid HTTP(S) URL."), { code: "endpoint_invalid" });
  }
  if (!new Set(["http:", "https:"]).has(parsed.protocol)) {
    throw Object.assign(new Error("MOMO API endpoint must use HTTP or HTTPS."), { code: "endpoint_invalid" });
  }
  const hostname = parsed.hostname.toLowerCase();
  if (hostname === "gateway.example" || hostname.endsWith(".example") || hostname.endsWith(".invalid") || hostname.endsWith(".test")) {
    throw Object.assign(new Error("MOMO API endpoint is a reserved placeholder hostname."), { code: "endpoint_placeholder" });
  }
  return normalized;
}

export function appHome(env = process.env) {
  return env.MOMO_PROXY_HOME || env.MOMO_BRIDGE_HOME || env.MOMO_SWITCH_HOME || join(userHome(env), ".momoapi-proxy");
}

export function settingsPath(env = process.env) {
  const primary = join(appHome(env), "settings.json");
  if (existsSync(primary)) return primary;
  if (env.MOMO_PROXY_HOME || env.MOMO_BRIDGE_HOME || env.MOMO_SWITCH_HOME) return primary;
  const home = userHome(env);
  const legacy1 = join(home, ".momo-codex-bridge", "settings.json");
  if (existsSync(legacy1)) return legacy1;
  const legacy2 = join(home, ".momo-codex-switch", "settings.json");
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

export function daemonEnvironment(env = process.env) {
  const sanitized = { ...env };
  // Command-scoped overrides are useful for setup and diagnostics, but a
  // detached daemon must use the persisted installation settings. Otherwise
  // a terminal (or Codex) with a temporary endpoint/port override can poison
  // every request until the service is manually reinstalled or restarted.
  let saved = {};
  try { saved = readSettings(env); } catch {}
  const persistedOverrides = [
    [Boolean(saved.endpoint), ["MOMO_API_ENDPOINT", "MOMO_ENDPOINT"]],
    [saved.port !== undefined && saved.port !== null, ["MOMO_BRIDGE_PORT", "MOMO_SWITCH_PORT"]],
    [Boolean(saved.localToken), ["MOMO_BRIDGE_TOKEN", "MOMO_SWITCH_TOKEN"]],
  ];
  for (const [persisted, names] of persistedOverrides) {
    if (!persisted) continue;
    for (const name of names) delete sanitized[name];
  }
  return sanitized;
}

export function resolveDaemonSettings(env = process.env) {
  return resolveSettings(daemonEnvironment(env));
}

export function resolveSettings(env = process.env) {
  const saved = readSettings(env);
  const updateMode = new Set(["automatic", "notify", "manual"]).has(saved.updateMode)
    ? saved.updateMode
    : (saved.autoUpdateEnabled === false ? "notify" : "automatic");
  const imageAssets = saved.imageAssets && typeof saved.imageAssets === "object" ? saved.imageAssets : {};
  const attachmentAssets = saved.attachmentAssets && typeof saved.attachmentAssets === "object" ? saved.attachmentAssets : {};
  // An installed daemon must remain pinned to its saved credential. Long-lived
  // shells (Codex/Desktop in particular) can retain an older process-level
  // MOMO_API_KEY after the user's credential has been updated. Treat the env
  // value as bootstrap/fallback only when no saved key exists.
  const apiKey = saved.apiKey || env.MOMO_API_KEY;
  const localToken = env.MOMO_BRIDGE_TOKEN || env.MOMO_SWITCH_TOKEN || saved.localToken;
  if (!apiKey) throw new Error("MOMO API key is not configured. Run setup with --api-key.");
  if (!localToken) throw new Error("MOMO Switch local token is not configured. Run setup again.");
  return {
    endpoint: normalizeEndpoint(env.MOMO_API_ENDPOINT || env.MOMO_ENDPOINT || saved.endpoint || DEFAULT_ENDPOINT),
    apiKey,
    localToken,
    port: Number(env.MOMO_BRIDGE_PORT || env.MOMO_SWITCH_PORT || saved.port || 18789),
    host: "127.0.0.1",
    syncIntervalMinutes: Number(saved.syncIntervalMinutes || 60),
    updateCheckEnabled: saved.updateCheckEnabled !== false,
    updateMode,
    autoUpdateEnabled: updateMode === "automatic" && saved.autoUpdateEnabled !== false,
    updateCheckIntervalHours: Math.max(1, Number(saved.updateCheckIntervalHours || 12)),
    desktopAliases: saved.desktopAliases !== false,
    autostart: saved.autostart !== false,
    lastSyncTime: saved.lastSyncTime || null,
    lastSyncStatus: saved.lastSyncStatus || null,
    lastError: saved.lastError || null,
    diagnosticsEnabled: saved.diagnosticsEnabled !== false,
    imagePluginEnabled: saved.imagePluginEnabled !== false,
    maxRequestBodyMb: saved.maxRequestBodyMb ? Number(saved.maxRequestBodyMb) : 144,
    requestAdmission: saved.requestAdmission && typeof saved.requestAdmission === "object" ? saved.requestAdmission : {},
    outputPolicy: saved.outputPolicy && typeof saved.outputPolicy === "object" ? saved.outputPolicy : {},
    contextPolicy: saved.contextPolicy && typeof saved.contextPolicy === "object" ? saved.contextPolicy : {},
    imageAssetDirectory: join(appHome(env), "images"),
    attachmentAssetDirectory: join(appHome(env), "attachments"),
    attachmentAssets: {
      enabled: attachmentAssets.enabled !== false,
      maxFileMb: attachmentAssets.maxFileMb === undefined ? 50 : Number(attachmentAssets.maxFileMb),
      maxBatchMb: attachmentAssets.maxBatchMb === undefined ? 100 : Number(attachmentAssets.maxBatchMb),
      inlineImageMb: attachmentAssets.inlineImageMb === undefined ? 6 : Number(attachmentAssets.inlineImageMb),
      inlineFileMb: attachmentAssets.inlineFileMb === undefined ? 2 : Number(attachmentAssets.inlineFileMb),
      inlineBatchMb: attachmentAssets.inlineBatchMb === undefined ? 5.5 : Number(attachmentAssets.inlineBatchMb),
      uploadTimeoutMs: attachmentAssets.uploadTimeoutMs === undefined ? 180000 : Number(attachmentAssets.uploadTimeoutMs),
    },
    imageAssets: {
      maxAssetMb: imageAssets.maxAssetMb === undefined ? 20 : Number(imageAssets.maxAssetMb),
      maxTotalMb: imageAssets.maxTotalMb === undefined ? 2048 : Number(imageAssets.maxTotalMb),
      maxAssets: imageAssets.maxAssets === undefined ? 2000 : Number(imageAssets.maxAssets),
      retentionDays: imageAssets.retentionDays === undefined ? 30 : Number(imageAssets.retentionDays),
    },
  };
}
