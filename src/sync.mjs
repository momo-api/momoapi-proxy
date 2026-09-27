import { readCatalog, writeCatalog } from "./catalog.mjs";
import { readSettings, writeSettings } from "./config.mjs";

const VERIFIED_CODEX_MODELS = new Set(["ox-alpha-free", "gpt-5.5", "gpt-5.4", "deepseek-v4-pro", "claude-opus-4-6-thinking", "gemini-3.7-flash"]);

export async function fetchMomoModels({ apiKey, endpoint = "https://momoapi.us", fetchImpl = fetch } = {}) {
  const base = endpoint.replace(/\/$/, "");
  try {
    const res = await fetchImpl(base + "/agent/catalog", { headers: { authorization: "Bearer " + apiKey } });
    if (res.ok) {
      const data = await res.json();
      return data.data || data.models || [];
    }
  } catch {
    // Fallback below
  }

  const fallbackRes = await fetchImpl(base + "/v1/models", { headers: { authorization: "Bearer " + apiKey } });
  if (!fallbackRes.ok) {
    throw new Error("MOMO model catalog request failed (" + fallbackRes.status + ").");
  }
  const payload = await fallbackRes.json();
  return (payload.data || []).map((model) => ({
    ...model,
    agent_status: VERIFIED_CODEX_MODELS.has(model.id) ? "stable" : (model.agent_status || model.agentStatus || "experimental"),
  }));
}

export async function syncCatalog({ apiKey, endpoint, env = process.env, fetchImpl = fetch } = {}) {
  const current = readCatalog(env);
  const models = await fetchMomoModels({ apiKey, endpoint, fetchImpl });
  const target = writeCatalog(models, env);
  const updated = readCatalog(env);
  const changed = JSON.stringify(current) !== JSON.stringify(updated);

  const settings = readSettings(env);
  if (settings.apiKey) {
    settings.lastSyncTime = new Date().toISOString();
    settings.lastSyncStatus = "ok";
    delete settings.lastError;
    writeSettings(settings, env);
  }

  return { success: true, count: updated?.models?.length || 0, changed, target };
}

export function startAutoSync({ settings, fetchImpl = fetch, env = process.env, onSync } = {}) {
  const intervalMs = Math.max(0.001, settings.syncIntervalMinutes || 60) * 60 * 1000;
  
  const doSync = async () => {
    try {
      const result = await syncCatalog({
        apiKey: settings.apiKey,
        endpoint: settings.endpoint,
        env,
        fetchImpl,
      });
      if (onSync) onSync(null, result);
    } catch (err) {
      const currentSettings = readSettings(env);
      if (currentSettings.apiKey) {
        currentSettings.lastSyncTime = new Date().toISOString();
        currentSettings.lastSyncStatus = "error";
        currentSettings.lastError = err.message;
        writeSettings(currentSettings, env);
      }
      if (onSync) onSync(err);
    }
  };

  // Run in background on startup
  doSync();

  const timer = setInterval(doSync, intervalMs);
  if (timer.unref) timer.unref();
  return {
    stop: () => clearInterval(timer),
  };
}
