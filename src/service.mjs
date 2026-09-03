import { execSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { appHome, resolveSettings } from "./config.mjs";
import { getCurrentVersion } from "./updater.mjs";

const TASK_NAME = "momo-codex-bridge";

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

export function writeRuntimePort(port, pid, extra = {}) {
  const { runtimePortPath } = getRuntimePaths();
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

export function readRuntimePort() {
  const { runtimePortPath } = getRuntimePaths();
  if (!existsSync(runtimePortPath)) return null;
  try {
    return JSON.parse(readFileSync(runtimePortPath, "utf8"));
  } catch {
    return null;
  }
}

export function writeHeartbeat(status = {}) {
  const { heartbeatPath } = getRuntimePaths();
  const data = {
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
 * Uses LeastPrivilege and InteractiveToken so standard users (and Windows Sandbox) can register without UAC elevation.
 */
export function buildWindowsTaskXml(launcherVbsPath) {
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
      <Command>${wscriptPath}</Command>
      <Arguments>//b //nologo "${launcherVbsPath}"</Arguments>
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

export function buildWindowsServiceWrapperCmd(binPath, logPath) {
  return [
    "@echo off",
    "setlocal",
    `:loop`,
    `>>"${logPath}" 2>&1 node "${binPath}" serve`,
    `if %ERRORLEVEL% NEQ 0 (`,
    `  >>"${logPath}" echo [%DATE% %TIME%] MOMO Bridge exited with code %ERRORLEVEL%; restarting in 3s`,
    `  ping -n 4 127.0.0.1 >nul`,
    `  goto loop`,
    `)`,
    `endlocal`,
  ].join("\r\n") + "\r\n";
}

export function installWindowsService(binPath) {
  if (process.platform !== "win32") return { installed: false, reason: "non-windows" };
  const paths = getRuntimePaths();

  // 1. Write wrapper CMD
  const cmdContent = buildWindowsServiceWrapperCmd(binPath, paths.daemonLogPath);
  writeFileSync(paths.serviceScriptPath, cmdContent, "utf8");

  // 2. Write launcher VBS
  const vbsContent = buildWindowsLauncherVbs(paths.serviceScriptPath);
  writeFileSync(paths.launcherVbsPath, vbsContent, "utf8");

  // 3. Write XML (UTF-16LE with BOM)
  const xmlContent = buildWindowsTaskXml(paths.launcherVbsPath);
  const xmlBuffer = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xmlContent, "utf16le")]);
  writeFileSync(paths.taskXmlPath, xmlBuffer);

  // 4. Register task via schtasks
  try {
    const schtasksExe = join(process.env.SystemRoot || "C:\\Windows", "System32", "schtasks.exe");
    execSync(`"${schtasksExe}" /create /tn "${TASK_NAME}" /xml "${paths.taskXmlPath}" /f`, { stdio: "ignore" });
    
    // 5. Trigger task run immediately
    execSync(`"${schtasksExe}" /run /tn "${TASK_NAME}"`, { stdio: "ignore" });
    return { installed: true, backend: "schtasks", taskName: TASK_NAME };
  } catch (err) {
    return { installed: false, backend: "schtasks", error: err.message };
  }
}

export function stopWindowsService() {
  if (process.platform !== "win32") return;
  const schtasksExe = join(process.env.SystemRoot || "C:\\Windows", "System32", "schtasks.exe");
  try {
    execSync(`"${schtasksExe}" /end /tn "${TASK_NAME}"`, { stdio: "ignore" });
  } catch {}
}

export function uninstallWindowsService() {
  if (process.platform !== "win32") return;
  const schtasksExe = join(process.env.SystemRoot || "C:\\Windows", "System32", "schtasks.exe");
  try {
    execSync(`"${schtasksExe}" /delete /tn "${TASK_NAME}" /f`, { stdio: "ignore" });
  } catch {}
}
