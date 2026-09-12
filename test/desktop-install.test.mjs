import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { installWindowsDesktop } from "../src/desktop-install.mjs";
import { TRAY_EXE_BASE64 } from "../src/tray-binary.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "momo-desktop-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { USERPROFILE: root, APPDATA: join(root, "Roaming") };
  const bin = join(root, ".momoapi-proxy", "bin");
  mkdirSync(bin, { recursive: true });
  return { env, target: join(bin, "MomoApiProxyTray.exe") };
}

test("desktop install stops the exact locked tray before replacement and passes the configured port", (t) => {
  const { env, target } = fixture(t);
  writeFileSync(target, "old locked executable");
  const scripts = [];
  let launches = 0;
  const result = installWindowsDesktop({ env, port: 19999, osPlatform: "win32",
    spawnSyncImpl(command, args) {
      const script = args.at(-1);
      scripts.push(script);
      if (script.includes(".Kill()")) {
        assert.equal(readFileSync(target, "utf8"), "old locked executable");
        assert.match(script, /ExecutablePath -eq/);
        assert.ok(script.includes(target));
        assert.doesNotMatch(script, /CommandLine LIKE/);
      }
      return { status: 0, stdout: "" };
    },
    spawnImpl(path, args, opts) {
      launches++;
      assert.equal(path, target);
      assert.deepEqual(readFileSync(path), Buffer.from(TRAY_EXE_BASE64, "base64"));
      assert.deepEqual(args, ["-p", "19999"]);
      assert.equal(opts.windowsHide, true);
      return { unref() {} };
    },
  });
  assert.equal(launches, 1);
  assert.equal(result.trayLaunched, true);
  assert.match(result.startupShortcut, /MOMO API Proxy Tray\.lnk$/);
  assert.ok(scripts.some((script) => script.includes("$Shortcut.Arguments = '-p 19999'")));
});

test("desktop install does not kill or relaunch an identical running tray", (t) => {
  const { env, target } = fixture(t);
  writeFileSync(target, Buffer.from(TRAY_EXE_BASE64, "base64"));
  const result = installWindowsDesktop({ env, osPlatform: "win32",
    spawnSyncImpl(command, args) {
      assert.doesNotMatch(args.at(-1), /\.Kill\(\)/);
      return { status: 0, stdout: args.at(-1).includes("Select-Object -ExpandProperty ProcessId") ? "123" : "" };
    },
    spawnImpl() { assert.fail("unchanged running tray must not restart"); },
  });
  assert.equal(result.trayLaunched, false);
});

test("desktop replacement failure is surfaced without overwriting the old executable", (t) => {
  const { env, target } = fixture(t);
  writeFileSync(target, "old executable");
  assert.throws(() => installWindowsDesktop({ env, osPlatform: "win32", spawnSyncImpl: () => ({ status: 1 }) }), /Could not stop/);
  assert.equal(readFileSync(target, "utf8"), "old executable");
});

test("desktop setup respects no-autostart", (t) => {
  const { env, target } = fixture(t);
  writeFileSync(target, Buffer.from(TRAY_EXE_BASE64, "base64"));
  let shortcutScript = "";
  const result = installWindowsDesktop({ env, osPlatform: "win32", autostart: false,
    spawnSyncImpl(command, args) { if (args.at(-1).includes("Make-Lnk")) shortcutScript = args.at(-1); return { status: 0, stdout: "123" }; },
  });
  assert.match(shortcutScript, /if \(\$false -and/);
  assert.equal(existsSync(result.startupShortcut), false);
});
