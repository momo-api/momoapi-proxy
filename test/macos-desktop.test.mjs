import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installMacDesktop, openMacDesktop, controlMacService, macRuntimePath } from "../src/macos-desktop.mjs";
import { MACOS_LAUNCHD_LABEL } from "../src/autostart.mjs";

function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), "momo-mac-ui-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const source = join(home, "signed-fixture.app");
  mkdirSync(join(source, "Contents", "MacOS"), { recursive: true });
  writeFileSync(join(source, "Contents", "MacOS", "MomoMenuBar"), "test binary placeholder");
  return { home, source, env: { HOME: home } };
}
function fakeMac(calls = [], { loaded = false, fail = () => false } = {}) {
  return (command, args) => {
    calls.push([command, args]);
    if (fail(command, args)) return { status: 1 };
    if (command.endsWith("launchctl")) {
      if (args[0] === "print") return { status: loaded ? 0 : 1 };
      if (args[0] === "bootstrap") loaded = true;
      if (args[0] === "bootout") loaded = false;
    }
    return { status: 0 };
  };
}
test("Mac companion is never compiled on the user's machine and missing signed assets are explicit", () => {
  assert.equal(installMacDesktop({ osPlatform: "win32" }).reason, "not_macos");
  assert.equal(installMacDesktop({ osPlatform: "darwin", source: "nonexistent-test-app" }).reason, "signed_app_unavailable");
});
test("only assessed prebuilt app installs and its UI launch agent is separate from daemon", (t) => {
  const { home, source, env } = fixture(t);
  const calls = [];
  const result = installMacDesktop({ env, source, osPlatform: "darwin", userId: 501, spawnSyncImpl: fakeMac(calls) });
  assert.equal(result.installed, true);
  assert.ok(calls.some(([command]) => command.endsWith("spctl")));
  assert.ok(calls.some(([command]) => command.endsWith("open")));
  const plist = readFileSync(join(home, "Library", "LaunchAgents", "us.momoapi.menu-bar.plist"), "utf8");
  assert.doesNotMatch(plist, /KeepAlive|serve|settings.json/);
  const runtime = JSON.parse(readFileSync(macRuntimePath(env)));
  assert.equal(runtime.node, process.execPath);
  assert.equal(runtime.schema, 1);
  assert.ok(calls.some(([command, args]) => command.endsWith("launchctl") && args[0] === "bootstrap"));
});
test("signature failure does not replace an existing app", (t) => {
  const { home, source, env } = fixture(t);
  const target = join(home, "Applications", "MOMO API Proxy.app");
  mkdirSync(target, { recursive: true }); writeFileSync(join(target, "previous"), "keep");
  assert.throws(() => installMacDesktop({ env, source, osPlatform: "darwin", spawnSyncImpl: () => ({ status: 1 }) }), /verification/);
  assert.equal(readFileSync(join(target, "previous"), "utf8"), "keep");
});
test("open failure restores existing app and does not delete unrelated application files", (t) => {
  const { home, source, env } = fixture(t);
  const target = join(home, "Applications", "MOMO API Proxy.app");
  mkdirSync(target, { recursive: true }); writeFileSync(join(target, "previous"), "keep");
  const unrelated = join(home, "Applications", "unrelated.txt"); writeFileSync(unrelated, "keep");
  assert.throws(() => installMacDesktop({ env, source, osPlatform: "darwin", userId: 501, spawnSyncImpl: fakeMac([], { fail: (cmd) => cmd.endsWith("open") }) }));
  assert.equal(readFileSync(join(target, "previous"), "utf8"), "keep"); assert.equal(existsSync(unrelated), true);
  assert.equal(existsSync(macRuntimePath(env)), false);
});

test("runtime descriptor contains only pinned non-secret paths, including custom home", (t) => {
  const { home, source, env } = fixture(t);
  env.MOMO_PROXY_HOME = join(home, "custom-home");
  env.MOMO_API_KEY = "must-not-serialize-test";
  installMacDesktop({ env, source, osPlatform: "darwin", userId: 501, nodePath: join(home, "custom-node"), cliPath: join(home, "legacy-app", "cli.mjs"), spawnSyncImpl: fakeMac() });
  assert.deepEqual(JSON.parse(readFileSync(macRuntimePath(env))), { schema: 1, node: join(home, "custom-node"), cli: join(home, "legacy-app", "cli.mjs"), appHome: env.MOMO_PROXY_HOME });
});

test("post-swap login activation failure restores app, agent and descriptor", (t) => {
  const { home, source, env } = fixture(t);
  const options = { env, source, osPlatform: "darwin", userId: 501 };
  installMacDesktop({ ...options, spawnSyncImpl: fakeMac() });
  const target = join(home, "Applications", "MOMO API Proxy.app");
  writeFileSync(join(target, "previous"), "keep");
  const agent = join(home, "Library", "LaunchAgents", "us.momoapi.menu-bar.plist");
  const oldAgent = readFileSync(agent), oldRuntime = readFileSync(macRuntimePath(env));
  let bootstraps = 0;
  const calls = [];
  assert.throws(() => installMacDesktop({ ...options, cliPath: join(home, "new-cli.mjs"), spawnSyncImpl: fakeMac(calls, { loaded: true, fail: (cmd, args) => cmd.endsWith("launchctl") && args[0] === "bootstrap" && ++bootstraps === 1 }) }));
  assert.equal(readFileSync(join(target, "previous"), "utf8"), "keep");
  assert.deepEqual(readFileSync(agent), oldAgent);
  assert.deepEqual(readFileSync(macRuntimePath(env)), oldRuntime);
  assert.equal(bootstraps, 2);
});

test("ordinary Mac desktop open does not reinstall or modify runtime files", (t) => {
  const { source, env } = fixture(t);
  installMacDesktop({ env, source, osPlatform: "darwin", userId: 501, spawnSyncImpl: fakeMac() });
  const before = readFileSync(macRuntimePath(env));
  const calls = [];
  assert.equal(openMacDesktop({ env, spawnSyncImpl: fakeMac(calls) }).opened, true);
  assert.deepEqual(calls.map(([cmd]) => cmd), ["/usr/bin/open"]);
  assert.deepEqual(readFileSync(macRuntimePath(env)), before);
});
test("Mac service actions target the exact managed LaunchAgent rather than port-owner kills", (t) => {
  const { home, env } = fixture(t);
  const plist = join(home, "Library", "LaunchAgents", MACOS_LAUNCHD_LABEL + ".plist");
  mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true }); writeFileSync(plist, "fixture");
  const calls = [];
  for (const action of ["start", "stop", "restart"]) controlMacService(action, { env, userId: 501, spawnSyncImpl: (cmd, args) => { calls.push([cmd, args]); return { status: args[0] === "print" && action === "start" ? 1 : 0 }; } });
  const mutations = calls.filter(([, args]) => args[0] !== "print");
  assert.deepEqual(mutations[0], ["/bin/launchctl", ["bootstrap", "gui/501", plist]]);
  assert.deepEqual(mutations[1], ["/bin/launchctl", ["bootout", "gui/501", plist]]);
  assert.deepEqual(mutations[2], ["/bin/launchctl", ["kickstart", "-k", "gui/501/" + MACOS_LAUNCHD_LABEL]]);
});
