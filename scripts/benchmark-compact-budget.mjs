// Local synthetic operations in fresh child processes; no upstream/model calls.
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { createHash } from "node:crypto";
import { cpus } from "node:os";
import { performance, PerformanceObserver, monitorEventLoopDelay } from "node:perf_hooks";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { compactFixture, compactCaseNames, compactOutcome } from "./compact-fixtures.mjs";
const arg = (name) => process.argv.find((value) => value.startsWith(name + "="))?.slice(name.length + 1);
const script = fileURLToPath(import.meta.url);
if (process.argv.includes("--worker")) {
  delete process.env.MOMO_COMPACT_BODY_LIMIT_MB;
  delete process.env.MOMO_MAX_HISTORICAL_REPLAY_MB;
  const api = await import(pathToFileURL(join(resolve(arg("--root")), "src/compaction.mjs")));
  const { body, operation } = compactFixture(arg("--case"));
  const inputBytes = Buffer.byteLength(JSON.stringify(body));
  global.gc?.();
  let gcCount = 0, gcMs = 0;
  const observer = new PerformanceObserver((list) => { for (const entry of list.getEntries()) { gcCount++; gcMs += entry.duration; } });
  observer.observe({ entryTypes: ["gc"] });
  const loop = monitorEventLoopDelay({ resolution: 5 }); loop.enable();
  await new Promise((done) => setTimeout(done, 15));
  const nativeStringify = JSON.stringify;
  let fullSerializations = 0;
  JSON.stringify = function (value, ...rest) { if (value === body) fullSerializations++; return nativeStringify(value, ...rest); };
  const start = performance.now();
  let outcome;
  try { outcome = compactOutcome(api, body, operation); }
  finally { JSON.stringify = nativeStringify; }
  const elapsedMs = performance.now() - start;
  const memory = process.memoryUsage();
  const osMaxRssMiB = process.resourceUsage().maxRSS / 1024;
  await new Promise((done) => setTimeout(done, 15));
  loop.disable(); observer.disconnect();
  const hash = createHash("sha256").update(JSON.stringify(outcome)).digest("hex");
  process.send({ case: arg("--case"), inputBytes, elapsedMs, fullSerializations, osMaxRssMiB, heapUsedMiB: memory.heapUsed / 1048576, externalMiB: memory.external / 1048576, gcCount, gcMs, loopMaxMs: loop.max / 1e6, hash, ...(outcome.error ? { code: outcome.error.code } : { trace: outcome.result.trace, rewritten: outcome.result.rewritten, outboundBytes: outcome.result.outboundBytes }) }, () => process.disconnect());
} else {
  const baseline = arg("--baseline-root");
  if (!baseline) throw new Error("Explicit --baseline-root=<clean old worktree> required");
  const rounds = Number(arg("--rounds") ?? 3);
  const cases = arg("--cases")?.split(",") ?? compactCaseNames;
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > 20 || cases.some((name) => !compactCaseNames.includes(name))) throw new Error("Invalid benchmark selection");
  const roots = { baseline: resolve(baseline), current: fileURLToPath(new URL("../", import.meta.url)) };
  const run = (kind, name) => new Promise((resolveRun, reject) => {
    const child = fork(script, ["--worker", "--root=" + roots[kind], "--case=" + name], { windowsHide: true, execArgv: ["--expose-gc", "--max-old-space-size=1024"], stdio: ["ignore", "ignore", "pipe", "ipc"] });
    let result;
    child.stderr.resume();
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Synthetic worker timed out")); }, 60000);
    child.on("message", (message) => { result = message; });
    child.once("error", (error) => { clearTimeout(timeout); reject(error); });
    child.once("exit", (code) => { clearTimeout(timeout); if (code !== 0 || !result) reject(new Error("Synthetic worker failed")); else resolveRun(result); });
  });
  const expected = new Map();
  for (let round = 1; round <= rounds; round++) for (const name of cases) for (const kind of round % 2 ? ["baseline", "current"] : ["current", "baseline"]) {
    const result = await run(kind, name);
    if (expected.has(name)) assert.equal(result.hash, expected.get(name), name + " body/trace/error must match baseline"); else expected.set(name, result.hash);
    console.log(JSON.stringify({ kind, round, ...result }));
  }
  console.log(JSON.stringify({ environment: { node: process.version, platform: process.platform, cpu: cpus()[0]?.model }, rounds, note: "Sequential alternating fresh processes, no warmup; hashes include entire outcome/body/trace/error. OS maxRSS includes startup/fixture/initial size; captured before hash. heap/external are end values, not peaks. GC/loop cover operation plus timer settling. Microbenchmark, no production or model-speed guarantee." }));
}
