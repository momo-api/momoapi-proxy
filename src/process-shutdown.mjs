function boundedDeadline(timeoutMs) {
  return Number.isFinite(Number(timeoutMs)) ? Math.max(1, Math.min(60_000, Math.trunc(Number(timeoutMs)))) : 1000;
}

export async function closeLoggingWithinDeadline({ loggingRuntime, timeoutMs = 1000 } = {}) {
  const deadline = boundedDeadline(timeoutMs);
  if (typeof loggingRuntime?.close !== "function") return { completed: true, reason: "not_configured" };
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(() => loggingRuntime.close({ timeoutMs: deadline }))
        .then((result) => result || { completed: true, reason: "closed" })
        .catch(() => ({ completed: false, reason: "logging_close_failed" })),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve({ completed: false, reason: "timeout" }), deadline);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function closeServerAndLogging({ server, loggingRuntime, timeoutMs = 1000 } = {}) {
  const deadline = boundedDeadline(timeoutMs);
  let timer;
  const serverClosed = new Promise((resolve) => {
    if (!server?.listening) return resolve({ completed: true, reason: "not_listening" });
    try { server.close(() => resolve({ completed: true, reason: "closed" })); }
    catch { resolve({ completed: false, reason: "close_failed" }); }
  });
  const loggingClosed = closeLoggingWithinDeadline({ loggingRuntime, timeoutMs: deadline });
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve({ timedOut: true }), deadline); });
  const result = await Promise.race([
    Promise.all([serverClosed, loggingClosed]).then(([serverResult, loggingResult]) => ({ timedOut: false, server: serverResult, logging: loggingResult })),
    timeout,
  ]);
  clearTimeout(timer);
  return result;
}

export function createSignalStopper({ server, loggingRuntime, beforeStop, exitImpl = process.exit, timeoutMs = 1000 } = {}) {
  let stopPromise = null;
  return function stop() {
    if (stopPromise) return stopPromise;
    try { beforeStop?.(); } catch {}
    stopPromise = closeServerAndLogging({ server, loggingRuntime, timeoutMs }).finally(() => {
      try { exitImpl(0); } catch {}
    });
    return stopPromise;
  };
}
