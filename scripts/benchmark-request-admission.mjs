// Loopback-only synthetic integration matrix. Each sample starts a new server
// process so server RSS/GC do not include the HTTP client's large fixture.
import { fork } from "node:child_process";
import { request } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir, cpus } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance, monitorEventLoopDelay, PerformanceObserver } from "node:perf_hooks";

const worker = process.argv.includes("--worker");
const token = "synthetic_benchmark_local";
const script = fileURLToPath(import.meta.url);
const rootArg = process.argv.find((arg) => arg.startsWith("--server-root="));
const serverRoot = rootArg ? resolve(rootArg.slice("--server-root=".length)) : fileURLToPath(new URL("../", import.meta.url));
const MIB = 1024 * 1024;

if (worker) {
  const scratch = mkdtempSync(join(tmpdir(), "momo-admission-bench-"));
  process.env.MOMO_PROXY_HOME = scratch;
  console.log = () => {}; // Suppress synthetic request logs; only aggregate IPC.
  const { createMomoSwitch } = await import(pathToFileURL(join(serverRoot, "src/server.mjs")));
  const loop = monitorEventLoopDelay({ resolution: 5 });
  let gcCount = 0, gcMs = 0, sampling = false;
  let peak = { rss: 0, heapUsed: 0, external: 0, arrayBuffers: 0 };
  const sample = () => { if (sampling) { const value = process.memoryUsage(); for (const key of Object.keys(peak)) peak[key] = Math.max(peak[key], value[key]); } };
  const gc = new PerformanceObserver((list) => { if (sampling) for (const entry of list.getEntries()) { gcCount++; gcMs += entry.duration; } });
  gc.observe({ entryTypes: ["gc"] });
  const server = createMomoSwitch({ endpoint: "https://synthetic.invalid", apiKey: "synthetic_gateway", localToken: token, host: "127.0.0.1", port: 0 }, { fetchImpl: async () => {
    sample();
    await new Promise((resolve) => setTimeout(resolve, 40));
    return new Response('data: {"type":"response.completed","response":{"id":"synthetic_bench","output":[]}}\n\n');
  } });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const interval = setInterval(sample, 5);
  process.send({ type: "ready", port: server.address().port, node: process.version });
  process.on("message", async (message) => {
    if (message === "start") {
      global.gc?.(); gcCount = 0; gcMs = 0; sampling = true; loop.enable(); sample();
      process.send({ type: "started" });
    }
    if (message === "stop") {
      sample(); loop.disable(); sampling = false; clearInterval(interval); gc.disconnect();
      const result = { peakSampledMiB: Object.fromEntries(Object.entries(peak).map(([key, value]) => [key, +(value / MIB).toFixed(2)])), processLifetimeMaxRssMiB: +(process.resourceUsage().maxRSS / 1024).toFixed(2), gcCount, gcMs: +gcMs.toFixed(2), eventLoopDelayMs: { p95: +(loop.percentile(95) / 1e6).toFixed(2), max: +(loop.max / 1e6).toFixed(2) } };
      server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
      // Only this process's freshly-created synthetic fixture directory.
      rmSync(scratch, { recursive: true, force: true });
      process.send({ type: "result", ...result }, () => process.disconnect());
    }
  });
} else {
  const roundsArg = process.argv.find((arg) => arg.startsWith("--rounds="));
  const rounds = roundsArg ? Number(roundsArg.split("=")[1]) : 3;
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > 10) throw new Error("rounds must be 1..10");
  function exchange(child, expected, send) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); child.kill(); reject(new Error("Benchmark worker deadline exceeded")); }, 30000);
      const cleanup = () => { clearTimeout(timer); child.off("message", onMessage); child.off("exit", onExit); child.off("error", onError); };
      const onMessage = (value) => { if (value.type === expected) { cleanup(); resolve(value); } };
      const onExit = (code) => { cleanup(); reject(new Error("Worker exited early: " + code)); };
      const onError = (error) => { cleanup(); reject(error); };
      child.on("message", onMessage); child.once("exit", onExit); child.once("error", onError);
      if (send) child.send(send);
    });
  }
  function post(port, payload) {
    return new Promise((resolve, reject) => {
      const start = performance.now();
      const client = request({ host: "127.0.0.1", port, path: "/v1/responses", method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json", "content-length": Buffer.byteLength(payload) } }, (response) => {
        response.resume(); response.on("end", () => resolve({ status: response.statusCode, ms: +(performance.now() - start).toFixed(2) })); response.on("error", reject);
      });
      client.on("error", reject); client.setTimeout(30000, () => client.destroy(new Error("Loopback upload deadline"))); client.end(payload);
    });
  }
  const results = [];
  for (const mib of [10, 25, 50]) for (const concurrency of [1, 2, 4]) for (let round = 1; round <= rounds; round++) {
    const child = fork(script, ["--worker", "--server-root=" + serverRoot], { execArgv: ["--expose-gc", "--max-old-space-size=1536"], stdio: ["ignore", "ignore", "pipe", "ipc"], windowsHide: true });
    child.stderr.resume(); // Never relay an unexpected file/credential-bearing stack.
    try {
      const { port } = await exchange(child, "ready");
      const fixture = JSON.stringify({ model: "gpt-5.6-sol", stream: true, input: [{ role: "developer", content: "Preserve constraints and task continuity." }, { role: "user", content: "Synthetic task" }, ...Array.from({ length: Math.ceil(mib * MIB / 60000) }, () => ({ role: "assistant", content: "x".repeat(60000) })), { role: "user", content: "Continue synthetic task" }] });
      await exchange(child, "started", "start");
      const responses = await Promise.all(Array.from({ length: concurrency }, () => post(port, fixture)));
      const metrics = await (await fetch("http://127.0.0.1:" + port + "/internal/metrics", { headers: { "x-local-token": token } })).json();
      if (metrics.admission && (metrics.admission.active || metrics.admission.queued || metrics.admission.reservedBytes)) throw new Error("Admission lease did not return to zero");
      const memory = await exchange(child, "result", "stop");
      results.push({ mib, concurrency, round, requestBytes: Buffer.byteLength(fixture), responses, admission: metrics.admission || null, ...memory });
      if (responses.some((response) => response.status !== 200)) throw new Error("Synthetic matrix request did not succeed");
    } finally { if (child.connected) child.kill(); }
  }
  console.log(JSON.stringify({ environment: { node: process.version, platform: process.platform, cpu: cpus()[0]?.model }, rounds, results, note: "Fresh server process per sample; loopback client excluded from server memory. Synthetic ASCII history + 40ms mock upstream, not production/model latency. Sampled heap/external can miss synchronous transient peaks; OS lifetime maxRSS includes process startup. Raw ingress budget is not an RSS cap. No production requests or credentials." }, null, 2));
}
