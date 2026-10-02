import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installMacDesktop, controlMacService } from "../src/macos-desktop.mjs";
import { MACOS_LAUNCHD_LABEL } from "../src/autostart.mjs";

function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), "momo-mac-ui-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const source = join(home, "signed-fixture.app");
  mkdirSync(join(source, "Contents", "MacOS"), { recursive: true });
  writeFileSync(join(source, "Contents", "MacOS", "MomoMenuBar"), "test binary placeholder");
  return { home, source, env: { HOME: home } };
}
test("Mac companion is never compiled on the user's machine and missing signed assets are explicit", () => {
  assert.equal(installMacDesktop({ osPlatform: "win32" }).reason, "not_macos");
  assert.equal(installMacDesktop({ osPlatform: "darwin", source: "nonexistent-test-app" }).reason, "signed_app_unavailable");
});
test("only assessed prebuilt app installs and its UI launch agent is separate from daemon", (t) => {
  const { home, source, env } = fixture(t);
  const calls = [];
  const result = installMacDesktop({ env, source, osPlatform: "darwin", spawnSyncImpl(command, args) { calls.push([command, args]); return { status: 0 }; } });
  assert.equal(result.installed, true);
  assert.ok(calls.some(([command]) => command.endsWith("spctl")));
  assert.ok(calls.some(([command]) => command.endsWith("open")));
  const plist = readFileSync(join(home, "Library", "LaunchAgents", "us.momoapi.menu-bar.plist"), "utf8");
  assert.doesNotMatch(plist, /KeepAlive|serve|settings.json/);
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
  assert.throws(() => installMacDesktop({ env, source, osPlatform: "darwin", spawnSyncImpl: (cmd) => ({ status: cmd.endsWith("open") ? 1 : 0 }) }));
  assert.equal(readFileSync(join(target, "previous"), "utf8"), "keep"); assert.equal(existsSync(unrelated), true);
});
test("Mac service actions target the exact managed LaunchAgent rather than port-owner kills", (t) => {
  const { home, env } = fixture(t);
  const plist = join(home, "Library", "LaunchAgents", MACOS_LAUNCHD_LABEL + ".plist");
  mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true }); writeFileSync(plist, "fixture");
  const calls = [];
  for (const action of ["start", "stop", "restart"]) controlMacService(action, { env, userId: 501, spawnSyncImpl: (cmd, args) => { calls.push([cmd, args]); return { status: 0 }; } });
  assert.deepEqual(calls[0], ["/bin/launchctl", ["bootstrap", "gui/501", plist]]);
  assert.deepEqual(calls[1], ["/bin/launchctl", ["bootout", "gui/501", plist]]);
  assert.deepEqual(calls[2], ["/bin/launchctl", ["kickstart", "-k", "gui/501/" + MACOS_LAUNCHD_LABEL]]);
});
