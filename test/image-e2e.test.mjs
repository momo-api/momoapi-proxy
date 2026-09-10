import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMomoSwitch } from "../src/server.mjs";

test("image MCP end-to-end over a fake upstream", async () => {
  const home = mkdtempSync(join(tmpdir(), "momo-image-e2e-"));
  const pngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2mYQAAAAASUVORK5CYII=";
  const settings = { endpoint: "https://mock.gateway", apiKey: "test-key-not-real", localToken: "test-local-token", host: "127.0.0.1", port: 0, maxRequestBodyMb: 64, imageAssetDirectory: join(home, "images") };
  let capturedResponsesBody = null;
  const fakeFetch = async (url, init = {}) => {
    const target = String(url);
    if (target === "https://mock.gateway/v1/models") return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { "content-type": "application/json" } });
    if (target === "https://mock.gateway/v1/images/generations") return new Response(JSON.stringify({ data: [{ url: "https://mock.gateway/generated/e2e.png", b64_json: pngBase64, task_id: "task-e2e" }] }), { status: 200, headers: { "content-type": "application/json" } });
    if (target === "https://mock.gateway/v1/images/generations/task-e2e") return new Response(JSON.stringify({ data: [{ url: "https://mock.gateway/generated/e2e.png", b64_json: pngBase64 }] }), { status: 200, headers: { "content-type": "application/json" } });
    if (target === "https://mock.gateway/v1/chat/completions") {
      const body = JSON.parse(init.body);
      assert.match(body.messages[0].content[1].image_url.url, /^data:image\/png;base64,/);
      return new Response("data: " + JSON.stringify({ choices: [{ delta: { content: "data:image/png;base64," + pngBase64 } }] }) + "\n\ndata: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    if (target === "https://mock.gateway/v1/responses") {
      capturedResponsesBody = JSON.parse(init.body);
      return new Response("event: response.completed\ndata: {}\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    throw new Error("unexpected upstream: " + target);
  };
  const server = createMomoSwitch(settings, { fetchImpl: fakeFetch });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const unavailable = await fetch(`http://127.0.0.1:${port}/internal/images/generate`, {
    method: "POST",
    headers: { "x-local-token": settings.localToken, "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-image-2.5-flare", prompt: "not routed while hidden" }),
  });
  assert.equal(unavailable.status, 503);
  assert.equal((await unavailable.json()).error.code, "model_unavailable");
  writeFileSync(join(home, "settings.json"), JSON.stringify({ ...settings, port }));
  const child = spawn(process.execPath, ["bin/momoapi-proxy.mjs", "mcp", "image"], { cwd: process.cwd(), env: { ...process.env, MOMO_PROXY_HOME: home }, stdio: ["pipe", "pipe", "pipe"] });
  let output = "";
  let errors = "";
  child.stdout.on("data", (chunk) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk) => { errors += chunk.toString(); });
  const send = (message) => child.stdin.write(JSON.stringify(message) + "\n");
  const waitFor = async (needle) => {
    const start = Date.now();
    while (!output.includes(needle)) {
      if (Date.now() - start > 5000) throw new Error("timeout waiting for " + needle + " stdout=" + output + " stderr=" + errors);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  try {
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } });
    await waitFor('"id":1');
    send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    await waitFor('"id":2');
    const listed = JSON.parse(output.trim().split(/\r?\n/).find((line) => line.includes('"id":2')));
    const models = listed.result.tools.find((tool) => tool.name === "image_generate").inputSchema.properties.model.enum;
    assert.equal(models.includes("gpt-image-2.5-sunburst"), false);
    assert.equal(models.includes("gpt-image-2.5-flare"), false);
    send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "image_generate", arguments: { model: "gpt-image-2-momoapi", prompt: "test image", n: 1, aspect_ratio: "1:1", resolution: "1k" } } });
    await waitFor('"id":3');
    const generated = JSON.parse(output.trim().split(/\r?\n/).find((line) => line.includes('"id":3')));
    assert.doesNotMatch(JSON.stringify(generated), new RegExp(pngBase64));
    const summary = JSON.parse(generated.result.content[0].text);
    assert.match(summary.images[0].asset_id, /^img_[a-f0-9]{64}$/);
    assert.equal(summary.images[0].reference, "asset:" + summary.images[0].asset_id);
    assert.match(summary.images[0].vision_reference, /^momo-image-ref:v1:img_[a-f0-9]{64}:[a-f0-9]{64}$/);
    assert.equal(summary.images[0].local_path, join(home, "images", summary.images[0].asset_id + ".png"));
    assert.equal(generated.result.content[1].type, "resource_link");
    assert.match(generated.result.content[1].uri, /^file:\/\//);
    const codexToolOutput = generated.result.content.map((part) => part.type === "text"
      ? { type: "input_text", text: part.text }
      : { type: "input_text", text: JSON.stringify(part) });
    const continued = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: "POST",
      headers: { authorization: "Bearer " + settings.localToken, "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.6-sol",
        stream: true,
        input: [
          { role: "user", content: [{ type: "input_text", text: "Generate a test image." }] },
          { type: "function_call", call_id: "call_image_e2e", name: "image_generate", arguments: "{}" },
          { type: "function_call_output", call_id: "call_image_e2e", output: codexToolOutput },
        ],
      }),
    });
    assert.equal(continued.status, 200);
    await continued.text();
    const outboundJson = JSON.stringify(capturedResponsesBody);
    const outboundImages = capturedResponsesBody.input[2].output.filter((part) => part.type === "input_image");
    assert.deepEqual(outboundImages, [{ type: "input_image", image_url: "https://mock.gateway/generated/e2e.png" }]);
    assert.ok(Buffer.byteLength(outboundJson, "utf8") < 2_000);
    assert.doesNotMatch(outboundJson, /data:image|iVBORw0KGgo/);
    send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "image_task_status", arguments: { task_id: "task-e2e" } } });
    await waitFor('"id":4');
    assert.match(output, /task-e2e/);
    send({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "image_asset_get", arguments: { asset_id: summary.images[0].asset_id } } });
    await waitFor('"id":5');
    const fetched = JSON.parse(output.trim().split(/\r?\n/).find((line) => line.includes('"id":5')));
    assert.doesNotMatch(JSON.stringify(fetched), new RegExp(pngBase64));
    assert.match(fetched.result.content[0].text, new RegExp(summary.images[0].asset_id));
    send({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "image_asset_get", arguments: { asset_id: summary.images[0].asset_id, include_preview: true } } });
    await waitFor('"id":7');
    const noInlinePreview = JSON.parse(output.trim().split(/\r?\n/).find((line) => line.includes('"id":7')));
    assert.equal(noInlinePreview.result.content.some((part) => part.type === "image"), false);
    assert.doesNotMatch(JSON.stringify(noInlinePreview), new RegExp(pngBase64));
    const legacyPreview = await fetch(`http://127.0.0.1:${port}/internal/images/assets/${summary.images[0].asset_id}?include_preview=1`, { headers: { "x-local-token": settings.localToken } });
    const legacyPreviewPayload = await legacyPreview.json();
    assert.equal(legacyPreviewPayload.images[0].b64_json, undefined);
    send({ jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "image_asset_list", arguments: { limit: 100 } } });
    await waitFor('"id":8');
    const listedAssets = JSON.parse(output.trim().split(/\r?\n/).find((line) => line.includes('"id":8')));
    assert.doesNotMatch(JSON.stringify(listedAssets), /vision_reference|momo-image-ref/);
    send({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "image_edit", arguments: { model: "gpt-image-2-momoapi", prompt: "edit local image", reference_images: [summary.images[0].reference] } } });
    await waitFor('"id":6');
    const edited = JSON.parse(output.trim().split(/\r?\n/).find((line) => line.includes('"id":6')));
    assert.doesNotMatch(JSON.stringify(edited), new RegExp(pngBase64));
    assert.match(edited.result.content[0].text, new RegExp(summary.images[0].asset_id));
  } finally {
    child.kill();
    await new Promise((resolve) => child.once("exit", resolve));
    await new Promise((resolve) => server.close(resolve));
    rmSync(home, { recursive: true, force: true });
  }
});
