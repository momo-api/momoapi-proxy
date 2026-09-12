import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMomoSwitch } from "../src/server.mjs";
import { parseSse } from "../src/responses-sse.mjs";
import { createToolEventAudit, observeToolBlock, summarizeToolEvents } from "../src/tool-audit.mjs";

const settings = { endpoint: "https://gateway.example", apiKey: "synthetic_gateway", localToken: "synthetic_local", host: "127.0.0.1", port: 0 };
const payload = { model: "gpt-5.6-sol", stream: true, tools: [{ type: "namespace", name: "terminal", tools: [{ type: "custom", name: "run" }] }], input: [{ role: "user", content: "synthetic transport test" }] };

async function withServer(fetchImpl, run, instrument) {
  const scratch = mkdtempSync(join(tmpdir(), "momo-stream-test-"));
  const previous = process.env.MOMO_PROXY_HOME;
  process.env.MOMO_PROXY_HOME = scratch;
  const server = createMomoSwitch(settings, { fetchImpl });
  instrument?.(server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try { await run("http://127.0.0.1:" + server.address().port); }
  finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    if (previous === undefined) delete process.env.MOMO_PROXY_HOME;
    else process.env.MOMO_PROXY_HOME = previous;
    rmSync(scratch, { recursive: true, force: true });
  }
}

function request(base, body = payload) {
  return fetch(base + "/v1/responses", { method: "POST", headers: { authorization: "Bearer synthetic_local", "content-type": "application/json" }, body: JSON.stringify(body) });
}

test("native Responses retains Chinese/emoji custom tool input across UTF-8 chunks", async () => {
  const input = 'text("中文😀")';
  const item = { type: "function_call", id: "fc_transport", call_id: "transport_call", name: "terminal__run", arguments: JSON.stringify({ input }) };
  const bytes = Buffer.from("data: " + JSON.stringify({ type: "response.output_item.done", item }) + "\n\n");
  await withServer(async () => new Response(new ReadableStream({ start(controller) {
    for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
    controller.close();
  } })), async (base) => {
    const response = await request(base);
    assert.equal(response.status, 200);
    const restored = parseSse(await response.text())[0].item;
    assert.equal(restored.type, "custom_tool_call");
    assert.equal(restored.name, "run");
    assert.equal(restored.namespace, "terminal");
    assert.equal(restored.call_id, item.call_id);
    assert.equal(restored.input, input);
  });
});

test("native CRLF first event is forwarded while upstream remains open", { timeout: 5000 }, async () => {
  let controller;
  await withServer(async () => new Response(new ReadableStream({ start(value) {
    controller = value;
    controller.enqueue(Buffer.from('data: {"type":"response.output_text.delta","delta":"synthetic"}\r\n\r\n'));
  } })), async (base) => {
    let timeout;
    try {
      const result = await Promise.race([
        (async () => { const response = await request(base); const reader = response.body.getReader(); const first = await reader.read(); return { reader, first }; })(),
        new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("first event waited for upstream EOF")), 1200); }),
      ]);
      assert.equal(result.first.done, false);
      assert.match(Buffer.from(result.first.value).toString(), /synthetic/);
      controller.close();
      await result.reader.cancel();
    } finally {
      clearTimeout(timeout);
      try { controller.close(); } catch {}
    }
  });
});

test("multiline native tool events restore once and preserve structural audit", async () => {
  const item = { type: "function_call", id: "fc_multi", call_id: "multi_call", name: "terminal__run", arguments: JSON.stringify({ input: "中文😀" }) };
  const event = { type: "response.output_item.done", item };
  const block = JSON.stringify(event, null, 2).split("\n").map((line) => "data: " + line).join("\r\n");
  const audit = createToolEventAudit();
  observeToolBlock(audit, "upstream", block);
  await withServer(async () => new Response(": comment\r\n" + block + "\r\n\r\n"), async (base) => {
    const response = await request(base);
    const text = await response.text();
    const events = parseSse(text);
    assert.equal(events.length, 1);
    assert.equal(events[0].item.input, "中文😀");
    assert.equal(events[0].item.namespace, "terminal");
    observeToolBlock(audit, "client", text);
    const summary = summarizeToolEvents(audit);
    assert.equal(summary.upstream.length, 1);
    assert.equal(summary.client.length, 1);
    assert.equal(summary.missingClientCalls, 0);
    assert.equal(summary.unexpectedClientCalls, 0);
  });
});

test("Chat, Gemini and Claude adapters preserve split UTF-8 text and multi-line data", async () => {
  const text = "中文😀";
  const cases = [
    { model: "grok-4.5", path: "/v1/chat/completions", event: { choices: [{ delta: { content: text } }] } },
    { model: "gemini-3.1-pro-preview", path: ":streamGenerateContent?alt=sse", event: { candidates: [{ content: { parts: [{ text }] } }] } },
    { model: "claude-sonnet-4-6", path: "/v1/messages", event: { type: "content_block_delta", delta: { type: "text_delta", text } } },
  ];
  for (const entry of cases) {
    const bytes = Buffer.from(JSON.stringify(entry.event, null, 2).split("\n").map((line) => "data: " + line).join("\r\n") + "\r\n\r\n");
    await withServer(async (url) => {
      assert.ok(url.endsWith(entry.path), entry.model + " adapter route");
      return new Response(new ReadableStream({ start(controller) {
        for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
        controller.close();
      } }));
    }, async (base) => {
      const response = await request(base, { model: entry.model, stream: true, input: payload.input });
      const events = parseSse(await response.text());
      assert.equal(events.filter((event) => event.type === "response.output_text.delta").map((event) => event.delta).join(""), text, entry.model);
      assert.equal(events.filter((event) => event.type === "response.completed").length, 1);
    });
  }
});

test("disconnect aborts upstream while an SSE body is open", { timeout: 5000 }, async () => {
  let aborted;
  let controller;
  await withServer(async (_url, init) => {
    aborted = new Promise((resolve) => init.signal.addEventListener("abort", resolve, { once: true }));
    return new Response(new ReadableStream({ start(value) {
      controller = value;
      controller.enqueue(Buffer.from('data: {"type":"response.output_text.delta","delta":"synthetic"}\n\n'));
    } }));
  }, async (base) => {
    let timer;
    try {
      const response = await request(base);
      const reader = response.body.getReader();
      await reader.read();
      await reader.cancel();
      await Promise.race([aborted, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("upstream was not aborted")), 1000); })]);
    } finally { clearTimeout(timer); try { controller.close(); } catch {} }
  });
});

test("invalid upstream UTF-8 yields failure, never a corrupted tool call or completion", async () => {
  await withServer(async () => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(Buffer.from('data: {"type":"response.output_text.delta","delta":"'));
    controller.enqueue(Uint8Array.of(0xff));
    controller.close();
  } })), async (base) => {
    const response = await request(base);
    const events = parseSse(await response.text());
    assert.equal(events.some((event) => event.type === "response.failed"), true);
    assert.equal(events.some((event) => event.type === "response.completed" || event.item?.type === "custom_tool_call"), false);
  });
});

test("native Responses does not pull another upstream event while the client needs drain", { timeout: 5000 }, async () => {
  let produced = 0;
  let release;
  let paused;
  let enterPause;
  paused = new Promise((resolve) => { enterPause = resolve; });
  await withServer(async () => ({ ok: true, body: (async function* () {
    for (let index = 0; index < 3; index++) {
      produced++;
      yield Buffer.from('data: ' + JSON.stringify({ type: "response.output_text.delta", delta: String(index) }) + "\n\n");
    }
  })() }), async (base) => {
    let timer;
    try {
      const responsePromise = request(base);
      await Promise.race([paused, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("drain instrumentation was not reached")), 1000); })]);
      assert.equal(produced, 1);
      release();
      const response = await responsePromise;
      assert.equal(parseSse(await response.text()).map((event) => event.delta).join(""), "012");
      assert.equal(produced, 3);
    } finally { clearTimeout(timer); release?.(); }
  }, (server) => server.on("request", (_request, response) => {
    const write = response.write.bind(response);
    let first = true;
    response.write = function (...args) {
      const result = write(...args);
      if (!first) return result;
      first = false;
      Object.defineProperty(response, "writableNeedDrain", { configurable: true, value: true });
      release = () => { delete response.writableNeedDrain; response.emit("drain"); };
      enterPause();
      return false;
    };
  }));
});
