import assert from "node:assert/strict";
import test from "node:test";
import { runDoctor } from "../src/doctor.mjs";

test("doctor correctly reports daemon metrics when daemon is online", async () => {
  const fakeMetrics = {
    uptimeSeconds: 120,
    isDraining: false,
    requests: { total: 15, success: 14, failed: 1, active: 0, activeSse: 0 },
    ttfbMs: { p50: 120, p95: 350, p99: 500, samples: 15 },
    memory: { rssBytes: 45000000, heapUsedBytes: 25000000, maxRssBytes: 50000000 },
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
