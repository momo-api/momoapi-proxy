import { connect } from "node:net";
import { readSettings } from "./config.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const failure = (code) => Object.assign(new Error("Managed proxy operation could not be verified (" + code + "). No port-owner process was killed."), { code });
function parameters(settings) {
  const port = Number(settings.port || 18789);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !settings.localToken) throw failure("runtime_config_invalid");
  return { port, base: "http://127.0.0.1:" + port, token: settings.localToken };
}

export async function probeManagedRuntime(settings = readSettings(), { fetchImpl = fetch } = {}) {
  const { base, token } = parameters(settings);
  let response;
  try {
    response = await fetchImpl(base + "/internal/metrics", { redirect: "error", signal: AbortSignal.timeout(2000), headers: { "x-local-token": token } });
  } catch (error) {
    if (error?.cause?.code === "ECONNREFUSED") return { running: false };
    throw failure("runtime_probe_ambiguous");
  }
  const result = await response.json().catch(() => null);
  if (!response.ok || result?.ok !== true) throw failure("runtime_untrusted");
  return { running: true };
}

export function portIsClosed(port, { connectImpl = connect } = {}) {
  return new Promise((resolve, reject) => {
    const socket = connectImpl({ host: "127.0.0.1", port });
    const finish = (closed, error) => { socket.destroy(); error ? reject(failure("runtime_port_ambiguous")) : resolve(closed); };
    socket.once("connect", () => finish(false));
    // ECONNRESET can occur while the authenticated daemon drains. It does
    // not prove closure: keep waiting within the bounded shutdown deadline.
    socket.once("error", (error) => finish(error.code === "ECONNREFUSED", !["ECONNREFUSED", "ECONNRESET"].includes(error.code)));
    socket.setTimeout(1000, () => finish(false, true));
  });
}

// An authenticated old runtime already supports graceful shutdown. Never
// infer ownership from an unauthenticated health endpoint, PID or port number.
export async function stopManagedRuntime(settings = readSettings(), {
  fetchImpl = fetch, portClosed = portIsClosed, timeoutMs = 10000, delay = sleep,
} = {}) {
  const { port, base, token } = parameters(settings);
  const status = await probeManagedRuntime(settings, { fetchImpl });
  if (!status.running) return { stopped: true, unchanged: true };
  let response;
  try {
    response = await fetchImpl(base + "/internal/shutdown", { method: "POST", redirect: "error", signal: AbortSignal.timeout(2500), headers: { "x-local-token": token } });
  } catch { throw failure("runtime_shutdown_ambiguous"); }
  const result = await response.json().catch(() => null);
  if (!response.ok || result?.ok !== true) throw failure("runtime_shutdown_refused");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await portClosed(port)) { await delay(200); if (await portClosed(port)) return { stopped: true }; }
    await delay(100);
  }
  throw failure("runtime_shutdown_timeout");
}
