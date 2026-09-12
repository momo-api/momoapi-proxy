import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diagnosticPath, diagnosticsState, getDiagnosticsMetrics, normalizeDiagnosticEvent, readRecentDiagnostics, recordDiagnosticEvent } from "../src/diagnostics.mjs";
import { flushLogging } from "../src/logging-runtime.mjs";

function resetDiagnosticsState() {
  diagnosticsState.localRecorded = 0;
  diagnosticsState.dropped = 0;
}

test("diagnostic events retain only bounded non-content metadata", () => {
  const event = normalizeDiagnosticEvent({
    event: "proxy_request_error",
    route: "/v1/responses",
    model: "gpt-5.6-sol",
    status: 413,
    errorCode: "payload_too_large",
    requestBytes: 2_234_959,
    prompt: "must never be retained",
    apiKey: "sk-this-must-never-be-retained",
    base64: "A".repeat(1024),
    installationId: "must-not-be-retained",
  }, { now: new Date("2026-09-09T00:00:00.000Z"), version: "0.11.0" });
  assert.equal(event.status, 413);
  assert.equal(event.request_bytes, 2_234_959);
  assert.equal("prompt" in event, false);
  assert.equal("apiKey" in event, false);
  assert.equal("base64" in event, false);
  assert.equal("installation_id" in event, false);
});

test("diagnostic error codes are normalized for local inspection", () => {
  const event = normalizeDiagnosticEvent({ event: "proxy_start_error", errorCode: "ENETUNREACH / network" });
  assert.equal(event.error_code, "enetunreach_network");
});

test("errors are stored locally without creating a remote queue", async () => {
  resetDiagnosticsState();
  const home = mkdtempSync(join(tmpdir(), "momo-diagnostics-"));
  const env = { MOMO_PROXY_HOME: home };
  try {
    recordDiagnosticEvent({ event: "proxy_request_error", route: "/v1/responses", status: 503, errorCode: "upstream_unavailable" }, {
      env,
      settings: { diagnosticsEnabled: true, apiKey: "must-never-be-used", telemetryEnabled: true },
    });
    await flushLogging({ env });
    const local = readFileSync(diagnosticPath(env), "utf8");
    assert.match(local, /upstream_unavailable/);
    assert.doesNotMatch(local, /must-never-be-used/);
    assert.equal(readRecentDiagnostics(1, env).length, 1);
    assert.equal(existsSync(join(home, "telemetry-queue.jsonl")), false);
    assert.deepEqual(getDiagnosticsMetrics(env), {
      localRecorded: 1,
      dropped: 0,
      mode: "local-only",
      localFileBytes: Buffer.byteLength(local),
      pendingRecords: 0,
      written: 1,
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("local diagnostics can be disabled", () => {
  resetDiagnosticsState();
  const home = mkdtempSync(join(tmpdir(), "momo-diagnostics-"));
  const env = { MOMO_PROXY_HOME: home };
  try {
    const event = recordDiagnosticEvent({ event: "proxy_request_error", status: 500 }, {
      env,
      settings: { diagnosticsEnabled: false },
    });
    assert.equal(event, null);
    assert.equal(existsSync(diagnosticPath(env)), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("ordinary client errors stay out of the diagnostics file", () => {
  resetDiagnosticsState();
  const home = mkdtempSync(join(tmpdir(), "momo-diagnostics-"));
  const env = { MOMO_PROXY_HOME: home };
  try {
    const event = recordDiagnosticEvent({ event: "proxy_request_error", status: 400, errorCode: "invalid_json" }, {
      env,
      settings: { diagnosticsEnabled: true },
    });
    assert.equal(event, null);
    assert.equal(existsSync(diagnosticPath(env)), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
