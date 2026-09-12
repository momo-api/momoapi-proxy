import assert from "node:assert/strict";
import test from "node:test";
import { runDoctor } from "../src/doctor.mjs";

test("doctor correctly reports daemon metrics when daemon is online", async () => {
  const fakeMetrics = {
    uptimeSeconds: 120,
    isDraining: false,
    requests: { total: 15, success: 14, failed: 1, active: 0, activeSse: 0 },
    ttfbMs: { p50: 120, p95: 350, p99: 500, samples: 15 },
    requestMetrics: { schemaVersion: 1, groups: { business: { stages: {} } } },
    memory: { rssBytes: 45000000, heapUsedBytes: 25000000, maxRssBytes: 50000000 },
    logging: { request: { accepted: 10 }, diagnostic: { accepted: 1 } },
    diagnostics: { mode: "local-only", localRecorded: 1, dropped: 0 },
  };

  const fakeFetch = async (url) => {
    if (url.includes("/internal/metrics")) {
      return new Response(JSON.stringify(fakeMetrics), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/v1/models")) {
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }
    return new Response("Not found", { status: 404 });
  };

  const res = await runDoctor({
    env: {
      MOMO_API_KEY: "sk-mock-key",
      MOMO_ENDPOINT: "https://mock.momo",
      MOMO_LOCAL_TOKEN: "mock-token",
    },
    fetchImpl: fakeFetch,
  });

  assert.ok(res.checks.daemonMetrics);
  assert.equal(res.checks.daemonMetrics.available, true);
  assert.equal(res.checks.daemonMetrics.uptimeSeconds, 120);
  assert.equal(res.checks.daemonMetrics.requests.total, 15);
  assert.equal(res.checks.daemonMetrics.ttfbMs.p50, 120);
  assert.deepEqual(res.checks.daemonMetrics.requestMetrics, fakeMetrics.requestMetrics);
  assert.deepEqual(res.checks.daemonMetrics.logging, fakeMetrics.logging);
  assert.deepEqual(res.checks.daemonMetrics.diagnostics, fakeMetrics.diagnostics);
});

test("doctor reports offline reason without fabricating zero values when daemon is unreachable", async () => {
  const fakeFetch = async (url) => {
    if (url.includes("/internal/metrics")) {
      throw new Error("connect ECONNREFUSED 127.0.0.1:18789");
    }
    if (url.includes("/v1/models")) {
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }
    return new Response("Not found", { status: 404 });
  };

  const res = await runDoctor({
    env: {
      MOMO_API_KEY: "sk-mock-key",
      MOMO_ENDPOINT: "https://mock.momo",
    },
    fetchImpl: fakeFetch,
  });

  assert.ok(res.checks.daemonMetrics);
  assert.equal(res.checks.daemonMetrics.available, false);
  assert.ok(res.checks.daemonMetrics.reason.includes("ECONNREFUSED"));
});

test("doctor preserves unavailable timing samples instead of converting null to zero", async () => {
  const absent = { available: false, samples: 0, observations: 0, p50: null, p95: null, p99: null };
  const result = await runDoctor({
    env: { MOMO_API_KEY: "synthetic_key", MOMO_ENDPOINT: "https://synthetic.invalid", MOMO_LOCAL_TOKEN: "synthetic_local" },
    fetchImpl: async (url) => Response.json(url.includes("/internal/metrics")
      ? { ttfbMs: absent, requestMetrics: { schemaVersion: 1, groups: {} } }
      : { data: [] }),
  });
  assert.equal(result.checks.daemonMetrics.available, true);
  assert.deepEqual(result.checks.daemonMetrics.ttfbMs, absent);
});
