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
    assert.equal(settings.updateMode, "automatic");
    assert.equal(settings.autoUpdateEnabled, true);
    assert.equal(settings.imagePluginEnabled, true);
    assert.equal(settings.imageAssetDirectory, join(home, "images"));
    assert.deepEqual(settings.imageAssets, { maxAssetMb: 20, maxTotalMb: 2048, maxAssets: 2000, retentionDays: 30 });
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
      diagnosticsEnabled: false,
      updateCheckEnabled: false,
      updateMode: "notify",
      updateCheckIntervalHours: 24,
      imagePluginEnabled: false,
      requestAdmission: { maxConcurrent: 2, maxBodyBudgetMb: 64 },
      outputPolicy: { maxStreamMb: 32, maxCallCacheMb: 16 },
    }));
    const settings = resolveSettings({ MOMO_PROXY_HOME: home });
    assert.equal(settings.endpoint, "https://momoapi.us");
    assert.equal(settings.diagnosticsEnabled, false);
    assert.equal(settings.updateCheckEnabled, false);
    assert.equal(settings.autoUpdateEnabled, false);
    assert.equal(settings.updateCheckIntervalHours, 24);
    assert.equal(settings.imagePluginEnabled, false);
    assert.deepEqual(settings.requestAdmission, { maxConcurrent: 2, maxBodyBudgetMb: 64 });
    assert.deepEqual(settings.outputPolicy, { maxStreamMb: 32, maxCallCacheMb: 16 });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("legacy installations migrate to verified automatic updates unless notification-only mode is explicit", () => {
  const home = mkdtempSync(join(tmpdir(), "momo-config-"));
  try {
    writeFileSync(join(home, "settings.json"), JSON.stringify({
      apiKey: "saved-current-key", localToken: "local-token", autoUpdateEnabled: false,
    }));
    const migrated = resolveSettings({ MOMO_PROXY_HOME: home });
    assert.equal(migrated.updateMode, "automatic");
    assert.equal(migrated.autoUpdateEnabled, true);

    writeFileSync(join(home, "settings.json"), JSON.stringify({
      apiKey: "saved-current-key", localToken: "local-token", updateMode: "notify",
    }));
    const notifyOnly = resolveSettings({ MOMO_PROXY_HOME: home });
    assert.equal(notifyOnly.updateMode, "notify");
    assert.equal(notifyOnly.autoUpdateEnabled, false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
