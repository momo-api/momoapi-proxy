import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";

const cli = resolve("bin/momoapi-proxy.mjs");
const candidate = "candidate-acceptance-test-only";
const rejected = "rejected-acceptance-test-only";
async function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), "momo-install-acceptance-"));
  const proxyHome = join(home, "proxy"); mkdirSync(proxyHome);
  const observed = [];
  const upstream = createServer((request, response) => {
    observed.push({ route: request.url, auth: request.headers.authorization });
    const ok = request.headers.authorization === "Bearer " + candidate;
    response.writeHead(ok ? 200 : 401, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: ok ? [{ id: "gpt-5.5", agent_status: "stable" }] : [] }));
  });
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  const reserved = createServer(); await new Promise((r) => reserved.listen(0, "127.0.0.1", r));
  const port = reserved.address().port; await new Promise((r) => reserved.close(r));
  const hook = join(home, "fetch-test-hook.mjs");
  writeFileSync(hook, 'const original = globalThis.fetch; globalThis.fetch = (url, options) => { const parsed = new URL(url); return original(parsed.origin === "https://momoapi.us" ? process.env.TEST_UPSTREAM + parsed.pathname + parsed.search : url, options); };');
  const env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: join(home, "Roaming"), CODEX_HOME: join(home, "codex"),
    MOMO_PROXY_HOME: proxyHome, MOMO_API_KEY: "inherited-stale-test-only", MOMO_PROXY_CONSOLE_MIRROR: "0",
    NODE_OPTIONS: '--import=' + pathToFileURL(hook).href, TEST_UPSTREAM: 'http://127.0.0.1:' + upstream.address().port };
  for (const name of ["MOMO_API_ENDPOINT", "MOMO_ENDPOINT", "MOMO_BRIDGE_PORT", "MOMO_SWITCH_PORT", "MOMO_BRIDGE_TOKEN", "MOMO_SWITCH_TOKEN"]) delete env[name];
  const children = [];
  async function run(args, input = "") {
    const child = spawn(process.execPath, [cli, ...args], { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    children.push(child);
    let stdout = "", stderr = "";
    child.stdout.on("data", (v) => { stdout += v; }); child.stderr.on("data", (v) => { stderr += v; });
    const timer = setTimeout(() => child.kill(), 20000);
    child.stdin.end(input);
    const code = await new Promise((r) => child.once("exit", r)); clearTimeout(timer);
    assert.doesNotMatch(stdout + stderr, /candidate-acceptance-test-only|rejected-acceptance-test-only|inherited-stale-test-only/);
    return { code, stdout, stderr };
  }
  t.after(async () => {
    await run(["stop", "--no-desktop"]).catch(() => {});
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill();
    await new Promise((r) => upstream.close(r)); rmSync(home, { recursive: true, force: true });
  });
  const file = join(proxyHome, "settings.json");
  const install = (key) => run(["install", "--api-key-stdin", "--no-autostart", "--no-image-plugin", "--no-desktop", "--port", String(port)], key + "\n");
  return { home, proxyHome, port, file, env, observed, run, install };
}

test("fresh headless install validates supplied Key, writes real config and starts/stops real proxy", async (t) => {
  const f = await fixture(t);
  const result = await f.install(candidate);
  assert.equal(result.code, 0, result.stderr);
  const saved = JSON.parse(readFileSync(f.file));
  assert.equal(saved.apiKey, candidate); assert.equal(saved.autostart, false); assert.equal(saved.imagePluginEnabled, false);
  assert.ok(saved.localToken); assert.equal(f.observed[0].auth, "Bearer " + candidate);
  assert.equal((await f.run(["start", "--no-desktop"])).code, 0);
  const response = await fetch('http://127.0.0.1:' + f.port + '/v1/models', { headers: { authorization: "Bearer " + saved.localToken } });
  assert.equal(response.status, 200); assert.equal((await response.json()).data[0].id, "gpt-5.5");
  assert.equal((await f.run(["stop", "--no-desktop"])).code, 0);
});

test("reinstall replaces stale disk/env Key, preserves identity; rejected and blank input leave settings untouched", async (t) => {
  const f = await fixture(t);
  const original = { apiKey: "old-expired-test-only", localToken: "stable-install-test-token", port: f.port, endpoint: "https://momoapi.us", autostart: false, updateMode: "manual", updateCheckEnabled: false, imagePluginEnabled: false, preference: "keep" };
  writeFileSync(f.file, JSON.stringify(original));
  for (const key of [rejected, ""]) {
    const result = await f.install(key); assert.equal(result.code, 1); assert.deepEqual(JSON.parse(readFileSync(f.file)), original);
  }
  const result = await f.install(candidate); assert.equal(result.code, 0, result.stderr);
  const saved = JSON.parse(readFileSync(f.file));
  assert.equal(saved.apiKey, candidate); assert.equal(saved.localToken, original.localToken); assert.equal(saved.preference, "keep"); assert.equal(saved.updateMode, "manual");
});

test("live legacy upgrade uses old token and graceful shutdown before Key submission", { skip: process.platform === "darwin" ? "Mac launchd requires device acceptance" : false }, async (t) => {
  const f = await fixture(t);
  const original = { apiKey: "old-expired-test-only", localToken: "legacy-test-token", port: f.port, endpoint: "https://momoapi.us", autostart: false, updateMode: "manual", updateCheckEnabled: false, imagePluginEnabled: false };
  writeFileSync(f.file, JSON.stringify(original));
  let stopped = false, candidateSentToLegacy = false;
  const legacy = createServer((request, response) => {
    if (request.url === "/internal/settings/api-key") candidateSentToLegacy = true;
    if (request.url === "/internal/capabilities") { response.writeHead(404); response.end(); return; }
    if (request.headers["x-local-token"] !== original.localToken) { response.writeHead(403); response.end(); return; }
    response.writeHead(200, { "content-type": "application/json" }); response.end('{"ok":true}');
    if (request.url === "/internal/shutdown") { stopped = true; legacy.close(); response.once("finish", () => legacy.closeAllConnections()); }
  });
  await new Promise((r) => legacy.listen(f.port, "127.0.0.1", r));
  t.after(() => new Promise((r) => legacy.close(r)));
  const result = await f.install(candidate); assert.equal(result.code, 0, result.stderr);
  assert.equal(stopped, true); assert.equal(candidateSentToLegacy, false);
  const saved = JSON.parse(readFileSync(f.file)); assert.equal(saved.apiKey, candidate); assert.equal(saved.localToken, original.localToken);
  const capability = await fetch('http://127.0.0.1:' + f.port + '/internal/capabilities', { headers: { "x-local-token": original.localToken } });
  assert.equal((await capability.json()).apiKeyChange, true);
});
