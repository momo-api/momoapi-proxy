import assert from "node:assert/strict";
import test from "node:test";
import { createMomoSwitch } from "../src/server.mjs";
import { extractFunctions, restoreToolName } from "../src/tools.mjs";

test("extractFunctions: functions namespace produces bare tool name for upstream", () => {
  const request = {
    tools: [
      {
        type: "namespace",
        name: "functions",
        tools: [
          { type: "custom", name: "exec", description: "Run shell or JS" },
        ],
      },
      {
        type: "namespace",
        name: "canvas",
        tools: [
          { type: "function", name: "draw", parameters: {} },
        ],
      },
    ],
  };

  const functions = extractFunctions(request);
  const execTool = functions.find((t) => t.originalName === "exec");
  assert.ok(execTool);
  assert.equal(execTool.name, "exec", "functions namespace must keep bare tool name 'exec', not 'functions__exec'");
  assert.equal(execTool.kind, "custom");

  const canvasTool = functions.find((t) => t.originalName === "draw");
  assert.ok(canvasTool);
  assert.equal(canvasTool.name, "canvas__draw", "non-functions namespace keeps namespace prefix");
});

test("restoreToolName: reverse matches bare exec, functions__exec, and variations to declared custom tool", () => {
  const declaredFunctions = [
    { name: "exec", originalName: "exec", kind: "custom", namespace: null },
    { name: "canvas__draw", originalName: "draw", kind: "function", namespace: "canvas" },
  ];

  // 1. 模型返回 bare exec
  const r1 = restoreToolName("exec", declaredFunctions);
  assert.equal(r1.kind, "custom");
  assert.equal(r1.originalName, "exec");

  // 2. 模型返回 functions__exec
  const r2 = restoreToolName("functions__exec", declaredFunctions);
  assert.equal(r2.kind, "custom");
  assert.equal(r2.originalName, "exec");

  // 3. 模型返回 functions/exec
  const r3 = restoreToolName("functions/exec", declaredFunctions);
  assert.equal(r3.kind, "custom");
  assert.equal(r3.originalName, "exec");

  // 4. 模型返回 canvas__draw 能够正常匹配
  const r4 = restoreToolName("canvas__draw", declaredFunctions);
  assert.equal(r4.kind, "function");
  assert.equal(r4.originalName, "draw");

  // 5. 模型返回 bare draw 也能按 originalName 反向匹配
  const r5 = restoreToolName("draw", declaredFunctions);
  assert.equal(r5.kind, "function");
  assert.equal(r5.originalName, "draw");
});

test("Gemini bridge: converts Gemini bare exec with raw/input/command/cmd to Codex custom_tool_call", async () => {
  const localToken = "gemini_tool_test_token";
  let capturedGeminiPayload;

  const fakeFetch = async (_url, init) => {
    capturedGeminiPayload = JSON.parse(init.body);
    // 模拟 Gemini 返回了 bare exec 调用，且参数字段为 raw: "echo test"
    const sse = "data: " + JSON.stringify({
      candidates: [{
        content: {
          parts: [{
            functionCall: {
              name: "exec",
              id: "call_gemini_123",
              args: { raw: "echo test" },
            },
          }],
        },
      }],
    }) + "\n\n";

    return new Response(sse, {
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
    },
    { fetchImpl: fakeFetch }
  );

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  try {
    // Codex 发送请求，包含 functions 命名空间下的 custom exec
    const res = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${localToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "gemini-3.8-flash",
        stream: true,
        input: [{ role: "user", content: [{ type: "input_text", text: "Please run echo test" }] }],
        tools: [
          {
            type: "namespace",
            name: "functions",
            tools: [
              { type: "custom", name: "exec", description: "Execute shell commands or scripts" },
            ],
          },
        ],
      }),
    });

    assert.equal(res.status, 200);
    const bodyText = await res.text();

    // 1. 验证发给 Gemini 的声明保持了 bare exec (没有变成 functions__exec)
    assert.ok(capturedGeminiPayload.tools);
    const decls = capturedGeminiPayload.tools[0].functionDeclarations;
    const execDecl = decls.find((d) => d.name === "exec");
    assert.ok(execDecl, "Declared function for Gemini must be 'exec'");

    // 2. 验证 Codex 收到了 custom_tool_call，而不是普通 function_call
    assert.match(bodyText, /"type":"custom_tool_call"/);
    assert.match(bodyText, /"name":"exec"/);
    assert.match(bodyText, /response\.custom_tool_call_input\.done/);

    // 3. 验证参数被正确包裹并提取为 await tools.exec_command({ cmd: ... })
    const outputItemDone = bodyText
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice(6)))
      .find((event) => event.type === "response.output_item.done");
    assert.ok(outputItemDone);
    assert.equal(outputItemDone.item.input, 'await tools.exec_command({ cmd: "echo test" });');
    assert.doesNotMatch(outputItemDone.item.input, /\{ command:/);
    let executedArgs;
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    await new AsyncFunction("tools", outputItemDone.item.input)({
      exec_command: async (args) => {
        executedArgs = args;
        return { output: "ok", exit_code: 0 };
      },
    });
    assert.deepEqual(executedArgs, { cmd: "echo test" });
    assert.match(bodyText, /echo test/);
  } finally {
    server.close();
  }
});

test("Gemini bridge: second turn custom_tool_call_output is replayed properly to Gemini", async () => {
  const localToken = "gemini_tool_test_token_2";
  let secondTurnPayload;

  let turn = 1;
  const fakeFetch = async (_url, init) => {
    if (turn === 1) {
      turn++;
      const sse = "data: " + JSON.stringify({
        candidates: [{
          content: {
            parts: [{
              functionCall: {
                name: "exec",
                id: "call_gemini_456",
                args: { command: "dir" },
              },
            }],
          },
        }],
      }) + "\n\n";
      return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
    }

    secondTurnPayload = JSON.parse(init.body);
    const sse = "data: " + JSON.stringify({
      candidates: [{
        content: {
          parts: [{ text: "Command completed successfully." }],
        },
      }],
    }) + "\n\n";
    return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
  };

  const server = createMomoSwitch(
    {
      apiKey: "momo_key",
      endpoint: "https://mock.momo",
      port: 0,
      host: "127.0.0.1",
      localToken,
    },
    { fetchImpl: fakeFetch }
  );

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  try {
    // 第 1 轮
    await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: "POST",
      headers: { authorization: `Bearer ${localToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: "gemini-3.8-flash",
        stream: true,
        input: [{ role: "user", content: [{ type: "input_text", text: "List directory" }] }],
        tools: [{ type: "custom", name: "exec" }],
      }),
    });

    // 第 2 轮: Codex 回传 custom_tool_call 与 custom_tool_call_output
    const res2 = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: "POST",
      headers: { authorization: `Bearer ${localToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: "gemini-3.8-flash",
        stream: true,
        input: [
          { role: "user", content: [{ type: "input_text", text: "List directory" }] },
          {
            type: "custom_tool_call",
            id: "ctc_1",
            call_id: "call_gemini_456",
            name: "exec",
            input: 'await tools.exec_command({ cmd: "dir" });',
          },
          {
            type: "custom_tool_call_output",
            call_id: "call_gemini_456",
            output: "Volume in drive C has no label.\nDirectory of C:\\\nfile1.txt",
          },
        ],
        tools: [{ type: "custom", name: "exec" }],
      }),
    });

    assert.equal(res2.status, 200);
    const body2 = await res2.text();
    assert.match(body2, /Command completed successfully/);

    // 验证发给 Gemini 的 contents: 必须包含 model 的 functionCall 和 user 的 functionResponse
    assert.ok(secondTurnPayload);
    const contents = secondTurnPayload.contents;
    const modelTurn = contents.find((c) => c.role === "model");
    assert.ok(modelTurn);
    assert.equal(modelTurn.parts[0].functionCall.name, "exec");

    const userTurn = contents.find((c) => c.role === "user" && c.parts.some((p) => p.functionResponse));
    assert.ok(userTurn, "Must contain user turn with functionResponse");
    const fnResp = userTurn.parts.find((p) => p.functionResponse).functionResponse;
    assert.equal(fnResp.name, "exec");
    assert.ok(fnResp.response);
  } finally {
    server.close();
  }
});
