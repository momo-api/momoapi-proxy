import assert from "node:assert/strict";
import test from "node:test";
import { createMomoSwitch } from "../src/server.mjs";

test("internal endpoints enforce loopback and localToken authentication", async () => {
  const localToken = "secret_local_test_token_123";
  const server = createMomoSwitch(
    {
      apiKey: "momo_key",
      endpoint: "https://mock.momo",
      port: 0,
      host: "127.0.0.1",
      localToken,
    },
    { exitImpl: () => {} }
  );

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  try {
    // 1. 无 token 访问 /internal/metrics -> 403
    const resNoToken = await fetch(`http://127.0.0.1:${port}/internal/metrics`);
    assert.equal(resNoToken.status, 403);

    // 2. 错误 token 访问 /internal/metrics -> 403
    const resBadToken = await fetch(`http://127.0.0.1:${port}/internal/metrics`, {
      headers: { "x-local-token": "wrong_token" },
    });
    assert.equal(resBadToken.status, 403);

    // 3. 正确 token 访问 /internal/metrics -> 200 并返回合规字段
    const resGood = await fetch(`http://127.0.0.1:${port}/internal/metrics`, {
      headers: { "x-local-token": localToken },
    });
    assert.equal(resGood.status, 200);
    const metrics = await resGood.json();
    assert.equal(metrics.ok, true);
    assert.ok(typeof metrics.uptimeSeconds === "number");
    assert.ok(typeof metrics.resetTime === "string");
    assert.ok(metrics.requests && typeof metrics.requests.total === "number");
    assert.ok(metrics.ttfbMs && typeof metrics.ttfbMs.p50 === "number");
    assert.ok(metrics.memory && typeof metrics.memory.rssBytes === "number");
    assert.ok(typeof metrics.memory.externalBytes === "number");
    assert.ok(metrics.telemetry && typeof metrics.telemetry.queueDepth === "number");

    // 4. 无 token 请求 /internal/shutdown -> 403
    const resShutdownNoToken = await fetch(`http://127.0.0.1:${port}/internal/shutdown`, { method: "POST" });
    assert.equal(resShutdownNoToken.status, 403);

    // 5. 正确 token 请求 /internal/shutdown -> 200 并进入 draining 状态
    const resShutdown = await fetch(`http://127.0.0.1:${port}/internal/shutdown`, {
      method: "POST",
      headers: { "x-local-token": localToken },
    });
    assert.equal(resShutdown.status, 200);
    const shutdownBody = await resShutdown.json();
    assert.equal(shutdownBody.ok, true);

    // 6. shutdown 响应完成后必须停止监听，新的 TCP 连接应被拒绝。
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(server.listening, false);
    await assert.rejects(fetch(`http://127.0.0.1:${port}/healthz`), /fetch failed/);
  } finally {
    server.close();
  }
});
