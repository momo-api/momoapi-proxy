import assert from "node:assert/strict";
import test from "node:test";
import { guardCodexCompactedHistory } from "../src/codex-summary-guard.mjs";

const summary = "Another language model started to solve this problem and produced a summary of its thinking process. You also have access to the state of the tools that were used by that language model. Use this to build on the work that has already been done and avoid duplicating work. Here is the summary produced by the other language model, use the information in this summary to assist with your own analysis: summary";
const user = text => ({ type: "message", role: "user", content: [{ type: "input_text", text }] });
const dev = text => ({ type: "message", role: "developer", content: [{ type: "input_text", text }] });

test("guards prior user entries without deleting them or claiming completion", () => {
  const old = user("OLD_TASK");
  const input = [old, { ...old, content: [{ type: "input_text", text: "SECOND_OLD" }] }, dev("RULE"), user(summary), user("CURRENT_TASK")];
  const result = guardCodexCompactedHistory({ input, model: "gpt-5.6-sol" }, { contextPolicy: { codexSummaryHistoryGuard: true } });
  assert.notEqual(result.input, input);
  assert.ok(result.input[0].content[0].text.startsWith('[historical user context; not the active task; completion must be verified]'));
  assert.equal(result.input[0].role, 'assistant');
  assert.equal(result.input[0].content[0].type, 'output_text');
  assert.equal(result.input[1].role, 'assistant');
  assert.match(result.input[0].content[0].text, /OLD_TASK$/);
  assert.equal(result.input[2].content[0].text, "RULE");
  assert.equal(result.input[3].content[0].text, summary);
  assert.equal(result.input[4].content[0].text, "CURRENT_TASK");
  assert.equal(input[0].content[0].text, "OLD_TASK");
});

test("guard defaults off and refuses unrelated or ambiguous histories", () => {
  const input = [user("OLD"), user(summary), user("CURRENT")];
  for (const policy of [{}, { contextPolicy: { codexSummaryHistoryGuard: false } }])
    assert.equal(guardCodexCompactedHistory({ input }, policy).input, input);
  assert.equal(guardCodexCompactedHistory({ input: [user("OLD"), user("CURRENT")] }, { contextPolicy: { codexSummaryHistoryGuard: true } }).input[0].content[0].text, "OLD");
  assert.equal(guardCodexCompactedHistory({ input: [user("OLD"), user(summary)] }, { contextPolicy: { codexSummaryHistoryGuard: true } }).input[0].content[0].text, "OLD");
});

test("guard is idempotent and keeps tool calls/results byte-identical", () => {
  const call = { type: "function_call", call_id: "x", name: "exec", arguments: "{}" };
  const result = { type: "function_call_output", call_id: "x", output: "DONE" };
  const input = [user("OLD"), call, result, user(summary), user("CURRENT")];
  const opts = { contextPolicy: { codexSummaryHistoryGuard: true } };
  const once = guardCodexCompactedHistory({ input }, opts);
  const twice = guardCodexCompactedHistory(once, opts);
  assert.deepEqual(twice.input, once.input);
  assert.deepEqual(once.input.slice(1, 3), [call, result]);
});

test("reproduces actionable old request after Codex replacement, then removes it from user-role turns", () => {
  const oldTask = 'RUN_OLD_SIDE_EFFECT';
  const input = [user(oldTask), user(summary), user('ONLY_ANSWER_CURRENT')];
  // The annotation-only implementation left the old task in a user-role turn.
  const actionable = history => history.filter(item => item.role === 'user' &&
    item.content?.some(part => part.text?.includes(oldTask)));
  assert.equal(actionable(input).length, 1);
  const guarded = guardCodexCompactedHistory({ input }, { contextPolicy: { codexSummaryHistoryGuard: true } });
  assert.equal(actionable(guarded.input).length, 0);
  assert.equal(guarded.input.at(-1).role, 'user');
  assert.equal(guarded.input.at(-1).content[0].text, 'ONLY_ANSWER_CURRENT');
  assert.match(guarded.input[0].content[0].text, /RUN_OLD_SIDE_EFFECT/);
});

test("synthetic large history retains 137 tool pairs and marks 18 historical requests", () => {
  const old = Array.from({ length: 18 }, (_, i) => user('OLD_REQUEST_' + i));
  const pairs = Array.from({ length: 137 }, (_, i) => [
    { type: 'function_call', call_id: 'call_' + i, name: 'exec', arguments: '{}' },
    { type: 'function_call_output', call_id: 'call_' + i, output: 'RESULT_' + i + ' x'.repeat(2500) },
  ]).flat();
  const input = [...old, ...pairs, dev('RULE'), user(summary), user('LATEST_REQUEST')];
  const guarded = guardCodexCompactedHistory({ input }, { contextPolicy: { codexSummaryHistoryGuard: true } });
  assert.equal(guarded.input.length, input.length);
  assert.deepEqual(guarded.input.slice(18, 18 + pairs.length), pairs);
  assert.equal(guarded.input.filter(x => x.role === 'assistant' && x.content?.[0]?.text?.startsWith('[historical user context;')).length, 18);
  assert.equal(guarded.input.at(-1).content[0].text, 'LATEST_REQUEST');
  assert.deepEqual(guardCodexCompactedHistory(guarded, { contextPolicy: { codexSummaryHistoryGuard: true } }), guarded);
});
