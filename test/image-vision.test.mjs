import assert from "node:assert/strict";
import test from "node:test";
import { collectImageVisionReferences, expandCurrentImageVisionReferences, imageVisionReference, verifyImageVisionReference, withImageVisionReferences } from "../src/image-vision.mjs";

const secret = "local-secret";
const assetId = "img_" + "a".repeat(64);

test("image vision references are signed, validated, and exposed only for vision assets", () => {
  const reference = imageVisionReference(assetId, secret);
  assert.equal(verifyImageVisionReference(reference, secret), assetId);
  assert.equal(verifyImageVisionReference(reference, "wrong-secret"), null);
  assert.equal(verifyImageVisionReference(reference.slice(0, -1) + "0", secret), null);
  assert.equal(verifyImageVisionReference(reference, ""), null);

  assert.deepEqual(withImageVisionReferences({ images: [
    { asset_id: assetId, vision_available: true },
    { asset_id: "img_" + "b".repeat(64), vision_available: false },
  ] }, secret).images, [
    { asset_id: assetId, vision_available: true, vision_reference: reference },
    { asset_id: "img_" + "b".repeat(64), vision_available: false },
  ]);
});

test("collects nested JSON references with bounded traversal", () => {
  const output = new Set();
  collectImageVisionReferences({ nested: JSON.stringify({ vision_reference: "one" }), list: [{ vision_reference: "two" }] }, output);
  assert.deepEqual([...output], ["one", "two"]);
  const deep = {};
  let cursor = deep;
  for (let index = 0; index < 10; index++) { cursor.next = {}; cursor = cursor.next; }
  cursor.vision_reference = "too-deep";
  const bounded = new Set();
  collectImageVisionReferences(deep, bounded);
  assert.equal(bounded.has("too-deep"), false);
});

test("expands signed references only in the current turn and deduplicates source URLs", async () => {
  const current = imageVisionReference(assetId, secret);
  const otherAsset = "img_" + "b".repeat(64);
  const other = imageVisionReference(otherAsset, secret);
  const calls = [];
  const store = {
    async sourceUrl(id) { calls.push(id); return id === assetId ? "https://gateway.example/image.png" : "https://gateway.example/image.png"; },
  };
  const payload = { input: [
    { type: "function_call_output", call_id: "old", output: JSON.stringify({ vision_reference: current }) },
    { role: "user", content: [{ type: "input_text", text: "continue" }] },
    { type: "function_call_output", call_id: "now", output: { images: [{ vision_reference: current }, { vision_reference: other }] } },
  ] };
  const expanded = await expandCurrentImageVisionReferences(payload, store, secret);
  assert.equal(expanded.input[0].output, payload.input[0].output);
  assert.equal(expanded.input[2].output.length, 2);
  assert.deepEqual(expanded.input[2].output.at(-1), {
    type: "input_image", image_url: "https://gateway.example/image.png", detail: "high",
  });
  assert.deepEqual(calls, [assetId, otherAsset]);
});
