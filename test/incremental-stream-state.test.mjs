import assert from "node:assert/strict";
import test from "node:test";
import { DsmlMarkerDetector, DSML_MARKERS, PartialCustomInputDecoder, PendingToolArguments } from "../src/incremental-stream-state.mjs";
import { createRoutedCustomToolRestoreBlockRewrite } from "../src/responses-compat.mjs";
import { parseSse } from "../src/responses-sse.mjs";

// Deliberately retain the simple pre-refactor algorithm as a test oracle.
function legacyPartial(source) {
  const match = /^\s*\{\s*"input"\s*:\s*"/.exec(source);
  if (!match) return "";
  const body = source.slice(match[0].length);
  let output = "";
  for (let index = 0; index < body.length; index++) {
    const char = body[index];
    if (char === '"') break;
    if (char !== "\\") { output += char; continue; }
    const escaped = body[++index];
    if (escaped === undefined) break;
    if (escaped === "u") {
      const hex = body.slice(index + 1, index + 5);
      if (hex.length !== 4 || !/^[0-9a-fA-F]{4}$/.test(hex)) break;
      output += String.fromCharCode(Number.parseInt(hex, 16)); index += 4;
    } else output += ({ n: "\n", t: "\t", r: "\r", b: "\b", f: "\f" })[escaped] ?? escaped;
  }
  return output;
}

test("marker detection equals full-history includes at every split and retains only a suffix", () => {
  for (const source of [...DSML_MARKERS.map((marker) => "中文😀prefix" + marker + "suffix"), "<> tool_calls <inv <|DSML| not-a-marker", ""]) {
    for (let cut = 0; cut <= source.length; cut++) {
      const detector = new DsmlMarkerDetector(); let full = "";
      for (const part of [source.slice(0, cut), "", ...source.slice(cut).split("")]) {
        full += part;
        assert.equal(detector.push(part), DSML_MARKERS.some((marker) => full.includes(marker)));
        assert.ok(detector.tail.length <= 11);
      }
    }
  }
});

test("detector work grows with new input, not accumulated output", () => {
  const detector = new DsmlMarkerDetector();
  for (let i = 0; i < 4096; i++) detector.push("x".repeat(1024));
  assert.ok(detector.examinedUnits <= 4096 * 1035);
  detector.push("<invoke "); const before = detector.examinedUnits;
  detector.push("x".repeat(4096)); assert.equal(detector.examinedUnits, before);
});

test("partial custom decoding is legacy-equivalent per delta for every split, escapes and malformed input", () => {
  const sources = [
    JSON.stringify({ input: "text('中文😀')\n\\\t\r\b\f\"/" }),
    ' \t{ \n"input" \t: \r"a\\u4e2d\\ud83d\\ude00\\uD800\\qz"}',
    '{"input":"a\\u12', '{"input":"a\\u12gz rest', '{"input":"a\\',
    '{"raw":"abc"}', '{"input": "a", "input":"b"}',
    '{"input":"a"trailing garbage', '{"input":"raw\u0000\ud800unit"}',
    ' \ufeff{ "input" : "x"}', '{"input"x: "x"}', '{"input":"\\u12345"}',
  ];
  for (const source of sources) for (let cut = 0; cut <= source.length; cut++) {
    const decoder = new PartialCustomInputDecoder(); let received = "", expected = "";
    for (const delta of [source.slice(0, cut), "", ...source.slice(cut).split("")]) {
      received += delta; const next = legacyPartial(received);
      assert.equal(decoder.push(delta), next.slice(expected.length), JSON.stringify({ source, cut, received }));
      expected = next;
    }
    assert.ok(decoder.examinedUnits <= source.length);
  }
});

test("long custom input decodes each source unit at most once", () => {
  const decoder = new PartialCustomInputDecoder(); let length = 0;
  decoder.push('{"input":"');
  for (let i = 0; i < 8192; i++) length += decoder.push("x".repeat(128)).length;
  assert.equal(length, 1048576); assert.equal(decoder.examinedUnits, length + 10);
});

test("deterministic randomized custom payloads preserve every legacy partial delta", () => {
  let seed = 97;
  const next = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0);
  const alphabet = ['x', '中', '😀', '\\', '"', '\n', '\t', '\r', '\u0000', '\ud800', '/', ' '];
  for (let sample = 0; sample < 400; sample++) {
    let input = "";
    for (let i = 0; i < 60; i++) input += alphabet[next() % alphabet.length];
    const source = JSON.stringify({ input });
    const decoder = new PartialCustomInputDecoder(); let received = "", expected = "";
    for (let offset = 0; offset < source.length;) {
      const length = 1 + next() % 19, delta = source.slice(offset, offset + length);
      offset += length; received += delta;
      const full = legacyPartial(received);
      assert.equal(decoder.push(delta), full.slice(expected.length));
      expected = full;
    }
    assert.equal(expected, input);
  }
});

test("pending buckets preserve arrival order and ID priority, including missing/empty identities", () => {
  const queue = new PendingToolArguments();
  const entries = [
    { block: "0", outputIndex: 0 }, { block: "1", itemId: "b", outputIndex: 0 },
    { block: "2", itemId: "a" }, { block: "3", outputIndex: 0 },
    { block: "4" }, { block: "5", itemId: "" }, { block: "6", itemId: "a", outputIndex: 7 },
  ];
  entries.forEach((item) => queue.add(item));
  assert.deepEqual(queue.take("a", 0).map((item) => item.block), ["0", "2", "3", "6"]);
  assert.equal(queue.size, 3); assert.equal(queue.has("b", 0), true);
  assert.deepEqual(queue.take("b", 7).map((item) => item.block), ["1"]);
  assert.deepEqual(queue.take("", undefined).map((item) => item.block), ["5"]);
  assert.equal(queue.size, 1); assert.deepEqual(queue.take(undefined, undefined), []);
  queue.clear(); assert.equal(queue.size, 0); assert.equal(queue.byId.size, 0);
});

test("pending matching agrees with legacy scanning under deterministic randomized ordering", () => {
  const queue = new PendingToolArguments(); let legacy = [], seed = 13;
  const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
  for (let i = 0; i < 10000; i++) {
    if (next() % 4) {
      const entry = { block: String(i), itemId: next() % 3 ? 'id_' + next() % 31 : undefined, outputIndex: next() % 5 ? next() % 31 : undefined };
      queue.add(entry); legacy.push(entry);
    } else {
      const itemId = 'id_' + next() % 31, outputIndex = next() % 31;
      const matches = (item) => item.itemId !== undefined ? item.itemId === itemId : item.outputIndex !== undefined && item.outputIndex === outputIndex;
      assert.deepEqual(queue.take(itemId, outputIndex).map((item) => item.block), legacy.filter(matches).map((item) => item.block));
      legacy = legacy.filter((item) => !matches(item));
    }
    assert.equal(queue.size, legacy.length);
  }
});

test("wire restoration keeps split escapes, interleaved pending deltas and fallback done source", () => {
  const rewrite = createRoutedCustomToolRestoreBlockRewrite(new Set(["exec"]));
  const block = (value) => 'event: upstream\r\ndata: ' + JSON.stringify(value);
  const output = [];
  for (const item of [
    { type: "response.function_call_arguments.delta", output_index: 0, delta: '{"input":"a\\u4' },
    { type: "response.function_call_arguments.delta", item_id: "fc_a", delta: 'e2d\\ud83d' },
    { type: "response.function_call_arguments.delta", output_index: 0, delta: '\\ude00"}' },
    { type: "response.output_item.added", output_index: 0, item: { id: "fc_a", type: "function_call", name: "exec", call_id: "call_a", arguments: "" } },
    { type: "response.function_call_arguments.done", item_id: "fc_a" },
  ]) output.push(...rewrite(block(item)));
  rewrite.finish();
  const events = parseSse(output.join("\n\n"));
  assert.equal(events.filter((item) => item.type === "response.custom_tool_call_input.delta").map((item) => item.delta).join(""), "a中😀");
  assert.equal(events.at(-1).input, "a中😀");
  assert.equal(events[0].item.call_id, "call_a");
});
