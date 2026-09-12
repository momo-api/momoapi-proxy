import test from "node:test";
import assert from "node:assert/strict";
import { summarizeToolRequest, createToolEventAudit, observeToolEvent, summarizeToolEvents } from "../src/tool-audit.mjs";
import {
  rewriteRoutedNamespaceToolsForUpstream,
  restoreRoutedNamespaceCalls,
  rewriteRoutedCustomToolsForUpstream,
  restoreRoutedCustomCalls,
  restoreAllRoutedCallsInJson,
  createRoutedCustomToolRestoreBlockRewrite,
} from "../src/responses-compat.mjs";

test("custom tool selectors are lowered without tool-definition fields", () => {
  const tools = [{ type: "namespace", name: "functions", tools: [{ type: "custom", name: "exec" }] }];
  for (const choice of ["auto", "required", "none", { type: "custom", name: "exec" }, { type: "allowed_tools", mode: "required", tools: [{ type: "custom", name: "exec", namespace: "functions" }] }]) {
    const lowered = rewriteRoutedCustomToolsForUpstream({ tools, tool_choice: choice });
    const wire = rewriteRoutedNamespaceToolsForUpstream(lowered.body).body;
    assert.equal(wire.tools[0].type, "function");
    assert.ok(wire.tools[0].parameters);
    const expected = typeof choice === "string" ? choice : choice.type === "custom"
      ? { type: "function", name: "exec" }
      : { type: "allowed_tools", mode: "required", tools: [{ type: "function", name: "exec" }] };
    assert.deepEqual(wire.tool_choice, expected);
  }
});

test("tool audit records only bounded structure and detects missing client call IDs", () => {
  const secret = "PRIVATE_BODY_SENTINEL";
  const summary = summarizeToolRequest({ tools: [{ type: "custom", name: secret, description: secret }], tool_choice: { type: secret, name: secret }, input: [{ type: "function_call_output", call_id: secret, output: secret }] });
  assert.equal(summary.unmatchedOutputs, 1);
  assert.doesNotMatch(JSON.stringify(summary), /PRIVATE_BODY_SENTINEL/);
  const audit = createToolEventAudit();
  const call = { type: "function_call", name: secret, call_id: secret, arguments: secret };
  observeToolEvent(audit, "upstream", { type: "response.output_item.done", item: call });
  assert.equal(summarizeToolEvents(audit).missingClientCalls, 1);
  observeToolEvent(audit, "client", { type: "response.completed", response: { output: [{ ...call, type: "custom_tool_call" }] } });
  assert.equal(summarizeToolEvents(audit).missingClientCalls, 0);
  assert.doesNotMatch(JSON.stringify(summarizeToolEvents(audit)), /PRIVATE_BODY_SENTINEL/);
});

test("responses-compat: namespace flattening and restoration for Codex-Canvas", () => {
  const request = {
    model: "gpt-5.6-sol",
    tools: [
      {
        type: "namespace",
        name: "personal:codex-canvas",
        tools: [
          {
            name: "read_file",
            description: "Read skill file",
            parameters: { type: "object", properties: { file_path: { type: "string" } }, required: ["file_path"] },
          },
        ],
      },
      {
        type: "namespace",
        name: "functions",
        tools: [
          {
            name: "exec_command",
            description: "Run shell command",
            parameters: { type: "object", properties: { cmd: { type: "string" } } },
          },
        ],
      },
    ],
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "@Codex-Canvas open canvas" }],
      },
    ],
  };

  const { body: rewrittenBody, aliases } = rewriteRoutedNamespaceToolsForUpstream(request);

  assert.equal(rewrittenBody.tools.length, 2);
  assert.equal(rewrittenBody.tools[0].name, "personal:codex-canvas__read_file");
  assert.equal(rewrittenBody.tools[1].name, "exec_command");
  assert.equal(aliases.get("personal:codex-canvas__read_file").namespace, "personal:codex-canvas");
  assert.equal(aliases.get("personal:codex-canvas__read_file").name, "read_file");

  // Test SSE event restoration
  const upstreamSsePayload = JSON.stringify({
    type: "response.output_item.added",
    item: {
      type: "function_call",
      name: "personal:codex-canvas__read_file",
      call_id: "call_123",
    },
  });

  const restoredSse = restoreAllRoutedCallsInJson(upstreamSsePayload, aliases, new Set());
  const parsedRestored = JSON.parse(restoredSse);
  assert.equal(parsedRestored.item.name, "read_file");
  assert.equal(parsedRestored.item.namespace, "personal:codex-canvas");
});

test("responses-compat: custom tool lowering and restoration (exec)", () => {
  const request = {
    model: "gpt-5.6-sol",
    tools: [
      {
        type: "custom",
        name: "exec",
        description: "Run JavaScript code",
      },
    ],
    input: [
      {
        type: "custom_tool_call",
        name: "exec",
        call_id: "call_exec_1",
        input: "text('hello')",
      },
      {
        type: "custom_tool_call_output",
        call_id: "call_exec_1",
        output: "hello",
      },
    ],
  };

  const { body: rewrittenBody, names: customNames } = rewriteRoutedCustomToolsForUpstream(request);

  assert.equal(rewrittenBody.tools[0].type, "function");
  assert.equal(rewrittenBody.tools[0].name, "exec");
  assert.equal(rewrittenBody.input[0].type, "function_call");
  assert.equal(rewrittenBody.input[0].arguments, JSON.stringify({ input: "text('hello')" }));
  assert.equal(rewrittenBody.input[1].type, "function_call_output");

  // Test restoring upstream SSE event
  const upstreamOutputDone = JSON.stringify({
    type: "response.output_item.done",
    item: {
      type: "function_call",
      name: "exec",
      call_id: "call_exec_2",
      arguments: JSON.stringify({ input: "tools.exec_command({cmd:'ls'})" }),
    },
  });

  const restored = restoreAllRoutedCallsInJson(upstreamOutputDone, new Map(), customNames);
  const parsed = JSON.parse(restored);
  assert.equal(parsed.item.type, "custom_tool_call");
  assert.equal(parsed.item.name, "exec");
  assert.equal(parsed.item.input, "tools.exec_command({cmd:'ls'})");
  assert.equal(parsed.item.arguments, undefined);
});

test("responses-compat: createRoutedCustomToolRestoreBlockRewrite stream events", () => {
  const customNames = new Set(["exec"]);
  const rewrite = createRoutedCustomToolRestoreBlockRewrite(customNames);

  // 1. Output item added
  const blockAdded = 'event: response.output_item.added\ndata: ' + JSON.stringify({
    type: "response.output_item.added",
    item_id: "fc_1",
    output_index: 0,
    item: {
      type: "function_call",
      id: "fc_1",
      name: "exec",
      arguments: "",
    },
  });
  const out1 = rewrite(blockAdded);
  assert.equal(out1.length, 1);
  const parsed1 = JSON.parse(out1[0].split("\ndata: ")[1]);
  assert.equal(parsed1.item.type, "custom_tool_call");
  assert.equal(parsed1.item.id, "ctc_1");

  // 2. Argument delta
  const blockDelta1 = 'event: response.function_call_arguments.delta\ndata: ' + JSON.stringify({
    type: "response.function_call_arguments.delta",
    item_id: "fc_1",
    output_index: 0,
    delta: '{"input":"tools.exec',
  });
  const out2 = rewrite(blockDelta1);
  assert.equal(out2.length, 1);
  assert(out2[0].startsWith("event: response.custom_tool_call_input.delta"));
  const parsed2 = JSON.parse(out2[0].split("\ndata: ")[1]);
  assert.equal(parsed2.type, "response.custom_tool_call_input.delta");
  assert.equal(parsed2.item_id, "ctc_1");
  assert.equal(parsed2.delta, "tools.exec");

  // 3. Argument done
  const blockDone = 'event: response.function_call_arguments.done\ndata: ' + JSON.stringify({
    type: "response.function_call_arguments.done",
    item_id: "fc_1",
    output_index: 0,
    arguments: '{"input":"tools.exec_command({cmd:\'ls\'})"}',
  });
  const out3 = rewrite(blockDone);
  assert.equal(out3.length, 1);
  assert(out3[0].startsWith("event: response.custom_tool_call_input.done"));
  const parsed3 = JSON.parse(out3[0].split("\ndata: ")[1]);
  assert.equal(parsed3.type, "response.custom_tool_call_input.done");
  assert.equal(parsed3.item_id, "ctc_1");
  assert.equal(parsed3.input, "tools.exec_command({cmd:'ls'})");
});
