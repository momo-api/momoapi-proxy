import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { autostartTarget, installAutostart, isAutostartInstalled, migrateWindowsAutostart, uninstallAutostart, WINDOWS_SERVICE_STARTUP, WINDOWS_TRAY_STARTUP, LEGACY_WINDOWS_SERVICE_STARTUP, LEGACY_WINDOWS_TRAY_STARTUP } from "../src/autostart.mjs";
import { buildWindowsServiceWrapperCmd } from "../src/service.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "momo-startup-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { USERPROFILE: root, APPDATA: join(root, "Roaming") };
  const dir = dirname(autostartTarget("win32", env));
  mkdirSync(dir, { recursive: true });
  return { env, dir };
}

test("Windows startup migration preserves both files and is idempotent", (t) => {
  const { env, dir } = fixture(t);
  writeFileSync(join(dir, LEGACY_WINDOWS_SERVICE_STARTUP), "original daemon command");
  writeFileSync(join(dir, LEGACY_WINDOWS_TRAY_STARTUP), Buffer.from([0, 1, 2, 255]));
  assert.equal(isAutostartInstalled("win32", env), true);
  assert.equal(migrateWindowsAutostart({ env }).migrated.length, 2);
  assert.equal(readFileSync(join(dir, WINDOWS_SERVICE_STARTUP), "utf8"), "original daemon command");
  assert.deepEqual(readFileSync(join(dir, WINDOWS_TRAY_STARTUP)), Buffer.from([0, 1, 2, 255]));
  assert.equal(existsSync(join(dir, LEGACY_WINDOWS_SERVICE_STARTUP)), false);
  assert.equal(existsSync(join(dir, LEGACY_WINDOWS_TRAY_STARTUP)), false);
  assert.deepEqual(migrateWindowsAutostart({ env }), { migrated: [], conflicts: [] });
});

test("Windows startup migration never overwrites conflicts or creates missing entries", (t) => {
  const { env, dir } = fixture(t);
  assert.deepEqual(migrateWindowsAutostart({ env }), { migrated: [], conflicts: [] });
  writeFileSync(join(dir, LEGACY_WINDOWS_SERVICE_STARTUP), "old");
  writeFileSync(join(dir, WINDOWS_SERVICE_STARTUP), "custom");
  assert.equal(migrateWindowsAutostart({ env }).conflicts.length, 1);
  assert.equal(readFileSync(join(dir, WINDOWS_SERVICE_STARTUP), "utf8"), "custom");
  assert.equal(readFileSync(join(dir, LEGACY_WINDOWS_SERVICE_STARTUP), "utf8"), "old");
  assert.equal(existsSync(join(dir, WINDOWS_TRAY_STARTUP)), false);
});

test("Windows install and uninstall use branded names and support legacy lifecycle", (t) => {
  const { env, dir } = fixture(t);
  writeFileSync(join(dir, LEGACY_WINDOWS_SERVICE_STARTUP), "legacy");
  const result = installAutostart({}, { osPlatform: "win32", env });
  assert.equal(result.target, join(dir, WINDOWS_SERVICE_STARTUP));
  assert.match(readFileSync(result.target, "utf8"), /momoapi-proxy\.mjs/);
  assert.match(readFileSync(result.target, "utf8"), /MOMO_PROXY_CONSOLE_MIRROR=0/);
  assert.equal(existsSync(join(dir, LEGACY_WINDOWS_SERVICE_STARTUP)), false);
  writeFileSync(join(dir, LEGACY_WINDOWS_SERVICE_STARTUP), "duplicate legacy");
  assert.equal(uninstallAutostart({ osPlatform: "win32", env }).uninstalled, true);
  assert.equal(isAutostartInstalled("win32", env), false);
});

test("background launchers explicitly disable request-log console mirroring", (t) => {
  const linux = fixture(t);
  const service = installAutostart({}, { osPlatform: "linux", env: { ...linux.env, HOME: linux.env.USERPROFILE } });
  assert.match(readFileSync(service.target, "utf8"), /Environment=MOMO_PROXY_CONSOLE_MIRROR=0/);

  const mac = fixture(t);
  const nodePath = "/opt/homebrew/bin/node";
  const plist = installAutostart({}, { osPlatform: "darwin", env: { ...mac.env, HOME: mac.env.USERPROFILE }, nodePath, activate: false });
  const plistContents = readFileSync(plist.target, "utf8");
  assert.match(plistContents, /<key>MOMO_PROXY_CONSOLE_MIRROR<\/key><string>0<\/string>/);
  assert.match(plistContents, /<string>\/opt\/homebrew\/bin\/node<\/string>/);
  assert.doesNotMatch(plistContents, /<string>node<\/string>/);
  assert.equal(plist.activated, false);

  const wrapper = buildWindowsServiceWrapperCmd("C:\\app\\momoapi-proxy.mjs", "C:\\logs\\daemon.log");
  assert.match(wrapper, /set MOMO_PROXY_CONSOLE_MIRROR=0\r\n/);
});

test("macOS autostart bootstraps the LaunchAgent for the current GUI user", (t) => {
  const mac = fixture(t);
  const calls = [];
  const result = installAutostart({}, {
    osPlatform: "darwin",
    env: { ...mac.env, HOME: mac.env.USERPROFILE },
    nodePath: "/Users/test/.nvm/versions/node/v24/bin/node",
    userId: 501,
    activate: true,
    spawnSyncImpl(command, args) {
      calls.push([command, args]);
      return { status: args[0] === "bootout" ? 113 : 0, stdout: "", stderr: "" };
    },
  });
  assert.equal(result.activated, true);
  assert.deepEqual(calls, [
    ["launchctl", ["bootout", "gui/501", result.target]],
    ["launchctl", ["bootstrap", "gui/501", result.target]],
  ]);
});

test("macOS autostart reports launchctl bootstrap failures", (t) => {
  const mac = fixture(t);
  assert.throws(() => installAutostart({}, {
    osPlatform: "darwin",
    env: { ...mac.env, HOME: mac.env.USERPROFILE },
    nodePath: "/usr/local/bin/node",
    userId: 502,
    activate: true,
    spawnSyncImpl(_command, args) {
      return args[0] === "bootstrap" ? { status: 5, stderr: "Input/output error" } : { status: 0, stderr: "" };
    },
  }), /Input\/output error/);
  assert.equal(existsSync(autostartTarget("darwin", { ...mac.env, HOME: mac.env.USERPROFILE })), false);
});

test("macOS autostart restores the previous plist when activation fails", (t) => {
  const mac = fixture(t);
  const env = { ...mac.env, HOME: mac.env.USERPROFILE };
  const target = autostartTarget("darwin", env);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, "previous plist");
  let bootstrapCalls = 0;
  assert.throws(() => installAutostart({}, {
    osPlatform: "darwin", env, nodePath: "/usr/local/bin/node", userId: 504, activate: true,
    spawnSyncImpl(_command, args) {
      if (args[0] === "bootstrap") bootstrapCalls += 1;
      return args[0] === "bootstrap" && bootstrapCalls === 1
        ? { status: 5, stderr: "new plist failed" }
        : { status: 0, stderr: "" };
    },
  }), /new plist failed/);
  assert.equal(readFileSync(target, "utf8"), "previous plist");
  assert.equal(bootstrapCalls, 2);
});

test("macOS uninstall unloads the LaunchAgent before removing it", (t) => {
  const mac = fixture(t);
  const env = { ...mac.env, HOME: mac.env.USERPROFILE };
  const installed = installAutostart({}, { osPlatform: "darwin", env, nodePath: "/usr/local/bin/node", activate: false });
  const calls = [];
  const removed = uninstallAutostart({
    osPlatform: "darwin", env, userId: 503, deactivate: true,
    spawnSyncImpl(command, args) { calls.push([command, args]); return { status: 0 }; },
  });
  assert.equal(removed.uninstalled, true);
  assert.deepEqual(calls, [["launchctl", ["bootout", "gui/503", installed.target]]]);
});

test("Windows migration preserves approval state before rename and aborts on failure", (t) => {
  const { env, dir } = fixture(t);
  const source = join(dir, LEGACY_WINDOWS_SERVICE_STARTUP);
  writeFileSync(source, "disabled startup command");
  assert.throws(() => migrateWindowsAutostart({ env, migrateApproval() { throw new Error("registry denied"); } }), /registry denied/);
  assert.equal(existsSync(source), true);
  assert.equal(existsSync(join(dir, WINDOWS_SERVICE_STARTUP)), false);
  const calls = [];
  migrateWindowsAutostart({ env, migrateApproval(legacy, current) { calls.push([legacy, current]); assert.equal(existsSync(source), true); } });
  assert.deepEqual(calls, [[LEGACY_WINDOWS_SERVICE_STARTUP, WINDOWS_SERVICE_STARTUP]]);
});
