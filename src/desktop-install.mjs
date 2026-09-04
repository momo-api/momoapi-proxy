import { spawnSync, spawn } from "node:child_process";
import { writeFileSync, copyFileSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { TRAY_EXE_BASE64 } from "./tray-binary.mjs";
import { APP_ICO_BASE64 } from "./ico-binary.mjs";

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
  const proxyHome = join(userHome, ".momoapi-proxy");
  const proxyBinDir = join(proxyHome, "bin");
  mkdirSync(proxyBinDir, { recursive: true });

  const targetExe = join(proxyBinDir, "momoapi-proxy.exe");
  const targetTray = join(proxyBinDir, "MomoApiProxyTray.exe");
  const targetIco = join(proxyHome, "app.ico");

  // 1. Copy current running exe to permanent app directory
  if (process.execPath && (!existsSync(targetExe) || process.execPath.toLowerCase() !== targetExe.toLowerCase())) {
    try {
      copyFileSync(process.execPath, targetExe);
    } catch {}
  }

  // 2. Extract embedded tray and true-alpha ICO binaries
  if (TRAY_EXE_BASE64) {
    try {
      writeFileSync(targetTray, Buffer.from(TRAY_EXE_BASE64, "base64"));
    } catch {}
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
  const startupLnk = join(startupDir, "momoapi-proxy-tray.lnk");

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
if (Test-Path '${startupDir.replace(/'/g, "''")}') {
  Make-Lnk '${startupLnk.replace(/'/g, "''")}' '${targetForShortcut.replace(/'/g, "''")}' 'MOMO API Proxy Tray Companion' '${targetIco.replace(/'/g, "''")}'
}
`;

  try {
    spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", psScript], { stdio: "ignore" });
  } catch {}

  // 4. Force restart Native Tray Companion with fresh binary
  let trayLaunched = false;
  if (existsSync(targetTray)) {
    try {
      const wql = "CommandLine LIKE '%tray.ps1%' OR Name LIKE '%MomoApiProxyTray%' OR Name LIKE '%momoapi-tray%'";
      spawnSync("powershell.exe", [
        "-NoProfile",
        "-Command",
        "Get-CimInstance Win32_Process -Filter \"" + wql + "\" -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
      ], { stdio: "ignore" });

      const p = spawn(targetTray, ["-p", String(port)], {
        detached: true,
        stdio: "ignore",
        windowsHide: false,
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
  };
}
