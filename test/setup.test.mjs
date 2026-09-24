import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateManagedCompactionConfig, rollback, setup, uninstall } from "../src/setup.mjs";
import { isAutostartInstalled } from "../src/autostart.mjs";
import { runDoctor } from "../src/doctor.mjs";

test("setup rejects reserved placeholder endpoints before writing configuration", async () => {
  const root = mkdtempSync(join(tmpdir(), "momo-setup-placeholder-"));
  const env = { ...process.env, HOME: root, USERPROFILE: root, APPDATA: join(root, "appdata"), CODEX_HOME: join(root, ".codex"), MOMO_PROXY_HOME: join(root, ".proxy") };
  let fetched = false;
  try {
    await assert.rejects(() => setup({
      apiKey: "momo-secret",
      endpoint: "https://gateway.example",
      autostart: false,
      imagePlugin: false,
      fetchImpl: async () => { fetched = true; return new Response("unexpected"); },
      env,
    }), (error) => error.code === "endpoint_placeholder");
    assert.equal(fetched, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("setup writes a local provider configuration and rollback restores it", async () => {
  const root = mkdtempSync(join(tmpdir(), "momo-switch-"));
  const env = { ...process.env, HOME: root, USERPROFILE: root, APPDATA: join(root, "appdata"), CODEX_HOME: join(root, ".codex"), MOMO_SWITCH_HOME: join(root, ".switch"), MOMO_BRIDGE_HOME: join(root, ".bridge") };
  const config = join(env.CODEX_HOME, "config.toml");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(env.CODEX_HOME, { recursive: true }));
  writeFileSync(config, 'model = "old-model"\ncompact_prompt = "my own compact rules"\n');
  const { DatabaseSync } = await import("node:sqlite");
  const state = new DatabaseSync(join(env.CODEX_HOME, "state_5.sqlite"));
  state.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, model_provider TEXT); INSERT INTO threads VALUES ('existing-openai', 'openai'), ('existing-codex', 'Codex');");
  state.close();
  const fakeFetch = async () => new Response(JSON.stringify({ data: [{ id: "gemini-3.7-flash", agent_status: "stable" }] }), { status: 200, headers: { "content-type": "application/json" } });
  try {
    const result = await setup({ apiKey: "momo-secret", endpoint: "https://gateway.internal", port: 19999, imagePlugin: false, fetchImpl: fakeFetch, env });
    const written = readFileSync(result.config, "utf8");
    assert.equal(result.defaultModel, "gemini-3.7-flash");
    assert.match(written, /model = "gemini-3\.7-flash"/);
    assert.match(written, /model_provider = "momoapi-proxy"/);
    assert.match(written, /\[model_providers\.momoapi-proxy\]/);
    assert.match(written, /name = "MOMO Route"/);
    assert.match(written, /base_url = "http:\/\/127\.0\.0\.1:19999\/v1"/);
    assert.match(written, /"credential", "local"/);
    assert.doesNotMatch(written, /^openai_base_url\s*=/m);
    assert.doesNotMatch(written, /model_context_window/);
    assert.doesNotMatch(written, /model_auto_compact_token_limit/);
    assert.doesNotMatch(written, /CURRENT ACTIVE TASK/);
    assert.match(written, /compact_prompt = "my own compact rules"/);
    assert.match(written, /MOMOAPI_ROUTE_MANAGED_BEGIN/);
    const stateAfter = new DatabaseSync(join(env.CODEX_HOME, "state_5.sqlite"));
    const historyRows = stateAfter.prepare("SELECT id, model_provider FROM threads ORDER BY id").all().map((row) => ({ ...row }));
    stateAfter.close();
    assert.deepEqual(historyRows, [
      { id: "existing-codex", model_provider: "Codex" },
      { id: "existing-openai", model_provider: "openai" },
    ]);
    const catalogText = readFileSync(result.catalog, "utf8");
    assert.match(catalogText, /gemini-3\.7-flash/);
    assert.doesNotMatch(catalogText, /"auto_compact_token_limit"/);
    const settings = JSON.parse(readFileSync(result.settingsFile, "utf8"));
    assert.equal(settings.updateCheckEnabled, true);
    assert.equal(settings.updateMode, "automatic");
    assert.equal(settings.autoUpdateEnabled, true);
    assert.equal(settings.diagnosticsEnabled, true);
    assert.equal("telemetryEnabled" in settings, false);
    assert.equal("installationId" in settings, false);
    assert.equal(isAutostartInstalled(process.platform, env), true);
    assert.deepEqual(rollback(env), [result.config]);
    assert.equal(readFileSync(config, "utf8"), 'model = "old-model"\ncompact_prompt = "my own compact rules"\n');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("macOS setup fails when its LaunchAgent cannot be activated", async () => {
  const root = mkdtempSync(join(tmpdir(), "momo-setup-mac-failure-"));
  const env = { ...process.env, HOME: root, USERPROFILE: root, APPDATA: join(root, "appdata"), CODEX_HOME: join(root, ".codex"), MOMO_PROXY_HOME: join(root, ".proxy") };
  const fakeFetch = async () => new Response(JSON.stringify({ data: [{ id: "gpt-5.5", agent_status: "stable" }] }), { status: 200, headers: { "content-type": "application/json" } });
  try {
    await assert.rejects(() => setup({
      apiKey: "momo-secret", endpoint: "https://gateway.internal", imagePlugin: false,
      fetchImpl: fakeFetch, env, osPlatform: "darwin",
      autostartInstaller() { throw new Error("launchctl bootstrap failed"); },
    }), /launchctl bootstrap failed/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("managed compaction migration removes only previous MOMO threshold overrides", () => {
  const root = mkdtempSync(join(tmpdir(), "momo-compact-migration-"));
  const env = { ...process.env, HOME: root, USERPROFILE: root, APPDATA: join(root, "appdata"), CODEX_HOME: join(root, ".codex") };
  const config = join(env.CODEX_HOME, "config.toml");
  try {
    mkdirSync(env.CODEX_HOME, { recursive: true });
    writeFileSync(config, [
      "# MOMOAPI_PROXY_MANAGED",
      'model = "gemini-3.8-flash"',
      "model_context_window = 272000",
      "model_auto_compact_token_limit = 120000",
      'model_auto_compact_token_limit_scope = "body_after_prefix"',
      'compact_prompt = "You are compacting an active Codex session. Produce a task handoff, not a replay of the previous assistant answer. Always preserve the latest user request as CURRENT ACTIVE TASK, distinguish already resolved historical issues from pending work, record current-turn progress and pending tool calls/results, preserve governing constraints, and state the next action. Never omit the latest user request when compaction occurs during a tool-using turn. Do not treat older user questions as active unless the latest request explicitly reopens them."',
      "disable_response_storage = false",
      "",
    ].join("\n"));
    assert.deepEqual(migrateManagedCompactionConfig(env), { changed: true, reason: "migrated" });
    const migrated = readFileSync(config, "utf8");
    assert.doesNotMatch(migrated, /model_context_window/);
    assert.doesNotMatch(migrated, /model_auto_compact_token_limit/);
    assert.doesNotMatch(migrated, /compact_prompt/);
    assert.deepEqual(migrateManagedCompactionConfig(env), { changed: false, reason: "current" });

    writeFileSync(config, "# user config\nmodel_auto_compact_token_limit = 120000\n");
    assert.deepEqual(migrateManagedCompactionConfig(env), { changed: false, reason: "unmanaged" });
    assert.doesNotMatch(readFileSync(config, "utf8"), /compact_prompt/);

    writeFileSync(config, '# MOMOAPI_PROXY_MANAGED\nmodel_auto_compact_token_limit = 210000\ncompact_prompt = "user-owned prompt"\n');
    assert.deepEqual(migrateManagedCompactionConfig(env), { changed: false, reason: "current" });
    assert.match(readFileSync(config, "utf8"), /model_auto_compact_token_limit = 210000/);
    assert.match(readFileSync(config, "utf8"), /compact_prompt = "user-owned prompt"/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("setup exposes the verified Ox model when the agent catalog falls back to /v1/models", async () => {
  const root = mkdtempSync(join(tmpdir(), "momo-switch-"));
  const env = { ...process.env, HOME: root, USERPROFILE: root, APPDATA: join(root, "appdata"), CODEX_HOME: join(root, ".codex"), MOMO_SWITCH_HOME: join(root, ".switch"), MOMO_BRIDGE_HOME: join(root, ".bridge") };
  let calls = 0;
  const fakeFetch = async () => {
    calls += 1;
    return calls === 1
      ? new Response("missing", { status: 404 })
      : new Response(JSON.stringify({ data: [{ id: "ox-alpha-free" }] }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const result = await setup({ apiKey: "momo-secret", endpoint: "https://gateway.internal", imagePlugin: false, fetchImpl: fakeFetch, env });
    const catalog = JSON.parse(readFileSync(result.catalog, "utf8"));
    assert.equal(result.defaultModel, "ox-alpha-free");
    const oxModel = catalog.models.find((m) => m.slug === "ox-alpha-free");
    assert.ok(oxModel);
    assert.equal(oxModel.visibility, "list");
    assert.ok(catalog.models.some((m) => m.slug === "gpt-5.6-sol"));
    assert.ok(catalog.models.some((m) => m.slug === "gpt-5.6-terra"));
    assert.ok(catalog.models.some((m) => m.slug === "gpt-5.6-luna"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("setup installs the MOMO Image plugin by default and records the preference", async () => {
  const root = mkdtempSync(join(tmpdir(), "momo-image-setup-"));
  const env = { ...process.env, HOME: root, USERPROFILE: root, APPDATA: join(root, "appdata"), CODEX_HOME: join(root, ".codex"), MOMO_PROXY_HOME: join(root, ".proxy") };
  const fakeFetch = async () => new Response(JSON.stringify({ data: [{ id: "gpt-5.5", agent_status: "stable" }] }), { status: 200, headers: { "content-type": "application/json" } });
  let installerEnv = null;
  try {
    const result = await setup({
      apiKey: "momo-secret",
      endpoint: "https://gateway.internal",
      autostart: false,
      fetchImpl: fakeFetch,
      env,
      imagePluginInstaller: ({ env: receivedEnv }) => {
        installerEnv = receivedEnv;
        return { attempted: true, installed: true, enabled: true, version: "0.4.0" };
      },
    });
    assert.equal(installerEnv, env);
    assert.equal(result.imagePlugin.installed, true);
    assert.equal(result.imagePlugin.enabled, true);
    assert.equal(JSON.parse(readFileSync(result.settingsFile, "utf8")).imagePluginEnabled, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("doctor and uninstall lifecycle verification", async () => {
  const root = mkdtempSync(join(tmpdir(), "momo-switch-doctor-"));
  const env = { ...process.env, HOME: root, USERPROFILE: root, APPDATA: join(root, "appdata"), CODEX_HOME: join(root, ".codex"), MOMO_SWITCH_HOME: join(root, ".switch"), MOMO_BRIDGE_HOME: join(root, ".bridge") };
  const fakeFetch = async () => new Response(JSON.stringify({ data: [{ id: "gpt-5.5", agent_status: "stable" }] }), { status: 200, headers: { "content-type": "application/json" } });
  try {
    await setup({ apiKey: "momo-secret", endpoint: "https://gateway.internal", imagePlugin: false, fetchImpl: fakeFetch, env });
    const report = await runDoctor({ env, fetchImpl: fakeFetch });
    assert.equal(report.checks.codexConfig.hasResponsesWire, true);
    assert.equal(report.checks.catalog.ok, true);
    assert.equal(report.checks.routeCatalog.ok, true);
    assert.equal(report.checks.autostart.installed, true);

    const configPath = join(env.CODEX_HOME, "config.toml");
    const staleCatalog = join(env.CODEX_HOME, "model-catalogs", "momo-models.json");
    writeFileSync(staleCatalog, JSON.stringify({ models: [{ slug: "gpt-5.5" }] }));
    writeFileSync(configPath, readFileSync(configPath, "utf8").replace(/momoapi-proxy\.json/g, "momo-models.json"));
    const staleReport = await runDoctor({ env, fetchImpl: fakeFetch });
    assert.equal(staleReport.ok, false);
    assert.equal(staleReport.checks.routeCatalog.ok, false);
    assert.equal(staleReport.checks.routeCatalog.mode, "proxy");

    const uninstallResult = uninstall({ env, removeKey: true });
    assert.equal(uninstallResult.uninstalled, true);
    assert.equal(isAutostartInstalled(process.platform, env), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("migrateHistory unifies previous session provider to targetProvider", async () => {
  const { migrateHistory } = await import("../src/history.mjs");
  const { DatabaseSync } = await import("node:sqlite");
  const root = mkdtempSync(join(tmpdir(), "momo-history-"));
  const dbPath = join(root, "state_5.sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, model_provider TEXT, title TEXT);");
  db.exec("INSERT INTO threads (id, model_provider, title) VALUES ('t1', 'openai', 'Session 1'), ('t2', 'Codex', 'Session 2'), ('t3', 'momo-switch', 'Session 3');");
  db.close();

  const res = await migrateHistory({ dbPath, targetProvider: "momoapi-proxy", backup: false });
  assert.equal(res.dbFound, true);
  assert.equal(res.migrated, 3);

  const dbAfter = new DatabaseSync(dbPath);
  const rows = dbAfter.prepare("SELECT model_provider FROM threads").all();
  assert.ok(rows.every((r) => r.model_provider === "momoapi-proxy"));
  dbAfter.close();
  rmSync(root, { recursive: true, force: true });
});

test("catalog sorting prioritizes gpt -> claude -> gemini -> deepseek -> other", async () => {
  const { buildCatalog } = await import("../src/catalog.mjs");
  const mockModels = [
    { id: "mimo-v2.6-flash-free", agent_status: "stable" },
    { id: "deepseek-v4-pro", agent_status: "stable" },
    { id: "gemini-3.7-flash", agent_status: "stable" },
    { id: "claude-opus-4-6-thinking", agent_status: "stable" },
    { id: "gpt-5.5", agent_status: "stable" },
    { id: "codex-auto-review", agent_status: "stable" },
    { id: "gpt-5.4", agent_status: "stable" },
  ];
  const catalog = buildCatalog(mockModels, { includeDesktopAliases: false });
  const slugs = catalog.models.map((m) => m.slug);
  assert.deepEqual(slugs, [
    "codex-auto-review",
    "gpt-5.4",
    "gpt-5.5",
    "claude-opus-4-6-thinking",
    "gemini-3.7-flash",
    "deepseek-v4-pro",
    "mimo-v2.6-flash-free",
  ]);
});

test("catalog excludes known media models even when upstream omits modality", async () => {
  const { buildCatalog } = await import("../src/catalog.mjs");
  const catalog = buildCatalog([
    { id: "gpt-5.5", agent_status: "stable" },
    { id: "momoapi-gemini-nano-banana-3", agent_status: "stable" },
    { id: "momoapi-gemini-omni-flash", agent_status: "stable" },
    { id: "momoapi-kling-3-standard", agent_status: "stable" },
    { id: "momoapi-veo-3-1-fast", agent_status: "stable" },
    { id: "momoapi-veo-3-1-lite", agent_status: "stable" },
    { id: "provider-image-model", agent_status: "stable" },
    { id: "provider-video-model", modality: "video", agent_status: "stable" },
  ], { includeDesktopAliases: false });
  assert.deepEqual(catalog.models.map((model) => model.slug), ["gpt-5.5"]);
});

test("catalog uses one compact cross-provider instruction source", async () => {
  const { buildCatalog } = await import("../src/catalog.mjs");
  const catalog = buildCatalog([
    { id: "gpt-5.5", agent_status: "stable" },
    { id: "claude-opus-4-6-thinking", agent_status: "stable" },
    { id: "gemini-3.7-flash", agent_status: "stable" },
    { id: "deepseek-v4-pro", agent_status: "stable" },
  ], { includeDesktopAliases: false });

  for (const model of catalog.models) {
    const instructions = model.base_instructions;
    assert.equal(model.model_messages.instructions_template, instructions);
    assert.ok(instructions.length >= 800);
    assert.ok(instructions.length <= 3000);
    assert.doesNotMatch(instructions, /You are Codex, an agent based on GPT-5/);
    assert.match(instructions, /AGENTS\.md/);
    assert.match(instructions, /Use available tools/);
    assert.match(instructions, /pending tool calls/);
    assert.match(instructions, /call\/result relationships/);
    assert.match(instructions, /Never expose credentials/);
  }
});

test("catalog leaves compaction to Codex unless the upstream model declares a limit", async () => {
  const { buildCatalog } = await import("../src/catalog.mjs");
  const catalog = buildCatalog([
    { id: "gpt-default", agent_status: "stable" },
    { id: "gpt-explicit", agent_status: "stable", auto_compact_token_limit: 234567 },
    { id: "gpt-explicit-camel", agent_status: "stable", autoCompactTokenLimit: 210000 },
  ], { includeDesktopAliases: false });

  const bySlug = new Map(catalog.models.map((model) => [model.slug, model]));
  assert.equal("auto_compact_token_limit" in bySlug.get("gpt-default"), false);
  assert.equal(bySlug.get("gpt-explicit").auto_compact_token_limit, 234567);
  assert.equal(bySlug.get("gpt-explicit-camel").auto_compact_token_limit, 210000);
});
