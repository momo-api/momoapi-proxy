import test from "node:test";
import assert from "node:assert/strict";
import { encodeRecoverableCompaction, parseCompactResponseText, readCompactResponseText, shouldUseLocalCompact } from "../src/compact-endpoint.mjs";

test("compact fallback policy only treats endpoint failures as locally recoverable", () => {
  assert.equal(shouldUseLocalCompact(404, "unknown compact endpoint"), true);
  assert.equal(shouldUseLocalCompact(404, "model not found"), false);
  assert.equal(shouldUseLocalCompact(400, "compact route unsupported"), true);
  assert.equal(shouldUseLocalCompact(500, "upstream failure"), false);
});

test("compact response parser validates the response.compaction envelope", () => {
  assert.deepEqual(parseCompactResponseText(JSON.stringify({ object: "response.compaction", output: [] })), { object: "response.compaction", output: [] });
  assert.throws(() => parseCompactResponseText("not json"), { code: "invalid_compact_response", statusCode: 502 });
  assert.throws(() => parseCompactResponseText(JSON.stringify({ object: "response", output: [] })), { code: "invalid_compact_response", statusCode: 502 });
});

test("compact response reader enforces a bounded body", async () => {
  const small = new Response("{\"object\":\"response.compaction\",\"output\":[]}");
  assert.match(await readCompactResponseText(small), /response\.compaction/);
  const huge = new Response(new Uint8Array(32 * 1024 * 1024 + 1));
  await assert.rejects(() => readCompactResponseText(huge), { code: "compact_response_too_large", statusCode: 502 });
});

test("recoverable compaction encoding produces a local envelope", () => {
  const encoded = encodeRecoverableCompaction("synthetic", [{ role: "user", content: "retain" }], [{ type: "message", role: "user", content: [{ type: "input_text", text: "checkpoint" }] }]);
  assert.match(encoded, /^momo1:/);
});
