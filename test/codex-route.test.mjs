import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { codexRouteStatus, readCodexCredential, restoreCodexRoute, switchCodexRoute } from "../src/codex-route.mjs";

const cliPath = fileURLToPath(new URL("../bin/momoapi-proxy.mjs", import.meta.url));

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "momo-codex-route-"));
  const env = { ...process.env, HOME: root, USERPROFILE: root, CODEX_HOME: join(root, ".codex"), MOMO_PROXY_HOME: join(root, ".proxy") };
  mkdirSync(env.CODEX_HOME, { recursive: true });
  mkdirSync(env.MOMO_PROXY_HOME, { recursive: true });
  writeFileSync(join(env.CODEX_HOME, "config.toml"), 'model_provider = "Codex"\nmodel = "gpt-5.6-luna"\n\n[model_providers.Codex]\nbase_url = "https://momoapi.us/v1"\nwire_api = "responses"\nrequires_openai_auth = true\n');
  writeFileSync(join(env.CODEX_HOME, "auth.json"), '{"OPENAI_API_KEY":"synthetic-auth-value"}\n');
  writeFileSync(join(env.MOMO_PROXY_HOME, "settings.json"), JSON.stringify({ endpoint: "https://momoapi.us", port: 18789, apiKey: "upstream-secret", localToken: "local-secret" }));
  return { root, env };
}

test("Codex route switches without changing auth or unrelated config", () => {
  const { root, env } = fixture();
  try {
    const direct = switchCodexRoute("direct", { env, nodePath: "C:\\node.exe", cliPath: "C:\\proxy\\momoapi-proxy.mjs" });
    assert.equal(direct.mode, "direct");
    let content = readFileSync(direct.config, "utf8");
    assert.match(content, /model_provider = "momo-route"/);
    assert.match(content, /base_url = "https:\/\/momoapi.us\/v1"/);
    assert.match(content, /"credential", "upstream"/);
    assert.match(content, /model = "gpt-5.6-luna"/);
    assert.doesNotMatch(content, /upstream-secret|local-secret/);
    assert.equal(codexRouteStatus(env).mode, "direct");

    const proxy = switchCodexRoute("proxy", { env, nodePath: "C:\\node.exe", cliPath: "C:\\proxy\\momoapi-proxy.mjs" });
    content = readFileSync(proxy.config, "utf8");
    assert.match(content, /base_url = "http:\/\/127.0.0.1:18789\/v1"/);
    assert.match(content, /"credential", "local"/);
    assert.equal((content.match(/MOMOAPI_ROUTE_MANAGED_BEGIN/g) || []).length, 1);
    assert.equal(codexRouteStatus(env).mode, "proxy");
    assert.ok(existsSync(proxy.rollback));
    assert.equal(readFileSync(join(env.CODEX_HOME, "auth.json"), "utf8"), '{"OPENAI_API_KEY":"synthetic-auth-value"}\n');

    const restored = restoreCodexRoute(env);
    assert.equal(restored.mode, "direct");
    assert.match(readFileSync(restored.restored, "utf8"), /model_provider = "Codex"/);
    assert.doesNotMatch(readFileSync(restored.restored, "utf8"), /MOMOAPI_ROUTE_MANAGED_BEGIN/);
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
