import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diagnosticPath, flushTelemetryQueue, normalizeDiagnosticEvent, recordDiagnosticEvent, startTelemetryReporter, telemetryQueuePath } from "../src/telemetry.mjs";

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
  }, { now: new Date("2026-09-09T00:00:00.000Z"), version: "0.11.0" });
  assert.equal(event.status, 413);
  assert.equal(event.request_bytes, 2_234_959);
  assert.equal("prompt" in event, false);
  assert.equal("apiKey" in event, false);
  assert.equal("base64" in event, false);
});

test("diagnostic error codes are normalized for the ingestion contract", () => {
  const event = normalizeDiagnosticEvent({ event: "proxy_start_error", errorCode: "ENETUNREACH / network" });
  assert.equal(event.error_code, "enetunreach_network");
});

test("reportable diagnostics are stored locally and flushed in an authenticated batch", async () => {
  const home = mkdtempSync(join(tmpdir(), "momo-telemetry-"));
  const env = { MOMO_PROXY_HOME: home };
  const settings = {
    apiKey: "test-api-key",
    endpoint: "https://gateway.example",
    installationId: "opaque-installation-id",
    diagnosticsEnabled: true,
    telemetryEnabled: true,
  };
  try {
    recordDiagnosticEvent({ event: "proxy_request_error", route: "/v1/responses", status: 503, errorCode: "upstream_unavailable" }, { env, settings });
    assert.match(readFileSync(diagnosticPath(env), "utf8"), /upstream_unavailable/);
    assert.match(readFileSync(telemetryQueuePath(env), "utf8"), /opaque-installation-id/);

    let request;
    const result = await flushTelemetryQueue({
      env,
      settings,
      fetchImpl: async (url, options) => {
        request = { url, options };
        return new Response(JSON.stringify({ success: true }), { status: 202 });
      },
    });
    assert.equal(result.sent, 1);
    assert.equal(request.url, "https://gateway.example/api/proxy/telemetry");
    assert.equal(request.options.headers.authorization, "Bearer test-api-key");
    const payload = JSON.parse(request.options.body);
    assert.equal(payload.events.length, 1);
    assert.equal(payload.events[0].error_code, "upstream_unavailable");
    assert.equal(readFileSync(telemetryQueuePath(env), "utf8"), "");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("non-reportable client errors remain local and do not enter the remote queue", () => {
  const home = mkdtempSync(join(tmpdir(), "momo-telemetry-"));
  const env = { MOMO_PROXY_HOME: home };
  try {
    recordDiagnosticEvent({ event: "proxy_request_error", status: 400, errorCode: "invalid_json" }, {
      env,
      settings: { diagnosticsEnabled: true, telemetryEnabled: true },
    });
    assert.match(readFileSync(diagnosticPath(env), "utf8"), /invalid_json/);
    assert.throws(() => readFileSync(telemetryQueuePath(env), "utf8"), /ENOENT/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("telemetry reporter backs off for every non-success response", async () => {
  const home = mkdtempSync(join(tmpdir(), "momo-telemetry-"));
  const env = { MOMO_PROXY_HOME: home };
  const delays = [];
  let scheduled;
  try {
    recordDiagnosticEvent({ event: "proxy_request_error", status: 503, errorCode: "upstream_unavailable" }, {
      env,
      settings: { diagnosticsEnabled: true, telemetryEnabled: true },
    });
    const reporter = startTelemetryReporter({
      env,
      settings: { apiKey: "test-api-key", endpoint: "https://gateway.example", telemetryEnabled: true },
      fetchImpl: async () => new Response("unauthorized", { status: 401 }),
      initialDelayMs: 0,
      scheduleImpl: (callback, delay) => {
        delays.push(delay);
        scheduled = callback;
        return { unref() {} };
      },
      clearScheduleImpl: () => {},
    });
    await scheduled();
    assert.deepEqual(delays, [0, 30_000]);
    reporter.stop();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
