import test from "node:test";
import assert from "node:assert/strict";
import { resolveTargetModel } from "../src/model-routing.mjs";

test("model routing preserves provider protocol families", () => {
  const cases = [
    ["gemini-3.8-flash", "gemini"],
    ["claude-opus-4-6-thinking", "claude"],
    ["mimo-v2.6-flash-free", "responses"],
    ["gpt-5.6-sol", "responses"],
    ["gpt-5.6-luna", "responses"],
    ["custom-responses", "responses"],
    ["grok-4.5", "chat"],
  ];
  for (const [model, protocol] of cases) assert.deepEqual(resolveTargetModel(model), { targetModel: model, protocol });
});

test("muse routing is restricted to muse-auto", () => {
  assert.deepEqual(resolveTargetModel("muse-auto"), { targetModel: "muse-auto", protocol: "muse" });
  assert.deepEqual(resolveTargetModel("muse-avocado-5.14"), { targetModel: "muse-avocado-5.14", protocol: "chat" });
});

test("model routing preserves the empty-string fallback", () => {
  assert.deepEqual(resolveTargetModel(""), { targetModel: "", protocol: "chat" });
});
