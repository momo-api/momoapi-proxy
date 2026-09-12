// Local synthetic CPU/framing benchmark. No model, endpoint, credentials or logs.
import { performance } from "node:perf_hooks";
import { cpus, platform, arch } from "node:os";
import { streamSseBlocks } from "../src/stream-transport.mjs";

const samples = 15;
const warmups = 3;
async function* legacyBlocks(chunks) {
  let buffer = "";
  for (const chunk of chunks) {
    buffer += Buffer.from(chunk).toString("utf8");
    const blocks = buffer.split("\n\n");
    buffer = blocks.pop() || "";
    for (const block of blocks) if (block.trim()) yield block;
  }
  if (buffer.trim()) yield buffer;
}
function percentile(values, p) { return [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1]; }
async function measure(read, chunks, expected) {
  const times = [];
  for (let sample = -warmups; sample < samples; sample++) {
    let count = 0;
    const start = performance.now();
    for await (const _block of read(chunks)) count++;
    const duration = performance.now() - start;
    if (count !== expected) throw new Error("Synthetic frame count mismatch");
    if (sample >= 0) times.push(duration);
  }
  return { p50Ms: +percentile(times, 0.5).toFixed(3), p95Ms: +percentile(times, 0.95).toFixed(3) };
}
const results = [];
for (const scenario of [
  { name: "small-tool-like", events: 100, chars: 100, chunkBytes: 4096 },
  { name: "many-small-events", events: 10000, chars: 100, chunkBytes: 4096 },
  { name: "one-large-event", events: 1, chars: 1024 * 1024, chunkBytes: 1024 },
]) {
  const event = 'data: ' + JSON.stringify({ type: "synthetic", delta: "x".repeat(scenario.chars) }) + "\n\n";
  const bytes = Buffer.from(event.repeat(scenario.events));
  const chunks = [];
  for (let offset = 0; offset < bytes.length; offset += scenario.chunkBytes) chunks.push(bytes.subarray(offset, offset + scenario.chunkBytes));
  results.push({ ...scenario, bytes: bytes.length, legacy: await measure(legacyBlocks, chunks, scenario.events), current: await measure(streamSseBlocks, chunks, scenario.events) });
}
console.log(JSON.stringify({
  environment: { node: process.version, platform: platform(), arch: arch(), cpu: cpus()[0]?.model },
  samples, warmups, results,
  memoryAtEnd: process.memoryUsage(),
  note: "In-process LF framing microbenchmark only; memoryAtEnd is not peak RSS. Not network/model TTFB, production throughput, or a load test. CRLF/UTF-8 correctness uses deterministic tests, not timing thresholds.",
}, null, 2));
