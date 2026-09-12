import { spawnSync, spawn } from "node:child_process";
import { writeFileSync, readFileSync, copyFileSync, existsSync, mkdirSync, unlinkSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { TRAY_EXE_BASE64 } from "./tray-binary.mjs";
import { APP_ICO_BASE64 } from "./ico-binary.mjs";
import { migrateWindowsAutostart, WINDOWS_TRAY_STARTUP, LEGACY_WINDOWS_TRAY_STARTUP } from "./autostart.mjs";

function isWindowsProcessRunning(executable, spawnSyncImpl) {
  try {
    const res = spawnSyncImpl("powershell.exe", [
      "-NoProfile",
      "-Command",
      "Get-CimInstance Win32_Process -Filter \"Name = 'MomoApiProxyTray.exe'\" | Where-Object { $_.ExecutablePath -eq '" + executable.replace(/'/g, "''") + "' } | Select-Object -ExpandProperty ProcessId",
    ], { encoding: "utf8", windowsHide: true });
    return Boolean(res.stdout && res.stdout.trim());
  } catch {
    return false;
  }
}

export function installWindowsDesktop({ port = 18789, autostart = true, env = process.env, osPlatform = process.platform, spawnSyncImpl = spawnSync, spawnImpl = spawn } = {}) {
  if (osPlatform !== "win32") return { installed: false, reason: "not_windows" };
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid tray port.");
  const userHome = env.USERPROFILE || homedir();
  const proxyHome = join(userHome, ".momoapi-proxy");
  const proxyBinDir = join(proxyHome, "bin");
  mkdirSync(proxyBinDir, { recursive: true });

  const targetExe = join(proxyBinDir, "momoapi-proxy.exe");
  const targetTray = join(proxyBinDir, "MomoApiProxyTray.exe");
  const targetIco = join(proxyHome, "app.ico");

  // 1. Clean up legacy node.exe copy and only copy real compiled standalone binaries
  const isNodeRuntime = /node(\.exe)?$/i.test(process.execPath || "");
  if (existsSync(targetExe)) {
    try {
      const stats = statSync(targetExe);
      if (stats.size > 50 * 1024 * 1024) {
        unlinkSync(targetExe);
      }
    } catch {}
  }
  if (!isNodeRuntime && process.execPath && (!existsSync(targetExe) || process.execPath.toLowerCase() !== targetExe.toLowerCase())) {
    try {
      copyFileSync(process.execPath, targetExe);
    } catch {}
  }

  // 2. Extract embedded tray and true-alpha ICO binaries
  if (TRAY_EXE_BASE64) {
    const trayBytes = Buffer.from(TRAY_EXE_BASE64, "base64");
    if (!existsSync(targetTray) || !readFileSync(targetTray).equals(trayBytes)) {
      // Windows locks running executables. Stop only our installed tray before
      // replacement, never a similarly named process or the proxy daemon.
      const stopped = spawnSyncImpl("powershell.exe", [
        "-NoProfile", "-Command",
        "$ErrorActionPreference='Stop'; Get-CimInstance Win32_Process -Filter \"Name = 'MomoApiProxyTray.exe'\" | Where-Object { $_.ExecutablePath -eq '" + targetTray.replace(/'/g, "''") + "' } | ForEach-Object { $p=Get-Process -Id $_.ProcessId; $p.Kill(); $p.WaitForExit() }",
      ], { encoding: "utf8", windowsHide: true, timeout: 15000 });
      if (stopped.error || stopped.status !== 0) throw new Error("Could not stop the installed MOMO API Proxy tray for replacement.");
      writeFileSync(targetTray, trayBytes);
    }
  }

  if (APP_ICO_BASE64) {
    try {
      writeFileSync(targetIco, Buffer.from(APP_ICO_BASE64, "base64"));
    } catch {}
  }

  // 3. Create Desktop, Start Menu and Startup Shortcuts with explicit IconLocation
  const desktopDir = join(userHome, "Desktop");
  const startMenuDir = join(env.APPDATA || join(userHome, "AppData", "Roaming"), "Microsoft", "Windows", "Start Menu", "Programs");
  const startupDir = join(startMenuDir, "Startup");

  const desktopLnk = join(desktopDir, "MOMO API Proxy.lnk");
  const startMenuLnk = join(startMenuDir, "MOMO API Proxy.lnk");
  const startupLnk = join(startupDir, WINDOWS_TRAY_STARTUP);
  const startupMigration = migrateWindowsAutostart({ env });
  if (startupMigration.conflicts.length) throw new Error("Both legacy and current MOMO startup entries exist; resolve the conflict before reinstalling.");

  const targetForShortcut = existsSync(targetTray) ? targetTray : targetExe;

  // Remove old shortcuts to force Windows to clear icon cache
  try { if (existsSync(desktopLnk)) unlinkSync(desktopLnk); } catch {}
  try { if (existsSync(startMenuLnk)) unlinkSync(startMenuLnk); } catch {}

  const psScript = `
$WshShell = New-Object -ComObject WScript.Shell
function Make-Lnk($Path, $Target, $Desc, $Icon) {
  $Shortcut = $WshShell.CreateShortcut($Path)
  $Shortcut.TargetPath = $Target
  $Shortcut.Description = $Desc
  $Shortcut.Arguments = '-p ${Number(port)}'
  if ($Icon -and (Test-Path $Icon)) {
    $Shortcut.IconLocation = "$Icon,0"
  }
  $Shortcut.Save()
}
if (Test-Path '${desktopDir.replace(/'/g, "''")}') {
  Make-Lnk '${desktopLnk.replace(/'/g, "''")}' '${targetForShortcut.replace(/'/g, "''")}' 'MOMO API Proxy Desktop Companion' '${targetIco.replace(/'/g, "''")}'
}
if (Test-Path '${startMenuDir.replace(/'/g, "''")}') {
  Make-Lnk '${startMenuLnk.replace(/'/g, "''")}' '${targetForShortcut.replace(/'/g, "''")}' 'MOMO API Proxy' '${targetIco.replace(/'/g, "''")}'
}
if ($${autostart ? "true" : "false"} -and (Test-Path '${startupDir.replace(/'/g, "''")}')) {
  Make-Lnk '${startupLnk.replace(/'/g, "''")}' '${targetForShortcut.replace(/'/g, "''")}' 'MOMO API Proxy Tray Companion' '${targetIco.replace(/'/g, "''")}'
}
`;

  const shortcuts = spawnSyncImpl("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", "$ErrorActionPreference='Stop';" + psScript], { encoding: "utf8", windowsHide: true });
  if (shortcuts.error || shortcuts.status !== 0) throw new Error("Could not create MOMO API Proxy shortcuts.");

  if (!autostart) {
    for (const name of [WINDOWS_TRAY_STARTUP, LEGACY_WINDOWS_TRAY_STARTUP]) {
      const path = join(startupDir, name);
      if (existsSync(path)) unlinkSync(path);
    }
  }

  // 4. Launch the installed companion only if it is not already running.
  let trayLaunched = false;
  if (existsSync(targetTray) && !isWindowsProcessRunning(targetTray, spawnSyncImpl)) {
    try {
      const p = spawnImpl(targetTray, ["-p", String(port)], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      p.unref();
      trayLaunched = true;
    } catch {}
  }

  return {
    installed: true,
    desktopShortcut: desktopLnk,
    startMenuShortcut: startMenuLnk,
    startupShortcut: startupLnk,
    trayPath: targetTray,
    trayLaunched,
    startupMigration,
  };
}
