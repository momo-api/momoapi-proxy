import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMomoSwitch } from "../src/server.mjs";

test("video MCP end-to-end returns remote URLs without downloading content", async () => {
  const home = mkdtempSync(join(tmpdir(), "momo-video-e2e-"));
  const settings = { endpoint: "https://mock.gateway", apiKey: "test-key-not-real", localToken: "test-local-token", host: "127.0.0.1", port: 0, maxRequestBodyMb: 64, imageAssetDirectory: join(home, "images") };
  const calls = [];
  const fakeFetch = async (url) => {
    const target = String(url);
    calls.push(target);
    if (target === "https://mock.gateway/agent/media-capabilities") return new Response(JSON.stringify({ models: [{
      id: "momoapi-veo-3-1-lite", modality: "video", available: true, operations: ["generate", "image_to_video"], parameters: {
        duration: { allowed: [4, 6, 8], default: 4 }, aspect_ratio: { allowed: ["16:9", "9:16"], default: "16:9" }, resolution: { allowed: ["720p", "1080p"], default: "720p" }, generate_audio: { allowed: [true, false], default: true }, max_reference_images: { maximum: 2 },
      },
    }] }), { status: 200 });
    if (target === "https://mock.gateway/v1/videos") return new Response(JSON.stringify({ id: "task-video-e2e", status: "queued" }), { status: 200 });
    if (target === "https://mock.gateway/v1/videos/task-video-e2e") return new Response(JSON.stringify({ id: "task-video-e2e", status: "completed", url: "https://adobe.example/output.mp4" }), { status: 200 });
    throw new Error("unexpected upstream: " + target);
  };
  const server = createMomoSwitch(settings, { fetchImpl: fakeFetch, env: { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: join(home, ".codex"), MOMO_PROXY_HOME: join(home, ".proxy") } });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  writeFileSync(join(home, "settings.json"), JSON.stringify({ ...settings, port }));
  const child = spawn(process.execPath, ["bin/momoapi-proxy.mjs", "mcp", "video"], { cwd: process.cwd(), env: { ...process.env, MOMO_PROXY_HOME: home }, stdio: ["pipe", "pipe", "pipe"] });
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
    const generateTool = listed.result.tools.find((tool) => tool.name === "video_generate");
    assert.deepEqual(generateTool.inputSchema.properties.model.enum, ["momoapi-veo-3-1-lite"]);
    assert.deepEqual(generateTool.inputSchema.properties.duration.enum, [4, 6, 8]);
    send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "video_generate", arguments: { model: "momoapi-veo-3-1-lite", prompt: "ocean", duration: 6, resolution: "1080p", generate_audio: false } } });
    await waitFor('"id":3');
    const generated = JSON.parse(output.trim().split(/\r?\n/).find((line) => line.includes('"id":3')));
    const submitted = JSON.parse(generated.result.content[0].text);
    assert.equal(submitted.task_id, "task-video-e2e");
    send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "video_task_status", arguments: { task_id: submitted.task_id } } });
    await waitFor('"id":4');
    const completed = JSON.parse(output.trim().split(/\r?\n/).find((line) => line.includes('"id":4')));
    assert.equal(JSON.parse(completed.result.content[0].text).remote_url, "https://adobe.example/output.mp4");
    assert.equal(calls.includes("https://adobe.example/output.mp4"), false);
  } finally {
    child.kill();
    await new Promise((resolve) => child.once("exit", resolve));
    await new Promise((resolve) => server.close(resolve));
    rmSync(home, { recursive: true, force: true });
  }
});
