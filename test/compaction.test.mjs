import assert from "node:assert/strict";
import test from "node:test";
import { buildLocalCompactResponse, compactionPolicy, decodeLocalCompaction, encodeLocalCompaction, prepareCompactPayload, prepareGeminiHistoryReplay, prepareOversizedHistoryReplay, prepareProviderSwitchHistoryReplay } from "../src/compaction.mjs";
import { decodeRoutedCompaction } from "../src/routed-compaction.mjs";
import { preparePreviousResponseReplay, rememberResponseState, resetResponseStateForTests } from "../src/responses-state.mjs";
import { commitProviderRoute, observeProviderRoute, resetProviderRouteStateForTests } from "../src/provider-switch-state.mjs";
import { createMomoSwitch, resetMetrics } from "../src/server.mjs";
import { compactFixture } from "../scripts/compact-fixtures.mjs";
import { isolatedProfile } from "./support/isolated-profile.mjs";

const settings = { endpoint: "https://gateway.example", apiKey: "test_gateway_key", localToken: "test_local_token", host: "127.0.0.1", port: 0, compactionMode: "upstream" };
const testProfile = isolatedProfile("momo-compaction-test-");

test("provider route state detects protocol switches without retaining raw thread ids", () => {
  resetProviderRouteStateForTests();
  const request = { headers: { "thread-id": "sensitive-thread-id" } };
  const first = observeProviderRoute(request, "responses");
  assert.equal(commitProviderRoute(first), true);
  const same = observeProviderRoute(request, "responses");
  assert.equal(commitProviderRoute(same), true);
  const switched = observeProviderRoute(request, "gemini");
  assert.equal(first.switched, false);
  assert.equal(same.switched, false);
  assert.equal(switched.switched, true);
  assert.equal(switched.previousProtocol, "responses");
  assert.equal(switched.currentProtocol, "gemini");
  assert.match(switched.threadHash, /^[a-f0-9]{16}$/);
  assert.notEqual(switched.threadHash, request.headers["thread-id"]);
});

test("failed provider routes do not hide the switch on retry", () => {
  resetProviderRouteStateForTests();
  const request = { headers: { "thread-id": "retry-thread" } };
  commitProviderRoute(observeProviderRoute(request, "responses"));
  const failedAttempt = observeProviderRoute(request, "gemini");
  assert.equal(failedAttempt.switched, true);
  const retry = observeProviderRoute(request, "gemini");
  assert.equal(retry.switched, true);
  assert.equal(retry.previousProtocol, "responses");
});

function continuityFixture() {
  return { model: "gpt-5.6-sol", stream: true, tool_choice: "required",
    tools: [{ type: "namespace", name: "functions", tools: [{ type: "custom", name: "exec" }] }],
    input: [
      { role: "developer", content: "CONSTRAINT_SENTINEL" },
      { role: "user", content: "ORIGINAL_TASK_SENTINEL" },
      { role: "assistant", content: "x".repeat(600000) },
      { type: "custom_tool_call", name: "exec", call_id: "completed", input: "text(1)" },
      { type: "custom_tool_call_output", call_id: "completed", output: "VERIFIED_STATE_SENTINEL" },
      { type: "custom_tool_call", name: "exec", call_id: "pending", input: "text(2)" },
      { role: "user", content: "LATEST_TASK_SENTINEL" },
      { type: "custom_tool_call_output", call_id: "pending", output: "PENDING_RESULT_SENTINEL" },
    ] };
}

test("checkpoint on/off retains constraints, execution evidence and cross-boundary tool pairs", () => {
  const fixture = continuityFixture();
  for (const limit of [524288, 8388608]) {
    const result = prepareOversizedHistoryReplay(structuredClone(fixture), { maxHistoricalReplayBytes: limit });
    assert.equal(result.rewritten, limit === 524288);
    const text = JSON.stringify(result.payload.input);
    for (const marker of ["CONSTRAINT_SENTINEL", "ORIGINAL_TASK_SENTINEL", "LATEST_TASK_SENTINEL", "VERIFIED_STATE_SENTINEL", "PENDING_RESULT_SENTINEL"]) assert.ok(text.includes(marker));
    for (const item of fixture.input.filter((item) => item.call_id)) assert.deepEqual(result.payload.input.find((candidate) => candidate.type === item.type && candidate.call_id === item.call_id), item);
    assert.deepEqual(result.payload.tools, fixture.tools);
    assert.equal(result.payload.tool_choice, "required");
    if (result.rewritten) assert.ok(result.outboundBytes < 64000);
  }
});

test("provider switching leaves history to Codex unless a replay guard is explicitly configured", () => {
  const fixture = continuityFixture();
  fixture.input[2].content = "x".repeat(240000);
  const ordinary = prepareOversizedHistoryReplay(structuredClone(fixture), {});
  const switched = prepareProviderSwitchHistoryReplay(structuredClone(fixture), {});
  assert.equal(ordinary.rewritten, false);
  assert.equal(switched.rewritten, false);
  assert.equal(switched.limitBytes, null);

  const guarded = prepareProviderSwitchHistoryReplay(structuredClone(fixture), {
    contextPolicy: { providerSwitchReplayBytes: 192 * 1024 },
  });
  assert.equal(guarded.rewritten, true);
  assert.equal(guarded.limitBytes, 192 * 1024);
  const wire = JSON.stringify(guarded.payload.input);
  for (const marker of ["CONSTRAINT_SENTINEL", "ORIGINAL_TASK_SENTINEL", "LATEST_TASK_SENTINEL", "VERIFIED_STATE_SENTINEL", "PENDING_RESULT_SENTINEL"]) assert.match(wire, new RegExp(marker));
});

test("ordinary history replay is zero-work by default and remains available as an explicit safety guard", () => {
  const fixture = continuityFixture();
  fixture.input[2].content = "x".repeat(600000);
  const native = prepareOversizedHistoryReplay(fixture, {});
  assert.equal(native.rewritten, false);
  assert.equal(native.payload, fixture);
  assert.equal(native.originalBytes, 0);
  assert.equal(native.limitBytes, null);

  const guarded = prepareOversizedHistoryReplay(structuredClone(fixture), {
    contextPolicy: { maxHistoricalReplayBytes: 512 * 1024 },
  });
  assert.equal(guarded.rewritten, true);
  assert.equal(guarded.limitBytes, 512 * 1024);
});

test("Gemini replay makes the current turn authoritative and bounds completed history", () => {
  const input = [];
  for (let index = 0; index < 12; index++) {
    input.push(
      { role: "user", content: [{ type: "input_text", text: "OLD_TASK_" + index + " " + "x".repeat(20_000) }] },
      { role: "assistant", content: [{ type: "output_text", text: "OLD_ANSWER_" + index + " " + "y".repeat(20_000) }] },
      { type: "custom_tool_call", name: "exec", call_id: "old_" + index, input: "old command " + index },
      { type: "custom_tool_call_output", call_id: "old_" + index, output: "old result " + index },
    );
  }
  const current = { role: "user", content: [{ type: "input_text", text: "CURRENT_PLUGIN_QUESTION" }] };
  const replay = prepareGeminiHistoryReplay(
    { model: "gemini-3.8-flash", input: [...input, current] },
    { maxHistoricalReplayBytes: 128 * 1024 },
  );
  assert.equal(replay.rewritten, true);
  assert.equal(replay.payload.input.at(-1), current);
  const wire = JSON.stringify(replay.payload.input);
  assert.match(wire, /CURRENT_PLUGIN_QUESTION/);
  assert.match(wire, /OLD_TASK_11/);
  assert.match(wire, /historical text truncated during compaction/);
  assert.doesNotMatch(wire, /OLD_TASK_0/);
  assert.match(wire, /historical completed assistant answer; supporting context only/);
  assert.doesNotMatch(wire, /OLD_ANSWER_10/);
  assert.match(wire, /OLD_ANSWER_11/);
  assert.doesNotMatch(wire, /old command 0/);
  assert.doesNotMatch(wire, /old command 11/);
  assert.ok(replay.outboundBytes < 40 * 1024);
});

test("server checkpoints both directions after an anonymous thread switches protocol families", async () => {
  resetProviderRouteStateForTests();
  resetMetrics();
  const captured = [];
  const fakeFetch = async (url, init) => {
    captured.push({ url: String(url), body: JSON.parse(init.body) });
    if (String(url).includes("streamGenerateContent")) {
      return new Response(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "gemini ok" }] } }] })}\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    return new Response(responseSse("resp_switch_first", [{ id: "msg_switch_first", type: "message", role: "assistant", content: [{ type: "output_text", text: "gpt ok" }] }]), { status: 200, headers: { "content-type": "text/event-stream" } });
  };

  await withServer(fakeFetch, async (base) => {
    const headers = authHeaders({ "thread-id": "private-thread-id-must-not-be-logged" });
    const history = [
      { role: "developer", content: "SWITCH_CONSTRAINT" },
      { role: "user", content: "old task" },
      { role: "assistant", content: "historical prose segment ".repeat(12000) },
      { role: "user", content: "SWITCH_ACTIVE_TASK" },
    ];
    const first = await fetch(`${base}/v1/responses`, { method: "POST", headers, body: JSON.stringify({ model: "gpt-5.6-sol", stream: true, input: history }) });
    assert.equal(first.status, 200);
    await first.text();
    const second = await fetch(`${base}/v1/responses`, { method: "POST", headers, body: JSON.stringify({ model: "gemini-3.8-flash", stream: true, input: history }) });
    assert.equal(second.status, 200);
    await second.text();
    const third = await fetch(`${base}/v1/responses`, { method: "POST", headers, body: JSON.stringify({ model: "gpt-5.6-sol", stream: true, input: history }) });
    assert.equal(third.status, 200);
    await third.text();

    const metrics = await fetch(`${base}/internal/metrics`, { headers: { "x-local-token": "test_local_token" } }).then((response) => response.json());
    assert.equal(metrics.context.providerSwitches, 2);
    assert.equal(metrics.context.providerSwitchCheckpoints, 2);
    assert.ok(metrics.context.providerSwitchBytesSkipped > 0);
  }, { contextPolicy: { providerSwitchReplayBytes: 192 * 1024 } });

  assert.equal(captured.length, 3);
  for (const request of captured.slice(1)) {
    const wire = JSON.stringify(request.body);
    assert.match(wire, /MOMO proxy historical checkpoint/);
    assert.match(wire, /SWITCH_CONSTRAINT/);
    assert.match(wire, /SWITCH_ACTIVE_TASK/);
    assert.ok(Buffer.byteLength(wire) < 64 * 1024);
    assert.ok((wire.match(/historical prose segment/g) || []).length < 1000);
  }
  assert.match(captured[1].url, /streamGenerateContent/);
  assert.match(captured[2].url, /\/v1\/responses$/);
});

test("explicit checkpoint retains pending calls and refuses oversized required evidence", () => {
  const fixture = continuityFixture();
  const output = buildLocalCompactResponse(fixture.model, fixture.input.slice(0, -2)).output;
  assert.equal(output[0].role, "assistant");
  assert.ok(output.some((item) => item.call_id === "pending"));
  assert.ok(output.some((item) => item.output === "VERIFIED_STATE_SENTINEL"));
  assert.throws(() => buildLocalCompactResponse(fixture.model, [{ role: "user", content: "retain" }, { type: "function_call", name: "run", call_id: "large", arguments: "x".repeat(1000000) }]), { code: "checkpoint_state_budget_exceeded" });
});

test("checkpoint retains dynamically loaded tools and exact latest long user text", () => {
  const loaded = { type: "additional_tools", tools: [{ type: "function", name: "dynamic_run", parameters: { type: "object" } }] };
  const text = "TASK_START_CONSTRAINT" + "x".repeat(100000) + "TASK_END";
  const compacted = buildLocalCompactResponse("gpt-5.6-sol", [loaded, { type: "input_text", text }]);
  assert.deepEqual(compacted.output.find((item) => item.type === "additional_tools"), loaded);
  assert.equal(compacted.output.find((item) => item.role === "user").content[0].text, text);
  const again = buildLocalCompactResponse("gpt-5.6-sol", compacted.output);
  assert.equal(again.output.find((item) => item.role === "user").content[0].text, text);
});

test("checkpoint never labels a historical task as the latest request during a new tool turn", () => {
  const oldTask = "OLD_TASK_SENTINEL verify the prior bibliography";
  const oldAnswer = "OLD_ANSWER_SENTINEL " + "x".repeat(600000);
  const activeTask = "ACTIVE_TASK_SENTINEL design the training-data pipeline";
  const input = [
    { role: "developer", content: "CONSTRAINT_SENTINEL" },
    { role: "user", content: oldTask },
    { role: "assistant", content: oldAnswer },
    { role: "user", content: activeTask },
  ];

  for (let index = 0; index < 10; index++) {
    input.push(
      { type: "custom_tool_call", name: "exec", call_id: `active_${index}`, input: `query ${index}` },
      { type: "custom_tool_call_output", call_id: `active_${index}`, output: `ACTIVE_EVIDENCE_${index}` },
    );
    const replay = prepareOversizedHistoryReplay(
      { model: "gemini-3.8-flash", input: structuredClone(input) },
      { maxHistoricalReplayBytes: 128 * 1024 },
    );
    assert.equal(replay.rewritten, true);
    const wire = JSON.stringify(replay.payload.input);
    assert.doesNotMatch(wire, /Latest user request/);
    assert.match(wire, /historical context only/i);
    assert.equal(wire.split(oldTask).length - 1, 1);
    assert.equal(wire.split(activeTask).length - 1, 1);
    assert.equal(wire.split("OLD_ANSWER_SENTINEL").length - 1, 1);
    assert.match(wire, /historical assistant context; not the active task/i);
    const activeIndex = replay.payload.input.findIndex((item) => JSON.stringify(item).includes(activeTask));
    const oldIndex = replay.payload.input.findIndex((item) => JSON.stringify(item).includes(oldTask));
    assert.ok(activeIndex > oldIndex);
    assert.equal(replay.payload.input.at(-1).call_id, `active_${index}`);
  }
});

test("unterminated final SSE block restores namespace and custom call identity", async () => {
  const fakeFetch = async (_url, init) => {
    const wire = JSON.parse(init.body);
    assert.equal(wire.tools[0].name, "terminal__run");
    const item = { type: "function_call", id: "fc_tail", call_id: "tail_call", name: "terminal__run", arguments: JSON.stringify({ input: "synthetic" }) };
    return new Response("data: " + JSON.stringify({ type: "response.output_item.done", item }));
  };
  await withServer(fakeFetch, async (base) => {
    const response = await fetch(base + "/v1/responses", { method: "POST", headers: authHeaders(), body: JSON.stringify({ model: "gpt-5.6-sol", tools: [{ type: "namespace", name: "terminal", tools: [{ type: "custom", name: "run" }] }], input: [{ role: "user", content: "synthetic" }] }) });
    const event = JSON.parse((await response.text()).trim().slice(5));
    assert.equal(event.item.type, "custom_tool_call");
    assert.equal(event.item.name, "run");
    assert.equal(event.item.namespace, "terminal");
    assert.equal(event.item.call_id, "tail_call");
    assert.equal(event.item.input, "synthetic");
  });
});

test("mock upstream tool round trip survives checkpoint and encrypted local envelope replay", async () => {
  for (const limit of [524288, 8388608]) {
    const captured = [];
    const fakeFetch = async (_url, init) => {
      captured.push(JSON.parse(init.body));
      const item = { type: "function_call", id: "fc_next", name: "exec", call_id: "next", arguments: JSON.stringify({ input: "text(3)" }) };
      return new Response(responseSse("resp_next", [item]), { headers: { "content-type": "text/event-stream" } });
    };
    await withServer(fakeFetch, async (base) => {
      const fixture = continuityFixture();
      for (const envelope of [false, true]) {
        const payload = envelope ? { ...fixture, input: [{ type: "compaction", encrypted_content: encodeLocalCompaction(buildLocalCompactResponse(fixture.model, fixture.input).output) }] } : fixture;
        const response = await fetch(base + "/v1/responses", { method: "POST", headers: authHeaders(), body: JSON.stringify(payload) });
        assert.equal(response.status, 200);
        const events = (await response.text()).split(String.fromCharCode(10)).filter((line) => line.startsWith("data: " )).map((line) => JSON.parse(line.slice(6)));
        const item = events.find((event) => event.type === "response.output_item.done").item;
        assert.equal(item.type, "custom_tool_call");
        assert.equal(item.name, "exec");
        assert.equal(item.call_id, "next");
        assert.equal(item.input, "text(3)");
        const wire = captured.at(-1);
        assert.equal(wire.tool_choice, "required");
        assert.equal(wire.tools[0].type, "function");
        assert.equal(wire.tools[0].name, "exec");
        for (const id of ["completed", "pending"]) {
          assert.ok(wire.input.some((entry) => entry.type === "function_call" && entry.call_id === id && entry.name === "exec"));
          assert.ok(wire.input.some((entry) => entry.type === "function_call_output" && entry.call_id === id));
        }
        const followup = await fetch(base + "/v1/responses", { method: "POST", headers: authHeaders(), body: JSON.stringify({ ...payload, input: [...payload.input, item, { type: "custom_tool_call_output", call_id: item.call_id, output: "SYNTHETIC_EXECUTION_RESULT" }] }) });
        assert.equal(followup.status, 200);
        await followup.text();
        const nextWire = captured.at(-1);
        assert.ok(nextWire.input.some((entry) => entry.type === "function_call" && entry.call_id === "next" && entry.name === "exec"));
        assert.ok(nextWire.input.some((entry) => entry.type === "function_call_output" && entry.call_id === "next" && entry.output === "SYNTHETIC_EXECUTION_RESULT"));
      }
    }, { maxHistoricalReplayBytes: limit });
  }
});

async function withServer(fetchImpl, run, overrides = {}) {
  const server = createMomoSwitch({ ...settings, ...overrides }, { fetchImpl, env: testProfile.env });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function authHeaders(extra = {}) {
  return { authorization: "Bearer test_local_token", "content-type": "application/json", ...extra };
}

function responseSse(id, output) {
  const events = [
    { type: "response.created", response: { id, object: "response", status: "in_progress", output: [] } },
    ...output.map((item, index) => ({ type: "response.output_item.done", response_id: id, output_index: index, item })),
    { type: "response.completed", response: { id, object: "response", status: "completed", output } },
  ];
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

test("compact preparation removes historical inline media before its independent limit", () => {
  const historicalImage = `data:image/png;base64,${"A".repeat(19 * 1024 * 1024)}`;
  const prepared = prepareCompactPayload({
    model: "gpt-5.6-sol",
    input: [
      { type: "message", role: "user", content: [{ type: "input_image", image_url: historicalImage }] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "continue" }] },
    ],
  });
  assert.ok(prepared.trace.compactBytes < 1024 * 1024);
  assert.match(JSON.stringify(prepared.payload), /historical image omitted during compaction/);
  assert.doesNotMatch(JSON.stringify(prepared.payload), /AAAAAA/);
});

test("oversized hidden history becomes a bounded local checkpoint while preserving the current turn", () => {
  const historicalImage = `data:image/png;base64,${"A".repeat(2 * 1024 * 1024)}`;
  const history = [];
  for (let index = 0; index < 80; index++) {
    history.push({ role: "user", content: [{ type: "input_text", text: `old task ${index} ${"x".repeat(8192)}` }, { type: "input_image", image_url: historicalImage }] });
    history.push({ role: "assistant", content: [{ type: "output_text", text: `old answer ${index}` }] });
    history.push({ type: "custom_tool_call_output", call_id: `call_${index}`, output: "z".repeat(8192) });
  }
  const current = { role: "user", content: [{ type: "input_text", text: "CURRENT MODEL-SWITCH REQUEST" }] };
  const payload = { model: "claude-opus-4-6-thinking", input: [...history, current] };
  const result = prepareOversizedHistoryReplay(payload, { contextPolicy: { maxHistoricalReplayBytes: 128 * 1024 } });
  assert.equal(result.rewritten, true);
  assert.ok(result.originalBytes > 2 * 1024 * 1024);
  assert.ok(result.outboundBytes < 1024 * 1024);
  assert.match(JSON.stringify(result.payload.input), /old task 0 /);
  assert.match(JSON.stringify(result.payload.input), /old task 79 /);
  assert.equal(result.payload.input.at(-1), current);
  assert.match(JSON.stringify(result.payload.input), /CURRENT MODEL-SWITCH REQUEST/);
  assert.doesNotMatch(JSON.stringify(result.payload.input), /data:image/);
  assert.doesNotMatch(JSON.stringify(result.payload.input), /z{1000}/);
});

test("a tool-result-only continuation is current data and is never checkpointed away", () => {
  const toolResult = { type: "custom_tool_call_output", call_id: "current_tool", output: "r".repeat(1024 * 1024) };
  const payload = { model: "claude-opus-4-6-thinking", input: [toolResult] };
  const result = prepareOversizedHistoryReplay(payload, { contextPolicy: { maxHistoricalReplayBytes: 128 * 1024 } });
  assert.equal(result.rewritten, false);
  assert.equal(result.payload.input[0], toolResult);
});

test("local compatibility mode creates a checkpoint only when explicitly selected", async () => {
  let fetchCalls = 0;
  await withServer(async () => { fetchCalls++; return new Response("unexpected", { status: 500 }); }, async (base) => {
    const response = await fetch(`${base}/v1/responses/compact`, {
      method: "POST", headers: authHeaders(),
      body: JSON.stringify({ model: "gpt-5.6-sol", input: [{ role: "user", content: "keep this task" }] }),
    });
    assert.equal(response.status, 200);
    assert.match(JSON.stringify(await response.json()), /keep this task/);
  }, { compactionMode: "local" });
  assert.equal(fetchCalls, 0);
});

test("unconfigured compaction fails closed while ordinary requests still reach upstream", async () => {
  assert.equal(compactionPolicy({}), "native");
  let calls = 0;
  await withServer(async () => {
    calls++;
    return new Response(responseSse("resp_ordinary", []), { headers: { "content-type": "text/event-stream" } });
  }, async (base) => {
    const send = (path, body) => fetch(base + path, {
      method: "POST", headers: authHeaders(), body: JSON.stringify({ model: "gpt-5.6-sol", ...body }),
    });
    const input = [{ role: "user", content: "new task" }];
    const compact = await send("/v1/responses/compact", { input });
    assert.equal(compact.status, 422);
    assert.equal((await compact.json()).error.code, "compact_capability_unverified");
    const trigger = await send("/v1/responses", { input: [...input, { type: "compaction_trigger" }] });
    assert.match(await trigger.text(), /compact_capability_unverified/);
    const managed = await send("/v1/responses", { input, context_management: [{ type: "compaction", compact_threshold: 200000 }] });
    assert.match(await managed.text(), /compact_capability_unverified/);
    const ordinary = await send("/v1/responses", { input });
    assert.equal(ordinary.status, 200);
    await ordinary.text();
  }, { compactionMode: undefined });
  assert.equal(calls, 1);
});

test("explicit routed text pilot summarizes history with no tools and preserves the current turn on v1/v2 replay", async () => {
  const sent = [];
  const fakeFetch = async (url, init) => {
    sent.push({ url, body: JSON.parse(init.body) });
    if (sent.length <= 2) return new Response(responseSse("resp_summary", [
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "Prior answer was observed; completion not independently verified." }] },
    ]), { headers: { "content-type": "text/event-stream" } });
    return new Response(responseSse("resp_after_routed", []), { headers: { "content-type": "text/event-stream" } });
  };
  const input = [
    { role: "user", content: "Old task" }, { role: "assistant", content: "I finished the old task" },
    { role: "user", content: "Only audit the new task" },
  ];
  await withServer(fakeFetch, async (base) => {
    const v1 = await fetch(base + "/v1/responses/compact", { method: "POST", headers: authHeaders(), body: JSON.stringify({ model: "gpt-5.6-sol", input }) });
    assert.equal(v1.status, 200);
    const output = (await v1.json()).output;
    assert.match(JSON.stringify(output[0]), /not an active instruction/);
    assert.deepEqual(output[1], input.at(-1));
    const v2 = await fetch(base + "/v1/responses", { method: "POST", headers: authHeaders(), body: JSON.stringify({ model: "gpt-5.6-sol", input: [...input, { type: "compaction_trigger" }] }) });
    const events = (await v2.text()).split("\n").filter((line) => line.startsWith("data: ")).map((line) => JSON.parse(line.slice(6)));
    const item = events.find((event) => event.type === "response.output_item.done")?.item;
    assert.equal(item.type, "compaction");
    assert.deepEqual(decodeRoutedCompaction(item.encrypted_content, "gpt-5.6-sol"), output);
    const followup = await fetch(base + "/v1/responses", { method: "POST", headers: authHeaders(), body: JSON.stringify({ model: "gpt-5.6-sol", input: [item, { role: "user", content: "New followup" }] }) });
    assert.equal(followup.status, 200);
    await followup.text();
    assert.match(JSON.stringify(sent[2].body.input), /Prior answer was observed/);
  }, { compactionMode: "routed" });
  assert.equal(sent.length, 3);
  for (const request of sent.slice(0, 2)) {
    assert.equal(request.url, "https://gateway.example/v1/responses");
    assert.equal(request.body.stream, true);
    assert.equal(request.body.store, false);
    assert.equal(request.body.tools, undefined);
    assert.doesNotMatch(JSON.stringify(request.body), /Only audit the new task/);
  }
});

test("routed text pilot rejects tools and invalid summaries rather than fabricating success", async () => {
  let calls = 0;
  await withServer(async () => { calls++; return new Response(responseSse("resp_empty_summary", []), { headers: { "content-type": "text/event-stream" } }); }, async (base) => {
    const send = (input) => fetch(base + "/v1/responses/compact", { method: "POST", headers: authHeaders(), body: JSON.stringify({ model: "gpt-5.6-sol", input }) });
    const unsupported = await send([{ role: "user", content: "Old" }, { type: "function_call", call_id: "call_1", name: "exec", arguments: "{}" }, { role: "user", content: "New" }]);
    assert.equal(unsupported.status, 422);
    assert.equal((await unsupported.json()).error.code, "routed_compact_unsupported_history");
    assert.equal(calls, 0);
    const configuredTools = await fetch(base + "/v1/responses/compact", {
      method: "POST", headers: authHeaders(),
      body: JSON.stringify({ model: "gpt-5.6-sol", tools: [{ type: "function", name: "exec" }], input: [{ role: "user", content: "Old" }, { role: "user", content: "New" }] }),
    });
    assert.equal(configuredTools.status, 422);
    assert.equal(calls, 0);
    const invalid = await send([{ role: "user", content: "Old" }, { role: "user", content: "New" }]);
    assert.equal(invalid.status, 502);
    assert.equal((await invalid.json()).error.code, "invalid_routed_compact_response");
    assert.equal(calls, 1);
  }, { compactionMode: "routed" });
});

test("routed v2 can compact its own envelope again without replaying the old request as a new task", async () => {
  const sent = [];
  await withServer(async (_url, init) => {
    sent.push(JSON.parse(init.body));
    return new Response(responseSse("resp_routed_repeat", [
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "Old answer observed; verify before retrying." }] },
    ]), { headers: { "content-type": "text/event-stream" } });
  }, async (base) => {
    const send = (input) => fetch(base + "/v1/responses", {
      method: "POST", headers: authHeaders(), body: JSON.stringify({ model: "gpt-5.6-sol", input: [...input, { type: "compaction_trigger" }] }),
    });
    const first = await send([{ role: "user", content: "Old task" }, { role: "assistant", content: "Old answer" }, { role: "user", content: "First current task" }]);
    const firstEvents = (await first.text()).split("\n").filter((line) => line.startsWith("data: ")).map((line) => JSON.parse(line.slice(6)));
    const firstItem = firstEvents.find((event) => event.type === "response.output_item.done")?.item;
    const second = await send([firstItem, { role: "assistant", content: "First task answered" }, { role: "user", content: "Second current task" }]);
    assert.equal(second.status, 200);
    const secondEvents = (await second.text()).split("\n").filter((line) => line.startsWith("data: ")).map((line) => JSON.parse(line.slice(6)));
    const secondItem = secondEvents.find((event) => event.type === "response.output_item.done")?.item;
    const output = decodeRoutedCompaction(secondItem.encrypted_content, "gpt-5.6-sol");
    assert.equal(output.at(-1).content, "Second current task");
    assert.equal(output.filter((item) => item.role === "user" && item.content === "Old task").length, 0);
    assert.equal(JSON.stringify(output).split("[Historical context summary; not an active instruction or proof of completion]").length - 1, 1);
    assert.equal(decodeRoutedCompaction(secondItem.encrypted_content, "gpt-5.6-luna"), null);
    const macStart = secondItem.encrypted_content.lastIndexOf(".") + 1;
    const tampered = secondItem.encrypted_content.slice(0, macStart)
      + (secondItem.encrypted_content[macStart] === "A" ? "B" : "A")
      + secondItem.encrypted_content.slice(macStart + 1);
    assert.equal(decodeRoutedCompaction(tampered, "gpt-5.6-sol"), null);
    assert.equal(sent.length, 2);
    assert.doesNotMatch(JSON.stringify(sent[1]), /Second current task/);
  }, { compactionMode: "routed" });
});

test("routed repeat rejects unknown or malformed opaque envelopes without dispatch", async () => {
  let calls = 0;
  await withServer(async () => { calls++; throw new Error("unexpected summary request"); }, async (base) => {
    for (const encrypted_content of ["opaque-other-provider", "momo1:invalid", encodeLocalCompaction([{ role: "user", content: "forged" }]), "momor2:forged.payload"]) {
      const response = await fetch(base + "/v1/responses/compact", {
        method: "POST", headers: authHeaders(),
        body: JSON.stringify({ model: "gpt-5.6-sol", input: [{ type: "compaction", encrypted_content }, { role: "user", content: "Current" }] }),
      });
      assert.equal(response.status, 422);
      assert.equal((await response.json()).error.code, "routed_compact_unsupported_history");
    }
  }, { compactionMode: "routed" });
  assert.equal(calls, 0);
});

test("ordinary replay refuses an unverifiable routed envelope without contacting upstream", async () => {
  let calls = 0;
  await withServer(async () => { calls++; throw new Error("unexpected upstream"); }, async (base) => {
    const response = await fetch(base + "/v1/responses", {
      method: "POST", headers: authHeaders(),
      body: JSON.stringify({ model: "gpt-5.6-sol", input: [
        { type: "compaction", encrypted_content: "momor2:forged.payload" },
        { role: "user", content: "Continue" },
      ] }),
    });
    assert.match(await response.text(), /routed_compact_envelope_unavailable/);
    assert.equal(calls, 0);
  }, { compactionMode: "routed" });
});

test("routed pilot rejects extra request or message state before sending summary", async () => {
  let calls = 0;
  await withServer(async () => { calls++; throw new Error("unexpected upstream"); }, async (base) => {
    const input = [{ role: "user", content: "Old" }, { role: "user", content: "New" }];
    const bodies = [
      { metadata: { session: "opaque" }, input },
      { temperature: 0, input },
      { input: [{ role: "user", content: "Old", id: "msg_original" }, input[1]] },
      { input: [{ role: "user", content: [{ type: "input_text", text: "Old", annotations: [] }] }, input[1]] },
      { input: [{ role: "developer", content: "Must preserve policy" }, ...input] },
    ];
    for (const body of bodies) {
      const response = await fetch(base + "/v1/responses/compact", {
        method: "POST", headers: authHeaders(), body: JSON.stringify({ model: "gpt-5.6-sol", ...body }),
      });
      assert.equal(response.status, 422);
      assert.equal((await response.json()).error.code, "routed_compact_unsupported_history");
    }
  }, { compactionMode: "routed" });
  assert.equal(calls, 0);
});

test("routed pilot propagates upstream throttling once and rejects managed auto-compaction", async () => {
  let calls = 0;
  await withServer(async () => { calls++; return Response.json({ error: { message: "rate limited" } }, { status: 429 }); }, async (base) => {
    const input = [{ role: "user", content: "Old" }, { role: "user", content: "New" }];
    const compact = await fetch(base + "/v1/responses/compact", {
      method: "POST", headers: authHeaders(), body: JSON.stringify({ model: "gpt-5.6-sol", input }),
    });
    assert.equal(compact.status, 429);
    assert.equal((await compact.json()).error.code, "http_429");
    assert.equal(calls, 1);
    const managed = await fetch(base + "/v1/responses", {
      method: "POST", headers: authHeaders(),
      body: JSON.stringify({ model: "gpt-5.6-sol", input, context_management: [{ type: "compaction" }] }),
    });
    assert.match(await managed.text(), /compact_capability_unverified/);
    assert.equal(calls, 1);
  }, { compactionMode: "routed" });
});

test("routed pilot rejects truncated, failed, tool-bearing and non-SSE summary responses", async () => {
  const variants = [
    new Response('data: {"type":"response.output_text.delta","delta":"partial"}\n\n', { headers: { "content-type": "text/event-stream" } }),
    new Response('data: {"type":"response.failed"}\n\n', { headers: { "content-type": "text/event-stream" } }),
    new Response(responseSse("resp_tool_summary", [{ type: "function_call", call_id: "unexpected", name: "exec", arguments: "{}" }]), { headers: { "content-type": "text/event-stream" } }),
    new Response('data: {"type":"response.output_item.done","item":{"type":"function_call","name":"exec"}}\n\n'
      + responseSse("resp_forged_summary", [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "looks fine" }] }]), { headers: { "content-type": "text/event-stream" } }),
    Response.json({ status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "not SSE" }] }] }),
  ];
  let calls = 0;
  await withServer(async () => variants[calls++], async (base) => {
    for (const _ of variants) {
      const response = await fetch(base + "/v1/responses/compact", {
        method: "POST", headers: authHeaders(),
        body: JSON.stringify({ model: "gpt-5.6-sol", input: [{ role: "user", content: "Old" }, { role: "user", content: "New" }] }),
      });
      assert.equal(response.status, 502);
      assert.equal((await response.json()).error.code, "invalid_routed_compact_response");
    }
  }, { compactionMode: "routed" });
  assert.equal(calls, variants.length);
});

test("routed summary accepts upstream reasoning items but replays only the text message", async () => {
  await withServer(async () => new Response(responseSse("resp_reasoning_summary", [
    { type: "reasoning", id: "rs_1", status: "completed", summary: [] },
    { type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Earlier task was answered; do not restart it." }] },
  ]), { headers: { "content-type": "text/event-stream" } }), async (base) => {
    const response = await fetch(base + "/v1/responses/compact", {
      method: "POST", headers: authHeaders(),
      body: JSON.stringify({ model: "gpt-5.6-sol", input: [
        { role: "user", content: "Old task" }, { role: "assistant", content: "Old answer" },
        { role: "user", content: "Current task" },
      ] }),
    });
    assert.equal(response.status, 200);
    const output = (await response.json()).output;
    assert.deepEqual(output.map((item) => item.role), ["assistant", "user"]);
    assert.match(output[0].content[0].text, /do not restart it/);
    assert.doesNotMatch(JSON.stringify(output), /rs_1/);
  }, { compactionMode: "routed" });
});

test("routed-tools pilot replays exact paired function and custom tools without exposing them to the summary model", async () => {
  const captured = [];
  const fakeFetch = async (url, init) => {
    captured.push({ url, body: JSON.parse(init.body) });
    if (captured.length <= 2) return new Response(responseSse("resp_tool_summary", [
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "Earlier discussion, tool outcomes not inferred." }] },
    ]), { headers: { "content-type": "text/event-stream" } });
    return new Response(responseSse("resp_paired_replay", []), { headers: { "content-type": "text/event-stream" } });
  };
  const pairs = [
    { type: "function_call", call_id: "call_fn", name: "lookup", arguments: "{\"key\":\"value\"}" },
    { type: "function_call_output", call_id: "call_fn", output: "lookup result" },
    { type: "custom_tool_call", call_id: "call_custom", name: "exec", input: "text(1)" },
    { type: "custom_tool_call_output", call_id: "call_custom", output: "exec result" },
  ];
  const followingAnswer = { role: "assistant", content: "I completed the old step, subject to verification." };
  const input = [{ role: "user", content: "Earlier discussion" }, ...pairs, followingAnswer, { role: "user", content: "Audit only the current change" }];
  await withServer(fakeFetch, async (base) => {
    const send = (path, items) => fetch(base + path, {
      method: "POST", headers: authHeaders(), body: JSON.stringify({ model: "gpt-5.6-sol", input: items }),
    });
    const v1 = await send("/v1/responses/compact", input);
    assert.equal(v1.status, 200);
    const output = (await v1.json()).output;
    assert.deepEqual(output.slice(1, -1), [...pairs, followingAnswer]);
    assert.deepEqual(output.at(-1), input.at(-1));
    const v2 = await send("/v1/responses", [...input, { type: "compaction_trigger" }]);
    const events = (await v2.text()).split("\n").filter((line) => line.startsWith("data: ")).map((line) => JSON.parse(line.slice(6)));
    const item = events.find((event) => event.type === "response.output_item.done")?.item;
    assert.deepEqual(decodeRoutedCompaction(item.encrypted_content, "gpt-5.6-sol").slice(1, -1), [...pairs, followingAnswer]);
    const replay = await send("/v1/responses", [item, { role: "user", content: "Continue audit" }]);
    assert.equal(replay.status, 200);
    await replay.text();
  }, { compactionMode: "routed-tools" });
  assert.equal(captured.length, 3);
  for (const request of captured.slice(0, 2)) {
    assert.equal(request.url, "https://gateway.example/v1/responses");
    assert.equal(request.body.tools, undefined);
    assert.doesNotMatch(JSON.stringify(request.body), /lookup result|exec result|call_custom|Audit only the current change/);
    assert.doesNotMatch(JSON.stringify(request.body), /I completed the old step/);
  }
  for (const pair of pairs) {
    const loweredType = pair.type.replace(/^custom_tool_/, "function_");
    assert.ok(captured[2].body.input.some((entry) => entry.call_id === pair.call_id && entry.type === loweredType));
  }
  assert.match(JSON.stringify(captured[2].body.input), /I completed the old step/);
});

test("routed-tools rejects orphan, duplicate and pending pairs before model dispatch", async () => {
  let calls = 0;
  await withServer(async () => { calls++; throw new Error("unexpected summary call"); }, async (base) => {
    const current = { role: "user", content: "Current task" };
    const cases = [
      [{ type: "function_call_output", call_id: "missing", output: "result" }],
      [{ type: "function_call", call_id: "pending", name: "lookup", arguments: "{}" }],
      [{ type: "function_call", call_id: "duplicate", name: "lookup", arguments: "{}" },
        { type: "function_call_output", call_id: "duplicate", output: "one" },
        { type: "function_call_output", call_id: "duplicate", output: "two" }],
      [{ type: "custom_tool_call", call_id: "mismatch", name: "exec", input: "text(1)" },
        { type: "function_call_output", call_id: "mismatch", output: "wrong type" }],
      [{ type: "function_call", call_id: "opaque", name: "lookup", arguments: "{}" },
        { type: "function_call_output", call_id: "opaque", output: "ok", encrypted_content: "opaque-state" }],
    ];
    for (const entries of cases) {
      const response = await fetch(base + "/v1/responses/compact", {
        method: "POST", headers: authHeaders(), body: JSON.stringify({ model: "gpt-5.6-sol", input: [{ role: "user", content: "Prior" }, ...entries, current] }),
      });
      assert.equal(response.status, 422);
      assert.equal((await response.json()).error.code,
        entries.at(-1).encrypted_content ? "routed_compact_unsupported_history" : "routed_compact_unpaired_tools");
    }
  }, { compactionMode: "routed-tools" });
  assert.equal(calls, 0);
});

test("routed-tools refuses causal history beyond its replay ceiling without calling the summary model", async () => {
  let calls = 0;
  await withServer(async () => { calls++; throw new Error("unexpected summary call"); }, async (base) => {
    const response = await fetch(base + "/v1/responses/compact", {
      method: "POST", headers: authHeaders(),
      body: JSON.stringify({ model: "gpt-5.6-sol", input: [
        { role: "user", content: "Old" },
        { type: "function_call", call_id: "large", name: "lookup", arguments: "{}" },
        { type: "function_call_output", call_id: "large", output: "x".repeat(600 * 1024) },
        { role: "user", content: "New" },
      ] }),
    });
    assert.equal(response.status, 413);
    assert.equal((await response.json()).error.code, "routed_compact_tools_too_large");
  }, { compactionMode: "routed-tools" });
  assert.equal(calls, 0);
});

test("native compact refuses unverified capability without contacting upstream", async () => {
  let calls = 0;
  await withServer(async () => { calls++; throw new Error("unexpected upstream"); }, async (base) => {
    const input = [{ role: "user", content: "CURRENT_TASK" }];
    const v1 = await fetch(`${base}/v1/responses/compact`, { method: "POST", headers: authHeaders(), body: JSON.stringify({ model: "gpt-5.6-sol", input }) });
    assert.equal(v1.status, 422);
    assert.equal((await v1.json()).error.code, "compact_capability_unverified");
    const v2 = await fetch(`${base}/v1/responses`, { method: "POST", headers: authHeaders(), body: JSON.stringify({ model: "gpt-5.6-sol", input: [...input, { type: "compaction_trigger" }] }) });
    assert.match(await v2.text(), /compact_capability_unverified/);
  }, { compactionMode: "native" });
  assert.equal(calls, 0);
});

test("native compact preserves original v1 request and upstream failure without checkpoint", async () => {
  const input = [{ role: "user", content: "CURRENT_TASK" }];
  let sent;
  await withServer(async (url, init) => { sent = { url, body: JSON.parse(init.body) }; return Response.json({ error: { message: "not found" } }, { status: 404 }); }, async (base) => {
    const response = await fetch(`${base}/v1/responses/compact`, { method: "POST", headers: authHeaders(), body: JSON.stringify({ model: "gpt-5.6-sol", input }) });
    assert.equal(response.status, 404);
    assert.equal((await response.json()).error.code, "http_404");
  }, { endpoint: "https://momoapi.us", compactionMode: "native", contextPolicy: { nativeCompactModels: ["gpt-5.6-sol"] } });
  assert.equal(sent.url, "https://momoapi.us/v1/responses/compact");
  assert.deepEqual(sent.body.input, input);
});

test("native v2 compact fails rather than truncating oversized replacement history", async () => {
  const huge = [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "A".repeat(2 * 1024 * 1024) }] }];
  let calls = 0;
  await withServer(async () => { calls++; return Response.json({ object: "response.compaction", output: huge }); }, async (base) => {
    const response = await fetch(`${base}/v1/responses`, { method: "POST", headers: authHeaders(), body: JSON.stringify({ model: "gpt-5.6-sol", input: [{ role: "user", content: "CURRENT_TASK" }, { type: "compaction_trigger" }] }) });
    assert.match(await response.text(), /local_compaction_envelope_too_large/);
  }, { endpoint: "https://momoapi.us", compactionMode: "native", contextPolicy: { nativeCompactModels: ["gpt-5.6-sol"] } });
  assert.equal(calls, 1);
});

test("native v2 rejects opaque compact output rather than wrapping cross-provider state", async () => {
  await withServer(async () => Response.json({ object: "response.compaction", output: [{ type: "compaction", encrypted_content: "opaque-provider-state" }] }), async (base) => {
    const response = await fetch(`${base}/v1/responses`, { method: "POST", headers: authHeaders(), body: JSON.stringify({ model: "gpt-5.6-sol", input: [{ role: "user", content: "CURRENT_TASK" }, { type: "compaction_trigger" }] }) });
    assert.match(await response.text(), /invalid_compact_response/);
  }, { endpoint: "https://momoapi.us", compactionMode: "native", contextPolicy: { nativeCompactModels: ["gpt-5.6-sol"] } });
});

test("native compact capability is not inferred for arbitrary Responses gateways", async () => {
  let calls = 0;
  await withServer(async () => { calls++; throw new Error("unexpected"); }, async (base) => {
    const response = await fetch(`${base}/v1/responses/compact`, { method: "POST", headers: authHeaders(), body: JSON.stringify({ model: "gpt-5.6-sol", input: [] }) });
    assert.equal(response.status, 422);
  }, { endpoint: "https://gateway.example", compactionMode: "native", contextPolicy: { nativeCompactModels: ["gpt-5.6-sol"] } });
  assert.equal(calls, 0);
});

test("native compact refuses declared models that use a non-Responses transport", async () => {
  let calls = 0;
  await withServer(async () => { calls++; throw new Error("unexpected"); }, async (base) => {
    for (const model of ["claude-opus-4-6-thinking", "gemini-3.8-flash", "muse-auto"]) {
      const response = await fetch(`${base}/v1/responses/compact`, { method: "POST", headers: authHeaders(), body: JSON.stringify({ model, input: [] }) });
      assert.equal(response.status, 422);
    }
  }, { endpoint: "https://momoapi.us", compactionMode: "native", contextPolicy: { nativeCompactModels: ["claude-opus-4-6-thinking", "gemini-3.8-flash", "muse-auto"] } });
  assert.equal(calls, 0);
});

test("verified native v2 replacement history replays through the versioned local envelope", async () => {
  const history = [{ type: "message", role: "user", content: [{ type: "input_text", text: "COMPACTED_HISTORY" }] }];
  const upstreamBodies = [];
  await withServer(async (url, init) => {
    upstreamBodies.push({ url, body: JSON.parse(init.body) });
    return url.endsWith("/responses/compact")
      ? Response.json({ object: "response.compaction", output: history })
      : new Response(responseSse("resp_native_followup", []), { headers: { "content-type": "text/event-stream" } });
  }, async (base) => {
    const compact = await fetch(`${base}/v1/responses`, { method: "POST", headers: authHeaders(), body: JSON.stringify({ model: "gpt-5.6-sol", input: [{ role: "user", content: "CURRENT_TASK" }, { type: "compaction_trigger" }] }) });
    const events = (await compact.text()).split("\n").filter((line) => line.startsWith("data: " )).map((line) => JSON.parse(line.slice(6)));
    const item = events.find((event) => event.type === "response.output_item.done")?.item;
    assert.deepEqual(decodeLocalCompaction(item.encrypted_content), history);
    const followup = await fetch(`${base}/v1/responses`, { method: "POST", headers: authHeaders(), body: JSON.stringify({ model: "gpt-5.6-sol", input: [item, { role: "user", content: "FOLLOWUP" }] }) });
    assert.equal(followup.status, 200);
    await followup.text();
  }, { endpoint: "https://momoapi.us", compactionMode: "native", contextPolicy: { nativeCompactModels: ["gpt-5.6-sol"] } });
  assert.match(JSON.stringify(upstreamBodies[1].body.input), /COMPACTED_HISTORY/);
  assert.doesNotMatch(JSON.stringify(upstreamBodies[1].body.input), /momo1:/);
});

test("repeated local compaction keeps only the latest user request as the active task", () => {
  const first = buildLocalCompactResponse("gpt-5.6-sol", [
    { role: "user", content: "What is the login account?" },
    { role: "assistant", content: "The login issue is resolved." },
    { role: "user", content: "Why did project details fail to load?" },
    { role: "assistant", content: "The project route issue is resolved." },
    { role: "user", content: "Show the repair report and artifacts in the board." },
  ]);
  const firstText = JSON.stringify(first.output);
  assert.match(firstText, /historical user request; a subsequent assistant answer was observed/);
  assert.match(firstText, /What is the login account/);
  assert.match(firstText, /Why did project details fail to load/);
  assert.match(firstText, /Show the repair report and artifacts in the board/);

  const second = buildLocalCompactResponse("gpt-5.6-sol", [
    ...first.output,
    { role: "assistant", content: "The report is now visible in the board." },
    { role: "user", content: "Verify the report links only; do not revisit resolved login issues." },
  ]);
  const retainedUsers = second.output.filter((item) => item?.role === "user");
  assert.equal(retainedUsers.at(-1).content[0].text, "Verify the report links only; do not revisit resolved login issues.");
  for (const item of retainedUsers.slice(0, -1)) {
    assert.match(item.content[0].text, /^\[historical user (?:request|context);/);
  }
  assert.equal(JSON.stringify(second.output).split("# MOMO proxy historical checkpoint").length - 1, 1);
  assert.doesNotMatch(JSON.stringify(second.output), /\[historical user context;[^\n]*\]\n\[historical user/);
});

test("completed last user request never becomes a fresh active task on repeated compaction", () => {
  const first = buildLocalCompactResponse("gpt-5.6-sol", [
    { role: "user", content: "Repair the login flow." },
    { role: "assistant", content: "Login flow repaired and verified." },
  ]);
  const user = first.output.find((item) => item.role === "user");
  assert.match(user.content[0].text, /^\[historical user request; a subsequent assistant answer was observed/);
  const second = buildLocalCompactResponse("gpt-5.6-sol", first.output);
  assert.equal(JSON.stringify(second.output).split("# MOMO proxy historical checkpoint").length - 1, 1);
  assert.equal(second.output.filter((item) => item.role === "user").length, 1);
  assert.match(second.output.find((item) => item.role === "user").content[0].text, /^\[historical user request;/);
  assert.doesNotMatch(JSON.stringify(second.output), /\[historical user request;[^\n]*\]\n\[historical user/);
  const third = buildLocalCompactResponse("gpt-5.6-sol", second.output);
  assert.equal(JSON.stringify(third.output).split("# MOMO proxy historical checkpoint").length - 1, 1);
  assert.doesNotMatch(JSON.stringify(third.output), /\[historical assistant context;[^\n]*\]\n\[historical assistant context;/);
});

test("checkpoint distinguishes tool evidence from a later assistant answer", () => {
  const output = buildLocalCompactResponse("gpt-5.6-sol", [
    { role: "user", content: "COMPLETED_REQUEST" },
    { type: "function_call", call_id: "done_1", name: "check", arguments: "{}" },
    { type: "function_call_output", call_id: "done_1", output: "VERIFIED_DONE" },
    { role: "user", content: "UNVERIFIED_REQUEST" },
    { role: "assistant", content: "I will do it next" },
    { role: "user", content: "CURRENT_REQUEST" },
  ]).output;
  const users = output.filter((item) => item.role === "user");
  assert.match(users[0].content[0].text, /subsequent tool result.*verify outcome before retrying/);
  assert.match(users[1].content[0].text, /^\[historical user request; a subsequent assistant answer was observed/);
  assert.equal(users[2].content[0].text, "CURRENT_REQUEST");
  assert.equal(JSON.stringify(output).split("CURRENT_REQUEST").length - 1, 1);
});

test("Claude model switch fails explicitly when required user state exceeds the checkpoint budget", async () => {
  let captured;
  const hugeHistory = [];
  for (let index = 0; index < 200; index++) {
    hugeHistory.push({ role: "user", content: `historic ${index} ${"h".repeat(8192)}` });
    hugeHistory.push({ type: "custom_tool_call_output", call_id: `old_${index}`, output: "o".repeat(8192) });
  }
  hugeHistory.push({ role: "user", content: "solve only the new task" });
  const fakeFetch = async (url, init) => {
    captured = { url, body: init.body };
    return new Response("data: {\"type\":\"message_stop\"}\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  await withServer(fakeFetch, async (base) => {
    const response = await fetch(`${base}/v1/responses`, { method: "POST", headers: authHeaders(), body: JSON.stringify({ model: "claude-opus-4-6-thinking", stream: true, input: hugeHistory }) });
    assert.equal(response.status, 413);
    assert.match(await response.text(), /checkpoint_state_budget_exceeded/);
  }, { compactionMode: "local", contextPolicy: { maxHistoricalReplayBytes: 128 * 1024 } });
  assert.equal(captured, undefined);
});

test("compact preparation never mutates integrity-protected encrypted_content", () => {
  const encrypted = `opaque.${"Q".repeat(128 * 1024)}`;
  const prepared = prepareCompactPayload({ model: "gpt-5.6-sol", input: [
    { type: "reasoning", id: "rs_signed", encrypted_content: encrypted, summary: [] },
    { role: "user", content: "continue" },
  ] });
  assert.equal(prepared.payload.input[0].encrypted_content, encrypted);
});

test("POST /v1/responses/compact forwards the sanitized canonical request", async () => {
  let captured;
  const fakeFetch = async (url, init) => {
    captured = { url, body: JSON.parse(init.body) };
    return Response.json({ id: "cmp_upstream", object: "response.compaction", output: [{ type: "message", role: "user", content: [{ type: "input_text", text: "checkpoint" }] }] });
  };
  await withServer(fakeFetch, async (base) => {
    const response = await fetch(`${base}/v1/responses/compact`, {
      method: "POST", headers: authHeaders({ "thread-id": "thread-compact" }),
      body: JSON.stringify({ model: "gpt-5.6-sol", input: [{ role: "user", content: "hello" }] }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.object, "response.compaction");
  });
  assert.equal(captured.url, "https://gateway.example/v1/responses/compact");
  assert.equal(captured.body.stream, undefined);
});

test("large compact HTTP request forwards exactly the incrementally budgeted body", async () => {
  const { body } = compactFixture("marker-420");
  const overrides = { compactionMode: "upstream", contextPolicy: { compactBodyLimitMb: 18 } };
  const expected = JSON.stringify(prepareCompactPayload(structuredClone(body), overrides).payload);
  let calls = 0;
  await withServer(async (url, init) => {
    calls++;
    assert.equal(url, "https://gateway.example/v1/responses/compact");
    assert.equal(init.body, expected);
    assert.ok(Buffer.byteLength(init.body) <= 18 * 1048576);
    return Response.json({ object: "response.compaction", output: [] });
  }, async (base) => {
    const response = await fetch(base + "/v1/responses/compact", { method: "POST", headers: authHeaders(), body: JSON.stringify(body) });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).object, "response.compaction");
  }, overrides);
  assert.equal(calls, 1);
});

test("opaque compact budget failure still falls back locally without touching upstream", async () => {
  const { body } = compactFixture("opaque");
  let calls = 0;
  await withServer(async () => { calls++; return Response.json({ error: "unexpected" }, { status: 500 }); }, async (base) => {
    const response = await fetch(base + "/v1/responses/compact", { method: "POST", headers: authHeaders(), body: JSON.stringify(body) });
    assert.equal(response.status, 200);
    const compacted = await response.json();
    assert.equal(compacted.object, "response.compaction");
    assert.ok(compacted.output.some((item) => item.role === "user" && item.content?.[0]?.text === "current"));
  }, { compactionMode: "upstream", contextPolicy: { compactBodyLimitMb: 18 } });
  assert.equal(calls, 0);
});

test("compact rejects an upstream 200 that is not a response.compaction object", async () => {
  const fakeFetch = async () => new Response("<html>not compact</html>", { status: 200, headers: { "content-type": "text/html" } });
  await withServer(fakeFetch, async (base) => {
    const response = await fetch(`${base}/v1/responses/compact`, { method: "POST", headers: authHeaders(), body: JSON.stringify({ model: "gpt-5.6-sol", input: [] }) });
    assert.equal(response.status, 502);
    assert.equal((await response.json()).error.code, "invalid_compact_response");
  });
});

test("compact rejects an oversized upstream response without buffering it unbounded", async () => {
  const oversized = `\"${"A".repeat(33 * 1024 * 1024)}\"`;
  const fakeFetch = async () => new Response(oversized, { status: 200, headers: { "content-type": "application/json" } });
  await withServer(fakeFetch, async (base) => {
    const response = await fetch(`${base}/v1/responses/compact`, { method: "POST", headers: authHeaders(), body: JSON.stringify({ model: "gpt-5.6-sol", input: [] }) });
    assert.equal(response.status, 502);
    assert.equal((await response.json()).error.code, "compact_response_too_large");
  });
});

test("compact endpoint returns a recoverable local checkpoint when upstream lacks compact", async () => {
  const fakeFetch = async () => Response.json({ error: { message: "unknown compact endpoint" } }, { status: 404 });
  await withServer(fakeFetch, async (base) => {
    const response = await fetch(`${base}/v1/responses/compact`, {
      method: "POST", headers: authHeaders(),
      body: JSON.stringify({ model: "gpt-5.6-sol", input: [{ role: "user", content: "repair the proxy" }] }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.object, "response.compaction");
    assert.match(JSON.stringify(body.output), /historical checkpoint/);
    assert.doesNotMatch(JSON.stringify(body.output), /Latest user request/);
    assert.match(JSON.stringify(body.output), /repair the proxy/);
  });
});

test("compact preserves a model-not-found 404 instead of fabricating a checkpoint", async () => {
  const fakeFetch = async () => Response.json({ error: { message: "model gpt-missing not found" } }, { status: 404 });
  await withServer(fakeFetch, async (base) => {
    const response = await fetch(`${base}/v1/responses/compact`, { method: "POST", headers: authHeaders(), body: JSON.stringify({ model: "gpt-missing", input: [] }) });
    assert.equal(response.status, 404);
    assert.match((await response.json()).error.message, /model gpt-missing not found/);
  });
});

test("same-session compactions are mutually exclusive", async () => {
  let releaseFirst;
  let enteredFirst;
  const firstEntered = new Promise((resolve) => { enteredFirst = resolve; });
  const holdFirst = new Promise((resolve) => { releaseFirst = resolve; });
  let calls = 0;
  const fakeFetch = async () => {
    calls += 1;
    if (calls === 1) {
      enteredFirst();
      await holdFirst;
    }
    return Response.json({ id: `cmp_${calls}`, object: "response.compaction", output: [] });
  };
  await withServer(fakeFetch, async (base) => {
    const init = { method: "POST", headers: authHeaders({ "thread-id": "same-lane" }), body: JSON.stringify({ model: "gpt-5.6-sol", input: [{ role: "user", content: "hello" }] }) };
    const first = fetch(`${base}/v1/responses/compact`, init);
    await firstEntered;
    const second = await fetch(`${base}/v1/responses/compact`, init);
    assert.equal(second.status, 409);
    assert.equal((await second.json()).error.code, "compaction_in_progress");
    releaseFirst();
    assert.equal((await first).status, 200);
  });
  assert.equal(calls, 1);
});

test("compaction_trigger emits one replayable compaction item", async () => {
  const compactOutput = [{ type: "message", role: "user", content: [{ type: "input_text", text: "canonical checkpoint" }] }];
  const upstreamBodies = [];
  const fakeFetch = async (url, init) => {
    upstreamBodies.push({ url, body: JSON.parse(init.body) });
    if (url.endsWith("/responses/compact")) return Response.json({ id: "cmp_1", object: "response.compaction", output: compactOutput });
    return new Response(responseSse("resp_after_compact", [{ id: "msg_after", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "ok" }] }]), { status: 200, headers: { "content-type": "text/event-stream" } });
  };

  await withServer(fakeFetch, async (base) => {
    const compact = await fetch(`${base}/v1/responses`, {
      method: "POST", headers: authHeaders({ "thread-id": "thread-v2" }),
      body: JSON.stringify({ model: "gpt-5.6-sol", stream: true, input: [{ role: "user", content: "old context" }, { type: "compaction_trigger" }] }),
    });
    const events = (await compact.text()).split("\n").filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice(6)));
    const items = events.filter((event) => event.type === "response.output_item.done").map((event) => event.item);
    assert.equal(items.length, 1);
    assert.equal(items[0].type, "compaction");
    assert.deepEqual(decodeLocalCompaction(items[0].encrypted_content), compactOutput);

    const next = await fetch(`${base}/v1/responses`, {
      method: "POST", headers: authHeaders({ "thread-id": "thread-v2" }),
      body: JSON.stringify({ model: "gpt-5.6-sol", stream: true, input: [items[0], { role: "user", content: "continue" }] }),
    });
    assert.equal(next.status, 200);
    await next.text();
  });

  assert.equal(upstreamBodies[0].url, "https://gateway.example/v1/responses/compact");
  assert.match(JSON.stringify(upstreamBodies[1].body.input), /canonical checkpoint/);
  assert.doesNotMatch(JSON.stringify(upstreamBodies[1].body.input), /momo1:/);
});

test("compaction_trigger falls back to a bounded checkpoint when upstream compact output is huge", async () => {
  const hugeOutput = [{ id: "msg_huge", type: "message", role: "user", content: [{ type: "input_text", text: "A".repeat(2 * 1024 * 1024) }] }];
  const fakeFetch = async () => Response.json({ id: "cmp_huge", object: "response.compaction", output: hugeOutput });
  await withServer(fakeFetch, async (base) => {
    const response = await fetch(`${base}/v1/responses`, { method: "POST", headers: authHeaders(), body: JSON.stringify({ model: "gpt-5.6-sol", input: [{ role: "user", content: "retain this request" }, { type: "compaction_trigger" }] }) });
    assert.equal(response.status, 200);
    const events = (await response.text()).split("\n").filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice(6)));
    const item = events.find((event) => event.type === "response.output_item.done")?.item;
    const recovered = decodeLocalCompaction(item.encrypted_content);
    assert.ok(item.encrypted_content.length < 2 * 1024 * 1024);
    assert.match(JSON.stringify(recovered), /retain this request/);
    assert.doesNotMatch(JSON.stringify(recovered), /A{1000}/);
  });
});

test("context_management compaction strips old inline media before ordinary admission", async () => {
  let captured;
  const fakeFetch = async (_url, init) => {
    captured = JSON.parse(init.body);
    return new Response(responseSse("resp_managed", [{ id: "msg_managed", type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }]), { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  const image = `data:image/png;base64,${"A".repeat(3 * 1024 * 1024)}`;
  await withServer(fakeFetch, async (base) => {
    const response = await fetch(`${base}/v1/responses`, {
      method: "POST", headers: authHeaders(),
      body: JSON.stringify({
        model: "gpt-5.6-sol", stream: true,
        context_management: [{ type: "compaction", compact_threshold: 200000 }],
        input: [
          { role: "user", content: [{ type: "input_image", image_url: image }] },
          { role: "assistant", content: "seen" },
          { role: "user", content: "continue" },
        ],
      }),
    });
    assert.equal(response.status, 200);
    await response.text();
  });
  assert.match(JSON.stringify(captured.input), /historical image omitted during compaction/);
  assert.match(JSON.stringify(captured.input), /continue/);
  assert.doesNotMatch(JSON.stringify(captured.input), /data:image/);
  assert.deepEqual(captured.context_management, [{ type: "compaction", compact_threshold: 200000 }]);
});

test("previous_response_id skips only a complete prefix crossing provider output", () => {
  resetResponseStateForTests();
  const user = { type: "message", role: "user", content: [{ type: "input_text", text: "one" }] };
  const output = { id: "msg_provider_1", type: "message", role: "assistant", content: [{ type: "output_text", text: "answer" }] };
  const first = preparePreviousResponseReplay({ model: "gpt-5.6-sol", input: [user] });
  assert.equal(rememberResponseState("resp_1", first.seed, [output]), true);

  const replay = preparePreviousResponseReplay({ model: "gpt-5.6-sol", previous_response_id: "resp_1", input: [user, output, { role: "user", content: "two" }] });
  assert.equal(replay.deduplicated, true);
  assert.deepEqual(replay.payload.input, [{ role: "user", content: "two" }]);

  const partial = preparePreviousResponseReplay({ model: "gpt-5.6-sol", previous_response_id: "resp_1", input: [output, { role: "user", content: "two" }] });
  assert.equal(partial.deduplicated, false);
  assert.equal(partial.payload.input.length, 2);
});

test("previous_response_id fails open without provider-issued output identity", () => {
  resetResponseStateForTests();
  const user = { role: "user", content: "same" };
  const output = { type: "message", role: "assistant", content: "idless" };
  const first = preparePreviousResponseReplay({ model: "gpt-5.6-sol", input: [user] });
  rememberResponseState("resp_idless", first.seed, [output]);
  const replay = preparePreviousResponseReplay({ model: "gpt-5.6-sol", previous_response_id: "resp_idless", input: [user, output, { role: "user", content: "next" }] });
  assert.equal(replay.deduplicated, false);
  assert.equal(replay.payload.input.length, 3);
});

test("previous_response_id never crosses model boundaries", () => {
  resetResponseStateForTests();
  const user = { role: "user", content: "same" };
  const output = { id: "msg_model_bound", type: "message", role: "assistant", content: "answer" };
  const first = preparePreviousResponseReplay({ model: "gpt-5.6-sol", input: [user] });
  rememberResponseState("resp_model_bound", first.seed, [output]);
  const replay = preparePreviousResponseReplay({ model: "gpt-5.6-luna", previous_response_id: "resp_model_bound", input: [user, output, { role: "user", content: "next" }] });
  assert.equal(replay.deduplicated, false);
});

test("store:false responses do not mint an unsafe continuation anchor", () => {
  resetResponseStateForTests();
  const replay = preparePreviousResponseReplay({ store: false, input: [{ role: "user", content: "private" }] });
  assert.equal(replay.seed, null);
  assert.equal(rememberResponseState("resp_private", replay.seed, [{ id: "msg_private", type: "message" }]), false);
});

test("server continuation removes a repeated full transcript and records metrics", async () => {
  resetResponseStateForTests();
  resetMetrics();
  const captured = [];
  const firstOutput = { id: "msg_provider_state", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "first answer" }] };
  let invocation = 0;
  const fakeFetch = async (_url, init) => {
    invocation += 1;
    captured.push(JSON.parse(init.body));
    const output = invocation === 1 ? firstOutput : { id: "msg_provider_next", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "next answer" }] };
    return new Response(responseSse(invocation === 1 ? "resp_state_1" : "resp_state_2", [output]), { status: 200, headers: { "content-type": "text/event-stream" } });
  };

  await withServer(fakeFetch, async (base) => {
    const firstUser = { type: "message", role: "user", content: [{ type: "input_text", text: "first" }] };
    const first = await fetch(`${base}/v1/responses`, { method: "POST", headers: authHeaders(), body: JSON.stringify({ model: "gpt-5.6-sol", stream: true, input: [firstUser] }) });
    assert.equal(first.status, 200);
    await first.text();

    const second = await fetch(`${base}/v1/responses`, { method: "POST", headers: authHeaders(), body: JSON.stringify({ model: "gpt-5.6-sol", stream: true, previous_response_id: "resp_state_1", input: [firstUser, firstOutput, { role: "user", content: "next" }] }) });
    assert.equal(second.status, 200);
    await second.text();

    const metrics = await fetch(`${base}/internal/metrics`, { headers: { "x-local-token": "test_local_token" } }).then((response) => response.json());
    assert.equal(metrics.context.replayDedupHits, 1);
    assert.ok(metrics.context.replayBytesSkipped > 0);
  });

  assert.deepEqual(captured[1].input, [{ type: "message", role: "user", content: [{ type: "input_text", text: "next" }] }]);
  assert.equal(captured[1].previous_response_id, "resp_state_1");
});

test("repeated previous_response_id turns stay bounded instead of growing linearly", () => {
  resetResponseStateForTests();
  const firstUser = { role: "user", content: "one" };
  const firstOutput = { id: "msg_bound_1", type: "message", role: "assistant", content: "answer one" };
  const first = preparePreviousResponseReplay({ model: "gpt-5.6-sol", input: [firstUser] });
  rememberResponseState("resp_bound_1", first.seed, [firstOutput]);

  const secondUser = { role: "user", content: "two" };
  const second = preparePreviousResponseReplay({ model: "gpt-5.6-sol", previous_response_id: "resp_bound_1", input: [firstUser, firstOutput, secondUser] });
  assert.deepEqual(second.payload.input, [secondUser]);
  const secondOutput = { id: "msg_bound_2", type: "message", role: "assistant", content: "answer two" };
  rememberResponseState("resp_bound_2", second.seed, [secondOutput]);

  const thirdUser = { role: "user", content: "three" };
  const third = preparePreviousResponseReplay({ model: "gpt-5.6-sol", previous_response_id: "resp_bound_2", input: [firstUser, firstOutput, secondUser, secondOutput, thirdUser] });
  assert.equal(third.deduplicated, true);
  assert.deepEqual(third.payload.input, [thirdUser]);
});

test("local checkpoint has a fixed recoverable structure", () => {
  const compacted = buildLocalCompactResponse("gpt-5.6-sol", [{ role: "user", content: "finish the tests" }]);
  assert.equal(compacted.object, "response.compaction");
  assert.match(JSON.stringify(compacted.output), /Prior input items/);
  assert.match(JSON.stringify(compacted.output), /finish the tests/);
});
