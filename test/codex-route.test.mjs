import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { catalogPath, directCatalogPath } from "../src/catalog.mjs";
import { codexRouteStatus, migrateManagedRouteAliases, readCodexCredential, restoreCodexRoute, switchCodexRoute } from "../src/codex-route.mjs";

const cliPath = fileURLToPath(new URL("../bin/momoapi-proxy.mjs", import.meta.url));

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "momo-codex-route-"));
  const env = { ...process.env, HOME: root, USERPROFILE: root, CODEX_HOME: join(root, ".codex"), MOMO_PROXY_HOME: join(root, ".proxy") };
  mkdirSync(env.CODEX_HOME, { recursive: true });
  mkdirSync(env.MOMO_PROXY_HOME, { recursive: true });
  mkdirSync(join(env.CODEX_HOME, "model-catalogs"), { recursive: true });
  writeFileSync(directCatalogPath(env), JSON.stringify({ models: [{ slug: "gpt-5.5" }, { slug: "gpt-5.6-luna" }] }));
  writeFileSync(catalogPath(env), JSON.stringify({ models: [{ slug: "gpt-5.5" }, { slug: "claude-opus-4-6-thinking" }, { slug: "gemini-3.8-flash" }] }));
  const directCatalog = directCatalogPath(env).replace(/\\/g, "/");
  writeFileSync(join(env.CODEX_HOME, "config.toml"), `model_provider = "Codex"\nmodel = "gpt-5.6-luna"\nmodel_catalog_json = "${directCatalog}"\n\n[model_providers.Codex]\nbase_url = "https://momoapi.us/v1"\nwire_api = "responses"\nrequires_openai_auth = true\n`);
  writeFileSync(join(env.CODEX_HOME, "auth.json"), '{"OPENAI_API_KEY":"synthetic-auth-value"}\n');
  writeFileSync(join(env.MOMO_PROXY_HOME, "settings.json"), JSON.stringify({ endpoint: "https://momoapi.us", port: 18789, apiKey: "upstream-secret", localToken: "local-secret" }));
  return { root, env };
}

test("Codex route switches all MOMO provider aliases without changing auth or unrelated config", () => {
  const { root, env } = fixture();
  try {
    const direct = switchCodexRoute("direct", { env, nodePath: "C:\\node.exe", cliPath: "C:\\proxy\\momoapi-proxy.mjs" });
    assert.equal(direct.mode, "direct");
    let content = readFileSync(direct.config, "utf8");
    assert.match(content, /model_provider = "Codex"/);
    assert.match(content, /\[model_providers\.Codex\][\s\S]*base_url = "https:\/\/momoapi.us\/v1"/);
    assert.match(content, /\[model_providers\.momo-route\][\s\S]*base_url = "https:\/\/momoapi.us\/v1"/);
    assert.match(content, /\[model_providers\.momo-codex-bridge\]/);
    assert.match(content, /"credential", "upstream"/);
    assert.match(content, /model = "gpt-5.6-luna"/);
    assert.ok(content.includes(`model_catalog_json = ${JSON.stringify(directCatalogPath(env).replace(/\\/g, "/"))}`));
    assert.doesNotMatch(content, /upstream-secret|local-secret/);
    assert.equal(codexRouteStatus(env).mode, "direct");
    assert.equal(codexRouteStatus(env).catalogConsistent, true);

    const proxy = switchCodexRoute("proxy", { env, nodePath: "C:\\node.exe", cliPath: "C:\\proxy\\momoapi-proxy.mjs" });
    content = readFileSync(proxy.config, "utf8");
    assert.match(content, /\[model_providers\.Codex\][\s\S]*base_url = "http:\/\/127.0.0.1:18789\/v1"/);
    assert.equal((content.match(/base_url = "http:\/\/127.0.0.1:18789\/v1"/g) || []).length, proxy.aliases.length);
    assert.match(content, /"credential", "local"/);
    assert.ok(content.includes(`model_catalog_json = ${JSON.stringify(catalogPath(env).replace(/\\/g, "/"))}`));
    assert.equal((content.match(/MOMOAPI_ROUTE_MANAGED_BEGIN/g) || []).length, 1);
    assert.equal(codexRouteStatus(env).mode, "proxy");
    assert.equal(codexRouteStatus(env).catalogConsistent, true);
    assert.ok(existsSync(proxy.rollback));
    assert.equal(readFileSync(join(env.CODEX_HOME, "auth.json"), "utf8"), '{"OPENAI_API_KEY":"synthetic-auth-value"}\n');

    const restored = restoreCodexRoute(env);
    assert.equal(restored.mode, "direct");
    assert.match(readFileSync(restored.restored, "utf8"), /model_provider = "Codex"/);
    assert.doesNotMatch(readFileSync(restored.restored, "utf8"), /MOMOAPI_ROUTE_MANAGED_BEGIN/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("route status follows the active provider instead of a stale managed marker", () => {
  const { root, env } = fixture();
  try {
    writeFileSync(join(env.CODEX_HOME, "config.toml"), [
      'model_provider = "Codex"',
      '# MOMOAPI_ROUTE_MANAGED_BEGIN',
      '# MOMOAPI_ROUTE_MODE=proxy',
      '[model_providers.Codex]',
      'base_url = "https://momoapi.us/v1"',
      '[model_providers.momo-route]',
      'base_url = "http://127.0.0.1:18789/v1"',
      '# MOMOAPI_ROUTE_MANAGED_END',
      '',
    ].join("\n"));
    const status = codexRouteStatus(env);
    assert.equal(status.mode, "direct");
    assert.equal(status.markerMode, "proxy");
    assert.equal(status.markerMismatch, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("route switch removes legacy top-level override that can defeat provider routing", () => {
  const { root, env } = fixture();
  try {
    const path = join(env.CODEX_HOME, "config.toml");
    writeFileSync(path, '# MOMOAPI_PROXY_MANAGED\nopenai_base_url = "http://127.0.0.1:18789/v1"\n' + readFileSync(path, "utf8"));
    switchCodexRoute("direct", { env, nodePath: "C:\\node.exe", cliPath: "C:\\proxy\\momoapi-proxy.mjs" });
    const content = readFileSync(path, "utf8");
    assert.doesNotMatch(content, /^openai_base_url\s*=/m);
    assert.doesNotMatch(content, /MOMOAPI_PROXY_MANAGED/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("managed route migration repairs aliases for existing conversations after update", () => {
  const { root, env } = fixture();
  try {
    const path = join(env.CODEX_HOME, "config.toml");
    writeFileSync(path, [
      'model_provider = "momo-route"',
      '[model_providers.Codex]',
      'base_url = "https://momoapi.us/v1"',
      '# MOMOAPI_ROUTE_MANAGED_BEGIN',
      '# MOMOAPI_ROUTE_MODE=proxy',
      '[model_providers.momo-route]',
      'base_url = "http://127.0.0.1:18789/v1"',
      '# MOMOAPI_ROUTE_MANAGED_END',
      '',
    ].join("\n"));
    assert.equal(codexRouteStatus(env).consistent, false);
    const migration = migrateManagedRouteAliases({ env, nodePath: "C:\\node.exe", cliPath: "C:\\proxy\\momoapi-proxy.mjs" });
    assert.equal(migration.changed, true);
    const content = readFileSync(path, "utf8");
    assert.match(content, /\[model_providers\.Codex\][\s\S]*base_url = "http:\/\/127.0.0.1:18789\/v1"/);
    assert.ok(content.includes(`model_catalog_json = ${JSON.stringify(catalogPath(env).replace(/\\/g, "/"))}`));
    assert.equal(codexRouteStatus(env).consistent, true);
    assert.deepEqual(migrateManagedRouteAliases({ env, nodePath: "C:\\node.exe", cliPath: "C:\\proxy\\momoapi-proxy.mjs" }).reason, "current");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Codex credential helper reads saved values without copying them into route config", () => {
  const { root, env } = fixture();
  try {
    assert.equal(readCodexCredential("upstream", env), "upstream-secret");
    assert.equal(readCodexCredential("local", env), "local-secret");
    assert.throws(() => readCodexCredential("other", env), /API key/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("direct route does not require a local proxy token", () => {
  const { root, env } = fixture();
  try {
    const settings = { endpoint: "https://momoapi.us", port: 18789, apiKey: "upstream-secret" };
    const result = switchCodexRoute("direct", { env, settings, nodePath: "C:\\node.exe", cliPath: "C:\\proxy\\momoapi-proxy.mjs" });
    assert.equal(result.mode, "direct");
    assert.throws(() => switchCodexRoute("proxy", { env, settings, nodePath: "C:\\node.exe", cliPath: "C:\\proxy\\momoapi-proxy.mjs" }), /local proxy token/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("direct route never retains the third-party proxy catalog when the official catalog is unavailable", () => {
  const { root, env } = fixture();
  try {
    unlinkSync(directCatalogPath(env));
    const path = join(env.CODEX_HOME, "config.toml");
    writeFileSync(path, readFileSync(path, "utf8").replace(directCatalogPath(env).replace(/\\/g, "/"), catalogPath(env).replace(/\\/g, "/")));
    const result = switchCodexRoute("direct", { env, nodePath: "C:\\node.exe", cliPath: "C:\\proxy\\momoapi-proxy.mjs" });
    const content = readFileSync(result.config, "utf8");
    assert.doesNotMatch(content, /^model_catalog_json\s*=/m);
    assert.equal(codexRouteStatus(env).catalogConsistent, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("route CLI completes direct, proxy, status, and restore in an isolated profile", () => {
  const { root, env } = fixture();
  try {
    const run = (...args) => spawnSync(process.execPath, [cliPath, "route", ...args], { env, encoding: "utf8" });
    assert.equal(run("direct").status, 0);
    assert.equal(JSON.parse(run("status").stdout).mode, "direct");
    assert.equal(run("proxy").status, 0);
    assert.equal(JSON.parse(run("status").stdout).mode, "proxy");
    assert.equal(run("restore").status, 0);
    assert.match(readFileSync(join(env.CODEX_HOME, "config.toml"), "utf8"), /model_provider = "Codex"/);
    const allConfig = readFileSync(join(env.CODEX_HOME, "config.toml"), "utf8");
    assert.doesNotMatch(allConfig, /upstream-secret|local-secret/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
