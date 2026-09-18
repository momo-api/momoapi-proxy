import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appHome, daemonEnvironment, resolveDaemonSettings, resolveSettings, settingsPath } from "../src/config.mjs";

test("injected user homes never fall back to the real profile", () => {
  const home = mkdtempSync(join(tmpdir(), "momo-config-home-"));
  const explicitProxyHome = join(home, "isolated-proxy");
  try {
    mkdirSync(join(home, ".momo-codex-bridge"), { recursive: true });
    writeFileSync(join(home, ".momo-codex-bridge", "settings.json"), "{}\n");
    assert.equal(appHome({ HOME: home }), join(home, ".momoapi-proxy"));
    assert.equal(appHome({ USERPROFILE: home }), join(home, ".momoapi-proxy"));
    assert.equal(settingsPath({ HOME: home }), join(home, ".momo-codex-bridge", "settings.json"));
    assert.equal(settingsPath({ HOME: home, MOMO_PROXY_HOME: explicitProxyHome }), join(explicitProxyHome, "settings.json"));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

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

test("daemon settings ignore a stale process endpoint while ordinary commands retain explicit overrides", () => {
  const home = mkdtempSync(join(tmpdir(), "momo-config-"));
  try {
    writeFileSync(join(home, "settings.json"), JSON.stringify({
      apiKey: "saved-current-key", localToken: "local-token", endpoint: "https://momoapi.us",
    }));
    const env = {
      MOMO_PROXY_HOME: home, MOMO_API_ENDPOINT: "https://gateway.internal",
    };
    assert.equal(resolveSettings(env).endpoint, "https://gateway.internal");
    assert.equal(resolveDaemonSettings(env).endpoint, "https://momoapi.us");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("detached daemon environment removes command-scoped routing overrides", () => {
  const home = mkdtempSync(join(tmpdir(), "momo-config-"));
  try {
    writeFileSync(join(home, "settings.json"), JSON.stringify({
      endpoint: "https://momoapi.us", port: 18789, localToken: "saved-local-token",
    }));
    const env = daemonEnvironment({
      MOMO_PROXY_HOME: home, MOMO_API_KEY: "bootstrap-key",
      MOMO_API_ENDPOINT: "https://gateway.example", MOMO_ENDPOINT: "https://other.example",
      MOMO_BRIDGE_PORT: "19999", MOMO_SWITCH_PORT: "18888",
      MOMO_BRIDGE_TOKEN: "temporary", MOMO_SWITCH_TOKEN: "temporary-legacy",
    });
    assert.equal(env.MOMO_PROXY_HOME, home);
    assert.equal(env.MOMO_API_KEY, "bootstrap-key");
    for (const name of ["MOMO_API_ENDPOINT", "MOMO_ENDPOINT", "MOMO_BRIDGE_PORT", "MOMO_SWITCH_PORT", "MOMO_BRIDGE_TOKEN", "MOMO_SWITCH_TOKEN"]) {
      assert.equal(name in env, false);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("daemon environment preserves bootstrap overrides before settings exist", () => {
  const home = mkdtempSync(join(tmpdir(), "momo-config-"));
  try {
    const env = daemonEnvironment({ MOMO_PROXY_HOME: home, MOMO_API_ENDPOINT: "https://bootstrap.example", MOMO_BRIDGE_PORT: "19999" });
    assert.equal(env.MOMO_API_ENDPOINT, "https://bootstrap.example");
    assert.equal(env.MOMO_BRIDGE_PORT, "19999");
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
    assert.equal(settings.maxRequestBodyMb, 144);
    assert.equal(settings.attachmentAssetDirectory, join(home, "attachments"));
    assert.deepEqual(settings.attachmentAssets, {
      enabled: true, maxFileMb: 50, maxBatchMb: 100, inlineImageMb: 6, inlineFileMb: 2, inlineBatchMb: 5.5, uploadTimeoutMs: 180000,
    });
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

test("saved update preferences are respected, including manual mode", () => {
  const home = mkdtempSync(join(tmpdir(), "momo-config-"));
  try {
    writeFileSync(join(home, "settings.json"), JSON.stringify({
      apiKey: "saved-current-key", localToken: "local-token", autoUpdateEnabled: false,
    }));
    const migrated = resolveSettings({ MOMO_PROXY_HOME: home });
    assert.equal(migrated.updateMode, "notify");
    assert.equal(migrated.autoUpdateEnabled, false);

    writeFileSync(join(home, "settings.json"), JSON.stringify({
      apiKey: "saved-current-key", localToken: "local-token", updateMode: "notify",
    }));
    const notifyOnly = resolveSettings({ MOMO_PROXY_HOME: home });
    assert.equal(notifyOnly.updateMode, "notify");
    assert.equal(notifyOnly.autoUpdateEnabled, false);

    writeFileSync(join(home, "settings.json"), JSON.stringify({
      apiKey: "saved-current-key", localToken: "local-token", updateMode: "manual", autoUpdateEnabled: false,
    }));
    const manual = resolveSettings({ MOMO_PROXY_HOME: home });
    assert.equal(manual.updateMode, "manual");
    assert.equal(manual.autoUpdateEnabled, false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
