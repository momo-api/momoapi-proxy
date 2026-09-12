import assert from "node:assert/strict";
import test from "node:test";
import { createMomoSwitch, resetMetrics } from "../src/server.mjs";
import { ContextBudgetError, getContextPolicy, prepareMediaPayload, shouldFallbackResponses } from "../src/context-policy.mjs";
import { logRequest, readRecentLogs } from "../src/logger.mjs";
import { flushLogging } from "../src/logging-runtime.mjs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const image = (seed, bytes = 256) => `data:image/png;base64,${seed.repeat(bytes)}`;

async function withServer(settings, fetchImpl, run) {
  const server = createMomoSwitch({
    endpoint: "https://gateway.example",
    apiKey: "momo-secret",
    localToken: "local-secret",
    host: "127.0.0.1",
    port: 0,
    ...settings,
  }, { fetchImpl });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await run(base); } finally { await new Promise((resolve) => server.close(resolve)); }
}

test("uses a protected 16/18 MiB outbound envelope by default", () => {
  const policy = getContextPolicy({});
  assert.equal(policy.softLimitBytes, 16 * 1024 * 1024);
  assert.equal(policy.hardLimitBytes, 18 * 1024 * 1024);
  assert.ok(policy.hardLimitBytes < 20 * 1024 * 1024);
});

test("deduplicates historical images, evicts old tool media, and preserves current-turn images", () => {
  const duplicate = image("A");
  const oldTool = image("B");
  const current = image("C");
  const input = [
    { type: "function_call_output", call_id: "old_tool", output: [{ type: "input_image", image_url: oldTool }] },
    { role: "user", content: [{ type: "input_image", image_url: duplicate }] },
    { role: "assistant", content: [{ type: "output_text", text: "noted" }] },
    { role: "user", content: [{ type: "input_text", text: "continue" }, { type: "input_image", image_url: duplicate }, { type: "input_image", image_url: current }] },
  ];
  const result = prepareMediaPayload({ model: "gpt-5.6-sol", input }, {
    contextPolicy: { maxHistoricalImages: 0, maxHistoricalImageBytes: 1024, maxCurrentTurnImageBytes: 4096, maxSingleImageBytes: 2048, outboundBodySoftLimitBytes: 8192, outboundBodyHardLimitBytes: 12288 },
  });
  const wire = JSON.stringify(result.payload);
  assert.match(wire, /historical tool image omitted|historical image omitted/);
  assert.equal(wire.includes(current), true);
  assert.equal(wire.lastIndexOf(duplicate), wire.indexOf(duplicate));
  assert.ok(result.trace.imageDedupHits >= 1);
  assert.ok(result.trace.historicalImagesRemoved >= 2);
});

test("shrinks an incident-scale 72-image history below the soft envelope", () => {
  const input = [];
  for (let index = 0; index < 72; index++) {
    const uniqueBase64 = `${"A".repeat(269_996)}${index.toString(36).padStart(4, "0")}`;
    input.push({
      type: "function_call_output",
      call_id: `history_${index}`,
      output: [{ type: "input_image", image_url: `data:image/png;base64,${uniqueBase64}` }],
    });
  }
  const currentImage = image("Z", 64 * 1024);
  input.push({ role: "user", content: [{ type: "input_text", text: "Continue with the current screenshot." }, { type: "input_image", image_url: currentImage }] });

  const started = performance.now();
  const result = prepareMediaPayload({ model: "gpt-5.6-sol", input }, {});
  const elapsedMs = performance.now() - started;
  assert.equal(result.trace.imageCount, 73);
  assert.ok(result.trace.originalOutboundBytes > 18 * 1024 * 1024);
  assert.ok(result.trace.outboundBytes < 16 * 1024 * 1024);
  assert.ok(result.trace.historicalImagesRemoved >= 64);
  assert.equal(JSON.stringify(result.payload).includes(currentImage), true);
  assert.ok(elapsedMs < 5000);
});

test("rejects current-turn media instead of silently deleting it", () => {
  const payload = { model: "gpt-5.6-sol", input: [{ role: "user", content: [{ type: "input_image", image_url: image("D", 2048) }] }] };
  assert.throws(
    () => prepareMediaPayload(payload, { contextPolicy: { maxSingleImageBytes: 1024, maxCurrentTurnImageBytes: 4096, outboundBodySoftLimitBytes: 8192, outboundBodyHardLimitBytes: 12288 } }),
    (error) => error instanceof ContextBudgetError && error.code === "media_budget_exceeded",
  );
});

test("rejects a final oversized text context locally before fetch", async () => {
  let fetchCalls = 0;
  await withServer({ contextPolicy: { outboundBodySoftLimitBytes: 1536, outboundBodyHardLimitBytes: 2048 } }, async () => {
    fetchCalls++;
    return new Response("unexpected", { status: 200 });
  }, async (base) => {
    const response = await fetch(base + "/v1/responses", {
      method: "POST",
      headers: { authorization: "Bearer local-secret", "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.6-sol", input: [{ role: "user", content: [{ type: "input_text", text: "x".repeat(4096) }] }] }),
    });
    assert.equal(response.status, 413);
    const body = await response.text();
    assert.match(body, /context_budget_exceeded/);
    assert.match(body, /response.failed/);
  });
  assert.equal(fetchCalls, 0);
});

test("does not replay Responses 413, 429, or 5xx through Chat Completions", async () => {
  for (const status of [413, 429, 503]) {
    let fetchCalls = 0;
    await withServer({}, async () => {
      fetchCalls++;
      return new Response(JSON.stringify({ error: { message: `upstream ${status}` } }), { status, headers: { "content-type": "application/json" } });
    }, async (base) => {
      const response = await fetch(base + "/v1/responses", {
        method: "POST",
        headers: { authorization: "Bearer local-secret", "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-5.6-sol", input: ["hello"] }),
      });
      assert.equal(response.status, status);
      assert.match(await response.text(), /response.failed/);
    });
    assert.equal(fetchCalls, 1);
  }
});

test("fallback is restricted to explicit Responses capability errors", () => {
  assert.equal(shouldFallbackResponses(404, "Not found"), true);
  assert.equal(shouldFallbackResponses(400, "Responses endpoint unsupported"), true);
  assert.equal(shouldFallbackResponses(400, "Input must be a list"), false);
  assert.equal(shouldFallbackResponses(413, "too large"), false);
  assert.equal(shouldFallbackResponses(500, "server error"), false);
});

test("context metrics expose rewrites and hard-limit rejections", async () => {
  resetMetrics();
  await withServer({ contextPolicy: { outboundBodySoftLimitBytes: 1536, outboundBodyHardLimitBytes: 2048 } }, async () => new Response("unexpected", { status: 200 }), async (base) => {
    const headers = { authorization: "Bearer local-secret", "content-type": "application/json" };
    const rejected = await fetch(base + "/v1/responses", { method: "POST", headers, body: JSON.stringify({ model: "gpt-5.6-sol", input: [{ role: "user", content: [{ type: "input_text", text: "x".repeat(4096) }] }] }) });
    await rejected.text();
    const metrics = await fetch(base + "/internal/metrics", { headers: { "x-local-token": "local-secret" } });
    const body = await metrics.json();
    assert.ok(body.context.requestsRejected >= 1);
    assert.ok(body.context.hardLimitRejections >= 1);
    assert.ok(body.context.maxSerializedBodyBytes >= 2048);
  });
});

test("request logging redacts credentials and inline images", async () => {
  const directory = mkdtempSync(join(tmpdir(), "momo-context-log-"));
  const env = { MOMO_PROXY_HOME: directory };
  try {
    logRequest({ method: "POST", url: "/v1/responses", status: 413, error: `Bearer secret-token data:image/png;base64,${"A".repeat(2000)}` }, env);
    await flushLogging({ env });
    const logs = readRecentLogs(5, env).join("\n");
    assert.doesNotMatch(logs, /secret-token/);
    assert.doesNotMatch(logs, /AAAAAA/);
    assert.match(logs, /redacted/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
