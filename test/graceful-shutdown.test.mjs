import assert from "node:assert/strict";
import test from "node:test";
import { createMomoSwitch } from "../src/server.mjs";

test("graceful shutdown: draining state, 503 responses, and incomplete SSE on deadline", async () => {
  const localToken = "shutdown_test_token_xyz";
  let upstreamSignal;

  const fakeFetch = async (_url, init) => {
    upstreamSignal = init.signal;
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("event: response.created\ndata: {}\n\n"));
        upstreamSignal.addEventListener("abort", () => {
          try {
            controller.close();
          } catch {}
        });
      },
    });

    return new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  };

  const server = createMomoSwitch(
    {
      apiKey: "momo_key",
      endpoint: "https://mock.momo",
      port: 0,
      host: "127.0.0.1",
      localToken,
      drainTimeoutMs: 300,
    },
    { fetchImpl: fakeFetch }
  );

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  try {
    const sseResponse = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${localToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: "gpt-5.6-sol", input: [] }),
    });

    assert.equal(sseResponse.status, 200);
    const reader = sseResponse.body.getReader();
    const firstChunk = await reader.read();
    assert.ok(!firstChunk.done);
    const firstChunkText = new TextDecoder().decode(firstChunk.value);
    assert.match(firstChunkText, /response\.created/);

    const shutdownRes = await fetch(`http://127.0.0.1:${port}/internal/shutdown`, {
      method: "POST",
      headers: { "x-local-token": localToken },
    });
    assert.equal(shutdownRes.status, 200);

    const bizRes = await fetch(`http://127.0.0.1:${port}/v1/models`, {
      headers: { authorization: `Bearer ${localToken}` },
    });
    assert.equal(bizRes.status, 503);
    assert.equal(bizRes.headers.get("retry-after"), "5");

    const healthRes = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.equal(healthRes.status, 503);
    const healthBody = await healthRes.json();
    assert.equal(healthBody.status, "draining");

    let sseOutput = "";
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      sseOutput += new TextDecoder().decode(chunk.value);
    }

    assert.match(sseOutput, /response\.incomplete/);
    assert.match(sseOutput, /Server shutting down gracefully/);

    assert.ok(upstreamSignal && upstreamSignal.aborted);
  } finally {
    server.close();
  }
});
