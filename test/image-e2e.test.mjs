import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMomoSwitch } from "../src/server.mjs";

test("image MCP end-to-end over a fake upstream", async () => {
  const home = mkdtempSync(join(tmpdir(), "momo-image-e2e-"));
  const settings = { endpoint: "https://mock.gateway", apiKey: "test-key-not-real", localToken: "test-local-token", host: "127.0.0.1", port: 0, maxRequestBodyMb: 64 };
  const fakeFetch = async (url) => {
    const target = String(url);
    if (target === "https://mock.gateway/v1/images/generations") return new Response(JSON.stringify({ data: [{ b64_json: "aGVsbG8=", task_id: "task-e2e" }] }), { status: 200, headers: { "content-type": "application/json" } });
    if (target === "https://mock.gateway/v1/images/generations/task-e2e") return new Response(JSON.stringify({ data: [{ b64_json: "aGVsbG8=" }] }), { status: 200, headers: { "content-type": "application/json" } });
    throw new Error("unexpected upstream: " + target);
  };
  const server = createMomoSwitch(settings, { fetchImpl: fakeFetch });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
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
    send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "image_generate", arguments: { model: "gpt-image-2-momoapi", prompt: "test image", n: 1, aspect_ratio: "1:1", resolution: "1k" } } });
    await waitFor('"id":3');
    assert.match(output, /aGVsbG8=/);
    send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "image_task_status", arguments: { task_id: "task-e2e" } } });
    await waitFor('"id":4');
    assert.match(output, /task-e2e/);
  } finally {
    child.kill();
    await new Promise((resolve) => child.once("exit", resolve));
    await new Promise((resolve) => server.close(resolve));
    rmSync(home, { recursive: true, force: true });
  }
});
