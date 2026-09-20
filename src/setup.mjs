import { existsSync, readFileSync, writeFileSync, copyFileSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { codexHome, catalogPath, writeCatalog } from "./catalog.mjs";
import { newLocalToken, normalizeEndpoint, writeSettings, settingsPath } from "./config.mjs";
import { installAutostart, uninstallAutostart } from "./autostart.mjs";
import { installWindowsService, uninstallWindowsService } from "./service.mjs";
import { installImagePlugin as installBundledImagePlugin } from "./plugin-install.mjs";
import { resolveInstalledCliPath, switchCodexRoute } from "./codex-route.mjs";

export const MARKER = "# MOMOAPI_PROXY_MANAGED";
const VERIFIED_CODEX_MODELS = new Set(["ox-alpha-free"]);
const LEGACY_MOMO_COMPACT_PROMPT = "You are compacting an active Codex session. Produce a task handoff, not a replay of the previous assistant answer. Always preserve the latest user request as CURRENT ACTIVE TASK, distinguish already resolved historical issues from pending work, record current-turn progress and pending tool calls/results, preserve governing constraints, and state the next action. Never omit the latest user request when compaction occurs during a tool-using turn. Do not treat older user questions as active unless the latest request explicitly reopens them.";
const LEGACY_MOMO_COMPACT_PROMPT_LINE = "compact_prompt = " + JSON.stringify(LEGACY_MOMO_COMPACT_PROMPT);

function authPath(env) { return join(codexHome(env), "auth.json"); }
function configPath(env) { return join(codexHome(env), "config.toml"); }
function backup(file) {
  const bak = file + ".momo-proxy.bak";
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
    if (
      trimmed.includes("MOMOAPI_PROXY_MANAGED") ||
      trimmed.includes("MOMO_CODEX_BRIDGE_MANAGED") ||
      trimmed.includes("MOMO_CODEX_SWITCH_MANAGED")
    ) {
      continue;
    }
    if (trimmed.startsWith("[")) {
      if (
        trimmed === "[model_providers.momoapi-proxy]" ||
        trimmed === '[model_providers."momoapi-proxy"]' ||
        trimmed === '[model_providers."momoapi proxy"]' ||
        trimmed === "[model_providers.momo-codex-bridge]" ||
        trimmed === '[model_providers."momo-codex-bridge"]' ||
        trimmed === "[model_providers.momo-switch]" ||
        trimmed === '[model_providers."momo-switch"]' ||
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
    if (trimmed === LEGACY_MOMO_COMPACT_PROMPT_LINE) {
      continue;
    }
    if (
      trimmed.startsWith("model_provider =") ||
      trimmed.startsWith("model =") ||
      trimmed.startsWith("model_reasoning_effort =") ||
      trimmed.startsWith("model_catalog_json =") ||
      trimmed.startsWith("model_context_window =") ||
      trimmed.startsWith("model_auto_compact_token_limit =") ||
      trimmed.startsWith("model_auto_compact_token_limit_scope =") ||
      trimmed.startsWith("disable_response_storage =")
    ) {
      continue;
    }
    kept.push(line);
  }
  return kept.join("\n").trim();
}

function managedConfig(catalog, port, defaultModel, cleanedOther = "") {
  return MARKER + "\n" +
    'openai_base_url = "http://127.0.0.1:' + port + '/v1"\n' +
    'model_provider = "momoapi-proxy"\n' +
    'model = "' + defaultModel + '"\n' +
    'model_reasoning_effort = "high"\n' +
    'model_catalog_json = "' + catalog.replace(/\\/g, "/") + '"\n' +
    'disable_response_storage = false\n' +
    (cleanedOther ? "\n" + cleanedOther + "\n" : "") +
    '\n' +
    '[model_providers.momoapi-proxy]\n' +
    'name = "MOMO API Proxy"\n' +
    'base_url = "http://127.0.0.1:' + port + '/v1"\n' +
    'wire_api = "responses"\n' +
    'requires_openai_auth = false\n\n' +
    '[model_providers.momo-codex-bridge]\n' +
    'name = "MOMO Codex Bridge"\n' +
    'base_url = "http://127.0.0.1:' + port + '/v1"\n' +
    'wire_api = "responses"\n' +
    'requires_openai_auth = false\n';
}

export function migrateManagedCompactionConfig(env = process.env) {
  const target = configPath(env);
  if (!existsSync(target)) return { changed: false, reason: "not_found" };
  const original = readFileSync(target, "utf8");
  if (!original.includes(MARKER)) return { changed: false, reason: "unmanaged" };

  let updated = original.replace(
    /^model_context_window\s*=\s*272000\s*\r?\n?/m,
    "",
  ).replace(
    /^model_auto_compact_token_limit\s*=\s*(?:120000|180000)\s*\r?\n?/m,
    "",
  ).replace(
    /^model_auto_compact_token_limit_scope\s*=\s*"body_after_prefix"\s*\r?\n?/m,
    "",
  ).replace(
    new RegExp("^" + LEGACY_MOMO_COMPACT_PROMPT_LINE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\r?\\n?", "m"),
    "",
  );
  if (updated === original) return { changed: false, reason: "current" };
  writeFileSync(target, updated);
  return { changed: true, reason: "migrated" };
}

function isCodexCandidate(model) {
  const status = model.agent_status || model.agentStatus || "experimental";
  return model?.id && status !== "hidden" && status !== "image" && status !== "video";
}

export async function setup({
  apiKey,
  endpoint,
  port = 18789,
  autostart = true,
  desktopAliases = true,
  imagePlugin = true,
  imagePluginInstaller = installBundledImagePlugin,
  autostartInstaller = installAutostart,
  windowsServiceInstaller = installWindowsService,
  osPlatform = process.platform,
  fetchImpl = fetch,
  env = process.env,
} = {}) {
  if (!apiKey) throw new Error("--api-key is required.");
  const localToken = newLocalToken();
  const settings = {
    apiKey,
    endpoint: normalizeEndpoint(endpoint || "https://momoapi.us"),
    port,
    localToken,
    autostart: Boolean(autostart),
    desktopAliases: Boolean(desktopAliases),
    updateCheckEnabled: true,
    updateMode: "automatic",
    autoUpdateEnabled: true,
    updateCheckIntervalHours: 12,
    diagnosticsEnabled: true,
    imagePluginEnabled: Boolean(imagePlugin),
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
  const finalConfig = managedConfig(catalog, port, defaultModel, cleanedOther) + "\n";
  writeFileSync(config, finalConfig);
  writeFileSync(auth, JSON.stringify({
    OPENAI_API_KEY: localToken,
    "momo-codex-bridge": localToken,
    "momoapi-proxy": localToken,
    "momoapi proxy": localToken,
    "momo-switch": localToken
  }, null, 2) + "\n");
  const settingsFile = writeSettings(settings, env);
  const currentCliPath = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "momoapi-proxy.mjs");
  switchCodexRoute("proxy", {
    env,
    settings,
    nodePath: process.execPath,
    cliPath: resolveInstalledCliPath(currentCliPath, env),
  });

  let autostartResult = null;
  if (autostart) {
    try {
      if (osPlatform === "win32") {
        const binFile = fileURLToPath(import.meta.url);
        const bridgeBin = join(dirname(binFile), "..", "bin", "momo-codex-bridge.mjs");
        const serviceResult = windowsServiceInstaller(bridgeBin, { env });
        autostartResult = serviceResult.installed ? serviceResult : autostartInstaller(settings, { env, osPlatform });
      } else {
        autostartResult = autostartInstaller(settings, { env, osPlatform });
      }
    } catch (err) {
      if (osPlatform === "darwin") throw err;
      autostartResult = { installed: false, error: err.message };
    }
  }

  // Existing Codex tasks retain their provider name. The managed route block
  // now keeps every MOMO provider alias on the same endpoint, so setup no
  // longer rewrites unrelated rows in state_5.sqlite.
  const historyResult = { migrated: 0, strategy: "provider-aliases" };

  let imagePluginResult = {
    attempted: false,
    installed: false,
    enabled: false,
    message: "MOMO media plugin installation was skipped.",
  };
  if (imagePlugin) {
    try {
      imagePluginResult = imagePluginInstaller({ env });
    } catch (err) {
      imagePluginResult = {
        attempted: true,
        installed: false,
        enabled: false,
        errorCode: err.code || "codex_plugin_install_failed",
        message: "MOMO media plugin installation did not complete. Run 'momoapi plugin install' to retry.",
      };
    }
  }

  return {
    catalog,
    settingsFile,
    models: models.length,
    defaultModel,
    config,
    auth,
    localToken,
    autostart: autostartResult,
    historyMigrated: historyResult?.migrated || 0,
    imagePlugin: imagePluginResult,
  };
}

export function rollback(env = process.env) {
  const files = [configPath(env), authPath(env), catalogPath(env)];
  const restored = [];
  for (const file of files) {
    const source = existsSync(file + ".momo-proxy.bak")
      ? file + ".momo-proxy.bak"
      : (existsSync(file + ".momo-bridge.bak") ? file + ".momo-bridge.bak" : (existsSync(file + ".momo-switch.bak") ? file + ".momo-switch.bak" : null));
    if (!source) continue;
    copyFileSync(source, file);
    restored.push(file);
  }
  const dbPath = join(codexHome(env), "state_5.sqlite");
  const dbBak = existsSync(dbPath + ".momo-proxy.bak")
    ? dbPath + ".momo-proxy.bak"
    : (existsSync(dbPath + ".momo-bridge.bak") ? dbPath + ".momo-bridge.bak" : (existsSync(dbPath + ".momo-history.bak") ? dbPath + ".momo-history.bak" : null));
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
