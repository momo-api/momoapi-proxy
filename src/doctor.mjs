import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isAutostartInstalled } from "./autostart.mjs";
import { catalogPath, readCatalog } from "./catalog.mjs";
import { resolveSettings } from "./config.mjs";

export function checkCodexHome(env = process.env) {
  const standardHome = join(homedir(), ".codex");
  const currentHome = env.CODEX_HOME || standardHome;
  const isOrca = /orca[\\/]codex-runtime-home/i.test(currentHome) || Boolean(env.ORCA_CODEX_HOME);
  const mismatch = isOrca || (Boolean(env.CODEX_HOME) && env.CODEX_HOME.toLowerCase() !== standardHome.toLowerCase());
  return {
    currentHome,
    standardHome,
    isOrca,
    mismatch,
    warning: mismatch
      ? "CODEX_HOME targets a non-standard runtime home (" + currentHome + ") instead of (" + standardHome + "); Codex/ChatGPT Desktop app may not see history."
      : null,
  };
}

export function checkCodexConfig(env = process.env) {
  const home = env.CODEX_HOME || join(homedir(), ".codex");
  const configFile = join(home, "config.toml");
  if (!existsSync(configFile)) {
    return { exists: false, managed: false, hasResponsesWire: false, error: "config.toml not found at " + configFile };
  }
  const content = readFileSync(configFile, "utf8");
  const managed = content.includes("MOMO_CODEX_SWITCH_MANAGED") || content.includes("[model_providers.momo-switch]") || content.includes("[model_providers.momoapi-proxy]") || content.includes('[model_providers."momoapi proxy"]');
  const hasResponsesWire = /wire_api\s*=\s*"responses"/i.test(content);
  return {
    exists: true,
    configFile,
    managed,
    hasResponsesWire,
  };
}

export async function runDoctor({ env = process.env, fetchImpl = fetch } = {}) {
  const results = {
    ok: true,
    timestamp: new Date().toISOString(),
    checks: {},
  };

  let settings = null;
  try {
    settings = resolveSettings(env);
    results.checks.settings = { ok: true, endpoint: settings.endpoint, port: settings.port, host: settings.host };
  } catch (err) {
    results.ok = false;
    results.checks.settings = { ok: false, error: err.message };
  }

  const homeCheck = checkCodexHome(env);
  results.checks.codexHome = {
    ok: !homeCheck.isOrca,
    ...homeCheck,
  };
  if (homeCheck.isOrca) results.ok = false;

  const configCheck = checkCodexConfig(env);
  results.checks.codexConfig = {
    ok: configCheck.exists && configCheck.managed && configCheck.hasResponsesWire,
    ...configCheck,
  };
  if (!configCheck.exists || !configCheck.managed || !configCheck.hasResponsesWire) results.ok = false;

  const catalog = readCatalog(env);
  const catPath = catalogPath(env);
  results.checks.catalog = {
    ok: Boolean(catalog?.models?.length),
    path: catPath,
    modelCount: catalog?.models?.length || 0,
  };
  if (!results.checks.catalog.ok) results.ok = false;

  results.checks.autostart = {
    installed: isAutostartInstalled(process.platform, env),
  };

  if (settings?.apiKey) {
    try {
      const res = await fetchImpl(settings.endpoint + "/v1/models", {
        headers: { authorization: "Bearer " + settings.apiKey },
      });
      results.checks.momoApi = {
        ok: res.ok,
        status: res.status,
        statusText: res.statusText,
      };
      if (!res.ok) results.ok = false;
    } catch (err) {
      results.ok = false;
      results.checks.momoApi = { ok: false, error: err.message };
    }
  } else {
    results.checks.momoApi = { ok: false, error: "API Key not configured" };
    results.ok = false;
  }

  return results;
}
