import assert from "node:assert/strict";
import test from "node:test";
import { buildLocalCompactResponse, decodeLocalCompaction, prepareCompactPayload } from "../src/compaction.mjs";
import { preparePreviousResponseReplay, rememberResponseState, resetResponseStateForTests } from "../src/responses-state.mjs";
import { createMomoSwitch, resetMetrics } from "../src/server.mjs";

const settings = { endpoint: "https://gateway.example", apiKey: "test_gateway_key", localToken: "test_local_token", host: "127.0.0.1", port: 0 };

async function withServer(fetchImpl, run, overrides = {}) {
  const server = createMomoSwitch({ ...settings, ...overrides }, { fetchImpl });
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
    assert.match(JSON.stringify(body.output), /recovery checkpoint/);
    assert.match(JSON.stringify(body.output), /repair the proxy/);
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
