import { spawnSync, spawn } from "node:child_process";
import { writeFileSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { TRAY_EXE_BASE64 } from "./tray-binary.mjs";

function isWindowsProcessRunning(pattern) {
  if (process.platform !== "win32") return false;
  try {
    const wql = "CommandLine LIKE '%" + pattern.replace(/'/g, "''") + "%' OR Name LIKE '%" + pattern.replace(/'/g, "''") + "%'";
    const res = spawnSync("powershell.exe", [
      "-NoProfile",
      "-Command",
      "Get-CimInstance Win32_Process -Filter \"" + wql + "\" -ErrorAction SilentlyContinue | Select-Object -ExpandProperty ProcessId",
    ], { encoding: "utf8" });
    return Boolean(res.stdout && res.stdout.trim());
  } catch {
    return false;
  }
}

export function installWindowsDesktop({ port = 18789, env = process.env } = {}) {
  if (process.platform !== "win32") return { installed: false, reason: "not_windows" };
  const userHome = env.USERPROFILE || homedir();
  const proxyBinDir = join(userHome, ".momoapi-proxy", "bin");
  mkdirSync(proxyBinDir, { recursive: true });

  const targetExe = join(proxyBinDir, "momoapi-proxy.exe");
  const targetTray = join(proxyBinDir, "MomoApiProxyTray.exe");

  // 1. Copy current running exe to permanent app directory
  if (process.execPath && (!existsSync(targetExe) || process.execPath.toLowerCase() !== targetExe.toLowerCase())) {
    try {
      copyFileSync(process.execPath, targetExe);
    } catch {}
  }

  // 2. Extract embedded tray executable
  if (TRAY_EXE_BASE64) {
    try {
      writeFileSync(targetTray, Buffer.from(TRAY_EXE_BASE64, "base64"));
    } catch {}
  }

  // 3. Create Desktop, Start Menu and Startup Shortcuts
  const desktopDir = join(userHome, "Desktop");
  const startMenuDir = join(env.APPDATA || join(userHome, "AppData", "Roaming"), "Microsoft", "Windows", "Start Menu", "Programs");
  const startupDir = join(startMenuDir, "Startup");

  const desktopLnk = join(desktopDir, "MOMO API Proxy.lnk");
  const startMenuLnk = join(startMenuDir, "MOMO API Proxy.lnk");
  const startupLnk = join(startupDir, "momoapi-proxy-tray.lnk");

  const targetForShortcut = existsSync(targetTray) ? targetTray : targetExe;

  const psScript = `
$WshShell = New-Object -ComObject WScript.Shell
function Make-Lnk($Path, $Target, $Desc) {
  $Shortcut = $WshShell.CreateShortcut($Path)
  $Shortcut.TargetPath = $Target
  $Shortcut.Description = $Desc
  $Shortcut.Save()
}
if (Test-Path '${desktopDir.replace(/'/g, "''")}') {
  Make-Lnk '${desktopLnk.replace(/'/g, "''")}' '${targetForShortcut.replace(/'/g, "''")}' 'MOMO API Proxy Desktop Companion'
}
if (Test-Path '${startMenuDir.replace(/'/g, "''")}') {
  Make-Lnk '${startMenuLnk.replace(/'/g, "''")}' '${targetForShortcut.replace(/'/g, "''")}' 'MOMO API Proxy'
}
if (Test-Path '${startupDir.replace(/'/g, "''")}') {
  Make-Lnk '${startupLnk.replace(/'/g, "''")}' '${targetForShortcut.replace(/'/g, "''")}' 'MOMO API Proxy Tray Companion'
}
`;

  try {
    spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", psScript], { stdio: "ignore" });
  } catch {}

  // 4. Launch Native Tray Companion
  let trayLaunched = false;
  if (existsSync(targetTray)) {
    try {
      const isRunning = isWindowsProcessRunning("MomoApiProxyTray.exe");
      if (!isRunning) {
        const p = spawn(targetTray, ["-p", String(port)], {
          detached: true,
          stdio: "ignore",
          windowsHide: false,
        });
        p.unref();
        trayLaunched = true;
      } else {
        trayLaunched = true;
      }
    } catch {}
  }

  return {
    installed: true,
    desktopShortcut: desktopLnk,
    startMenuShortcut: startMenuLnk,
    startupShortcut: startupLnk,
    trayPath: targetTray,
    trayLaunched,
  };
}
