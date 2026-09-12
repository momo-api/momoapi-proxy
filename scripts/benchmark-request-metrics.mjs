// Synthetic instrumentation cost only; no network, real payloads or secrets.
import { performance } from "node:perf_hooks";
import { cpus } from "node:os";
import { RequestMetrics } from "../src/request-metrics.mjs";

const iterations = 20000;
const rounds = 7;
const response = Object.freeze({ status: 200 });
const fetchMock = async () => response;
const collector = new RequestMetrics();
async function run(instrumented, count) {
  const started = performance.now();
  for (let i = 0; i < count; i++) {
    if (instrumented) {
      const timing = collector.begin("POST", "/responses");
      timing.observe("queueWaitMs", 1);
      timing.observe("bodyReadMs", 2);
      timing.observe("bodyParseMs", 3);
      timing.bodyReady();
      await timing.wrapFetch(fetchMock)("synthetic");
      timing.sse(); timing.firstWrite(); timing.finish(200);
    } else { await fetchMock("synthetic"); }
  }
  return (performance.now() - started) * 1000 / count;
}
await run(false, 2000); await run(true, 2000);
const samples = [];
for (let round = 1; round <= rounds; round++) {
  for (const instrumented of round % 2 ? [false, true] : [true, false]) {
    samples.push({ round, instrumented, microsecondsPerRequest: await run(instrumented, iterations) });
  }
}
// Fill every fixed stage window before measuring query-time sorting.
for (const [method, path] of [["GET", "/health"], ["GET", "/internal/metrics"], ["POST", "/internal/images/generate"], ["GET", "/unknown"]]) {
  for (let i = 0; i < 500; i++) {
    const timing = collector.begin(method, path);
    for (const stage of ["queueWaitMs", "bodyReadMs", "bodyParseMs", "preUpstreamMs", "upstreamHeadersMs"]) timing.observe(stage, 1);
    timing.firstWrite(); timing.finish(200);
  }
}
const start = performance.now();
for (let i = 0; i < 2000; i++) collector.snapshot();
console.log(JSON.stringify({ environment: { node: process.version, platform: process.platform, cpu: cpus()[0]?.model }, iterations, rounds, samples, fullSnapshotMicroseconds: (performance.now() - start) * 1000 / 2000,
  note: "In-process warm microbenchmark; lifecycle+one mock fetch versus mock fetch only. Not clean-old/new HTTP latency or model speed. Fixed 5x7x500 sample capacity; full snapshot sorting occurs only on metrics queries. Does not measure true peak RSS." }));
