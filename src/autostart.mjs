import { existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BIN_PATH = join(__dirname, "..", "bin", "momoapi-proxy.mjs");
export const WINDOWS_SERVICE_STARTUP = "MOMO API Proxy Service.cmd";
export const WINDOWS_TRAY_STARTUP = "MOMO API Proxy Tray.lnk";
export const LEGACY_WINDOWS_SERVICE_STARTUP = "momo-codex-bridge.cmd";
export const LEGACY_WINDOWS_TRAY_STARTUP = "momoapi-proxy-tray.lnk";

export function autostartTarget(osPlatform = platform(), env = process.env) {
  if (osPlatform === "win32") {
    const appData = env.APPDATA || (env.USERPROFILE ? join(env.USERPROFILE, "AppData", "Roaming") : join(homedir(), "AppData", "Roaming"));
    return join(appData, "Microsoft", "Windows", "Start Menu", "Programs", "Startup", WINDOWS_SERVICE_STARTUP);
  }
  if (osPlatform === "darwin") {
    const home = env.HOME || homedir();
    return join(home, "Library", "LaunchAgents", "us.momoapi.codex-bridge.plist");
  }
  const home = env.HOME || homedir();
  return join(home, ".config", "systemd", "user", "momo-codex-bridge.service");
}

export function isAutostartInstalled(osPlatform = platform(), env = process.env) {
  const target = autostartTarget(osPlatform, env);
  return existsSync(target) || (osPlatform === "win32" && existsSync(join(dirname(target), LEGACY_WINDOWS_SERVICE_STARTUP)));
}

// Rename only known startup entries, preserving their data and enabled state.
// An existing destination is a conflict, never an invitation to overwrite it.
export function migrateWindowsAutostart({ env = process.env, migrateApproval = copyStartupApproval } = {}) {
  const directory = dirname(autostartTarget("win32", env));
  const migrated = [];
  const conflicts = [];
  for (const [legacy, current] of [
    [LEGACY_WINDOWS_SERVICE_STARTUP, WINDOWS_SERVICE_STARTUP],
    [LEGACY_WINDOWS_TRAY_STARTUP, WINDOWS_TRAY_STARTUP],
  ]) {
    const source = join(directory, legacy);
    const target = join(directory, current);
    if (!existsSync(source)) continue;
    if (existsSync(target)) { conflicts.push({ source, target }); continue; }
    migrateApproval(legacy, current, env);
    renameSync(source, target);
    migrated.push({ source, target });
  }
  return { migrated, conflicts };
}

function copyStartupApproval(legacy, current, env) {
  // A test/custom home must never change the logged-in user's registry.
  if (platform() !== "win32" || env.APPDATA !== process.env.APPDATA || env.USERPROFILE !== process.env.USERPROFILE) return;
  const script = "$ErrorActionPreference='Stop'; $key=Get-Item -LiteralPath 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\StartupFolder' -ErrorAction SilentlyContinue; "
    + "if($key -and $key.GetValueNames().Contains('" + legacy + "') -and -not $key.GetValueNames().Contains('" + current + "')) { New-ItemProperty -LiteralPath $key.PSPath -Name '" + current + "' -PropertyType Binary -Value $key.GetValue('" + legacy + "') | Out-Null }";
  const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", script], { encoding: "utf8", windowsHide: true, timeout: 10000 });
  if (result.error || result.status !== 0) throw new Error("Could not preserve the Windows startup approval state.");
}

export function installAutostart(settings, { osPlatform = platform(), env = process.env } = {}) {
  const target = autostartTarget(osPlatform, env);
  mkdirSync(dirname(target), { recursive: true });

  if (osPlatform === "win32") {
    const migration = migrateWindowsAutostart({ env });
    if (migration.conflicts.length) throw new Error("Both legacy and current MOMO startup entries exist; resolve the conflict before reinstalling.");
    const script = "@echo off\r\nstart \"\" /B node \"" + BIN_PATH + "\" serve > nul 2>&1\r\n";
    writeFileSync(target, script);
    const legacy = join(dirname(target), LEGACY_WINDOWS_SERVICE_STARTUP);
    if (existsSync(legacy)) unlinkSync(legacy);
    return { installed: true, target, type: "startup_script" };
  }

  if (osPlatform === "darwin") {
    const plist = '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n  <key>Label</key>\n  <string>us.momoapi.codex-bridge</string>\n  <key>ProgramArguments</key>\n  <array>\n    <string>node</string>\n    <string>' + BIN_PATH + '</string>\n    <string>serve</string>\n  </array>\n  <key>RunAtLoad</key>\n  <true/>\n  <key>KeepAlive</key>\n  <true/>\n</dict>\n</plist>\n';
    writeFileSync(target, plist);
    return { installed: true, target, type: "launchd_plist" };
  }

  const service = "[Unit]\nDescription=MOMO Codex Bridge\nAfter=network.target\n\n[Service]\nType=simple\nExecStart=node " + BIN_PATH + " serve\nRestart=always\nRestartSec=5\n\n[Install]\nWantedBy=default.target\n";
  writeFileSync(target, service);
  return { installed: true, target, type: "systemd_service" };
}

export function uninstallAutostart({ osPlatform = platform(), env = process.env } = {}) {
  const target = autostartTarget(osPlatform, env);
  const targets = osPlatform === "win32"
    ? [target, join(dirname(target), LEGACY_WINDOWS_SERVICE_STARTUP)] : [target];
  let uninstalled = false;
  for (const entry of targets) {
    if (existsSync(entry)) { unlinkSync(entry); uninstalled = true; }
  }
  return { uninstalled, target };
}
