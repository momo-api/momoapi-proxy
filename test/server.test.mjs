import assert from "node:assert/strict";
import test from "node:test";
import { createMomoSwitch } from "../src/server.mjs";
import { startAutoSync } from "../src/sync.mjs";

const settings = { endpoint: "https://gateway.example", apiKey: "momo-secret", localToken: "local-secret", host: "127.0.0.1", port: 0 };

async function withServer(fetchImpl, run) {
  const server = createMomoSwitch(settings, { fetchImpl });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  try { await run("http://127.0.0.1:" + address.port); } finally { await new Promise((resolve) => server.close(resolve)); }
}

test("rejects access with an invalid local admission token", async () => {
  await withServer(fetch, async (base) => {
    const response = await fetch(base + "/v1/models", { headers: { authorization: "Bearer wrong-token" } });
    assert.equal(response.status, 401);
  });
});

test("passes a Responses model through without leaking MOMO credentials", async () => {
  let upstreamRequest;
  const fakeFetch = async (url, init) => {
    upstreamRequest = { url, init };
    return new Response("event: response.completed\ndata: {}\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  await withServer(fakeFetch, async (base) => {
    const response = await fetch(base + "/v1/responses", { method: "POST", headers: { authorization: "Bearer local-secret", "content-type": "application/json" }, body: JSON.stringify({ model: "deepseek-v4-flash", input: [] }) });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /response.completed/);
  });
  assert.equal(upstreamRequest.url, "https://gateway.example/v1/responses");
  assert.equal(upstreamRequest.init.headers.authorization, "Bearer momo-secret");
  assert.equal(JSON.parse(upstreamRequest.init.body).stream, true);
});

test("bridges Gemini function calls into Codex Responses SSE", async () => {
  let geminiBody;
  const fakeFetch = async (url, init) => {
    geminiBody = JSON.parse(init.body);
    const sse = "data: " + JSON.stringify({ candidates: [{ content: { parts: [{ functionCall: { name: "shell_command", args: { cmd: "pwd" } } }] } }] }) + "\n\n";
    return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  await withServer(fakeFetch, async (base) => {
    const response = await fetch(base + "/v1/responses", { method: "POST", headers: { authorization: "Bearer local-secret", "content-type": "application/json" }, body: JSON.stringify({ model: "gemini-3.7-flash", stream: true, input: [{ role: "user", content: [{ type: "input_text", text: "Run pwd" }] }], additional_tools: [{ type: "function", name: "shell_command", description: "Run a command", parameters: { type: "object", properties: { cmd: { type: "string" } } } }] }) });
    const body = await response.text();
    assert.equal(response.status, 200);
    assert.match(body, /response.function_call_arguments.done/);
    assert.match(body, /shell_command/);
    assert.match(body, /response.completed/);
  });
  assert.equal(geminiBody.tools[0].functionDeclarations[0].name, "shell_command");
  assert.equal(geminiBody.contents[0].parts[0].text, "Run pwd");
});

test("bridges Claude streamed input_json_delta tool arguments", async () => {
  let claudeBody;
  const fakeFetch = async (_url, init) => {
    claudeBody = JSON.parse(init.body);
    const sse = [
      { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_123", name: "shell_command", input: {} } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"command\":\"Get-Location\"}" } },
      { type: "content_block_stop", index: 0 },
    ].map((event) => "data: " + JSON.stringify(event) + "\n\n").join("");
    return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  await withServer(fakeFetch, async (base) => {
    const response = await fetch(base + "/v1/responses", { method: "POST", headers: { authorization: "Bearer local-secret", "content-type": "application/json" }, body: JSON.stringify({ model: "claude-sonnet-4-6", input: [{ role: "user", content: [{ type: "input_text", text: "Run a command" }] }], tools: [{ type: "function", name: "shell_command", parameters: { type: "object" } }] }) });
    const body = await response.text();
    assert.match(body, /Get-Location/);
    assert.match(body, /response.function_call_arguments.done/);
  });
  assert.equal(claudeBody.tools[0].name, "shell_command");
});

test("bridges a Codex custom tool as a custom_tool_call", async () => {
  let claudeBody;
  const fakeFetch = async (_url, init) => {
    claudeBody = JSON.parse(init.body);
    const sse = [
      { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_patch", name: "apply_patch", input: {} } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"input\":\"*** Begin Patch\\n*** End Patch\"}" } },
      { type: "content_block_stop", index: 0 },
    ].map((event) => "data: " + JSON.stringify(event) + "\n\n").join("");
    return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  await withServer(fakeFetch, async (base) => {
    const response = await fetch(base + "/v1/responses", { method: "POST", headers: { authorization: "Bearer local-secret", "content-type": "application/json" }, body: JSON.stringify({ model: "claude-sonnet-4-6", input: [{ role: "user", content: [{ type: "input_text", text: "Patch this file" }] }], additional_tools: [{ type: "custom", name: "apply_patch", description: "Apply a unified diff." }] }) });
    const body = await response.text();
    assert.match(body, /response\.custom_tool_call_input\.done/);
    assert.match(body, /custom_tool_call/);
    assert.match(body, /\*\*\* Begin Patch/);
  });
  assert.equal(claudeBody.tools[0].name, "apply_patch");
  assert.equal(claudeBody.tools[0].input_schema.required[0], "input");
});

test("preserves Claude tool-use context for the next tool-result turn", async () => {
  const requests = [];
  let invocation = 0;
  const fakeFetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    requests.push(body);
    invocation += 1;
    if (invocation === 1) {
      const sse = [
        { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_context", name: "shell_command", input: {} } },
        { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"command\":\"pwd\"}" } },
        { type: "content_block_stop", index: 0 },
      ].map((event) => "data: " + JSON.stringify(event) + "\n\n").join("");
      return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    return new Response("data: " + JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } }) + "\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  await withServer(fakeFetch, async (base) => {
    const headers = { authorization: "Bearer local-secret", "content-type": "application/json" };
    await fetch(base + "/v1/responses", { method: "POST", headers, body: JSON.stringify({ model: "claude-sonnet-4-6", input: [{ role: "user", content: [{ type: "input_text", text: "Run pwd" }] }], tools: [{ type: "function", name: "shell_command", parameters: { type: "object" } }] }) });
    await fetch(base + "/v1/responses", { method: "POST", headers, body: JSON.stringify({ model: "claude-sonnet-4-6", input: [{ type: "function_call_output", call_id: "toolu_context", output: "/tmp" }] }) });
  });
  assert.equal(requests[1].messages[0].content[0].text, "Run pwd");
  assert.deepEqual(requests[1].messages[1], { role: "assistant", content: [{ type: "tool_use", id: "toolu_context", name: "shell_command", input: { command: "pwd" } }] });
  assert.deepEqual(requests[1].messages[2], { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_context", content: "/tmp" }] });
});

test("preserves Gemini function-call context for the next function-response turn", async () => {
  const requests = [];
  let invocation = 0;
  const fakeFetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    requests.push(body);
    invocation += 1;
    const part = invocation === 1
      ? { thoughtSignature: "signature_for_tool_result", functionCall: { name: "shell_command", args: { command: "pwd" } } }
      : { text: "done" };
    return new Response("data: " + JSON.stringify({ candidates: [{ content: { parts: [part] } }] }) + "\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  await withServer(fakeFetch, async (base) => {
    const headers = { authorization: "Bearer local-secret", "content-type": "application/json" };
    const first = await fetch(base + "/v1/responses", { method: "POST", headers, body: JSON.stringify({ model: "gemini-3.7-flash", input: [{ role: "user", content: [{ type: "input_text", text: "Run pwd" }] }], tools: [{ type: "function", name: "shell_command", parameters: { type: "object" } }] }) });
    const callId = (await first.text()).match(/"call_id":"([^"]+)"/)?.[1];
    assert.ok(callId);
    await fetch(base + "/v1/responses", { method: "POST", headers, body: JSON.stringify({ model: "gemini-3.7-flash", input: [{ type: "function_call_output", call_id: callId, output: "/tmp" }] }) });
  });
  assert.equal(requests[1].contents[0].parts[0].text, "Run pwd");
  assert.deepEqual(requests[1].contents[1], { role: "model", parts: [{ thoughtSignature: "signature_for_tool_result", functionCall: { name: "shell_command", args: { command: "pwd" } } }] });
  assert.deepEqual(requests[1].contents[2], { role: "user", parts: [{ functionResponse: { name: "shell_command", response: { result: "/tmp" } } }] });
});

test("routes models cleanly: Claude to /v1/messages, Gemini to gemini endpoint, and others to /v1/responses", async () => {
  const captured = [];
  const fakeFetch = async (url, init) => {
    captured.push({ url, body: init.body ? JSON.parse(init.body) : null });
    return new Response("event: response.completed\ndata: {}\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  await withServer(fakeFetch, async (base) => {
    const headers = { authorization: "Bearer local-secret", "content-type": "application/json" };
    // 1. Sol -> native Responses
    await fetch(base + "/v1/responses", { method: "POST", headers, body: JSON.stringify({ model: "gpt-5.6-sol", input: [] }) });
    assert.equal(captured[0].url, "https://gateway.example/v1/responses");
    assert.equal(captured[0].body.model, "gpt-5.6-sol");

    // 2. Claude Thinking -> Claude Messages
    await fetch(base + "/v1/responses", { method: "POST", headers, body: JSON.stringify({ model: "claude-opus-4-6-thinking", input: [] }) });
    assert.equal(captured[1].url, "https://gateway.example/v1/messages");
    assert.equal(captured[1].body.model, "claude-opus-4-6-thinking");
    assert.deepEqual(captured[1].body.thinking, { type: "enabled", budget_tokens: 4048 });

    // 3. Gemini -> Gemini endpoint
    await fetch(base + "/v1/responses", { method: "POST", headers, body: JSON.stringify({ model: "gemini-3.7-flash", reasoning_effort: "high", input: [] }) });
    assert.ok(captured[2].url.includes("v1beta/models/gemini-3.7-flash:streamGenerateContent"));
    assert.equal(captured[2].body.generationConfig.thinkingConfig.thinkingLevel, "HIGH");
  });
});

test("normalizes complex multi-turn history stripping proprietary thought blocks and metadata", async () => {
  let capturedBody;
  const fakeFetch = async (url, init) => {
    capturedBody = JSON.parse(init.body);
    return new Response("event: response.completed\ndata: {}\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  await withServer(fakeFetch, async (base) => {
    const headers = { authorization: "Bearer local-secret", "content-type": "application/json" };
    const response = await fetch(base + "/v1/responses", {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "gpt-5.6-sol",
        reasoning_effort: "ultra",
        input: [
          { type: "session_meta", id: "sess_1" },
          { type: "task_started", turn: 1 },
          { type: "message", role: "user", content: [{ type: "input_text", text: "Create code" }] },
          { type: "reasoning", summary: ["some thoughts"] },
          { type: "message", role: "assistant", content: [
            { type: "thought", text: "hidden thought" },
            { type: "encrypted_content", data: "xyz" },
            { type: "output_text", text: "Here is the code." }
          ]},
          { type: "token_count", count: 150 },
          { type: "function_call", call_id: "c1", name: "exec", arguments: { cmd: "ls" } },
          { type: "function_call_output", call_id: "c1", output: "main.py" },
          { type: "custom_tool_call", call_id: "c2", name: "patch", input: { file: "main.py" } },
          { type: "custom_tool_call_output", call_id: "c2", output: "ok" },
          { type: "message", role: "assistant", content: [{ type: "output_text", text: "Done." }] },
          { type: "message", role: "user", content: [{ type: "input_text", text: "Next step please" }] }
        ],
      }),
    });
    assert.equal(response.status, 200);
  });

  assert.equal(capturedBody.input.length, 8);
  const assistantMsg = capturedBody.input[1];
  assert.equal(assistantMsg.role, "assistant");
  assert.deepEqual(assistantMsg.content, [{ type: "output_text", text: "Here is the code." }]);
  assert.equal(capturedBody.input[2].arguments, JSON.stringify({ cmd: "ls" }));
  assert.equal(capturedBody.input[4].input, JSON.stringify({ file: "main.py" }));
  assert.deepEqual(capturedBody.reasoning, { effort: "xhigh" });
});

test("emits formatted SSE error events and completes stream gracefully on upstream failure", async () => {
  const fakeFetch = async () => {
    return new Response(JSON.stringify({ error: { message: "Quota exceeded" } }), {
      status: 429,
      headers: { "content-type": "application/json" }
    });
  };
  await withServer(fakeFetch, async (base) => {
    const headers = { authorization: "Bearer local-secret", "content-type": "application/json" };
    const response = await fetch(base + "/v1/responses", {
      method: "POST",
      headers,
      body: JSON.stringify({ model: "gpt-5.6-sol", input: ["hi"] }),
    });
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.match(body, /response.created/);
    assert.match(body, /Quota exceeded/);
    assert.match(body, /event: error/);
    assert.match(body, /response.completed/);
  });
});

test("calculates Claude thinking token budget dynamically from reasoning_effort", async () => {
  let capturedBody;
  const fakeFetch = async (url, init) => {
    capturedBody = JSON.parse(init.body);
    return new Response("event: message_start\ndata: {}\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  await withServer(fakeFetch, async (base) => {
    const headers = { authorization: "Bearer local-secret", "content-type": "application/json" };
    await fetch(base + "/v1/responses", {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "claude-opus-4-6-thinking",
        input: [{ role: "user", content: [{ type: "input_text", text: "solve this" }] }],
        reasoning_effort: "high",
      }),
    });
  });
  assert.deepEqual(capturedBody.thinking, { type: "enabled", budget_tokens: 8192 });
  assert.equal(capturedBody.max_tokens, 16384);
});

test("auto-sync timer schedules periodic catalog refreshes", async () => {
  let syncCount = 0;
  const fakeFetch = async () => {
    syncCount += 1;
    return new Response(JSON.stringify({ data: [{ id: "gpt-5.5" }] }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const autoSync = startAutoSync({
    settings: { apiKey: "test-key", endpoint: "https://gateway.example", syncIntervalMinutes: 0.001 },
    fetchImpl: fakeFetch,
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.ok(syncCount >= 1);
  } finally {
    autoSync.stop();
  }
});
