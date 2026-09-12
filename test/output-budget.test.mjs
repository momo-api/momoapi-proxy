import assert from "node:assert/strict";
import test from "node:test";
import { BoundedCallCache, RetainedOutputBudget, budgetedOutputBody, resolveOutputPolicy, readBoundedOutputText } from "../src/output-budget.mjs";
import { streamSseBlocks } from "../src/stream-transport.mjs";
import { ResponseStreamEmitter, parseSse } from "../src/responses-sse.mjs";
import { createRoutedCustomToolRestoreBlockRewrite } from "../src/responses-compat.mjs";
import { buildClaudeMessages, buildGeminiContents } from "../src/server.mjs";
import { rememberResponseState, preparePreviousResponseReplay, resetResponseStateForTests } from "../src/responses-state.mjs";
const MIB = 1024 * 1024;
const event = (value) => "data: " + JSON.stringify(value);
const collect = async (source) => { const values = []; for await (const value of source) values.push(value); return values; };

test("output policy defaults and invalid fields cannot remove safety bounds", () => {
  const defaults = resolveOutputPolicy();
  assert.equal(defaults.maxStreamMb, 64); assert.equal(defaults.maxRetainedMb, 16);
  assert.deepEqual(resolveOutputPolicy({ outputPolicy: { maxStreamMb: 0, maxRetainedMb: Infinity, maxEvents: -1, maxItems: "unlimited" } }), defaults);
});

test("retained bytes count UTF-8 and reject over-limit updates before mutation", () => {
  const budget = new RetainedOutputBudget(); budget.maxBytes = 7;
  budget.text("中😀"); assert.equal(budget.bytes, 7);
  assert.throws(() => budget.text("a"), { code: "output_budget_exceeded" }); assert.equal(budget.bytes, 7);
});

test("structural node count and nesting also bound empty-object floods", () => {
  const budget = new RetainedOutputBudget({ outputPolicy: { maxItems: 4 } });
  assert.throws(() => budget.value([{}, {}, {}, {}]), { code: "output_budget_exceeded" });
  let nested = {}; for (let i = 0; i < 66; i++) nested = { nested };
  assert.throws(() => new RetainedOutputBudget().value(nested), { code: "output_budget_exceeded" });
});

test("wire bytes reject at chunk boundary and close upstream iterator", async () => {
  let closed = false;
  const source = (async function* () { try { yield Buffer.alloc(MIB); yield Buffer.alloc(1); assert.fail("must not pull past limit"); } finally { closed = true; } })();
  await assert.rejects(collect(budgetedOutputBody(source, { outputPolicy: { maxStreamMb: 1 } })), { code: "output_budget_exceeded" });
  assert.equal(closed, true);
});

test("event-count ceiling covers strings, streamed blocks, comments and EOF", async () => {
  for (const body of [":one\n\n:two", [Buffer.from(":one\n\n:two")]]) {
    await assert.rejects(collect(streamSseBlocks(body, { maxEvents: 1 })), { code: "output_budget_exceeded" });
  }
});

test("bounded diagnostics accept split unicode but reject large bodies and text-only mocks", async () => {
  const data = Buffer.from("中文😀");
  assert.equal(await readBoundedOutputText({ body: (async function* () { for (const byte of data) yield Uint8Array.of(byte); })() }, data.length), "中文😀");
  await assert.rejects(readBoundedOutputText(new Response("x".repeat(1025)), 1024), { code: "output_budget_exceeded" });
  await assert.rejects(readBoundedOutputText({ text: async () => "abc" }, 2), { code: "output_budget_exceeded" });
});

test("emitter stops before adding a budget-exceeding tool and preserves accepted text", () => {
  let output = "";
  const response = { write: (text) => { output += text; }, end() {} };
  const emitter = new ResponseStreamEmitter(response, "synthetic", "resp_synthetic", { outputPolicy: { maxRetainedMb: 1 } });
  emitter.start(); emitter.writeTextDelta("中文😀");
  assert.throws(() => emitter.writeCustomToolCall({ name: "run", input: "x".repeat(MIB) }), { code: "output_budget_exceeded" });
  const events = parseSse(output);
  assert.equal(events.filter((item) => item.type === "response.output_text.delta")[0].delta, "中文😀");
  assert.equal(events.some((item) => item.item?.type === "custom_tool_call" || item.type === "response.completed"), false);
});

test("pending custom arguments cannot be silently discarded at terminal or EOF", () => {
  for (const terminal of [true, false]) {
    const rewrite = createRoutedCustomToolRestoreBlockRewrite(new Set(["exec"]));
    assert.deepEqual(rewrite(event({ type: "response.function_call_arguments.delta", item_id: "missing", delta: "abc" })), []);
    assert.throws(() => terminal ? rewrite(event({ type: "response.completed", response: { output: [] } })) : rewrite.finish(), { code: "unmatched_tool_arguments" });
  }
});

test("pending and matched custom argument accumulators enforce independent retained limits", () => {
  for (const matched of [true, false]) {
    const rewrite = createRoutedCustomToolRestoreBlockRewrite(new Set(["exec"]), { outputPolicy: { maxRetainedMb: 1 } });
    if (matched) rewrite(event({ type: "response.output_item.added", item: { type: "function_call", id: "fc_budget", name: "exec", arguments: "" } }));
    assert.throws(() => {
      for (let i = 0; i < 20; i++) rewrite(event({ type: "response.function_call_arguments.delta", item_id: "fc_budget", delta: "x".repeat(65536) }));
    }, { code: "output_budget_exceeded" });
  }
});

test("out-of-order namespace/custom arguments restore exactly within budget", () => {
  const rewrite = createRoutedCustomToolRestoreBlockRewrite(new Set(["exec"]));
  const args = JSON.stringify({ input: "text('中文😀')" });
  const output = [];
  output.push(...rewrite(event({ type: "response.function_call_arguments.delta", output_index: 0, delta: args })));
  output.push(...rewrite(event({ type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "fc_order", call_id: "call_order", name: "exec", arguments: "" } })));
  output.push(...rewrite(event({ type: "response.output_item.done", item: { type: "function_call", id: "fc_order", call_id: "call_order", name: "exec", arguments: args } })));
  rewrite.finish();
  const restored = parseSse(output.join("\n\n"));
  assert.equal(restored.at(-1).item.input, "text('中文😀')"); assert.equal(restored.at(-1).item.call_id, "call_order");
});

test("terminal-only provider identities resolve pending calls without losing arguments", () => {
  const rewrite = createRoutedCustomToolRestoreBlockRewrite(new Set(["exec"]));
  const args = JSON.stringify({ input: "text('中文😀')" });
  rewrite(event({ type: "response.function_call_arguments.delta", output_index: 0, delta: args }));
  const output = rewrite(event({ type: "response.completed", response: { id: "resp_terminal", output: [{ type: "function_call", id: "fc_late", call_id: "call_late", name: "exec", arguments: args }] } }));
  rewrite.finish();
  const restored = parseSse(output.join("\n\n"));
  assert.equal(restored.at(-1).type, "response.completed");
  assert.equal(restored.at(-1).response.output[0].input, "text('中文😀')");
  assert.equal(restored.find((item) => item.type === "response.custom_tool_call_input.delta").delta, "text('中文😀')");
});

test("call cache admits whole entries, bounds bytes/count, and missing continuation fails explicitly", () => {
  const calls = new BoundedCallCache({ outputPolicy: { maxCallCacheMb: 1 } });
  const value = { claudeMessages: [{ role: "user", content: "x".repeat(600000) }], geminiContents: [{ role: "user", parts: [{ text: "synthetic" }] }] };
  calls.set("first", value); calls.set("second", value);
  assert.equal(calls.has("first"), false); assert.equal(calls.has("second"), true);
  assert.ok(calls.snapshot().bytes <= MIB); assert.equal(calls.snapshot().evicted, 1);
  const result = [{ type: "function_call_output", call_id: "first", output: "synthetic" }];
  assert.throws(() => buildClaudeMessages(result, calls), { code: "tool_continuation_unavailable", statusCode: 409 });
  assert.throws(() => buildGeminiContents(result, calls), { code: "tool_continuation_unavailable" });
  const before = calls.snapshot();
  assert.throws(() => calls.set("second", { text: "x".repeat(MIB) }), { code: "output_budget_exceeded" });
  assert.deepEqual(calls.snapshot(), before);
  calls.clear(); assert.equal(calls.snapshot().bytes, 0);
  for (let i = 0; i < 600; i++) calls.set(String(i), { arguments: {} });
  assert.equal(calls.size, 512);
  for (const key of [...calls.keys()]) calls.delete(key);
  assert.equal(calls.snapshot().bytes, 0);
});

test("cache churn stays bounded across thousands of independently weighted continuations", () => {
  const cache = new BoundedCallCache({ outputPolicy: { maxCallCacheMb: 1 } });
  for (let index = 0; index < 3000; index++) {
    cache.set("call_" + index, { geminiContents: [{ role: "user", parts: [{ text: "x".repeat(8192) }] }] });
    assert.ok(cache.snapshot().bytes <= MIB); assert.ok(cache.size <= 512);
  }
  assert.ok(cache.snapshot().evicted > 2800);
  assert.equal(cache.has("call_2999"), true); assert.equal(cache.has("call_0"), false);
});

test("oversized replay identities cannot create large long-lived cache keys", () => {
  resetResponseStateForTests();
  const seed = preparePreviousResponseReplay({ model: "synthetic", input: [{ role: "user", content: "hello" }] }).seed;
  const output = [{ type: "message", id: "synthetic_item", content: [] }];
  assert.equal(rememberResponseState("x".repeat(8193), seed, output), false);
  assert.equal(rememberResponseState("resp_synthetic", { ...seed, model: "x".repeat(8193) }, output), false);
  assert.equal(rememberResponseState("resp_synthetic", seed, output), true);
  resetResponseStateForTests();
});
