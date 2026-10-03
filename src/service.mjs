import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { appHome, userHome } from "./config.mjs";
import { getCurrentVersion } from "./updater.mjs";

const TASK_NAME = "momo-codex-bridge";

export function windowsTaskName(env = process.env) {
  if (!(env.MOMO_PROXY_HOME || env.MOMO_BRIDGE_HOME || env.MOMO_SWITCH_HOME)) return TASK_NAME;
  if (resolve(appHome(env)).toLowerCase() === resolve(join(userHome(env), ".momoapi-proxy")).toLowerCase()) return TASK_NAME;
  return `${TASK_NAME}-${createHash("sha256").update(appHome(env)).digest("hex").slice(0, 16)}`;
}

function xmlEscape(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

export function windowsCmdPath(value) {
  if (/["%\r\n]/.test(value)) throw new Error("Windows launcher paths cannot contain quotes, percent signs or newlines.");
  return value;
}

export function getRuntimePaths(env = process.env) {
  const dir = appHome(env);
  mkdirSync(dir, { recursive: true });
  return {
    homeDir: dir,
    runtimePortPath: join(dir, "runtime-port.json"),
    heartbeatPath: join(dir, "tray-heartbeat.json"),
    daemonLogPath: join(dir, "daemon.log"),
    serviceScriptPath: join(dir, "service-wrapper.cmd"),
    launcherVbsPath: join(dir, "service-launcher.vbs"),
    taskXmlPath: join(dir, "task-definition.xml"),
  };
}

export function writeRuntimePort(port, pid, extra = {}, env = process.env) {
  const { runtimePortPath } = getRuntimePaths(env);
  const data = {
    port,
    pid,
    version: getCurrentVersion(),
    startedAt: new Date().toISOString(),
    ...extra,
  };
  try {
    writeFileSync(runtimePortPath, JSON.stringify(data, null, 2), "utf8");
  } catch {}
}

export function readRuntimePort(env = process.env) {
  const { runtimePortPath } = getRuntimePaths(env);
  if (!existsSync(runtimePortPath)) return null;
  try {
    return JSON.parse(readFileSync(runtimePortPath, "utf8"));
  } catch {
    return null;
  }
}

export function writeHeartbeat(status = {}, env = process.env) {
  const { heartbeatPath } = getRuntimePaths(env);
  let previous = {};
  if (existsSync(heartbeatPath)) {
    try { previous = JSON.parse(readFileSync(heartbeatPath, "utf8")); } catch {}
  }
  const data = {
    ...previous,
    timestamp: Date.now(),
    time: new Date().toISOString(),
    version: getCurrentVersion(),
    ...status,
  };
  try {
    writeFileSync(heartbeatPath, JSON.stringify(data, null, 2), "utf8");
  } catch {}
}

/**
 * Generates OpenCodex-compatible Task Scheduler XML for Windows.
 * Uses LeastPrivilege and the current user's InteractiveToken. Registration
 * can still be denied by OS policy; setup then uses its Startup-file fallback.
 */
export function buildWindowsTaskXml(launcherVbsPath, userSid = "") {
  const wscriptPath = join(process.env.SystemRoot || "C:\\Windows", "System32", "wscript.exe");
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>MOMO Codex Bridge Service (OpenCodex Engine)</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      ${userSid ? `<UserId>${xmlEscape(userSid)}</UserId>` : ""}
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>true</Hidden>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>5</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xmlEscape(wscriptPath)}</Command>
      <Arguments>${xmlEscape(`//b //nologo "${launcherVbsPath}"`)}</Arguments>
    </Exec>
  </Actions>
</Task>`;
}

export function buildWindowsLauncherVbs(serviceScriptPath) {
  const escaped = serviceScriptPath.replace(/"/g, '""');
  return [
    "' MOMO Codex Bridge — OpenCodex background launcher",
    'Set shell = CreateObject("WScript.Shell")',
    `shell.Run """${escaped}""", 0, True`,
  ].join("\r\n") + "\r\n";
}

export function buildWindowsServiceWrapperCmd(binPath, logPath, nodePath = process.execPath, env = process.env) {
  [binPath, logPath, nodePath, appHome(env)].forEach(windowsCmdPath);
  return [
    "@echo off",
    "setlocal DisableDelayedExpansion",
    `set "MOMO_PROXY_HOME=${appHome(env)}"`,
    "set MOMO_PROXY_CONSOLE_MIRROR=0",
    `:loop`,
    `>>"${logPath}" 2>&1 "${nodePath}" "${binPath}" serve`,
    `if %ERRORLEVEL% NEQ 0 (`,
    `  >>"${logPath}" echo [%DATE% %TIME%] MOMO Bridge exited with code %ERRORLEVEL%; restarting in 3s`,
    `  ping -n 4 127.0.0.1 >nul`,
    `  goto loop`,
    `)`,
    `endlocal`,
  ].join("\r\n") + "\r\n";
}

export function resolveWindowsServiceBinPath(binPath, env = process.env) {
  const installedBin = join(appHome(env), "app", "bin", "momoapi-proxy.mjs");
  return existsSync(installedBin) ? installedBin : binPath;
}

export function installWindowsService(binPath, { env = process.env, spawnSyncImpl = spawnSync } = {}) {
  if (process.platform !== "win32") return { installed: false, reason: "non-windows" };
  const paths = getRuntimePaths(env);
  const serviceBinPath = resolveWindowsServiceBinPath(binPath, env);

  // 1. Write wrapper CMD
  const cmdContent = buildWindowsServiceWrapperCmd(serviceBinPath, paths.daemonLogPath, process.execPath, env);
  writeFileSync(paths.serviceScriptPath, cmdContent, "utf8");

  // 2. Write launcher VBS
  const vbsContent = buildWindowsLauncherVbs(paths.serviceScriptPath);
  writeFileSync(paths.launcherVbsPath, vbsContent, "utf8");

  // 3. Write XML (UTF-16LE with BOM)
  const identity = spawnSync(join(process.env.SystemRoot || "C:\\Windows", "System32", "whoami.exe"), ["/user", "/fo", "csv", "/nh"], { encoding: "utf8", windowsHide: true, timeout: 10000 });
  const userSid = String(identity.stdout || "").match(/S-1-\d+(?:-\d+)+/)?.[0];
  if (identity.error || identity.status !== 0 || !userSid) return { installed: false, backend: "schtasks", error: "Could not resolve the current Windows task principal." };
  const xmlContent = buildWindowsTaskXml(paths.launcherVbsPath, userSid);
  const xmlBuffer = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xmlContent, "utf16le")]);
  writeFileSync(paths.taskXmlPath, xmlBuffer);

  // 4. Register task via schtasks
  const taskName = windowsTaskName(env);
  try {
    const schtasksExe = join(process.env.SystemRoot || "C:\\Windows", "System32", "schtasks.exe");
    const run = (args) => {
      const result = spawnSyncImpl(schtasksExe, args, { stdio: "ignore", windowsHide: true, timeout: 15000 });
      if (result.error || result.status !== 0) throw new Error("Windows scheduled task operation failed.");
    };
    run(["/create", "/tn", taskName, "/xml", paths.taskXmlPath, "/f"]);
    
    // 5. Trigger task run immediately
    run(["/run", "/tn", taskName]);
    return { installed: true, backend: "schtasks", taskName };
  } catch (err) {
    return { installed: false, backend: "schtasks", error: err.message };
  }
}

export function stopWindowsService({ env = process.env } = {}) {
  if (process.platform !== "win32") return;
  const schtasksExe = join(process.env.SystemRoot || "C:\\Windows", "System32", "schtasks.exe");
  try {
    spawnSync(schtasksExe, ["/end", "/tn", windowsTaskName(env)], { stdio: "ignore", windowsHide: true, timeout: 15000 });
  } catch {}
}

export function uninstallWindowsService({ env = process.env } = {}) {
  if (process.platform !== "win32") return;
  const schtasksExe = join(process.env.SystemRoot || "C:\\Windows", "System32", "schtasks.exe");
  try {
    spawnSync(schtasksExe, ["/delete", "/tn", windowsTaskName(env), "/f"], { stdio: "ignore", windowsHide: true, timeout: 15000 });
  } catch {}
}
