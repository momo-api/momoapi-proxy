import assert from "node:assert/strict";
import test from "node:test";
import { request as httpRequest } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createMomoSwitch } from "../src/server.mjs";

const body = JSON.stringify({ model: "gpt-5.6-sol", stream: true, input: [{ role: "user", content: "synthetic admission" }] });
const token = "synthetic_local_admission";
const deferred = () => { let resolve; const promise = new Promise((value) => { resolve = value; }); return { resolve, promise }; };
async function withServer(policy, fetchImpl, run, instrument) {
  const scratch = mkdtempSync(join(tmpdir(), "momo-admission-test-"));
  const previous = process.env.MOMO_PROXY_HOME;
  process.env.MOMO_PROXY_HOME = scratch;
  const server = createMomoSwitch({ endpoint: "https://gateway.example", apiKey: "synthetic_gateway", localToken: token, host: "127.0.0.1", port: 0, maxRequestBodyMb: 2, requestAdmission: policy }, { fetchImpl, exitImpl: () => {} });
  instrument?.(server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try { await run("http://127.0.0.1:" + server.address().port); }
  finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    if (previous === undefined) delete process.env.MOMO_PROXY_HOME; else process.env.MOMO_PROXY_HOME = previous;
    rmSync(scratch, { recursive: true, force: true });
  }
}
function post(base, path = "/v1/responses", extra = {}) {
  return fetch(base + path, { method: "POST", headers: { authorization: "Bearer " + token }, body, ...extra });
}
async function metrics(base) { return (await (await fetch(base + "/internal/metrics", { headers: { "x-local-token": token } })).json()).admission; }
async function waitQueued(base, count) {
  const start = Date.now();
  while (Date.now() - start < 1500) {
    const value = await metrics(base);
    if (value.queued === count) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("queue did not reach expected size");
}
const upstreamOk = () => new Response('data: {"type":"response.completed","response":{"id":"synthetic_response","output":[]}}\n\n');

test("active work holds its lease; queued bodies are not read; overflow is 503; health/auth bypass", { timeout: 6000 }, async () => {
  const entered = deferred(); const release = deferred();
  let upstreamCalls = 0; let queuedRequest;
  await withServer({ maxConcurrent: 1, maxQueued: 1 }, async () => { upstreamCalls++; entered.resolve(); await release.promise; return upstreamOk(); }, async (base) => {
    const first = post(base); await entered.promise;
    const second = post(base, "/responses?queued=1");
    await waitQueued(base, 1);
    try {
      assert.equal(queuedRequest.momoRequestBodyBytes, undefined);
      assert.equal(queuedRequest.listenerCount("data"), 0);
      assert.equal(upstreamCalls, 1);
      const overflow = await post(base);
      assert.equal(overflow.status, 503);
      assert.equal(overflow.headers.get("retry-after"), "1");
      assert.equal((await overflow.json()).error.code, "request_queue_full");
      const health = await fetch(base + "/health"); assert.equal(health.status, 200); await health.text();
      const unauthorized = await post(base, "/v1/responses", { headers: { authorization: "Bearer synthetic_wrong" } });
      assert.equal(unauthorized.status, 401); await unauthorized.text();
    } finally { release.resolve(); }
    await (await first).text(); await (await second).text();
    const final = await metrics(base);
    assert.equal(final.active, 0); assert.equal(final.reservedBytes, 0);
    assert.equal(upstreamCalls, 2);
  }, (server) => server.on("request", (request) => { if (request.url.includes("queued=1")) queuedRequest = request; }));
});

test("queue timeout never calls upstream and the slot is reusable after invalid JSON", { timeout: 5000 }, async () => {
  const entered = deferred(); const release = deferred(); let calls = 0;
  await withServer({ maxConcurrent: 1, queueTimeoutMs: 30 }, async () => { calls++; entered.resolve(); await release.promise; return upstreamOk(); }, async (base) => {
    const first = post(base); await entered.promise;
    try {
      const expired = await post(base);
      assert.equal(expired.status, 503); assert.equal((await expired.json()).error.code, "request_queue_timeout");
      assert.equal(calls, 1);
    } finally { release.resolve(); }
    await (await first).text();
    const bad = await post(base, "/responses", { body: "{" });
    assert.equal(bad.status, 400); assert.equal((await bad.json()).error.code, "invalid_json");
    await (await post(base)).text();
    assert.equal((await metrics(base)).active, 0);
    assert.equal(calls, 2);
  });
});

test("cancelling a queued client removes its slot before active work completes", { timeout: 5000 }, async () => {
  const entered = deferred(); const release = deferred(); let calls = 0;
  await withServer({ maxConcurrent: 1 }, async () => { calls++; entered.resolve(); await release.promise; return upstreamOk(); }, async (base) => {
    const first = post(base); await entered.promise;
    const controller = new AbortController();
    const second = assert.rejects(post(base, "/responses", { signal: controller.signal }), { name: "AbortError" });
    try { await waitQueued(base, 1); controller.abort(); await second; await waitQueued(base, 0); assert.equal(calls, 1); }
    finally { controller.abort(); release.resolve(); }
    await (await first).text();
    assert.equal((await metrics(base)).active, 0);
  });
});

function incompleteUpload(base, headers) {
  let request;
  const result = new Promise((resolve, reject) => {
    request = httpRequest(base + "/responses", { method: "POST", headers: { authorization: "Bearer " + token, ...headers } }, (response) => {
      let text = "";
      response.on("data", (chunk) => { text += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, body: JSON.parse(text) }));
    });
    request.on("error", reject);
    request.flushHeaders();
  });
  return { result, get request() { return request; } };
}

test("Content-Length is rejected before upload and a stalled body gets 408 without leaking a lease", { timeout: 5000 }, async () => {
  await withServer({ bodyReadTimeoutMs: 30 }, async () => { assert.fail("must reject before upstream"); }, async (base) => {
    const large = incompleteUpload(base, { "content-length": 3 * 1024 * 1024 });
    try { const result = await large.result; assert.equal(result.status, 413); assert.equal(result.body.error.code, "payload_too_large"); }
    finally { large.request.destroy(); }
    const slow = incompleteUpload(base, { "content-length": 100 });
    try { const result = await slow.result; assert.equal(result.status, 408); assert.equal(result.body.error.code, "request_body_timeout"); }
    finally { slow.request.destroy(); }
    const final = await metrics(base); assert.equal(final.active, 0); assert.equal(final.reservedBytes, 0);
  });
});

test("unknown chunked bodies reserve their ceiling and reject impossible reservations immediately", { timeout: 5000 }, async () => {
  await withServer({ maxBodyBudgetMb: 1 }, async () => { assert.fail("must not contact upstream"); }, async (base) => {
    const upload = incompleteUpload(base, { "transfer-encoding": "chunked" });
    try { const result = await upload.result; assert.equal(result.status, 413); assert.equal(result.body.error.code, "admission_request_too_large"); }
    finally { upload.request.destroy(); }
    assert.equal((await metrics(base)).active, 0);
  });
});

test("one shared gate covers Chat, compact and internal image POST routes", { timeout: 5000 }, async () => {
  const entered = deferred(); const release = deferred(); let calls = 0;
  await withServer({ maxConcurrent: 1, maxQueued: 0 }, async () => { calls++; entered.resolve(); await release.promise; return upstreamOk(); }, async (base) => {
    const first = post(base); await entered.promise;
    try {
      for (const path of ["/v1/chat/completions", "/chat/completions", "/v1/responses/compact", "/responses/compact", "/internal/images/generate", "/internal/images/edit"]) {
        const response = await post(base, path);
        assert.equal(response.status, 503, path);
        assert.equal((await response.json()).error.code, "request_queue_full");
      }
      assert.equal(calls, 1);
    } finally { release.resolve(); }
    await (await first).text();
  });
});

test("shutdown removes queued work without sending it upstream and lets active work finish", { timeout: 5000 }, async () => {
  const entered = deferred(); const release = deferred(); let calls = 0;
  await withServer({ maxConcurrent: 1 }, async () => { calls++; entered.resolve(); await release.promise; return upstreamOk(); }, async (base) => {
    const first = post(base); await entered.promise;
    const second = post(base); await waitQueued(base, 1);
    try {
      const shutdown = await fetch(base + "/internal/shutdown", { method: "POST", headers: { "x-local-token": token } });
      assert.equal(shutdown.status, 200); await shutdown.text();
      const queued = await second;
      assert.equal(queued.status, 503); assert.equal((await queued.json()).error.code, "server_draining");
      assert.equal(calls, 1);
    } finally { release.resolve(); }
    assert.equal((await first).status, 200);
    await (await first).text();
  });
});

test("active SSE cancellation aborts the upstream and releases admission for the next request", { timeout: 5000 }, async () => {
  let calls = 0; const aborted = deferred();
  await withServer({ maxConcurrent: 1, maxQueued: 0 }, async (_url, init) => {
    calls++;
    if (calls > 1) return upstreamOk();
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(Buffer.from('data: {"type":"response.created","response":{"id":"synthetic_sse"}}\n\n'));
      init.signal.addEventListener("abort", () => { controller.close(); aborted.resolve(); }, { once: true });
    } }));
  }, async (base) => {
    const response = await post(base); const reader = response.body.getReader(); await reader.read();
    assert.equal((await metrics(base)).active, 1);
    await reader.cancel(); await aborted.promise;
    for (let i = 0; i < 100 && (await metrics(base)).active; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal((await metrics(base)).reservedBytes, 0);
    const next = await post(base); assert.equal(next.status, 200); await next.text();
    assert.equal(calls, 2);
  });
});

test("actual chunked body overflow returns a readable HTTP error then closes just that upload", { timeout: 5000 }, async () => {
  await withServer({}, async () => { assert.fail("oversize must not reach upstream"); }, async (base) => {
    const upload = incompleteUpload(base, { "transfer-encoding": "chunked" });
    try {
      upload.request.end(Buffer.alloc(2 * 1024 * 1024 + 1, 120));
      const result = await upload.result;
      assert.equal(result.status, 413); assert.equal(result.body.error.code, "payload_too_large");
      const value = await metrics(base); assert.equal(value.active, 0); assert.equal(value.reservedBytes, 0);
      const health = await fetch(base + "/health"); assert.equal(health.status, 200); await health.text();
    } finally { upload.request.destroy(); }
  });
});
