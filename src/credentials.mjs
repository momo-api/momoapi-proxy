import { lockSettings, readSettings, writeSettingsLocked } from "./config.mjs";

export function credentialError(code, status = 400) {
  const messages = {
    key_required: "Enter a new API Key.",
    key_invalid: "The API Key was rejected (401). Existing settings were not changed.",
    key_forbidden: "Access was denied (403); this does not establish that the Key is expired.",
    key_rate_limited: "Validation was rate limited. Retry later.",
    key_upstream_error: "Upstream validation is temporarily unavailable.",
    key_network_error: "Validation could not connect. Check the network and retry.",
    key_timeout: "Validation timed out. Existing settings were not changed.",
    key_endpoint_untrusted: "Key validation is restricted to https://momoapi.us.",
    key_settings_missing: "Install MOMO API Proxy before changing the Key.",
    key_activation_failed: "Runtime activation failed; the previous Key was restored.",
    key_rollback_failed: "Key change failed and rollback could not be verified. Check service status.",
    key_runtime_mismatch: "Saved and running credentials differ. Restart the proxy before changing the Key.",
  };
  return Object.assign(new Error(messages[code] || "API Key operation failed."), { code, status });
}

export async function validateApiKey(apiKey, { endpoint = "https://momoapi.us", fetchImpl = fetch, timeoutMs = 12000 } = {}) {
  if (typeof apiKey !== "string" || !apiKey.trim() || apiKey.length > 4096 || /[\s\x00-\x1f\x7f]/.test(apiKey)) throw credentialError("key_required");
  let url;
  try { url = new URL(endpoint); } catch { throw credentialError("key_endpoint_untrusted"); }
  if (url.origin !== "https://momoapi.us" || url.username || url.password || url.search || url.hash || !["", "/"].includes(url.pathname)) throw credentialError("key_endpoint_untrusted");
  let response;
  try {
    response = await fetchImpl("https://momoapi.us/v1/models", {
      headers: { authorization: "Bearer " + apiKey }, redirect: "error", signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw credentialError(error?.name === "TimeoutError" || error?.name === "AbortError" ? "key_timeout" : "key_network_error", 503);
  }
  try { await response.body?.cancel(); } catch {}
  if (!response.ok) {
    const code = ({ 401: "key_invalid", 403: "key_forbidden", 429: "key_rate_limited" })[response.status] || "key_upstream_error";
    throw credentialError(code, response.status === 401 ? 422 : 503);
  }
  return { ok: true };
}

// The lock spans validation, persistence and runtime activation. No credential
// is returned, logged, copied to an ordinary backup or sent through argv.
export async function rotateApiKey(apiKey, { env = process.env, fetchImpl = fetch, runtimeSettings, activate = async () => {} } = {}) {
  const release = lockSettings(env);
  try {
    const previous = readSettings(env);
    if (!previous.apiKey || !previous.localToken) throw credentialError("key_settings_missing");
    if (runtimeSettings && (runtimeSettings.apiKey !== previous.apiKey || runtimeSettings.localToken !== previous.localToken || String(runtimeSettings.endpoint).replace(/\/+$/, "") !== String(previous.endpoint || "https://momoapi.us").replace(/\/+$/, ""))) throw credentialError("key_runtime_mismatch", 409);
    await validateApiKey(apiKey, { endpoint: previous.endpoint, fetchImpl });
    const updated = { ...previous, apiKey };
    writeSettingsLocked(updated, env);
    try {
      await activate(apiKey);
      // Publish only after activation succeeds. New requests must not observe
      // an uncommitted candidate while an async activation can still fail.
      if (runtimeSettings) runtimeSettings.apiKey = apiKey;
      if (runtimeSettings && runtimeSettings.apiKey !== apiKey) throw new Error("activation mismatch");
    } catch {
      try {
        writeSettingsLocked(previous, env);
        if (runtimeSettings) runtimeSettings.apiKey = previous.apiKey;
        await activate(previous.apiKey);
      } catch { throw credentialError("key_rollback_failed", 500); }
      throw credentialError("key_activation_failed", 500);
    }
    return { ok: true, runtime: runtimeSettings ? "reloaded" : "offline" };
  } finally { release(); }
}
