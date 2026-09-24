import assert from "node:assert/strict";
import test from "node:test";
import { createMomoSwitch } from "../src/server.mjs";
import { isolatedProfile } from "./support/isolated-profile.mjs";

const profile = isolatedProfile("muse-integration-");
const settings = { endpoint: "https://muse-upstream.example", apiKey: "test-key", localToken: "local-key", host: "127.0.0.1", port: 0 };

async function withServer(upstream, run) {
  const server = createMomoSwitch(settings, {
    env: profile.env,
    fetchImpl: async (url, init) => upstream(String(url), init),
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function requestBody() {
  return {
    model: "muse-auto",
    stream: true,
    input: [{ role: "user", content: [{ type: "input_text", text: "edit notes/ok.txt" }] }],
    tools: [{ type: "custom", name: "apply_patch" }],
  };
}

const patchText = "*** Begin Patch\n*** Add File: notes/ok.txt\n+ok\n*** End Patch";

test("Muse legal patch is emitted as a Responses custom tool call", async () => {
  let captured;
  const upstream = async (_url, init) => {
    captured = JSON.parse(init.body);
    const sse = `data: ${JSON.stringify({ choices: [{ delta: { content: patchText } }] })}\n\ndata: [DONE]\n\n`;
    return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
  };

  await withServer(upstream, async (base) => {
    const response = await fetch(base + "/v1/responses", {
      method: "POST",
      headers: { authorization: "Bearer local-key", "content-type": "application/json" },
      body: JSON.stringify(requestBody()),
    });
    const body = await response.text();
    assert.equal(response.status, 200);
    assert.match(body, /response\.custom_tool_call_input\.done/);
    assert.match(body, /custom_tool_call/);
    assert.match(body, /\*\*\* Begin Patch/);
  });

  assert.equal(captured.model, "muse-auto");
  assert.equal(captured.stream, true);
  assert.equal(captured.messages.length, 2);
  assert.equal(captured.messages[1].content, "edit notes/ok.txt");
  assert.equal("tools" in captured, false);
});

test("Muse patch stays text when apply_patch is not declared", async () => {
  const upstream = async () => {
    const sse = `data: ${JSON.stringify({ choices: [{ delta: { content: patchText } }] })}\n\ndata: [DONE]\n\n`;
    return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
  };

  await withServer(upstream, async (base) => {
    const body = await (await fetch(base + "/v1/responses", {
      method: "POST",
      headers: { authorization: "Bearer local-key", "content-type": "application/json" },
      body: JSON.stringify({ ...requestBody(), tools: [] }),
    })).text();
    assert.doesNotMatch(body, /custom_tool_call/);
    assert.match(body, /response\.output_text\.delta/);
  });
});

test("Muse upstream failure returns standard Responses failure SSE", async () => {
  const upstream = async () => new Response(JSON.stringify({ error: { message: "upstream unavailable" } }), {
    status: 503, headers: { "content-type": "application/json" },
  });

  await withServer(upstream, async (base) => {
    const response = await fetch(base + "/v1/responses", {
      method: "POST",
      headers: { authorization: "Bearer local-key", "content-type": "application/json" },
      body: JSON.stringify(requestBody()),
    });
    const body = await response.text();
    assert.equal(response.status, 503);
    assert.match(body, /response\.failed/);
    assert.match(body, /upstream unavailable/);
  });
});


