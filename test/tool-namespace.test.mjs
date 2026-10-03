import assert from "node:assert/strict";
import test from "node:test";
import { createMomoSwitch } from "../src/server.mjs";
import { emitRememberedCall } from "../src/tool-call-state.mjs";
import { ResponseStreamEmitter, parseSse, functionEvents, customToolEvents } from "../src/responses-sse.mjs";
import { extractFunctions } from "../src/tools.mjs";
import { isolatedProfile } from "./support/isolated-profile.mjs";

const profile = isolatedProfile("momo-tool-namespace-");
const input = 'text("中文🙂\\nblackbox")';
const parameters = { type: "object", properties: { query: { type: "string" } }, required: ["query"] };
const children = () => [
  { type: "custom", name: "write", format: { type: "text" } },
  { type: "function", name: "read", parameters },
];
const tools = [
  ...["pad", "board"].map(name => ({ type: "namespace", name, tools: children() })),
  ...children(),
  { type: "namespace", name: "functions", tools: [
    { type: "custom", name: "run", format: { type: "text" } },
    { type: "function", name: "inspect", parameters },
  ] },
];
const functions = extractFunctions({ tools });
const argsFor = tool => tool.kind === "custom" ? { input } : { query: "中文🙂" };
const encode = frames => frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join("");

function assertToolItems(events) {
  const added = events.filter(e => e.type === "response.output_item.added").map(e => e.item);
  const done = events.filter(e => e.type === "response.output_item.done").map(e => e.item);
  const completed = events.filter(e => e.type === "response.completed");
  assert.equal(completed.length, 1);
  for (const items of [added, done, completed[0].response.output]) {
    assert.equal(items.length, functions.length);
    functions.forEach((tool, index) => {
      const item = items[index];
      assert.equal(item.type, tool.kind === "custom" ? "custom_tool_call" : "function_call");
      assert.equal(item.name, tool.originalName);
      if (tool.namespace) assert.equal(item.namespace, tool.namespace);
      else assert.equal(Object.hasOwn(item, "namespace"), false);
      assert.ok(item.call_id);
      assert.equal(item.id, done[index].id);
      assert.equal(item.call_id, done[index].call_id);
      if (items !== added) {
        if (tool.kind === "custom") assert.equal(item.input, input);
        else assert.deepEqual(JSON.parse(item.arguments), argsFor(tool));
      }
    });
  }
}

test("remembered calls preserve namespace identity in cache and all SSE output items", () => {
  let text = "";
  const emitter = new ResponseStreamEmitter({ write: chunk => { text += chunk; }, end() {} }, "mock");
  const calls = new Map();
  emitter.start();
  functions.forEach((tool, index) => {
    const callId = `call_${index}`;
    emitRememberedCall(emitter, calls, tool, argsFor(tool), callId);
    assert.equal(calls.get(callId).namespace, tool.namespace);
    assert.equal(calls.get(callId).name, tool.name);
    assert.equal(calls.get(callId).originalName, tool.originalName);
  });
  emitter.complete();
  assertToolItems(parseSse(text));
});

test("standalone tool event helpers preserve optional namespace without inventing one", () => {
  for (const namespace of ["pad", null, undefined]) {
    for (const helper of [functionEvents, customToolEvents]) {
      const result = helper("resp_test", 0, { callId: "call_test", name: "write", namespace, input, arguments: { query: "中文🙂" } });
      const items = parseSse(result.events.join("")).filter(e => e.item).map(e => e.item);
      assert.equal(items.length, 2);
      for (const item of items) {
        if (namespace) assert.equal(item.namespace, namespace);
        else assert.equal(Object.hasOwn(item, "namespace"), false);
      }
    }
  }
});

test("namespace bytes remain budgeted and rejected calls leave no cache or output item", () => {
  for (const kind of ["function", "custom"]) {
    let text = "";
    const emitter = new ResponseStreamEmitter({ write: chunk => { text += chunk; }, end() {} }, "mock", undefined, { outputPolicy: { maxRetainedMb: 1 } });
    const calls = new Map();
    emitter.start();
    const mapped = { name: "huge__write", originalName: "write", namespace: "中".repeat(400_000), kind };
    assert.throws(() => emitRememberedCall(emitter, calls, mapped, { input }, "call_budget"), { code: "output_budget_exceeded" });
    assert.equal(calls.has("call_budget"), false);
    assert.equal(parseSse(text).some(e => e.item || e.type === "response.completed"), false);
  }
});

const routes = [
  { protocol: "chat", model: "deepseek-v4-flash" },
  { protocol: "chat-dsml", model: "deepseek-v4-flash" },
  { protocol: "gemini", model: "gemini-3.7-flash" },
  { protocol: "claude", model: "claude-sonnet-4-6" },
  { protocol: "responses-dsml", model: "gpt-5.6-sol" },
];

for (const { protocol, model } of routes) {
  test(`${protocol}: restores colliding namespace names for function/custom calls at added/done/completed`, async () => {
    const fetchImpl = async (url, init) => {
      const body = JSON.parse(init.body);
      const offered = protocol === "gemini" ? body.tools[0].functionDeclarations.map(t => t.name)
        : protocol === "claude" ? body.tools.map(t => t.name)
          : protocol === "responses-dsml" ? body.tools.map(t => t.name)
            : body.tools.map(t => t.function.name);
      assert.deepEqual(offered, functions.map(t => t.name));
      let frames;
      if (protocol.endsWith("dsml")) {
        const dsml = `<tool_calls>${functions.map(tool => `<invoke name="${tool.name}">${Object.entries(argsFor(tool)).map(([key, value]) => `<parameter name="${key}">${value}</parameter>`).join("")}</invoke>`).join("")}</tool_calls>`;
        frames = protocol === "chat-dsml"
          ? [{ choices: [{ delta: { content: dsml } }] }]
          : [{ type: "response.created", response: { id: "resp_dsml" } }, { type: "response.output_text.delta", delta: dsml }, { type: "response.completed", response: { output: [] } }];
      } else if (protocol === "chat") {
        assert.ok(String(url).endsWith("/v1/chat/completions"));
        frames = [{ choices: [{ delta: { tool_calls: functions.map((tool, index) => ({ index, id: `call_${index}`, type: "function", function: { name: tool.name, arguments: JSON.stringify(argsFor(tool)) } })) } }] }];
      } else if (protocol === "gemini") {
        frames = [{ candidates: [{ content: { parts: functions.map((tool, index) => ({ functionCall: { id: `call_${index}`, name: tool.name, args: argsFor(tool) } })) } }] }];
      } else {
        frames = functions.flatMap((tool, index) => [
          { type: "content_block_start", index, content_block: { type: "tool_use", id: `call_${index}`, name: tool.name, input: {} } },
          { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(argsFor(tool)) } },
          { type: "content_block_stop", index },
        ]);
      }
      return new Response(encode(frames), { headers: { "content-type": "text/event-stream" } });
    };
    const server = createMomoSwitch({ endpoint: "https://mock.example", apiKey: "synthetic-upstream", localToken: "synthetic-local", host: "127.0.0.1", port: 0 }, { fetchImpl, env: profile.env });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/responses`, {
        method: "POST", headers: { authorization: "Bearer synthetic-local", "content-type": "application/json" },
        body: JSON.stringify({ model, stream: true, input: [{ role: "user", content: [{ type: "input_text", text: "Use the tools" }] }], tools }),
      });
      assert.equal(response.status, 200);
      const events = parseSse(await response.text());
      assertToolItems(events);
      if (!protocol.endsWith("dsml")) {
        assert.deepEqual(events.find(e => e.type === "response.completed").response.output.map(item => item.call_id), functions.map((_, index) => `call_${index}`));
      }
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });
}
