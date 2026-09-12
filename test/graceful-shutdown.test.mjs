import assert from "node:assert/strict";
import test from "node:test";
import { createMomoSwitch } from "../src/server.mjs";

test("graceful shutdown: draining state, 503 responses, and incomplete SSE on deadline", async () => {
  const localToken = "shutdown_test_token_xyz";
  let upstreamSignal;
  let loggingCloses = 0;
  let markExited;
  const exited = new Promise((resolve) => { markExited = resolve; });
  const loggingRuntime = { env: process.env, enqueueRequest: () => true, enqueueDiagnostic: () => true,
    snapshot: () => ({ request: {}, diagnostic: {} }), close: async () => { loggingCloses++; return { completed: true }; } };

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
    { fetchImpl: fakeFetch, exitImpl: markExited, loggingRuntime }
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

    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(server.listening, false, "shutdown must stop accepting new TCP connections immediately");
    await assert.rejects(
      fetch(`http://127.0.0.1:${port}/healthz`),
      /fetch failed/,
      "a new connection after shutdown must be refused"
    );

    let sseOutput = "";
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      sseOutput += new TextDecoder().decode(chunk.value);
    }

    assert.match(sseOutput, /response\.incomplete/);
    assert.match(sseOutput, /"type":"response\.incomplete"/);
    assert.match(sseOutput, /"incomplete_details":{"reason":"server_shutdown"}/);
    assert.match(sseOutput, /Server shutting down gracefully/);

    assert.ok(upstreamSignal && upstreamSignal.aborted);
    await exited;
    assert.equal(loggingCloses, 1);
  } finally {
    server.close();
  }
});

test("graceful shutdown lets an active request finish naturally before the deadline", async () => {
  const localToken = "shutdown_natural_finish_token";
  let upstreamAborted = false;
  let releaseUpstream;
  let markUpstreamEntered;
  let loggingCloses = 0;
  let markExited;
  const exited = new Promise((resolve) => { markExited = resolve; });
  const loggingRuntime = { env: process.env, enqueueRequest: () => true, enqueueDiagnostic: () => true,
    snapshot: () => ({ request: {}, diagnostic: {} }), close: async () => { loggingCloses++; return { completed: true }; } };
  const upstreamGate = new Promise((resolve) => { releaseUpstream = resolve; });
  const upstreamEntered = new Promise((resolve) => { markUpstreamEntered = resolve; });

  const fakeFetch = async (_url, init) => {
    init.signal.addEventListener("abort", () => { upstreamAborted = true; });
    markUpstreamEntered();
    await upstreamGate;
    return new Response(JSON.stringify({ data: [{ id: "model_after_drain" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const server = createMomoSwitch(
    {
      apiKey: "momo_key",
      endpoint: "https://mock.momo",
      port: 0,
      host: "127.0.0.1",
      localToken,
      drainTimeoutMs: 1000,
    },
    { fetchImpl: fakeFetch, exitImpl: markExited, loggingRuntime }
  );

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const activeRequest = fetch(`http://127.0.0.1:${port}/v1/models`, {
    headers: { authorization: `Bearer ${localToken}` },
  });
  await upstreamEntered;

  const shutdownRes = await fetch(`http://127.0.0.1:${port}/internal/shutdown`, {
    method: "POST",
    headers: { "x-local-token": localToken },
  });
  assert.equal(shutdownRes.status, 200);
  assert.equal((await shutdownRes.json()).ok, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(server.listening, false);
  assert.equal(upstreamAborted, false);

  releaseUpstream();
  const completedResponse = await activeRequest;
  assert.equal(completedResponse.status, 200);
  assert.deepEqual(await completedResponse.json(), { data: [{ id: "model_after_drain" }] });
  assert.equal(upstreamAborted, false);
  await exited;
  assert.equal(loggingCloses, 1);
});

test("HTTP shutdown logging close cannot extend the configured drain deadline indefinitely", async () => {
  const localToken = "shutdown_hard_logging_deadline";
  let markExited;
  const exited = new Promise((resolve) => { markExited = resolve; });
  const loggingRuntime = { env: process.env, enqueueRequest: () => true, enqueueDiagnostic: () => true,
    snapshot: () => ({ request: {}, diagnostic: {} }), close: () => new Promise(() => {}) };
  const server = createMomoSwitch({ apiKey: "momo_key", endpoint: "https://mock.momo", port: 0, host: "127.0.0.1",
    localToken, drainTimeoutMs: 80 }, { exitImpl: markExited, loggingRuntime });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const started = Date.now();
  try {
    const response = await fetch(`http://127.0.0.1:${port}/internal/shutdown`, { method: "POST", headers: { "x-local-token": localToken } });
    assert.equal(response.status, 200);
    await exited;
    assert.ok(Date.now() - started < 500);
  } finally {
    server.close();
  }
});
