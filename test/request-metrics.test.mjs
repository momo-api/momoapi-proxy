import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMomoSwitch } from "../src/server.mjs";
import { MetricWindow, RequestMetrics, requestMetricGroup } from "../src/request-metrics.mjs";

// Keep synthetic request logs/assets out of the installed proxy's profile.
const scratch = mkdtempSync(join(tmpdir(), "momo-request-metrics-test-"));
const previousProfile = process.env.MOMO_PROXY_HOME;
process.env.MOMO_PROXY_HOME = scratch;
test.after(() => {
  if (previousProfile === undefined) delete process.env.MOMO_PROXY_HOME;
  else process.env.MOMO_PROXY_HOME = previousProfile;
  rmSync(scratch, { recursive: true, force: true });
});

const settings = { endpoint: "https://synthetic.invalid", apiKey: "synthetic_key", localToken: "synthetic_local", host: "127.0.0.1", port: 0 };
const headers = { authorization: "Bearer synthetic_local", "content-type": "application/json" };
async function withServer(fetchImpl, run, overrides = {}) {
  const server = createMomoSwitch({ ...settings, ...overrides }, { fetchImpl });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const base = "http://127.0.0.1:" + server.address().port;
  try { await run(base); }
  finally { server.closeAllConnections(); await new Promise((done) => server.close(done)); }
}
const metrics = (base) => fetch(base + "/internal/metrics", { headers }).then((r) => r.json());

test("health and metrics polling never create business samples; absence is null", async () => {
  await withServer(async () => { throw new Error("No upstream expected"); }, async (base) => {
    for (let i = 0; i < 4; i++) {
      await fetch(base + "/health?ignored=synthetic").then((r) => r.text());
      await metrics(base);
    }
    const value = await metrics(base);
    assert.equal(value.requests.total, 0);
    assert.equal(value.requests.active, 0);
    assert.deepEqual(value.ttfbMs, { available: false, samples: 0, observations: 0, p50: null, p95: null, p99: null });
    assert.equal(value.requestMetrics.groups.health.requests.total, 4);
    assert.equal(value.requestMetrics.groups.control.requests.total, 5);
    assert.equal(value.requestMetrics.groups.control.requests.active, 1);
  });
});

test("metric windows use nearest rank, reject invalid values and retain only the latest 500", () => {
  const window = new MetricWindow();
  for (const value of [NaN, Infinity, -1, undefined, "1"]) window.add(value);
  assert.equal(window.snapshot().p50, null);
  window.add(0);
  assert.equal(window.snapshot().p95, 0);
  for (let i = 1; i <= 1000; i++) window.add(i);
  assert.deepEqual(window.snapshot(), { available: true, observations: 1001, samples: 500, p50: 750, p95: 975, p99: 995 });
});

test("route classes are fixed and exact, including image and preflight isolation", () => {
  for (const path of ["/v1/responses", "/responses/compact", "/chat/completions"]) assert.equal(requestMetricGroup("POST", path), "business");
  assert.equal(requestMetricGroup("GET", "/v1/models"), "business");
  assert.equal(requestMetricGroup("GET", "/healthz"), "health");
  assert.equal(requestMetricGroup("GET", "/internal/images/tasks/opaque"), "image");
  assert.equal(requestMetricGroup("GET", "/internal/metrics"), "control");
  for (const [method, path] of [["OPTIONS", "/v1/responses"], ["POST", "/health"], ["GET", "/v1/responses-extra"], ["POST", "/v1/models/foo"]]) assert.equal(requestMetricGroup(method, path), "other");
});

test("stage clock is monotonic, completion is idempotent and snapshots cannot mutate state", async () => {
  let clock = 0;
  const collector = new RequestMetrics({ now: () => clock });
  const timing = collector.begin("POST", "/responses");
  timing.observe("queueWaitMs", 4);
  clock = 10; timing.bodyReady();
  clock = 30;
  const result = { body: (async function* () { throw new Error("Must not pull"); })() };
  const wrapped = timing.wrapFetch(async (...args) => { assert.deepEqual(args, ["synthetic", { signal: "untouched" }]); clock = 50; return result; });
  assert.equal(await wrapped("synthetic", { signal: "untouched" }), result);
  clock = 60; timing.firstWrite(); timing.firstWrite(); timing.sse(); timing.sse();
  clock = 100; timing.finish(200); timing.finish(500, true); timing.sse(); timing.firstWrite();
  const group = collector.snapshot().groups.business;
  assert.deepEqual(group.requests, { total: 1, success: 1, failed: 0, aborted: 0, active: 0, activeSse: 0 });
  for (const [name, value] of Object.entries({ queueWaitMs: 4, preUpstreamMs: 20, upstreamHeadersMs: 20, clientFirstWriteMs: 60, transportTotalMs: 100 })) assert.equal(group.stages[name].p50, value);
  assert.equal(group.stages.bodyReadMs.p50, null);
  group.requests.total = 100;
  assert.equal(collector.snapshot().groups.business.requests.total, 1);
});

test("fetch failures retain original error and have no invented headers sample or retry", async () => {
  const collector = new RequestMetrics();
  const timing = collector.begin("GET", "/models");
  const sentinel = new Error("SENSITIVE_ERROR_NOT_RETAINED");
  let calls = 0;
  const wrapped = timing.wrapFetch(() => { calls++; throw sentinel; });
  await assert.rejects(wrapped("https://synthetic.invalid?secret=NOT_RETAINED"), (error) => error === sentinel);
  assert.equal(calls, 1);
  timing.finish(502);
  const group = collector.snapshot().groups.business;
  assert.deepEqual(group.upstream, { attempts: 1, headersReceived: 0, errors: 1 });
  assert.equal(group.stages.upstreamHeadersMs.available, false);
  assert.doesNotMatch(JSON.stringify(collector.snapshot()), /NOT_RETAINED/);
});

test("multiple upstream attempts count separately without fabricating request samples", async () => {
  const collector = new RequestMetrics();
  const timing = collector.begin("POST", "/responses");
  const wrapped = timing.wrapFetch(async () => ({ ok: false, status: 404 }));
  await wrapped(); await wrapped(); timing.finish(502);
  const group = collector.snapshot().groups.business;
  assert.equal(group.requests.total, 1);
  assert.equal(group.upstream.headersReceived, 2);
  assert.equal(group.stages.preUpstreamMs.samples, 1);
  assert.equal(group.stages.upstreamHeadersMs.samples, 2);
});

test("HTTP stages distinguish pre-upstream rejection, headers and first body write", async () => {
  let calls = 0;
  await withServer(async () => { calls++; return Response.json({ object: "response.compaction", output: [] }); }, async (base) => {
    await fetch(base + "/v1/responses/compact", { method: "POST", headers, body: "{" }).then((r) => { assert.equal(r.status, 400); return r.text(); });
    let value = (await metrics(base)).requestMetrics.groups.business;
    assert.equal(calls, 0);
    assert.equal(value.stages.bodyParseMs.samples, 1);
    assert.equal(value.stages.upstreamHeadersMs.available, false);
    await fetch(base + "/v1/responses/compact", { method: "POST", headers, body: JSON.stringify({ model: "PRIVATE_MODEL_SENTINEL", input: [{ role: "user", content: "PRIVATE_CONTENT_SENTINEL" }] }) }).then((r) => r.text());
    const snapshot = await metrics(base);
    value = snapshot.requestMetrics.groups.business;
    assert.equal(calls, 1);
    assert.equal(value.stages.bodyReadMs.samples, 2);
    assert.equal(value.stages.bodyParseMs.samples, 2);
    assert.equal(value.stages.queueWaitMs.samples, 2);
    assert.equal(value.stages.upstreamHeadersMs.samples, 1);
    assert.equal(value.stages.clientFirstWriteMs.samples, 2);
    assert.equal(value.requests.success, 1);
    assert.equal(value.requests.failed, 1);
    assert.doesNotMatch(JSON.stringify(snapshot.requestMetrics), /PRIVATE_|synthetic_local|synthetic_key/);
  }, { compactionMode: "upstream" });
});

test("local compact has no upstream timing and server instances do not share samples", async () => {
  await withServer(async () => { throw new Error("No upstream"); }, async (first) => {
    await fetch(first + "/responses/compact", { method: "POST", headers, body: JSON.stringify({ model: "synthetic", input: [] }) }).then((r) => r.text());
    const value = await metrics(first);
    assert.equal(value.requests.total, 1);
    assert.equal(value.requestMetrics.groups.business.stages.upstreamHeadersMs.p50, null);
    await withServer(async () => {}, async (second) => {
      assert.equal((await metrics(second)).requests.total, 0);
    });
    assert.equal((await metrics(first)).requests.total, 1);
  });
});

test("disconnect before headers releases active counters once without a first-write sample", async () => {
  let entered, aborted;
  const upstreamEntered = new Promise((resolve) => { entered = resolve; });
  const upstreamAborted = new Promise((resolve) => { aborted = resolve; });
  await withServer(async (_url, init) => {
    entered();
    return new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => { aborted(); reject(new Error("aborted")); }, { once: true }));
  }, async (base) => {
    const controller = new AbortController();
    const request = fetch(base + "/models", { headers, signal: controller.signal }).catch(() => {});
    await upstreamEntered;
    assert.equal((await metrics(base)).requests.active, 1);
    controller.abort(); await request; await upstreamAborted;
    const value = await metrics(base);
    assert.equal(value.requests.active, 0);
    assert.equal(value.requests.failed, 1);
    assert.equal(value.requests.aborted, 1);
    assert.equal(value.ttfbMs.available, false);
    assert.equal(value.requestMetrics.groups.business.stages.upstreamHeadersMs.available, false);
  });
});

test("queue timeout records waiting but never invents body/parse/upstream work", async () => {
  let entered, release;
  const firstEntered = new Promise((resolve) => { entered = resolve; });
  const hold = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  await withServer(async () => { calls++; entered(); await hold; return Response.json({ object: "response.compaction", output: [] }); }, async (base) => {
    const init = { method: "POST", headers, body: JSON.stringify({ model: "synthetic", input: [] }) };
    const first = fetch(base + "/responses/compact", init).then((r) => r.text());
    try {
      await firstEntered;
      const second = await fetch(base + "/responses/compact", init);
      assert.equal(second.status, 503); await second.text();
      const value = (await metrics(base)).requestMetrics.groups.business;
      assert.equal(calls, 1);
      assert.equal(value.stages.queueWaitMs.samples, 2);
      assert.equal(value.stages.bodyReadMs.samples, 1);
      assert.equal(value.stages.bodyParseMs.samples, 1);
      assert.equal(value.stages.upstreamHeadersMs.samples, 0);
      assert.equal(value.requests.active, 1);
      assert.equal(value.requests.failed, 1);
    } finally { release(); await first; }
    assert.equal((await metrics(base)).requests.active, 0);
  }, { compactionMode: "upstream", requestAdmission: { maxConcurrent: 1, maxQueued: 1, queueTimeoutMs: 30 } });
});

test("raw Chat SSE stays active until completion, preserving upstream wire bytes", async () => {
  let release;
  const hold = new Promise((resolve) => { release = resolve; });
  const wire = 'data: {"choices":[{"delta":{"content":"中文😀"}}]}\n\n';
  await withServer(async () => new Response(new ReadableStream({ async start(controller) {
    controller.enqueue(new TextEncoder().encode(wire));
    await hold; controller.close();
  } }), { headers: { "content-type": "text/event-stream" } }), async (base) => {
    const response = await fetch(base + "/chat/completions", { method: "POST", headers, body: JSON.stringify({ model: "synthetic", messages: [], stream: true }) });
    const reader = response.body.getReader();
    try {
      assert.equal(new TextDecoder().decode((await reader.read()).value), wire);
      const value = await metrics(base);
      assert.equal(value.requests.activeSse, 1);
      assert.equal(value.ttfbMs.samples, 1);
      assert.equal(value.requestMetrics.groups.business.stages.upstreamHeadersMs.samples, 1);
    } finally { release(); }
    assert.equal((await reader.read()).done, true);
    const value = await metrics(base);
    assert.equal(value.requests.activeSse, 0);
    assert.equal(value.requests.success, 1);
  });
});

test("bodyless responses finish transport without manufacturing first-body-write timing", async () => {
  await withServer(async () => new Response(null, { status: 204 }), async (base) => {
    const response = await fetch(base + "/chat/completions", { method: "POST", headers, body: JSON.stringify({ model: "synthetic", messages: [] }) });
    assert.equal(response.status, 204); await response.text();
    const value = await metrics(base);
    assert.equal(value.requests.success, 1);
    assert.equal(value.ttfbMs.available, false);
    assert.equal(value.requestMetrics.groups.business.stages.transportTotalMs.samples, 1);
  });
});

test("arbitrary path cardinality never grows metric labels or leaks path data", () => {
  const collector = new RequestMetrics();
  for (let i = 0; i < 10000; i++) {
    const timing = collector.begin("GET", "/untrusted/PRIVATE_SENTINEL/" + i);
    timing.firstWrite(); timing.finish(404);
  }
  const value = collector.snapshot();
  assert.equal(Object.keys(value.groups).length, 5);
  assert.equal(value.groups.other.stages.clientFirstWriteMs.samples, 500);
  assert.equal(value.groups.other.requests.total, 10000);
  assert.doesNotMatch(JSON.stringify(value), /PRIVATE_SENTINEL/);
  assert.ok(JSON.stringify(value).length < 10000);
});

test("HTTP 200 with a failed SSE terminal is explicitly transport success, not model success", async () => {
  const wire = 'data: {"type":"response.failed","response":{"id":"resp_synthetic","status":"failed","error":{"code":"synthetic"}}}\n\n';
  await withServer(async () => new Response(wire, { headers: { "content-type": "text/event-stream" } }), async (base) => {
    const response = await fetch(base + "/responses", { method: "POST", headers, body: JSON.stringify({ model: "gpt-5.6-sol", stream: true, input: [] }) });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /response.failed/);
    const value = await metrics(base);
    assert.equal(value.requests.success, 1);
    assert.equal(value.requests.failed, 0);
    assert.equal(value.requests.activeSse, 0);
    assert.match(value.requestMetrics.scope, /not model or SSE terminal success/);
  });
});

test("cancelling an open SSE counts an aborted HTTP transport and releases active SSE once", async () => {
  let aborted;
  const upstreamAborted = new Promise((resolve) => { aborted = resolve; });
  await withServer(async (_url, init) => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode('data: {"choices":[]}\n\n'));
    init.signal.addEventListener("abort", () => { aborted(); controller.close(); }, { once: true });
  } }), { headers: { "content-type": "text/event-stream" } }), async (base) => {
    const controller = new AbortController();
    const response = await fetch(base + "/chat/completions", { method: "POST", headers, signal: controller.signal, body: JSON.stringify({ model: "synthetic", messages: [], stream: true }) });
    const reader = response.body.getReader();
    assert.equal((await reader.read()).done, false);
    assert.equal((await metrics(base)).requests.activeSse, 1);
    controller.abort();
    await reader.read().catch(() => {});
    await upstreamAborted;
    const value = await metrics(base);
    assert.deepEqual(value.requests, { total: 1, success: 0, failed: 1, aborted: 1, active: 0, activeSse: 0 });
    assert.equal(value.ttfbMs.samples, 1);
    assert.equal(value.requestMetrics.groups.business.stages.transportTotalMs.samples, 1);
  });
});
