import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMomoSwitch } from "../src/server.mjs";
import { parseSse } from "../src/responses-sse.mjs";

const payload = { model: "gpt-5.6-sol", stream: true, input: [{ role: "user", content: "synthetic output budget" }] };
async function withServer(fetchImpl, run, extra = {}) {
  const scratch = mkdtempSync(join(tmpdir(), "momo-output-test-"));
  const previous = process.env.MOMO_PROXY_HOME;
  process.env.MOMO_PROXY_HOME = scratch;
  const server = createMomoSwitch({ endpoint: "https://gateway.example", apiKey: "synthetic_gateway", localToken: "synthetic_local", host: "127.0.0.1", port: 0, outputPolicy: { maxStreamMb: 1, maxRetainedMb: 1 }, ...extra }, { fetchImpl });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try { await run("http://127.0.0.1:" + server.address().port); }
  finally {
    server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
    if (previous === undefined) delete process.env.MOMO_PROXY_HOME; else process.env.MOMO_PROXY_HOME = previous;
    rmSync(scratch, { recursive: true, force: true });
  }
}
function request(base, body = payload) {
  return fetch(base + "/v1/responses", { method: "POST", headers: { authorization: "Bearer synthetic_local", "content-type": "application/json" }, body: JSON.stringify(body) });
}
const block = (data) => Buffer.from("data: " + JSON.stringify(data) + "\n\n");

test("many individually valid SSE frames cannot exceed the full-stream budget and report completion", async () => {
  let released = false;
  await withServer(async () => ({ ok: true, body: (async function* () {
    try {
      yield block({ type: "response.created", response: { id: "resp_synthetic_budget" } });
      for (let i = 0; i < 20; i++) yield block({ type: "response.output_text.delta", delta: "x".repeat(65536) });
      yield block({ type: "response.completed", response: { id: "resp_synthetic_budget", output: [] } });
    } finally { released = true; }
  })() }), async (base) => {
    const events = parseSse(await (await request(base)).text());
    assert.equal(events.some((event) => event.type === "response.completed"), false);
    assert.equal(events.find((event) => event.type === "response.failed")?.response.error.code, "output_budget_exceeded");
    assert.equal(events.find((event) => event.type === "response.failed")?.response.id, "resp_synthetic_budget");
    assert.equal(events.filter((event) => event.type === "response.created").length, 1);
    assert.equal(released, true);
  });
});

test("adapter text accumulators fail rather than complete when retained budget fills", async () => {
  for (const model of ["grok-4.5", "gemini-3.1-pro-preview", "claude-sonnet-4-6"]) {
    let aborted;
    await withServer(async (_url, init) => { aborted = init.signal; return { ok: true, body: (async function* () {
      for (let i = 0; i < 20; i++) {
        const text = "x".repeat(65536);
        yield block(model.startsWith("grok") ? { choices: [{ delta: { content: text } }] } : model.startsWith("gemini") ? { candidates: [{ content: { parts: [{ text }] } }] } : { type: "content_block_delta", delta: { type: "text_delta", text } });
      }
    })() }; }, async (base) => {
      const events = parseSse(await (await request(base, { ...payload, model })).text());
      assert.equal(events.some((event) => event.type === "response.completed"), false, model);
      assert.equal(events.find((event) => event.type === "response.failed")?.response.error.code, "output_budget_exceeded", model);
      assert.equal(aborted.aborted, true);
    }, { outputPolicy: { maxStreamMb: 4, maxRetainedMb: 1 } });
  }
});

test("tool delta accumulation rejects before emitting a completed Chat or Claude call", async () => {
  for (const model of ["grok-4.5", "claude-sonnet-4-6"]) {
    await withServer(async () => ({ ok: true, body: (async function* () {
      if (model.startsWith("claude")) yield block({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "call_budget", name: "run", input: {} } });
      for (let i = 0; i < 20; i++) yield block(model.startsWith("grok")
        ? { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_budget", function: { name: i ? "" : "run", arguments: "x".repeat(65536) } }] } }] }
        : { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "x".repeat(65536) } });
      yield block({ type: "content_block_stop", index: 0 });
    })() }), async (base) => {
      const events = parseSse(await (await request(base, { ...payload, model })).text());
      assert.equal(events.some((event) => event.type === "response.completed" || event.type === "response.output_item.done"), false);
      assert.equal(events.find((event) => event.type === "response.failed")?.response.error.code, "output_budget_exceeded");
    }, { outputPolicy: { maxStreamMb: 4, maxRetainedMb: 1 } });
  }
});

test("replay output collection cannot swallow budget errors and anchor incomplete state", async () => {
  await withServer(async () => ({ ok: true, body: (async function* () {
    yield block({ type: "response.created", response: { id: "resp_state_budget" } });
    for (let i = 0; i < 20; i++) yield block({ type: "response.output_item.done", item: { type: "message", id: "item_" + i, content: [{ type: "output_text", text: "x".repeat(65536) }] } });
    yield block({ type: "response.completed", response: { id: "resp_state_budget", output: [] } });
  })() }), async (base) => {
    const events = parseSse(await (await request(base)).text());
    assert.equal(events.some((event) => event.type === "response.completed"), false);
    assert.equal(events.find((event) => event.type === "response.failed")?.response.error.code, "output_budget_exceeded");
  }, { outputPolicy: { maxStreamMb: 4, maxRetainedMb: 1 } });
});

test("unmatched native tool deltas fail at EOF or completion instead of disappearing", async () => {
  for (const terminal of [false, true]) await withServer(async () => new Response(Buffer.concat([
    block({ type: "response.function_call_arguments.delta", item_id: "missing", delta: "abc" }),
    ...(terminal ? [block({ type: "response.completed", response: { output: [] } })] : []),
  ])), async (base) => {
    const events = parseSse(await (await request(base)).text());
    assert.equal(events.some((event) => event.type === "response.completed"), false);
    assert.equal(events.find((event) => event.type === "response.failed")?.response.error.code, "unmatched_tool_arguments");
  });
});

test("event count ceiling is enforced even with negligible text", async () => {
  await withServer(async () => new Response(":one\n\n:two\n\n:three\n\n"), async (base) => {
    const events = parseSse(await (await request(base)).text());
    assert.equal(events.find((event) => event.type === "response.failed")?.response.error.code, "output_budget_exceeded");
  }, { outputPolicy: { maxEvents: 2 } });
});

test("missing result-only Gemini/Claude continuation is 409 before any model POST", async () => {
  for (const model of ["gemini-3.1-pro-preview", "claude-sonnet-4-6"]) await withServer(async () => { assert.fail("missing continuation must not reach upstream"); }, async (base) => {
    const response = await request(base, { ...payload, model, input: [{ type: "function_call_output", call_id: "missing", output: "synthetic" }] });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error.code, "tool_continuation_unavailable");
  });
});

test("an oversized call cache entry cannot emit an executable Gemini tool", async () => {
  await withServer(async () => new Response(block({ candidates: [{ content: { parts: [{ functionCall: { id: "call_too_large", name: "run", args: { data: "x".repeat(1100000) } } }] } }] })), async (base) => {
    const events = parseSse(await (await request(base, { ...payload, model: "gemini-3.1-pro-preview" })).text());
    assert.equal(events.some((event) => event.item?.type === "function_call" || event.type === "response.completed"), false);
    assert.equal(events.find((event) => event.type === "response.failed")?.response.error.code, "output_budget_exceeded");
  }, { outputPolicy: { maxCallCacheMb: 1, maxStreamMb: 4, maxRetainedMb: 4 } });
});

test("raw Chat over-budget streams end as truncated transport, never synthetic success", async () => {
  let released = false;
  await withServer(async () => ({ status: 200, headers: new Headers({ "content-type": "text/event-stream" }), body: (async function* () {
    try { for (let i = 0; i < 20; i++) { yield block({ choices: [{ delta: { content: "x".repeat(65536) } }] }); await new Promise((resolve) => setImmediate(resolve)); } }
    finally { released = true; }
  })() }), async (base) => {
    const response = await fetch(base + "/v1/chat/completions", { method: "POST", headers: { authorization: "Bearer synthetic_local" }, body: JSON.stringify({ model: "grok-4.5", messages: [{ role: "user", content: "synthetic" }], stream: true }) });
    await assert.rejects(response.text()); assert.equal(released, true);
  });
});

test("accepted Gemini and Claude calls retain exact Unicode arguments through result-only continuation", async () => {
  for (const model of ["gemini-3.1-pro-preview", "claude-sonnet-4-6"]) {
    let posts = 0;
    const args = { input: "const message = '中文😀'; text(message);" };
    await withServer(async (_url, init) => {
      posts++;
      if (posts === 1) {
        const events = model.startsWith("gemini") ? [{ candidates: [{ content: { parts: [{ functionCall: { id: "call_closed", name: "run", args }, thoughtSignature: "synthetic_signature" }] } }] }] : [
          { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "call_closed", name: "run", input: {} } },
          { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(args) } },
          { type: "content_block_stop", index: 0 },
        ];
        return new Response(Buffer.concat(events.map(block)));
      }
      const body = JSON.parse(init.body);
      if (model.startsWith("gemini")) {
        const part = body.contents.flatMap((item) => item.parts).find((item) => item.functionCall);
        assert.deepEqual(part.functionCall.args, args); assert.equal(part.thoughtSignature, "synthetic_signature");
        assert.ok(body.contents.flatMap((item) => item.parts).some((item) => item.functionResponse));
      } else {
        const parts = body.messages.flatMap((item) => Array.isArray(item.content) ? item.content : []);
        assert.deepEqual(parts.find((item) => item.type === "tool_use").input, args);
        assert.equal(parts.find((item) => item.type === "tool_result").tool_use_id, "call_closed");
      }
      return new Response(block(model.startsWith("gemini") ? { candidates: [{ content: { parts: [{ text: "done" }] } }] } : { type: "content_block_delta", delta: { type: "text_delta", text: "done" } }));
    }, async (base) => {
      const body = { ...payload, model, tools: [{ type: "custom", name: "run" }] };
      const first = parseSse(await (await request(base, body)).text());
      const tool = first.find((item) => item.type === "response.output_item.done" && item.item.type === "custom_tool_call").item;
      assert.equal(tool.input, args.input); assert.equal(tool.call_id, "call_closed");
      const second = parseSse(await (await request(base, { ...body, input: [{ type: "custom_tool_call_output", call_id: tool.call_id, output: "synthetic result" }] })).text());
      assert.equal(second.some((item) => item.type === "response.completed"), true);
      const metrics = await (await fetch(base + "/internal/metrics", { headers: { "x-local-token": "synthetic_local" } })).json();
      assert.ok(metrics.callCache.bytes > 0); assert.ok(metrics.callCache.bytes < metrics.callCache.maxBytes);
      assert.equal(metrics.admission.active, 0); assert.equal(metrics.admission.reservedBytes, 0);
      assert.equal(posts, 2);
    });
  }
});

test("large upstream error bodies are bounded and never trigger protocol fallback", async () => {
  let calls = 0;
  await withServer(async () => { calls++; return new Response("x".repeat(1100000), { status: 400 }); }, async (base) => {
    const response = await request(base);
    const events = parseSse(await response.text());
    assert.equal(events.find((item) => item.type === "response.failed")?.response.error.code, "output_budget_exceeded");
    assert.equal(calls, 1);
  });
});

test("four simultaneous overflowing streams release all ingress reservations and upstream iterators", async () => {
  let released = 0;
  await withServer(async () => ({ ok: true, body: (async function* () {
    try { for (let i = 0; i < 20; i++) { yield block({ type: "response.output_text.delta", delta: "x".repeat(65536) }); await new Promise((resolve) => setImmediate(resolve)); } }
    finally { released++; }
  })() }), async (base) => {
    await Promise.all(Array.from({ length: 4 }, async () => {
      const events = parseSse(await (await request(base)).text());
      assert.equal(events.some((item) => item.type === "response.completed"), false);
      assert.equal(events.find((item) => item.type === "response.failed")?.response.error.code, "output_budget_exceeded");
    }));
    const metrics = await (await fetch(base + "/internal/metrics", { headers: { "x-local-token": "synthetic_local" } })).json();
    assert.equal(metrics.admission.active, 0); assert.equal(metrics.admission.reservedBytes, 0);
    assert.equal(released, 4);
  });
});

test("Chat, Gemini and Claude preserve host-helper JavaScript instead of wrapping it as shell", async () => {
  const sources = [
    "text('中文😀')",
    "text(await tools.exec_command({cmd:'synthetic-only'}));",
    "image('data:image/png;base64,synthetic')",
    "audio('synthetic')", "generatedImage({image_url:'synthetic'})",
    "store('synthetic', 1); text(load('synthetic'));",
    "load('synthetic')", "notify('synthetic')", "exit()",
    "setTimeout(() => text('synthetic'), 1)", "clearTimeout(1)", "yield_control()",
    "text /* comment */ ('synthetic')",
  ];
  for (const model of ["grok-4.5", "gemini-3.1-pro-preview", "claude-sonnet-4-6"]) await withServer(async () => {
    const events = sources.flatMap((input, index) => {
      const id = "call_helpers_" + index;
      const args = { input };
      if (model.startsWith("grok")) return [{ choices: [{ delta: { tool_calls: [{ index, id, function: { name: "exec", arguments: JSON.stringify(args) } }] } }] }];
      if (model.startsWith("gemini")) return [{ candidates: [{ content: { parts: [{ functionCall: { id, name: "exec", args } }] } }] }];
      return [
        { type: "content_block_start", index, content_block: { type: "tool_use", id, name: "exec", input: args } },
        { type: "content_block_stop", index },
      ];
    });
    return new Response(Buffer.concat(events.map(block)));
  }, async (base) => {
    const events = parseSse(await (await request(base, { ...payload, model, tools: [{ type: "custom", name: "exec" }] })).text());
    const calls = events.filter((item) => item.type === "response.output_item.done" && item.item.type === "custom_tool_call");
    assert.deepEqual(calls.map((item) => item.item.input), sources, model);
    assert.deepEqual(calls.map((item) => item.item.call_id), sources.map((_, i) => "call_helpers_" + i));
  });
});

test("helper-like command prefixes remain shell-compatible instead of being treated as JS", async () => {
  const sources = ["echo synthetic", "text-file synthetic", "image synthetic.png", "notify-send synthetic", "exit 0", "text_helper('synthetic')"];
  await withServer(async () => new Response(Buffer.concat(sources.map((input, index) => block({
    candidates: [{ content: { parts: [{ functionCall: { id: "call_shell_" + index, name: "exec", args: { input } } }] } }],
  })))), async (base) => {
    const events = parseSse(await (await request(base, { ...payload, model: "gemini-3.1-pro-preview", tools: [{ type: "custom", name: "exec" }] })).text());
    const calls = events.filter((item) => item.type === "response.output_item.done" && item.item.type === "custom_tool_call");
    assert.deepEqual(calls.map((item) => item.item.input), sources.map((input) => "await tools.exec_command({ cmd: " + JSON.stringify(input) + " });"));
  });
});
