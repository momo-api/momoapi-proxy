import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { prepareCompactPayload, buildLocalCompactResponse, prepareOversizedHistoryReplay } from "../src/compaction.mjs";
import { compactFixture, compactOutcome } from "../scripts/compact-fixtures.mjs";

const MIB = 1048576;
const settings = { contextPolicy: { compactBodyLimitMb: 18 } };
const envKeys = ["MOMO_COMPACT_BODY_LIMIT_MB", "MOMO_MAX_HISTORICAL_REPLAY_MB"];
const previousEnv = envKeys.map((key) => process.env[key]);
for (const key of envKeys) delete process.env[key];
test.after(() => envKeys.forEach((key, index) => {
  if (previousEnv[index] === undefined) delete process.env[key]; else process.env[key] = previousEnv[index];
}));
function counted(body, run) {
  const original = JSON.stringify;
  let fullSerializations = 0;
  JSON.stringify = function (value, ...rest) {
    if (value === body) fullSerializations++;
    return original(value, ...rest);
  };
  try { return { result: run(), fullSerializations }; }
  finally { JSON.stringify = original; }
}

test("compact repeated marker batches use a constant number of whole-body serializations", () => {
  const current = { role: "user", content: "CURRENT exact 中文😀" };
  const body = { model: "synthetic", input: [...Array.from({ length: 420 }, () => ({ role: "assistant", content: "x".repeat(65536) })), current] };
  const { result, fullSerializations } = counted(body, () => prepareCompactPayload(body, settings));
  assert.ok(result.trace.markerizedItems > 100);
  assert.equal(result.trace.markerizedItems % 8, 0);
  assert.ok(fullSerializations <= 2, 'full-body serializations: ' + fullSerializations);
  assert.equal(result.trace.compactBytes, Buffer.byteLength(JSON.stringify(body)));
  assert.equal(body.input.at(-1), current);
});

test("compact current-item cleanup also has constant whole-body serializations", () => {
  const body = { model: "synthetic", input: [{ role: "user", content: "task" }, ...Array.from({ length: 64 }, (_, i) => ({ type: "function_call_output", call_id: String(i), output: "中".repeat(131072) }))] };
  const { result, fullSerializations } = counted(body, () => prepareCompactPayload(body, settings));
  assert.equal(result.trace.markerizedItems, 0);
  assert.ok(fullSerializations <= 2, 'full-body serializations: ' + fullSerializations);
  assert.equal(result.trace.compactBytes, Buffer.byteLength(JSON.stringify(body)));
});

test("compact exact boundary keeps legacy batch-of-eight selection", () => {
  for (const extra of [-1, 0, 1]) {
    const body = { model: "synthetic", input: Array.from({ length: 10 }, () => ({ role: "assistant", content: "historic".repeat(256) })), padding: "" };
    body.input.push({ role: "user", content: "current" });
    body.padding = "p".repeat(18 * MIB - Buffer.byteLength(JSON.stringify(body)) + extra);
    const result = prepareCompactPayload(body, settings);
    assert.equal(result.trace.markerizedItems, extra > 0 ? 8 : 0);
    assert.equal(result.trace.compactBytes, Buffer.byteLength(JSON.stringify(body)));
  }
});

test("local checkpoint retains exact required groups with two full-body measurements", () => {
  const call = { type: "custom_tool_call", name: "exec", call_id: "pending", input: "text('中文😀')" };
  const result = { type: "custom_tool_call_output", call_id: "done", output: "verified" };
  const dynamic = { type: "additional_tools", tools: [{ type: "custom", name: "dynamic" }] };
  const history = [{ role: "system", content: "constraint" }, { role: "developer", content: "more constraints" }, dynamic, { role: "user", content: "original task" }, ...Array.from({ length: 128 }, () => ({ role: "assistant", content: "x".repeat(65536) })), { ...call, call_id: "done" }, result, call];
  const body = { model: "synthetic", input: [...history, { role: "user", content: "latest task" }] };
  const run = counted(body, () => prepareOversizedHistoryReplay(body));
  assert.equal(run.fullSerializations, 2);
  assert.equal(run.result.rewritten, true);
  for (const item of [call, result, dynamic]) assert.ok(body.input.includes(item));
  assert.throws(() => buildLocalCompactResponse("synthetic", [{ ...call, input: "x".repeat(900001) }]), { code: "checkpoint_state_budget_exceeded", statusCode: 413 });
});

const golden = JSON.parse(readFileSync(new URL("./fixtures/compact-budget-golden.json", import.meta.url), "utf8"));
for (const [name, expected] of Object.entries(golden.hashes)) test("compact baseline body/trace/error byte equality: " + name, () => {
  const { body, operation } = compactFixture(name);
  const result = compactOutcome({ prepareCompactPayload, prepareOversizedHistoryReplay }, body, operation);
  assert.equal(createHash("sha256").update(JSON.stringify(result)).digest("hex"), expected);
});
