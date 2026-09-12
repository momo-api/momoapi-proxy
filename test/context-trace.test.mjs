import test from "node:test";
import assert from "node:assert/strict";
import { contextLogFields, recordContextTrace } from "../src/context-trace.mjs";

test("context trace records bounded metrics once", () => {
  const metrics = { contextRequestsAdmitted: 0, contextRequestsRejected: 0, outboundBodySoftLimitHits: 0, outboundBodyHardLimitRejects: 0, imageBytesRemoved: 0, imageBytesForwarded: 0, imageDedupHits: 0, historicalImagesRemoved: 0, maxSerializedBodyBytes: 0 };
  const response = {};
  const trace = { softLimitHit: true, hardLimitRejected: false, imageBytesRemoved: 3, imageBytesForwarded: 7, imageDedupHits: 2, historicalImagesRemoved: 1, maxOutboundBytes: 99, policyActions: ["rewritten"] };
  recordContextTrace(response, trace, metrics, true);
  recordContextTrace(response, trace, metrics, true);
  assert.equal(metrics.contextRequestsAdmitted, 1);
  assert.equal(metrics.outboundBodySoftLimitHits, 1);
  assert.equal(metrics.maxSerializedBodyBytes, 99);
  assert.equal(response.momoContextTrace, trace);
});

test("context log fields expose only bounded trace metadata", () => {
  const fields = contextLogFields({ momoContextTrace: { requestBytes: 10, outboundBytes: 8, imageCount: 1, imageBytes: 4, policyActions: ["dedup"] } }, { momoRequestBodyBytes: 12 });
  assert.deepEqual(fields, { toolAudit: undefined, requestBytes: 10, outboundBytes: 8, imageCount: 1, imageBytes: 4, policyAction: "dedup" });
});
