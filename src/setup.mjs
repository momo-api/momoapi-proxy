import { existsSync, readFileSync, writeFileSync, copyFileSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { codexHome, catalogPath, writeCatalog } from "./catalog.mjs";
import { newLocalToken, writeSettings, settingsPath } from "./config.mjs";
import { installAutostart, uninstallAutostart } from "./autostart.mjs";
import { installWindowsService, uninstallWindowsService } from "./service.mjs";
import { migrateHistory } from "./history.mjs";

export const MARKER = "# MOMO_CODEX_BRIDGE_MANAGED";
const VERIFIED_CODEX_MODELS = new Set(["ox-alpha-free"]);

function authPath(env) { return join(codexHome(env), "auth.json"); }
function configPath(env) { return join(codexHome(env), "config.toml"); }
function backup(file) {
  const bak = file + ".momo-bridge.bak";
  if (existsSync(file) && !existsSync(bak)) {
    copyFileSync(file, bak);
  }
}

export function cleanConfigToml(content) {
  if (!content) return "";
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const kept = [];
  let inMomoSection = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed.includes("MOMO_CODEX_SWITCH_MANAGED") || trimmed.includes("MOMO_CODEX_BRIDGE_MANAGED")) {
      continue;
    }
    if (trimmed.startsWith("[")) {
      if (
        trimmed === "[model_providers.momo-codex-bridge]" ||
        trimmed === '[model_providers."momo-codex-bridge"]' ||
        trimmed === "[model_providers.momo-switch]" ||
        trimmed === '[model_providers."momo-switch"]' ||
        trimmed === "[model_providers.momoapi-proxy]" ||
        trimmed === '[model_providers."momoapi-proxy"]' ||
        trimmed === '[model_providers."momoapi proxy"]' ||
        trimmed === "[model_providers.momo]" ||
        trimmed === '[model_providers."momo"]'
      ) {
        inMomoSection = true;
        continue;
      } else {
        inMomoSection = false;
      }
    }
    if (inMomoSection) {
      continue;
    }
    if (
      trimmed.startsWith("model_provider =") ||
      trimmed.startsWith("model =") ||
      trimmed.startsWith("model_reasoning_effort =") ||
      trimmed.startsWith("model_catalog_json =") ||
      trimmed.startsWith("disable_response_storage =")
    ) {
      continue;
    }
    kept.push(line);
  }
  return kept.join("\n").trim();
}

function managedConfig(catalog, port, defaultModel) {
  return MARKER + "\n" +
    'openai_base_url = "http://127.0.0.1:' + port + '/v1"\n' +
    'model_provider = "momo-codex-bridge"\n' +
    'model = "' + defaultModel + '"\n' +
    'model_reasoning_effort = "high"\n' +
    'model_catalog_json = "' + catalog.replace(/\\/g, "/") + '"\n' +
    'disable_response_storage = false\n\n' +
    '[model_providers.momo-codex-bridge]\n' +
    'name = "MOMO Codex Bridge"\n' +
    'base_url = "http://127.0.0.1:' + port + '/v1"\n' +
    'wire_api = "responses"\n' +
    'requires_openai_auth = false\n\n' +
    '[model_providers.momoapi-proxy]\n' +
    'name = "MOMO API Proxy"\n' +
    'base_url = "http://127.0.0.1:' + port + '/v1"\n' +
    'wire_api = "responses"\n' +
    'requires_openai_auth = false\n';
}

function isCodexCandidate(model) {
  const status = model.agent_status || model.agentStatus || "experimental";
  return model?.id && status !== "hidden" && status !== "image" && status !== "video";
}

export async function setup({ apiKey, endpoint, port = 18789, autostart = true, desktopAliases = true, fetchImpl = fetch, env = process.env } = {}) {
  if (!apiKey) throw new Error("--api-key is required.");
  const localToken = newLocalToken();
  const settings = {
    apiKey,
    endpoint: (endpoint || "https://momoapi.us").replace(/\/$/, ""),
    port,
    localToken,
    autostart: Boolean(autostart),
    desktopAliases: Boolean(desktopAliases),
  };
  const modelsResponse = await fetchImpl(settings.endpoint + "/agent/catalog", { headers: { authorization: "Bearer " + apiKey } });
  let models;
  if (modelsResponse.ok) {
    const payload = await modelsResponse.json();
    models = payload.data || payload.models || [];
  } else {
    const fallback = await fetchImpl(settings.endpoint + "/v1/models", { headers: { authorization: "Bearer " + apiKey } });
    if (!fallback.ok) throw new Error("MOMO model catalog request failed (" + fallback.status + ").");
    const payload = await fallback.json();
    models = (payload.data || []).map((model) => ({
      ...model,
      agent_status: VERIFIED_CODEX_MODELS.has(model.id) ? "stable" : "experimental",
    }));
  }
  const config = configPath(env);
  const auth = authPath(env);
  const catalog = catalogPath(env);
  backup(config); backup(auth); backup(catalog);
  const previousRaw = existsSync(config) ? readFileSync(config, "utf8") : "";
  const cleanedOther = cleanConfigToml(previousRaw);
  const candidates = models.filter(isCodexCandidate);
  const PREFERRED_DEFAULTS = ["gpt-5.6-sol", "gpt-5.5", "gpt-5.4", "claude-opus-4-6-thinking"];
  const defaultModel =
    candidates.find((m) => m.id === "gpt-5.6-sol")?.id ||
    candidates.find((m) => PREFERRED_DEFAULTS.includes(m.id))?.id ||
    candidates.find((m) => (m.agent_status || m.agentStatus) === "stable")?.id ||
    candidates[0]?.id;
  if (!defaultModel) throw new Error("MOMO returned no Codex-compatible models.");
  writeCatalog(models, env, { includeDesktopAliases: desktopAliases });
  const finalConfig = managedConfig(catalog, port, defaultModel) + (cleanedOther ? "\n\n" + cleanedOther + "\n" : "\n");
  writeFileSync(config, finalConfig);
  writeFileSync(auth, JSON.stringify({
    OPENAI_API_KEY: localToken,
    "momo-codex-bridge": localToken,
    "momoapi-proxy": localToken,
    "momoapi proxy": localToken,
    "momo-switch": localToken
  }, null, 2) + "\n");
  const settingsFile = writeSettings(settings, env);

  let autostartResult = null;
  if (autostart) {
    try {
      if (process.platform === "win32") {
        const binFile = fileURLToPath(import.meta.url);
        const bridgeBin = join(dirname(binFile), "..", "bin", "momo-codex-bridge.mjs");
        const serviceResult = installWindowsService(bridgeBin);
        autostartResult = serviceResult.installed ? serviceResult : installAutostart(settings, { env });
      } else {
        autostartResult = installAutostart(settings, { env });
      }
    } catch (err) {
      autostartResult = { installed: false, error: err.message };
    }
  }

  let historyResult = null;
  try {
    historyResult = await migrateHistory({ dbPath: join(codexHome(env), "state_5.sqlite"), targetProvider: "momo-codex-bridge" });
  } catch (err) {
    historyResult = { migrated: 0, error: err.message };
  }

  return { catalog, settingsFile, models: models.length, defaultModel, config, auth, localToken, autostart: autostartResult, historyMigrated: historyResult?.migrated || 0 };
}

export function rollback(env = process.env) {
  const files = [configPath(env), authPath(env), catalogPath(env)];
  const restored = [];
  for (const file of files) {
    const source = existsSync(file + ".momo-bridge.bak")
      ? file + ".momo-bridge.bak"
      : (existsSync(file + ".momo-switch.bak") ? file + ".momo-switch.bak" : null);
    if (!source) continue;
    copyFileSync(source, file);
    restored.push(file);
  }
  const dbPath = join(codexHome(env), "state_5.sqlite");
  const dbBak = existsSync(dbPath + ".momo-bridge.bak") ? dbPath + ".momo-bridge.bak" : (existsSync(dbPath + ".momo-history.bak") ? dbPath + ".momo-history.bak" : null);
  if (dbBak) {
    try { copyFileSync(dbBak, dbPath); restored.push(dbPath); } catch {}
  }
  return restored;
}

export function uninstall({ env = process.env, removeKey = false } = {}) {
  uninstallAutostart({ env });
  const restored = rollback(env);
  let keyRemoved = false;
  if (removeKey) {
    const file = settingsPath(env);
    if (existsSync(file)) {
      unlinkSync(file);
      keyRemoved = true;
    }
  }
  return { uninstalled: true, restoredFiles: restored, keyRemoved };
}
