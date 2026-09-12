import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getCurrentVersion } from "../src/updater.mjs";

const BIN = join(process.cwd(), "bin", "momoapi-proxy.mjs");
const VERSION = getCurrentVersion();

async function listen(server) {
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  return server.address().port;
}

async function closeServer(server) {
  if (!server?.listening) return;
  await new Promise((resolve) => server.close(resolve));
}

function spawnCli(args, env) {
  const child = spawn(process.execPath, [BIN, ...args], {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  return { child, exited, output: () => ({ stdout, stderr }) };
}

async function waitForHealth(port, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(500) });
      if (response.ok) return response.json();
    } catch (error) { lastError = error; }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`daemon did not become healthy: ${lastError?.message || "timeout"}`);
}

async function waitForExit(run, timeoutMs = 5000) {
  let timer;
  try {
    return await Promise.race([
      run.exited,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("child exit timeout")), timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function writeSettings(home, settings) {
  writeFileSync(join(home, "settings.json"), `${JSON.stringify(settings, null, 2)}\n`);
}

function readJsonLines(target) {
  return readFileSync(target, "utf8").trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

async function createFixture(t) {
  const home = mkdtempSync(join(tmpdir(), "momo-cli-runtime-"));
  const upstream = createServer((request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(request.url === "/agent/catalog" ? { data: [] } : { data: [] }));
  });
  const upstreamPort = await listen(upstream);
  const reserved = createServer();
  const port = await listen(reserved);
  await closeServer(reserved);
  const apiKey = "momo_TEST_RUNTIME_SECRET_123456789";
  const localToken = "local_TEST_RUNTIME_SECRET_987654321";
  writeSettings(home, { apiKey, localToken, port, endpoint: `http://127.0.0.1:${upstreamPort}`,
    updateCheckEnabled: false, autostart: false, syncIntervalMinutes: 1440 });
  const env = { MOMO_PROXY_HOME: home, MOMO_PROXY_CONSOLE_MIRROR: "0" };
  t.after(async () => { await closeServer(upstream); rmSync(home, { recursive: true, force: true }); });
  return { home, port, apiKey, localToken, env };
}

test("serve writes bounded request logs without mirroring them and status reports daemon runtime metrics", async (t) => {
  const fixture = await createFixture(t);
  const run = spawnCli(["serve"], fixture.env);
  t.after(() => { if (run.child.exitCode === null && run.child.signalCode === null) run.child.kill(); });
  const health = await waitForHealth(fixture.port);
  assert.equal(health.version, VERSION);

  const statusRun = spawnCli(["status"], fixture.env);
  const statusExit = await waitForExit(statusRun);
  assert.equal(statusExit.code, 0, statusRun.output().stderr);
  const status = JSON.parse(statusRun.output().stdout);
  assert.equal(status.version, VERSION);
  assert.equal(status.runtimeVersion, VERSION);
  assert.equal(status.running, true);
  assert.ok(status.logging?.request);
  assert.ok(status.logging?.diagnostic);
  assert.equal(status.diagnostics?.mode, "local-only");

  const shutdownStarted = Date.now();
  const shutdown = await fetch(`http://127.0.0.1:${fixture.port}/internal/shutdown`, {
    method: "POST", headers: { "x-local-token": fixture.localToken },
  });
  assert.equal(shutdown.status, 200);
  const exit = await waitForExit(run);
  assert.equal(exit.code, 0, run.output().stderr);
  assert.ok(Date.now() - shutdownStarted < 3000);

  const requestLog = join(fixture.home, "request-events.jsonl");
  assert.equal(existsSync(requestLog), true);
  const records = readJsonLines(requestLog);
  assert.ok(records.some((record) => record.event === "proxy_request" && record.route === "/healthz"));
  const combined = run.output().stdout + run.output().stderr + readFileSync(requestLog, "utf8");
  assert.doesNotMatch(run.output().stdout, /"event":"proxy_request"/);
  assert.doesNotMatch(combined, new RegExp(`${fixture.apiKey}|${fixture.localToken}`));
});

test("serve records startup failure and exits when its port is already occupied", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "momo-cli-start-failure-"));
  const blocker = createServer();
  const port = await listen(blocker);
  const apiKey = "momo_TEST_START_SECRET_123456789";
  const localToken = "local_TEST_START_SECRET_987654321";
  writeSettings(home, { apiKey, localToken, port, endpoint: "http://127.0.0.1:1", updateCheckEnabled: false });
  const run = spawnCli(["serve"], { MOMO_PROXY_HOME: home, MOMO_PROXY_CONSOLE_MIRROR: "0" });
  t.after(async () => {
    if (run.child.exitCode === null && run.child.signalCode === null) run.child.kill();
    await closeServer(blocker);
    rmSync(home, { recursive: true, force: true });
  });
  const started = Date.now();
  const exit = await waitForExit(run);
  assert.equal(exit.code, 1);
  assert.ok(Date.now() - started < 3000);
  const target = join(home, "diagnostic-events-v2.jsonl");
  assert.equal(existsSync(target), true);
  const records = readJsonLines(target);
  assert.ok(records.some((record) => record.event === "proxy_start_error" && record.error_code === "eaddrinuse"));
  const combined = run.output().stdout + run.output().stderr + readFileSync(target, "utf8");
  assert.doesNotMatch(combined, new RegExp(`${apiKey}|${localToken}`));
});

test("offline status reports version but does not fabricate daemon logging counters", async (t) => {
  const fixture = await createFixture(t);
  const run = spawnCli(["status"], fixture.env);
  const exit = await waitForExit(run);
  assert.equal(exit.code, 0, run.output().stderr);
  const status = JSON.parse(run.output().stdout);
  assert.equal(status.version, VERSION);
  assert.equal(status.runtimeVersion, null);
  assert.equal(status.running, false);
  assert.deepEqual(status.logging, { available: false, reason: "daemon_offline" });
  assert.deepEqual(status.diagnostics, { available: false, reason: "daemon_offline" });
});

test("SIGTERM flushes accepted request records before process exit", { skip: process.platform === "win32" ? "POSIX signal semantics required" : false }, async (t) => {
  const fixture = await createFixture(t);
  const run = spawnCli(["serve"], fixture.env);
  t.after(() => { if (run.child.exitCode === null && run.child.signalCode === null) run.child.kill("SIGKILL"); });
  await waitForHealth(fixture.port);
  const requests = 24;
  const responses = await Promise.all(Array.from({ length: requests }, () => fetch(`http://127.0.0.1:${fixture.port}/healthz`)));
  assert.equal(responses.every((response) => response.ok), true);
  run.child.kill("SIGTERM");
  const exit = await waitForExit(run);
  assert.equal(exit.code, 0, run.output().stderr);
  const records = readJsonLines(join(fixture.home, "request-events.jsonl"));
  assert.ok(records.filter((record) => record.event === "proxy_request" && record.route === "/healthz").length >= requests);
});
