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
  const plist = installAutostart({}, { osPlatform: "darwin", env: { ...mac.env, HOME: mac.env.USERPROFILE } });
  assert.match(readFileSync(plist.target, "utf8"), /<key>MOMO_PROXY_CONSOLE_MIRROR<\/key><string>0<\/string>/);

  const wrapper = buildWindowsServiceWrapperCmd("C:\\app\\momoapi-proxy.mjs", "C:\\logs\\daemon.log");
  assert.match(wrapper, /set MOMO_PROXY_CONSOLE_MIRROR=0\r\n/);
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
