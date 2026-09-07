import assert from "node:assert/strict";
import test from "node:test";
import { createMomoSwitch, resetMetrics } from "../src/server.mjs";

test("metrics accurately track requests, successes, failures, and TTFB", async () => {
  resetMetrics();
  const localToken = "metrics_token_456";

  const fakeFetch = async (url, opts) => {
    if (url.includes("/v1/models")) {
      return new Response(JSON.stringify({ data: [{ id: "model-a" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("Upstream failure", { status: 500 });
  };

  const server = createMomoSwitch({
    apiKey: "momo_key",
    endpoint: "https://mock.momo",
    port: 0,
    host: "127.0.0.1",
    localToken,
  }, { fetchImpl: fakeFetch });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  try {
    // 1. 发起 2 次成功请求并读完 body
    const r1 = await fetch(`http://127.0.0.1:${port}/v1/models`, {
      headers: { authorization: `Bearer ${localToken}` },
    });
    await r1.json();

    const r2 = await fetch(`http://127.0.0.1:${port}/v1/models`, {
      headers: { authorization: `Bearer ${localToken}` },
    });
    await r2.json();

    // 2. 发起 1 次失败请求 (未授权 401) 并读完 body
    const r3 = await fetch(`http://127.0.0.1:${port}/v1/models`, {
      headers: { authorization: "Bearer bad_key" },
    });
    await r3.json();

    // 等待 10ms 确保 finish 事件处理完毕
    await new Promise((r) => setTimeout(r, 10));

    // 3. 拉取 metrics 验证计数
    const resMetrics = await fetch(`http://127.0.0.1:${port}/internal/metrics`, {
      headers: { "x-local-token": localToken },
    });
    const metrics = await resMetrics.json();

    assert.equal(metrics.ok, true);
    // 前面 2 次成功 + 1 次 401 失败
    assert.equal(metrics.requests.success, 2);
    assert.equal(metrics.requests.failed, 1);
    assert.equal(metrics.requests.active, 1); // 只有当前 metrics 请求本身活跃
    assert.ok(metrics.ttfbMs.samples >= 3);
    assert.ok(metrics.ttfbMs.p50 >= 0);
    assert.ok(metrics.memory.rssBytes > 0);
    assert.ok(metrics.memory.externalBytes >= 0);
  } finally {
    server.close();
  }
});
