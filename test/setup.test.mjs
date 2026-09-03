import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rollback, setup, uninstall } from "../src/setup.mjs";
import { isAutostartInstalled } from "../src/autostart.mjs";
import { runDoctor } from "../src/doctor.mjs";

test("setup writes a local provider configuration and rollback restores it", async () => {
  const root = mkdtempSync(join(tmpdir(), "momo-switch-"));
  const env = { ...process.env, HOME: root, USERPROFILE: root, APPDATA: join(root, "appdata"), CODEX_HOME: join(root, ".codex"), MOMO_SWITCH_HOME: join(root, ".switch"), MOMO_BRIDGE_HOME: join(root, ".bridge") };
  const config = join(env.CODEX_HOME, "config.toml");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(env.CODEX_HOME, { recursive: true }));
  writeFileSync(config, "model = \"old-model\"\n");
  const fakeFetch = async () => new Response(JSON.stringify({ data: [{ id: "gemini-3.7-flash", agent_status: "stable" }] }), { status: 200, headers: { "content-type": "application/json" } });
  try {
    const result = await setup({ apiKey: "momo-secret", endpoint: "https://gateway.example", port: 19999, fetchImpl: fakeFetch, env });
    const written = readFileSync(result.config, "utf8");
    assert.equal(result.defaultModel, "gemini-3.7-flash");
    assert.match(written, /model = "gemini-3\.7-flash"/);
    assert.match(written, /model_provider = "momoapi-proxy"/);
    assert.match(written, /\[model_providers\.momoapi-proxy\]/);
    assert.match(written, /name = "MOMO API Proxy"/);
    assert.match(written, /base_url = "http:\/\/127\.0\.0\.1:19999\/v1"/);
    assert.match(written, /requires_openai_auth = false/);
    assert.match(written, /MOMO_CODEX_SWITCH_MANAGED/);
    assert.match(readFileSync(result.catalog, "utf8"), /gemini-3\.7-flash/);
    assert.equal(isAutostartInstalled(process.platform, env), true);
    assert.deepEqual(rollback(env), [result.config]);
    assert.equal(readFileSync(config, "utf8"), "model = \"old-model\"\n");
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
    const result = await setup({ apiKey: "momo-secret", endpoint: "https://gateway.example", fetchImpl: fakeFetch, env });
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

test("doctor and uninstall lifecycle verification", async () => {
  const root = mkdtempSync(join(tmpdir(), "momo-switch-doctor-"));
  const env = { ...process.env, HOME: root, USERPROFILE: root, APPDATA: join(root, "appdata"), CODEX_HOME: join(root, ".codex"), MOMO_SWITCH_HOME: join(root, ".switch"), MOMO_BRIDGE_HOME: join(root, ".bridge") };
  const fakeFetch = async () => new Response(JSON.stringify({ data: [{ id: "gpt-5.5", agent_status: "stable" }] }), { status: 200, headers: { "content-type": "application/json" } });
  try {
    await setup({ apiKey: "momo-secret", endpoint: "https://gateway.example", fetchImpl: fakeFetch, env });
    const report = await runDoctor({ env, fetchImpl: fakeFetch });
    assert.equal(report.checks.codexConfig.hasResponsesWire, true);
    assert.equal(report.checks.catalog.ok, true);
    assert.equal(report.checks.autostart.installed, true);

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
    { id: "muse-spark-1.3-contributor-free", agent_status: "stable" },
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
    "muse-spark-1.3-contributor-free",
  ]);
});
