import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveSettings } from "../src/config.mjs";

test("saved API key wins over a stale process environment key", () => {
  const home = mkdtempSync(join(tmpdir(), "momo-config-"));
  try {
    writeFileSync(join(home, "settings.json"), JSON.stringify({
      apiKey: "saved-current-key",
      localToken: "local-token",
      endpoint: "https://momoapi.us",
    }));
    const settings = resolveSettings({
      MOMO_PROXY_HOME: home,
      MOMO_API_KEY: "stale-process-key",
    });
    assert.equal(settings.apiKey, "saved-current-key");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("environment API key remains a fallback before setup creates settings", () => {
  const home = mkdtempSync(join(tmpdir(), "momo-config-"));
  try {
    const settings = resolveSettings({
      MOMO_PROXY_HOME: home,
      MOMO_API_KEY: "bootstrap-env-key",
      MOMO_BRIDGE_TOKEN: "local-token",
    });
    assert.equal(settings.apiKey, "bootstrap-env-key");
    assert.equal(settings.autoUpdateEnabled, true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("diagnostic reporting and update checks have safe configurable defaults", () => {
  const home = mkdtempSync(join(tmpdir(), "momo-config-"));
  try {
    writeFileSync(join(home, "settings.json"), JSON.stringify({
      apiKey: "saved-current-key",
      localToken: "local-token",
      endpoint: "https://momoapi.us/",
      telemetryEnabled: false,
      diagnosticsEnabled: false,
      updateCheckEnabled: false,
      autoUpdateEnabled: false,
      updateCheckIntervalHours: 24,
      installationId: "install_opaque_123456",
    }));
    const settings = resolveSettings({ MOMO_PROXY_HOME: home });
    assert.equal(settings.endpoint, "https://momoapi.us");
    assert.equal(settings.telemetryEnabled, false);
    assert.equal(settings.diagnosticsEnabled, false);
    assert.equal(settings.updateCheckEnabled, false);
    assert.equal(settings.autoUpdateEnabled, false);
    assert.equal(settings.updateCheckIntervalHours, 24);
    assert.equal(settings.installationId, "install_opaque_123456");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
