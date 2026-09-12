import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordDiagnosticEvent } from "../src/diagnostics.mjs";
import { legacyLogPath, logPath, logRequest, readRecentLogs } from "../src/logger.mjs";
import { createLoggingRuntime, diagnosticEventPath, requestEventPath } from "../src/logging-runtime.mjs";
import { closeLoggingWithinDeadline, closeServerAndLogging, createSignalStopper } from "../src/process-shutdown.mjs";
import { createMomoSwitch } from "../src/server.mjs";

function scratchRuntime(t, options = {}) {
  const home = mkdtempSync(join(tmpdir(), "momo-logging-runtime-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const env = { MOMO_PROXY_HOME: home, MOMO_PROXY_CONSOLE_MIRROR: "0" };
  return { home, env, runtime: createLoggingRuntime({ env, ...options }) };
}

test("request records are sanitized and queued before asynchronous disk I/O", async (t) => {
  let release, appendStarted;
  const gate = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { appendStarted = resolve; });
  const batches = [];
  const { env, runtime } = scratchRuntime(t, { sinkFactory: () => ({
    snapshot: () => ({ rotations: 0, lockConflicts: 0, failures: 0, lastError: null }),
    async append(records) { appendStarted(); await gate; batches.push(...records); },
  }) });
  const accepted = logRequest({ method: "POST\nINJECT", url: "/v1/responses\r\nforged", status: 503,
    error: `Bearer secret-token ${"A".repeat(500)} \ud800`, toolCalls: [{ name: "tool\nname" }],
    toolAudit: { leafTools: 1, tools: [{ type: "custom", nameHash: "abcd" }] } },
  env, { runtime, settings: { diagnosticsEnabled: false } });
  assert.equal(accepted, true); assert.equal(batches.length, 0);
  await started; assert.equal(runtime.snapshot().request.pendingRecords, 1);
  release(); assert.equal((await runtime.flush()).completed, true);
  const record = JSON.parse(batches[0].toString("utf8"));
  assert.equal(record.method, "POST INJECT"); assert.equal(record.route, "/v1/responses forged");
  assert.doesNotMatch(JSON.stringify(record), /secret-token|AAAAAA|\r|\n/); assert.match(record.error, /redacted/);
  assert.equal(runtime.snapshot().request.written, 1);
});

test("large metadata and invalid Unicode remain a single bounded record", async (t) => {
  const records = [];
  const { env, runtime } = scratchRuntime(t, { sinkFactory: () => ({ snapshot: () => ({}), append: async (batch) => records.push(...batch) }) });
  assert.equal(logRequest({ method: "POST", url: "/v1/responses", status: 200,
    toolCalls: Array.from({ length: 1000 }, () => ({ name: `x\n${"😀".repeat(1000)}\ud800` })),
    toolAudit: { tools: Array.from({ length: 1000 }, () => ({ type: "custom\n", nameHash: "f".repeat(1000) })) } },
  env, { runtime, settings: { diagnosticsEnabled: false } }), true);
  await runtime.flush(); assert.equal(records.length, 1); assert.ok(records[0].length <= 64 * 1024);
  assert.equal(records[0].subarray(0, -1).includes(10), false); assert.doesNotMatch(records[0].toString("utf8"), /�/);
});

test("diagnostics disabled does not initialize its writer", (t) => {
  let sinks = 0;
  const { env, runtime } = scratchRuntime(t, { diagnosticsEnabled: false, sinkFactory: () => { sinks++; return { append: async () => {} }; } });
  assert.equal(recordDiagnosticEvent({ event: "proxy_request_error", status: 503 }, { env, settings: { diagnosticsEnabled: false }, runtime }), null);
  assert.equal(sinks, 0); assert.equal(runtime.snapshot().diagnostic.initialized, false);
});

test("new rotating log generations are read in order and legacy is fallback-only", (t) => {
  const { home, env } = scratchRuntime(t);
  writeFileSync(legacyLogPath(env), "legacy-only\n"); assert.deepEqual(readRecentLogs(5, env), ["legacy-only"]);
  writeFileSync(logPath(env) + ".1", "old-1\nold-2\n"); writeFileSync(logPath(env), "new-1\nnew-2\n");
  assert.deepEqual(readRecentLogs(3, env), ["old-2", "new-1", "new-2"]);
  assert.doesNotMatch(readRecentLogs(10, env).join("\n"), /legacy-only/);
  assert.equal(requestEventPath(env), join(home, "request-events.jsonl"));
  assert.equal(diagnosticEventPath(env), join(home, "diagnostic-events-v2.jsonl"));
  assert.equal(readFileSync(legacyLogPath(env), "utf8"), "legacy-only\n");
});

test("logging metrics separate accepted, written, failed and pending records", async (t) => {
  let invocation = 0, release; const gate = new Promise((resolve) => { release = resolve; });
  const { runtime } = scratchRuntime(t, { sinkFactory: () => ({ snapshot: () => ({ failures: invocation }), async append() {
    invocation++; if (invocation === 1) await gate; else throw Object.assign(new Error("hidden path"), { mayHaveWritten: false });
  } }) });
  runtime.enqueueRequest("first"); await new Promise((resolve) => setImmediate(resolve)); runtime.enqueueRequest("second");
  assert.deepEqual({ accepted: runtime.snapshot().request.accepted, written: runtime.snapshot().request.written,
    failed: runtime.snapshot().request.writeFailed, pending: runtime.snapshot().request.pendingRecords },
  { accepted: 2, written: 0, failed: 0, pending: 2 });
  release(); await runtime.flush(); assert.equal(runtime.snapshot().request.written, 1);
  assert.equal(runtime.snapshot().request.writeFailed, 1); assert.equal(runtime.snapshot().request.lastError, "log_append_failed");
  assert.doesNotMatch(JSON.stringify(runtime.snapshot()), /hidden path/);
});

test("process shutdown closes server and logging within one bounded deadline", async () => {
  let serverClose; const server = { listening: true, close(callback) { serverClose = callback; } };
  let loggingClosed = 0; const loggingRuntime = { close: async () => { loggingClosed++; return { completed: true }; } };
  const timed = await closeServerAndLogging({ server, loggingRuntime, timeoutMs: 20 });
  assert.equal(timed.timedOut, true); assert.equal(loggingClosed, 1); serverClose();
});

test("logging close has an outer hard deadline even when an injected runtime never settles", async () => {
  const started = Date.now();
  const result = await closeLoggingWithinDeadline({ loggingRuntime: { close: () => new Promise(() => {}) }, timeoutMs: 20 });
  assert.deepEqual(result, { completed: false, reason: "timeout" });
  assert.ok(Date.now() - started < 500);
});

test("signal stopper is idempotent and exits after bounded close", async () => {
  let before = 0, exits = 0, closes = 0;
  const stop = createSignalStopper({ server: { listening: false }, loggingRuntime: { close: async () => { closes++; } },
    beforeStop: () => { before++; }, exitImpl: () => { exits++; }, timeoutMs: 50 });
  assert.equal(stop(), stop()); await stop(); assert.equal(before, 1); assert.equal(closes, 1); assert.equal(exits, 1);
});

test("server close callback waits for its internally owned logging runtime", async () => {
  let release, closeCalls = 0;
  const gate = new Promise((resolve) => { release = resolve; });
  const runtime = { env: process.env, enqueueRequest: () => true, enqueueDiagnostic: () => true,
    snapshot: () => ({ request: {}, diagnostic: {} }), close: () => { closeCalls++; return gate; } };
  const server = createMomoSwitch({ endpoint: "https://gateway.example", apiKey: "synthetic",
    localToken: "synthetic-local", host: "127.0.0.1", port: 0 }, { loggingRuntimeFactory: () => runtime });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  let callbackCalled = false;
  const closed = new Promise((resolve) => server.close(() => { callbackCalled = true; resolve(); }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closeCalls, 1);
  assert.equal(callbackCalled, false);
  release({ completed: true });
  await closed;
  assert.equal(callbackCalled, true);
});
