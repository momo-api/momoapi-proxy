import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMomoSwitch } from "../src/server.mjs";
import { readSettings, writeSettings, updateSettings, lockSettings, resolveDaemonSettings } from "../src/config.mjs";
import { rotateApiKey, validateApiKey } from "../src/credentials.mjs";

function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), "momo-key-test-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const env = { MOMO_PROXY_HOME: home, MOMO_PROXY_CONSOLE_MIRROR: "0" };
  const original = { apiKey: "previous-test-credential", localToken: "stable-test-local-token", endpoint: "https://momoapi.us", port: 19999,
    updateMode: "manual", autostart: false, arbitraryPreference: { enabled: false } };
  writeSettings(original, env);
  return { home, env, original };
}
const accepted = async (_url, options) => {
  assert.equal(options.redirect, "error");
  return new Response("{}", { status: 200 });
};

test("rotation preserves every non-Key field and saved credential wins over stale env", async (t) => {
  const { env, home, original } = fixture(t);
  const runtime = { ...original };
  assert.deepEqual(await rotateApiKey("new-test-credential", { env, runtimeSettings: runtime, fetchImpl: accepted }), { ok: true, runtime: "reloaded" });
  assert.deepEqual(readSettings(env), { ...original, apiKey: "new-test-credential" });
  assert.equal(runtime.apiKey, "new-test-credential");
  assert.equal(resolveDaemonSettings({ ...env, MOMO_API_KEY: "stale" }).apiKey, "new-test-credential");
  assert.deepEqual(readdirSync(home), ["settings.json"]);
});

for (const [status, code] of [[401, "key_invalid"], [403, "key_forbidden"], [429, "key_rate_limited"], [500, "key_upstream_error"]]) {
  test(`validation ${status} leaves saved and runtime Key untouched; never echoes upstream body`, async (t) => {
    const { env, original } = fixture(t);
    const runtime = { ...original };
    await assert.rejects(rotateApiKey("new-test-credential", { env, runtimeSettings: runtime,
      fetchImpl: async () => new Response("new-test-credential", { status }) }), (e) => e.code === code && !e.message.includes("new-test-credential"));
    assert.deepEqual(readSettings(env), original);
    assert.equal(runtime.apiKey, original.apiKey);
  });
}

test("network and timeout failures are sanitized, not invalid-Key findings", async (t) => {
  const { env, original } = fixture(t);
  for (const name of ["TypeError", "TimeoutError"]) {
    await assert.rejects(rotateApiKey("new-test-credential", { env, fetchImpl: async () => { throw Object.assign(new Error("new-test-credential"), { name }); } }),
      (e) => e.code === (name === "TimeoutError" ? "key_timeout" : "key_network_error") && !e.message.includes("new-test-credential"));
  }
  assert.deepEqual(readSettings(env), original);
});

test("foreign endpoints, userinfo, paths and redirects cannot receive a candidate Key", async () => {
  for (const endpoint of ["http://momoapi.us", "https://evil.invalid", "https://momoapi.us/path", "https://user:pass@momoapi.us"]) {
    await assert.rejects(validateApiKey("new-test-credential", { endpoint, fetchImpl: () => assert.fail("must not fetch") }), (e) => e.code === "key_endpoint_untrusted");
  }
});

test("activation failure rolls back disk and runtime without a secret backup", async (t) => {
  const { env, original, home } = fixture(t);
  const runtime = { ...original };
  await assert.rejects(rotateApiKey("new-test-credential", { env, runtimeSettings: runtime, fetchImpl: accepted,
    activate: async (key) => { if (key !== original.apiKey) throw new Error("candidate secret"); } }), (e) => e.code === "key_activation_failed");
  assert.deepEqual(readSettings(env), original);
  assert.deepEqual(runtime, original);
  assert.deepEqual(readdirSync(home), ["settings.json"]);
});

test("deferred activation never publishes candidate to runtime on failure", async (t) => {
  const { env, original } = fixture(t);
  const runtime = { ...original };
  let rejectActivation, entered;
  const ready = new Promise((r) => { entered = r; });
  const operation = rotateApiKey("new-test-credential", { env, runtimeSettings: runtime, fetchImpl: accepted, activate: (key) => {
    if (key === original.apiKey) return;
    entered(); return new Promise((_r, reject) => { rejectActivation = reject; });
  } });
  const checked = assert.rejects(operation, (error) => error.code === "key_activation_failed");
  await ready;
  assert.equal(runtime.apiKey, original.apiKey);
  rejectActivation(new Error("activation failed"));
  await checked;
  assert.deepEqual(readSettings(env), original);
});

test("all configuration writers share a lock and metadata patches keep the latest Key", async (t) => {
  const { env, original } = fixture(t);
  const release = lockSettings(env);
  assert.throws(() => writeSettings(original, env), (e) => e.code === "settings_busy");
  assert.throws(() => updateSettings({ lastSyncStatus: "ok" }, env), (e) => e.code === "settings_busy");
  await assert.rejects(rotateApiKey("new-test-credential", { env, fetchImpl: accepted }), (e) => e.code === "settings_busy");
  release();
  await rotateApiKey("new-test-credential", { env, fetchImpl: accepted });
  updateSettings({ lastSyncStatus: "ok" }, env);
  assert.equal(readSettings(env).apiKey, "new-test-credential");
});

test("legacy writes explicitly migrate without modifying the old source", (t) => {
  const home = mkdtempSync(join(tmpdir(), "momo-key-legacy-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const legacy = join(home, ".momo-codex-bridge", "settings.json");
  mkdirSync(join(home, ".momo-codex-bridge"));
  writeFileSync(legacy, JSON.stringify({ apiKey: "legacy-test", localToken: "legacy-local" }));
  const env = { HOME: home };
  updateSettings({ lastSyncStatus: "ok" }, env);
  assert.equal(existsSync(join(home, ".momoapi-proxy", "settings.json")), true);
  assert.deepEqual(JSON.parse(readFileSync(legacy)), { apiKey: "legacy-test", localToken: "legacy-local" });
  assert.equal(readSettings(env).localToken, "legacy-local");
});

test("authenticated native loopback rotation reloads future upstream requests and has no CORS", async (t) => {
  const { env, original } = fixture(t);
  const keys = [];
  const server = createMomoSwitch(original, { env, fetchImpl: async (url, options) => { keys.push(options.headers.authorization); return new Response('{"data":[]}'); } });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(r)));
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(base + "/internal/capabilities")).status, 403);
  assert.equal((await fetch(base + "/internal/capabilities", { headers: { "x-local-token": original.localToken, origin: "https://foreign.invalid" } })).status, 403);
  const capabilities = await fetch(base + "/internal/capabilities", { headers: { "x-local-token": original.localToken } });
  assert.equal(capabilities.status, 200);
  assert.equal((await capabilities.json()).apiKeyChange, true);
  const request = (headers, body = { apiKey: "new-test-credential" }) => fetch(base + "/internal/settings/api-key", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  assert.equal((await request({})).status, 403);
  assert.equal((await request({ "x-local-token": original.localToken, origin: "https://evil.invalid" })).status, 403);
  assert.equal((await request({ "x-local-token": original.localToken }, null)).status, 400);
  assert.equal((await request({ "x-local-token": original.localToken }, { apiKey: "a".repeat(10000) })).status, 413);
  const changed = await request({ "x-local-token": original.localToken });
  assert.equal(changed.status, 200);
  assert.equal(changed.headers.get("access-control-allow-origin"), null);
  assert.deepEqual(await changed.json(), { ok: true, runtime: "reloaded" });
  const models = await fetch(base + "/v1/models", { headers: { authorization: "Bearer " + original.localToken } });
  assert.equal(models.status, 200); await models.text();
  assert.equal(keys.at(-1), "Bearer new-test-credential");
});

test("an in-flight request keeps its credential snapshot while future requests use rotated Key", async (t) => {
  const { env, original } = fixture(t);
  const keys = [];
  let entered, finish;
  const active = new Promise((resolve) => { entered = resolve; });
  const server = createMomoSwitch(original, { env, fetchImpl: async (_url, options) => {
    const key = options.headers.authorization;
    keys.push(key);
    if (key === "Bearer " + original.apiKey) {
      entered(); await new Promise((resolve) => { finish = resolve; });
    }
    return new Response('{"data":[]}');
  } });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = 'http://127.0.0.1:' + server.address().port;
  const headers = { authorization: "Bearer " + original.localToken };
  const pending = fetch(base + "/v1/models", { headers });
  await active;
  const changed = await fetch(base + "/internal/settings/api-key", { method: "POST", headers: { "x-local-token": original.localToken }, body: JSON.stringify({ apiKey: "new-test-credential" }) });
  assert.equal(changed.status, 200); await changed.text();
  finish();
  const prior = await pending; assert.equal(prior.status, 200); await prior.text();
  const next = await fetch(base + "/v1/models", { headers }); await next.text();
  assert.deepEqual(keys, ["Bearer " + original.apiKey, "Bearer new-test-credential", "Bearer new-test-credential"]);
});
