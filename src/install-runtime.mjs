import { existsSync } from "node:fs";
import { installAutostart, autostartTarget } from "./autostart.mjs";
import { stopManagedRuntime } from "./runtime-control.mjs";

// Only an explicit terminal installation can migrate a legacy runtime.
// No port-based process killing, unauthenticated health shortcut or Key write.
export async function upgradeMacInstallRuntime(saved, {
  env = process.env, osPlatform = process.platform, fetchImpl = fetch,
  autostartInstaller = installAutostart, existsSyncImpl = existsSync,
  stopRuntime = stopManagedRuntime, startRuntime,
  timeoutMs = 12000, delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  if (osPlatform !== "darwin") {
    if (!["win32", "linux"].includes(osPlatform) || typeof startRuntime !== "function") throw new Error("Legacy runtime migration requires a verified runtime starter.");
    await stopRuntime(saved, { fetchImpl });
    await startRuntime();
  } else if (saved.autostart === false || !saved.localToken || !existsSyncImpl(autostartTarget("darwin", env))) {
    throw new Error("Legacy runtime requires a managed Mac login service. Update/restart that service before installing; no credential was changed by this migration.");
  }
  const base = "http://127.0.0.1:" + saved.port;
  const options = () => ({ redirect: "error", signal: AbortSignal.timeout(2000), headers: { "x-local-token": saved.localToken } });
  let authorized;
  if (osPlatform === "darwin") {
    try { authorized = await fetchImpl(base + "/internal/metrics", options()); } catch { throw new Error("Cannot authenticate legacy runtime; migration refused."); }
    const metrics = await authorized.json().catch(() => null);
    if (!authorized.ok || metrics?.ok !== true) throw new Error("Cannot authenticate legacy runtime; migration refused.");
    // Boot only the exact managed label using OLD settings/current source.
    autostartInstaller(saved, { env, osPlatform: "darwin" });
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetchImpl(base + "/internal/capabilities", options());
      const capabilities = await response.json().catch(() => null);
      if (response.ok && capabilities?.ok === true && capabilities.apiKeyChange === true) return { upgraded: true };
    } catch { /* Wait for this managed LaunchAgent, never kill a port owner. */ }
    await delay(150);
  }
  throw new Error("Managed runtime migration was attempted but credential-change readiness was not confirmed. Key was not changed by migration; check momoapi doctor.");
}
