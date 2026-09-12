// Synthetic localhost-only output pressure. Each run uses a fresh server process;
// the client consumes/discards output and is excluded from server RSS.
import { fork } from "node:child_process";
import { performance, monitorEventLoopDelay } from "node:perf_hooks";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir, cpus } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const script = fileURLToPath(import.meta.url);
const rootArg = process.argv.find((arg) => arg.startsWith("--server-root="));
const root = rootArg ? resolve(rootArg.slice(14)) : fileURLToPath(new URL("../", import.meta.url));
if (process.argv.includes("--worker")) {
  const scratch = mkdtempSync(join(tmpdir(), "momo-output-bench-"));
  process.env.MOMO_PROXY_HOME = scratch;
  console.log = () => {};
  const { createMomoSwitch } = await import(pathToFileURL(join(root, "src/server.mjs")));
  const loop = monitorEventLoopDelay({ resolution: 5 });
  let produced = 0, released = false, peak = 0;
  const sample = () => { peak = Math.max(peak, process.memoryUsage().rss); };
  const server = createMomoSwitch({ endpoint: "https://synthetic.invalid", apiKey: "synthetic_key", localToken: "synthetic_local", host: "127.0.0.1", port: 0 }, { fetchImpl: async (_url, init) => {
    const marker = JSON.parse(init.body).input?.at(-1)?.content?.[0]?.text || "small";
    const frames = marker === "flood" ? 8192 : marker === "normal" ? 256 : 4;
    return { ok: true, body: (async function* () {
      try {
        yield Buffer.from('data: {"type":"response.created","response":{"id":"resp_synthetic_bench"}}\n\n');
        for (let i = 0; i < frames; i++) {
          produced++; sample();
          yield Buffer.from('data: ' + JSON.stringify({ type: "response.output_text.delta", delta: "x".repeat(4096) }) + "\n\n");
          if (i % 32 === 0) await new Promise((resolve) => setImmediate(resolve));
        }
        yield Buffer.from('data: {"type":"response.completed","response":{"id":"resp_synthetic_bench","output":[]}}\n\n');
      } finally { released = true; }
    })() };
  } });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  global.gc?.(); loop.enable(); sample();
  process.send({ type: "ready", port: server.address().port });
  process.on("message", async () => {
    sample(); loop.disable();
    const summary = { type: "result", produced, released, peakSampledRssMiB: +(peak / 1048576).toFixed(2), osMaxRssMiB: +(process.resourceUsage().maxRSS / 1024).toFixed(2), heapUsedMiB: +(process.memoryUsage().heapUsed / 1048576).toFixed(2), loopMaxMs: +(loop.max / 1e6).toFixed(2) };
    server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
    rmSync(scratch, { recursive: true, force: true });
    process.send(summary, () => process.disconnect());
  });
} else {
  const roundsArg = process.argv.find((arg) => arg.startsWith("--rounds="));
  const rounds = roundsArg ? Number(roundsArg.slice(9)) : 3;
  const scenariosArg = process.argv.find((arg) => arg.startsWith("--scenarios="));
  const scenarios = scenariosArg ? scenariosArg.slice(12).split(",") : ["small", "normal", "flood"];
  if (!Number.isSafeInteger(rounds) || rounds < 1 || rounds > 20 || !scenarios.length || scenarios.some((name) => !["small", "normal", "flood"].includes(name))) throw new Error("Invalid synthetic benchmark selection");
  function wait(child, type, send) {
    return new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); child.off("message", receive); child.off("exit", ended); child.off("error", fail); };
      const receive = (value) => { if (value.type === type) { cleanup(); resolve(value); } };
      const fail = () => { cleanup(); reject(new Error("Synthetic benchmark worker failed")); };
      const ended = () => fail();
      const timer = setTimeout(() => { child.kill(); fail(); }, 30000);
      child.on("message", receive); child.once("exit", ended); child.once("error", fail);
      if (send) child.send("stop");
    });
  }
  const results = [];
  for (const scenario of scenarios) for (let round = 1; round <= rounds; round++) {
    const child = fork(script, ["--worker", "--server-root=" + root], { windowsHide: true, execArgv: ["--expose-gc", "--max-old-space-size=1024"], stdio: ["ignore", "ignore", "pipe", "ipc"] });
    child.stderr.resume();
    try {
      const { port } = await wait(child, "ready");
      const start = performance.now();
      const response = await fetch("http://127.0.0.1:" + port + "/v1/responses", { signal: AbortSignal.timeout(180000), method: "POST", headers: { authorization: "Bearer synthetic_local", "content-type": "application/json" }, body: JSON.stringify({ model: "gpt-5.6-sol", stream: true, input: [{ role: "user", content: scenario }] }) });
      let tail = "", completed = false, failed = false, bytes = 0;
      for await (const chunk of response.body) {
        bytes += chunk.length;
        tail = (tail + Buffer.from(chunk).toString("utf8")).slice(-20000);
        if (tail.includes('"type":"response.completed"')) completed = true;
        if (tail.includes('"type":"response.failed"')) failed = true;
      }
      const elapsedMs = +(performance.now() - start).toFixed(2);
      const memory = await wait(child, "result", true);
      results.push({ scenario, round, status: response.status, bytes, completed, failed, elapsedMs, ...memory });
    } finally { if (child.connected) child.kill(); }
  }
  console.log(JSON.stringify({ environment: { node: process.version, platform: process.platform, cpu: cpus()[0]?.model }, rounds, results, note: "Fresh-server samples; local synthetic small=16KiB, normal=1MiB, flood=32MiB text output. Budgets may intentionally reject flood; check terminal fields. Not production speed/RSS guarantees. Client excluded; sampled RSS may miss transients, OS lifetime maximum includes startup." }, null, 2));
}
