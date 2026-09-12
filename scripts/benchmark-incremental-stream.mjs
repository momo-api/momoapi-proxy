// Local synthetic hot-path A/B; --baseline-root must point to a clean old tree.
// Alternating, sequential runs in one process; no network/model/real history.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { cpus } from "node:os";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createRoutedCustomToolRestoreBlockRewrite as currentRewrite } from "../src/responses-compat.mjs";
import { DsmlMarkerDetector, DSML_MARKERS } from "../src/incremental-stream-state.mjs";
const baselineArg = process.argv.find((arg) => arg.startsWith("--baseline-root="));
if (!baselineArg) throw new Error("Explicit --baseline-root=<clean baseline worktree> required");
const { createRoutedCustomToolRestoreBlockRewrite: baselineRewrite } = await import(pathToFileURL(join(resolve(baselineArg.slice(16)), "src/responses-compat.mjs")));
const sse = (value) => 'event: synthetic\r\ndata: ' + JSON.stringify(value);
const settings = { outputPolicy: { maxItems: 65536 } };
function customFrames(size, chunk = 512) {
  const args = JSON.stringify({ input: 'text("中文😀");\n' + "x".repeat(size) + '\\"' });
  const item = { type: "function_call", id: "fc_bench", call_id: "call_bench", name: "exec", arguments: args };
  const frames = [sse({ type: "response.output_item.added", item: { ...item, arguments: "" } })];
  for (let i = 0; i < args.length; i += chunk) frames.push(sse({ type: "response.function_call_arguments.delta", item_id: item.id, delta: args.slice(i, i + chunk) }));
  frames.push(sse({ type: "response.function_call_arguments.done", item_id: item.id }), sse({ type: "response.output_item.done", item }), sse({ type: "response.completed", response: { output: [item] } }));
  return frames;
}
function pendingFrames(count, terminalOnly = false) {
  const pending = [], identities = [], items = [];
  for (let i = 0; i < count; i++) {
    const item = { type: "function_call", id: 'fc_' + i, call_id: 'call_' + i, name: i % 3 ? "exec" : "ordinary", arguments: JSON.stringify({ input: "中文😀" }) };
    items.push(item);
    pending.push(sse({ type: "response.function_call_arguments.delta", ...(i % 2 ? { item_id: item.id } : { output_index: i }), delta: item.arguments }));
    identities.push(sse({ type: "response.output_item.done", output_index: i, item }));
  }
  return [...pending, ...(terminalOnly ? [] : identities.reverse()), sse({ type: "response.completed", response: { output: items } })];
}
function replay(factory, frames) {
  const rewrite = factory(new Set(["exec"]), settings), hash = createHash("sha256"); let events = 0;
  for (const frame of frames) for (const output of rewrite(frame)) { hash.update(output); hash.update("\n\n"); events++; }
  rewrite.finish?.();
  return { events, hash: hash.digest("hex") };
}
function legacyMarker(chunks) { let full = "", found = false; for (const chunk of chunks) { full += chunk; found = DSML_MARKERS.some((marker) => full.includes(marker)); } return found; }
function currentMarker(chunks) { const detector = new DsmlMarkerDetector(); let full = ""; for (const chunk of chunks) { full += chunk; detector.push(chunk); } return detector.found; }
const scenarios = [];
for (const [name, frames] of [["custom-small", customFrames(128)], ["custom-256KiB", customFrames(262144)], ["pending-2000", pendingFrames(2000)], ["terminal-pending-2000", pendingFrames(2000, true)]]) {
  scenarios.push({ name, bytes: frames.reduce((n, frame) => n + Buffer.byteLength(frame), 0), run: (kind) => replay(kind === "baseline" ? baselineRewrite : currentRewrite, frames) });
}
for (const mib of [1, 4]) {
  const chunks = Array.from({ length: mib * 1024 }, () => "x".repeat(1024));
  scenarios.push({ name: 'marker-' + mib + 'MiB', bytes: mib * 1048576, run: (kind) => (kind === "baseline" ? legacyMarker : currentMarker)(chunks) });
}
const samples = 7, warmups = 1, results = [];
const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1];
for (const scenario of scenarios) {
  const times = { baseline: [], current: [] };
  let expected;
  for (let round = -warmups; round < samples; round++) {
    for (const kind of round % 2 ? ["baseline", "current"] : ["current", "baseline"]) {
      global.gc?.();
      const start = performance.now(); const result = scenario.run(kind); const elapsed = performance.now() - start;
      if (expected === undefined) expected = result; else assert.deepEqual(result, expected, scenario.name + " event bytes/order must match baseline");
      if (round >= 0) times[kind].push(elapsed);
    }
  }
  results.push({ name: scenario.name, bytes: scenario.bytes, equivalent: expected, ...Object.fromEntries(Object.entries(times).map(([key, values]) => [key, { p50Ms: +percentile(values, .5).toFixed(3), p95Ms: +percentile(values, .95).toFixed(3) }])) });
}
console.log(JSON.stringify({ environment: { node: process.version, platform: process.platform, cpu: cpus()[0]?.model }, warmups, samples, results, note: "Microbenchmark, sequential alternating old/new; per-event byte hashes include order and EOF output. P95 of 7 is sample max, not a reliable production percentile. GC requested outside timing if --expose-gc. Process memory/peak not attributed to either implementation; no upstream or client speed claim." }, null, 2));
