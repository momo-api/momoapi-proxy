import { appendFileSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { basename, dirname, join, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function retryFileOperation(operation, { attempts = 40, delayMs = 250 } = {}) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try { return operation(); } catch (error) {
      lastError = error;
      if (!new Set(["EPERM", "EACCES", "EBUSY", "ENOTEMPTY"]).has(error?.code)) throw error;
      await sleep(delayMs);
    }
  }
  throw lastError;
}

function validateStagedLayout({ rootDir, stagingDir, backupDir }) {
  const root = resolve(rootDir || "");
  const staging = resolve(stagingDir || "");
  const backup = resolve(backupDir || "");
  const parent = dirname(root);
  if (backup !== resolve(root + ".update-backup")
    || dirname(staging) !== parent
    || !basename(staging).startsWith(".momoapi-proxy-update-")
    || staging === root
    || staging === backup) {
    throw Object.assign(new Error("Refusing an unsafe staged update directory layout."), { code: "update_layout_unsafe" });
  }
}

export function pruneFailedUpdateDirectories(rootDir, { keep = 3, remove = (target) => rmSync(target, { recursive: true, force: true }) } = {}) {
  const parent = dirname(resolve(rootDir));
  const prefix = `${basename(resolve(rootDir))}.failed-`;
  const retained = Math.max(0, Number.isFinite(Number(keep)) ? Math.floor(Number(keep)) : 3);
  const candidates = readdirSync(parent, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
    .map((entry) => entry.name)
    .sort((left, right) => right.localeCompare(left));
  const removed = [];
  for (const name of candidates.slice(retained)) {
    const target = join(parent, name);
    remove(target);
    removed.push(target);
  }
  return { kept: candidates.slice(0, retained).map((name) => join(parent, name)), removed };
}

function copyDirectoryContents(source, destination) {
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  for (const entry of readdirSync(source)) {
    cpSync(join(source, entry), join(destination, entry), { recursive: true });
  }
}

function replaceDirectoryContents(destination, source) {
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  const sourceEntries = new Set(readdirSync(source));
  for (const entry of sourceEntries) {
    const sourcePath = join(source, entry);
    const destinationPath = join(destination, entry);
    const sourceStat = lstatSync(sourcePath);
    if (sourceStat.isDirectory()) {
      if (existsSync(destinationPath) && !lstatSync(destinationPath).isDirectory()) {
        rmSync(destinationPath, { recursive: true, force: true });
      }
      replaceDirectoryContents(destinationPath, sourcePath);
    } else {
      if (existsSync(destinationPath) && lstatSync(destinationPath).isDirectory()) {
        rmSync(destinationPath, { recursive: true, force: true });
      }
      cpSync(sourcePath, destinationPath, { force: true });
    }
  }
  for (const entry of readdirSync(destination)) {
    if (!sourceEntries.has(entry)) rmSync(join(destination, entry), { recursive: true, force: true });
  }
}

function installedTreeVersion(root) {
  try { return JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version || null; } catch { return null; }
}

function proxyHome(env = process.env) {
  return env.MOMO_PROXY_HOME || env.MOMO_BRIDGE_HOME || env.MOMO_SWITCH_HOME
    || join(env.USERPROFILE || env.HOME || tmpdir(), ".momoapi-proxy");
}

function appendSupervisorLog(message, env = process.env) {
  try {
    const target = join(proxyHome(env), "update-supervisor.log");
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    appendFileSync(target, `[${new Date().toISOString()}] ${message}\n`, { encoding: "utf8", mode: 0o600 });
  } catch {}
}

function writeSupervisorStatus(status, env = process.env) {
  try {
    const target = join(proxyHome(env), "update-status.json");
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    const checkedAt = new Date().toISOString();
    const failed = new Set(["activation_failed", "rolled_back", "rollback_failed"]).has(status.status);
    let previous = null;
    try { previous = JSON.parse(readFileSync(target, "utf8")); } catch {}
    const failedTarget = failed ? (status.failedTarget || status.latest || status.target || null) : null;
    const failureFields = failedTarget ? {
      failedTarget,
      failedAt: previous?.failedTarget === failedTarget ? (previous.failedAt || checkedAt) : checkedAt,
      automaticRetryBlocked: true,
    } : {};
    writeFileSync(target, JSON.stringify({ checkedAt, ...status, ...failureFields }, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  } catch {}
}

export async function waitForProcessExit(pid, timeoutMs = 30_000) {
  if (!Number.isInteger(pid) || pid <= 0) return true;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await sleep(200);
  }
  return false;
}

export async function waitForExpectedHealth({ port, expectedVersion, requireUpstream = false, timeoutMs = 30_000, fetchImpl = fetch } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const route = requireUpstream ? "/readyz" : "/healthz";
      const response = await fetchImpl(`http://127.0.0.1:${port}${route}`, {
        signal: typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
          ? AbortSignal.timeout(requireUpstream ? 5_000 : 1_000)
          : undefined,
      });
      if (response.ok) {
        const payload = await response.json();
        if (!expectedVersion || payload.version === expectedVersion) return true;
      }
    } catch {}
    await sleep(250);
  }
  return false;
}

function runProxyCli(scriptPath, commandArgs, timeoutMs = 30_000) {
  const args = Array.isArray(commandArgs) ? commandArgs : [commandArgs];
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    stdio: "ignore",
    windowsHide: true,
    timeout: timeoutMs,
  });
  const ok = result.status === 0 && !result.error;
  return {
    ok,
    errorCode: ok
      ? null
      : (result.error?.code || (result.signal ? `signal_${result.signal}` : `exit_${result.status ?? "unknown"}`)),
  };
}

function cliRunSucceeded(result) {
  return result === true || Boolean(result && typeof result === "object" && result.ok === true);
}

function cliRunErrorCode(result) {
  const raw = result && typeof result === "object" ? result.errorCode : null;
  const normalized = String(raw || "command_failed").replace(/[^a-zA-Z0-9_.-]/g, "_");
  return normalized.slice(0, 80) || "command_failed";
}

async function runCliThenCheckHealth({
  runCli, scriptPath, command, timeoutMs, healthCheck, port, expectedVersion, requireUpstream = false, phase, env,
}) {
  let commandResult;
  try {
    commandResult = runCli(scriptPath, command, timeoutMs);
  } catch (error) {
    commandResult = { ok: false, errorCode: error?.code || error?.name || "command_threw" };
  }
  const commandSucceeded = cliRunSucceeded(commandResult);
  if (!commandSucceeded) {
    appendSupervisorLog(`${phase} command did not complete successfully (${cliRunErrorCode(commandResult)}); checking the service health independently.`, env);
  }
  const healthy = await healthCheck({ port, expectedVersion, requireUpstream });
  if (healthy && !commandSucceeded) {
    appendSupervisorLog(`${phase} reached the expected healthy version despite the command failure or timeout.`, env);
  }
  return { commandSucceeded, healthy };
}

function normalizedWindowsPath(value) {
  return String(value || "").replaceAll("/", "\\").toLowerCase();
}

function managedTrayPaths(rootDir) {
  const resolvedRoot = win32.resolve(String(rootDir || ""));
  const names = ["MomoApiProxyTray.exe", "momoapi-tray.exe"];
  return [
    ...names.map((name) => win32.join(win32.dirname(resolvedRoot), "bin", name)),
    ...names.map((name) => win32.join(resolvedRoot, "bin", name)),
  ];
}

export function isManagedTrayProcess(processInfo, rootDir) {
  if (!processInfo) return false;
  const name = String(processInfo.Name || processInfo.name || "").toLowerCase();
  if (!new Set(["momoapiproxytray.exe", "momoapi-tray.exe"]).has(name)) return false;
  const executablePath = normalizedWindowsPath(processInfo.ExecutablePath ?? processInfo.executablePath);
  return managedTrayPaths(rootDir).some((candidate) => executablePath === normalizedWindowsPath(candidate));
}

export function isManagedTrayRunning(rootDir, {
  platform = process.platform,
  listProcesses = () => {
    const result = spawnSync("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-Command",
      "Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.Name -in @('MomoApiProxyTray.exe','momoapi-tray.exe') } | Select-Object ProcessId,Name,ExecutablePath | ConvertTo-Json -Compress",
    ], { encoding: "utf8", windowsHide: true, timeout: 10_000 });
    if (result.status !== 0 || !result.stdout?.trim()) return [];
    try {
      const parsed = JSON.parse(result.stdout);
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      return [];
    }
  },
} = {}) {
  if (platform !== "win32") return false;
  return listProcesses().some((entry) => isManagedTrayProcess(entry, rootDir));
}

export async function stopManagedTrayProcesses(rootDir, {
  platform = process.platform,
  listProcesses = () => {
    const result = spawnSync("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-Command",
      "Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.Name -in @('MomoApiProxyTray.exe','momoapi-tray.exe') } | Select-Object ProcessId,Name,ExecutablePath | ConvertTo-Json -Compress",
    ], { encoding: "utf8", windowsHide: true, timeout: 10_000 });
    if (result.status !== 0 || !result.stdout?.trim()) return [];
    try {
      const parsed = JSON.parse(result.stdout);
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      return [];
    }
  },
  terminate = (pid) => process.kill(pid, "SIGTERM"),
  waitForExit = waitForProcessExit,
} = {}) {
  if (platform !== "win32") return [];
  const matches = listProcesses().filter((entry) => isManagedTrayProcess(entry, rootDir));
  const matchedPids = matches.map((entry) => Number(entry.ProcessId ?? entry.processId));
  for (const pid of matchedPids) {
    try { terminate(pid); } catch {}
  }
  const exitStates = await Promise.all(matchedPids.map((pid) => waitForExit(pid, 5_000)));
  for (let index = 0; index < matchedPids.length; index += 1) {
    if (!exitStates[index]) {
      throw Object.assign(new Error(`Managed tray process ${matchedPids[index]} did not exit before the update.`), { code: "update_tray_stop_failed" });
    }
  }
  return matchedPids;
}

export function startManagedTray(rootDir, port, {
  platform = process.platform,
  spawnImpl = spawn,
  runningCheck = isManagedTrayRunning,
  pathExists = existsSync,
} = {}) {
  if (platform !== "win32") return false;
  if (runningCheck(rootDir)) return true;
  const executable = managedTrayPaths(rootDir).find((candidate) => pathExists(candidate));
  if (!executable) return false;
  try {
    const child = spawnImpl(executable, ["--port", String(port || 18789)], {
      detached: true, stdio: "ignore", windowsHide: true,
    });
    if (!child?.pid) return false;
    child.unref?.();
    return true;
  } catch {
    return false;
  }
}

export function isManagedImageMcpProcess(processInfo, rootDir) {
  if (!processInfo || String(processInfo.Name || processInfo.name || "").toLowerCase() !== "node.exe") return false;
  const pid = Number(processInfo.ProcessId ?? processInfo.processId);
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;
  const commandLine = normalizedWindowsPath(processInfo.CommandLine ?? processInfo.commandLine);
  const targetScript = normalizedWindowsPath(win32.join(win32.resolve(String(rootDir || "")), "bin", "momoapi-proxy.mjs"));
  const index = commandLine.indexOf(targetScript);
  if (index < 0) return false;
  const before = index > 0 ? commandLine[index - 1] : " ";
  const afterIndex = index + targetScript.length;
  const after = afterIndex < commandLine.length ? commandLine[afterIndex] : " ";
  if (!/[\s\"']/.test(before) || !/[\s\"']/.test(after)) return false;
  const remaining = commandLine.slice(afterIndex).replace(/^[\s\"']+/, "");
  return /^(?:\"|')?mcp(?:\"|')?[\s]+(?:\"|')?image(?:\"|')?(?:[\s]|$)/i.test(remaining);
}

export async function stopManagedImageMcpProcesses(rootDir, {
  platform = process.platform,
  listProcesses = () => {
    const result = spawnSync("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-Command",
      "Get-CimInstance Win32_Process -Filter \"Name = 'node.exe'\" -ErrorAction SilentlyContinue | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress",
    ], { encoding: "utf8", windowsHide: true, timeout: 10_000 });
    if (result.status !== 0 || !result.stdout?.trim()) return [];
    try {
      const parsed = JSON.parse(result.stdout);
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      return [];
    }
  },
  terminate = (pid) => process.kill(pid, "SIGTERM"),
  waitForExit = waitForProcessExit,
} = {}) {
  if (platform !== "win32") return [];
  const matches = listProcesses().filter((entry) => isManagedImageMcpProcess(entry, rootDir));
  const matchedPids = matches.map((entry) => Number(entry.ProcessId ?? entry.processId));
  for (const entry of matches) {
    const pid = Number(entry.ProcessId ?? entry.processId);
    try {
      terminate(pid);
    } catch {}
  }
  const exitStates = await Promise.all(matchedPids.map((pid) => waitForExit(pid, 5_000)));
  for (let index = 0; index < matchedPids.length; index += 1) {
    if (!exitStates[index]) {
      throw Object.assign(new Error(`Managed image MCP process ${matchedPids[index]} did not exit before the update.`), { code: "update_mcp_stop_failed" });
    }
  }
  return matchedPids;
}

export async function superviseUpdate({
  rootDir,
  stagingDir,
  backupDir,
  targetVersion,
  previousVersion,
  port,
  parentPid,
  env = process.env,
  waitForParent = waitForProcessExit,
  runCli = runProxyCli,
  healthCheck = waitForExpectedHealth,
  move = renameSync,
  remove = (target) => rmSync(target, { recursive: true, force: true }),
  retry = retryFileOperation,
  stopMcpProcesses = stopManagedImageMcpProcesses,
  stopTrayProcesses = stopManagedTrayProcesses,
  pathExists = existsSync,
  copyContents = copyDirectoryContents,
  replaceContents = replaceDirectoryContents,
  installImagePlugin = true,
  trayRunningCheck = isManagedTrayRunning,
  startTray = startManagedTray,
} = {}) {
  const stagedActivation = Boolean(stagingDir);
  let activationMode = stagedActivation ? "swap" : "legacy";
  const newScript = join(rootDir, "bin", "momoapi-proxy.mjs");
  const backupScript = join(backupDir, "bin", "momoapi-proxy.mjs");
  await waitForParent(parentPid);
  const trayWasRunning = Boolean(trayRunningCheck(rootDir));
  const restoreTray = (healthy, phase) => {
    if (!healthy || !trayWasRunning) return false;
    const started = Boolean(startTray(rootDir, port));
    appendSupervisorLog(started
      ? `Restored the Windows tray after ${phase}.`
      : `The Windows tray was running before the update but could not be restored after ${phase}.`, env);
    return started;
  };

  if (stagedActivation) {
    validateStagedLayout({ rootDir, stagingDir, backupDir });
    appendSupervisorLog(`Stopping proxy v${previousVersion} before activating v${targetVersion}.`, env);
    if (pathExists(newScript)) runCli(newScript, "stop", 30_000);
    try {
      const stoppedTrayPids = await stopTrayProcesses(rootDir);
      if (stoppedTrayPids.length) appendSupervisorLog(`Stopped ${stoppedTrayPids.length} managed tray process(es) before replacing the application tree.`, env);
    } catch (error) {
      const restoredHealthy = pathExists(newScript)
        ? (await runCliThenCheckHealth({
            runCli, scriptPath: newScript, command: "start", healthCheck, port, expectedVersion: previousVersion,
            phase: `Restoring proxy v${previousVersion}`, env,
          })).healthy
        : false;
      writeSupervisorStatus({
        status: "activation_failed", current: previousVersion, latest: targetVersion, previous: previousVersion,
        hasUpdate: true, checkFailed: true, rolledBack: false,
        errorCode: error?.code || "update_tray_stop_failed",
      }, env);
      appendSupervisorLog(`Stopping managed tray processes failed: ${error?.code || error?.name || "unknown_error"}.`, env);
      restoreTray(restoredHealthy, "the interrupted activation");
      return { activated: false, rolledBack: false, restoredHealthy, errorCode: error?.code || "update_tray_stop_failed" };
    }
    try {
      const stoppedMcpPids = await stopMcpProcesses(rootDir);
      if (stoppedMcpPids.length) appendSupervisorLog(`Stopped ${stoppedMcpPids.length} managed image MCP process(es) that referenced the old application tree.`, env);
    } catch (error) {
      const restoredHealthy = pathExists(newScript)
        ? (await runCliThenCheckHealth({
            runCli, scriptPath: newScript, command: "start", healthCheck, port, expectedVersion: previousVersion,
            phase: `Restoring proxy v${previousVersion}`, env,
          })).healthy
        : false;
      writeSupervisorStatus({
        status: "activation_failed", current: previousVersion, latest: targetVersion, previous: previousVersion,
        hasUpdate: true, checkFailed: true, rolledBack: false,
        errorCode: error?.code || "update_mcp_stop_failed",
      }, env);
      appendSupervisorLog(`Stopping managed image MCP processes failed: ${error?.code || error?.name || "unknown_error"}.`, env);
      restoreTray(restoredHealthy, "the interrupted activation");
      return { activated: false, rolledBack: false, restoredHealthy, errorCode: error?.code || "update_mcp_stop_failed" };
    }
    if (installImagePlugin) {
      const stagedScript = join(stagingDir, "bin", "momoapi-proxy.mjs");
      const marketplaceMigrated = pathExists(stagedScript)
        && cliRunSucceeded(runCli(stagedScript, ["plugin", "install"], 120_000));
      appendSupervisorLog(marketplaceMigrated
        ? "Moved the MOMO Image marketplace outside the application tree before activation."
        : "The MOMO Image marketplace pre-activation migration was unavailable; activation will continue with rollback protection.", env);
    }
    await sleep(500);
    try {
      await retry(() => remove(backupDir));
      await retry(() => move(rootDir, backupDir));
      await retry(() => move(stagingDir, rootDir));
    } catch (error) {
      let restoredTree = pathExists(rootDir);
      try {
        if (!restoredTree && pathExists(backupDir)) {
          await retry(() => move(backupDir, rootDir));
          restoredTree = true;
        }
      } catch (restoreError) {
        appendSupervisorLog(`Restoring the previous update tree failed: ${restoreError?.code || restoreError?.name || "unknown_error"}.`, env);
      }
      const canUseInPlaceFallback = restoredTree && pathExists(stagingDir)
        && new Set(["EPERM", "EACCES", "EBUSY", "ENOTEMPTY"]).has(error?.code);
      if (canUseInPlaceFallback) {
        let backupValid = false;
        try {
          await retry(() => remove(backupDir));
          copyContents(rootDir, backupDir);
          if (installedTreeVersion(backupDir) !== previousVersion) {
            throw Object.assign(new Error("The in-place update backup did not preserve the previous version."), { code: "update_inplace_backup_invalid" });
          }
          backupValid = true;
          replaceContents(rootDir, stagingDir);
          if (installedTreeVersion(rootDir) !== targetVersion) {
            throw Object.assign(new Error("The in-place update did not install the target version."), { code: "update_inplace_copy_invalid" });
          }
          activationMode = "inplace";
          appendSupervisorLog(`Directory swap was blocked (${error.code}); activated the verified tree with the transactional in-place fallback.`, env);
        } catch (fallbackError) {
          let restoredTreeContents = false;
          try {
            if (backupValid && pathExists(backupDir)) {
              replaceContents(rootDir, backupDir);
              restoredTreeContents = installedTreeVersion(rootDir) === previousVersion;
            } else {
              restoredTreeContents = installedTreeVersion(rootDir) === previousVersion;
            }
          } catch (restoreError) {
            appendSupervisorLog(`Restoring the in-place update backup failed: ${restoreError?.code || restoreError?.name || "unknown_error"}.`, env);
          }
          const restoredScript = join(rootDir, "bin", "momoapi-proxy.mjs");
          const restoredHealthy = restoredTreeContents && pathExists(restoredScript)
            ? (await runCliThenCheckHealth({
                runCli, scriptPath: restoredScript, command: "start", healthCheck, port, expectedVersion: previousVersion,
                phase: `Restoring proxy v${previousVersion}`, env,
              })).healthy
            : false;
          writeSupervisorStatus({
            status: restoredHealthy ? "rolled_back" : "rollback_failed", current: previousVersion, latest: targetVersion, previous: previousVersion,
            hasUpdate: true, checkFailed: true, rolledBack: restoredTreeContents,
            errorCode: restoredHealthy ? "update_inplace_failed" : "update_inplace_restore_failed",
          }, env);
          appendSupervisorLog(`Transactional in-place activation failed: ${fallbackError?.code || fallbackError?.name || "unknown_error"}.`, env);
          restoreTray(restoredHealthy, "the in-place rollback");
          if (restoredHealthy) {
            try { pruneFailedUpdateDirectories(rootDir); } catch {}
          }
          return {
            activated: false, rolledBack: restoredTreeContents, restoredHealthy,
            errorCode: restoredHealthy ? "update_inplace_failed" : "update_inplace_restore_failed",
          };
        }
      } else {
        const restoredScript = join(rootDir, "bin", "momoapi-proxy.mjs");
        const restoredHealthy = restoredTree && pathExists(restoredScript)
          ? (await runCliThenCheckHealth({
              runCli, scriptPath: restoredScript, command: "start", healthCheck, port, expectedVersion: previousVersion,
              phase: `Restoring proxy v${previousVersion}`, env,
            })).healthy
          : false;
        writeSupervisorStatus({
          status: restoredHealthy ? "rolled_back" : "rollback_failed", current: previousVersion, latest: targetVersion, previous: previousVersion,
          hasUpdate: true, checkFailed: true, rolledBack: restoredTree,
          errorCode: restoredHealthy ? "update_swap_failed" : "update_swap_restore_failed",
        }, env);
        appendSupervisorLog(`Update file swap failed: ${error?.code || error?.name || "unknown_error"}.`, env);
        restoreTray(restoredHealthy, "the file-swap rollback");
        if (restoredHealthy) {
          try { pruneFailedUpdateDirectories(rootDir); } catch {}
        }
        return {
          activated: false, rolledBack: restoredTree, restoredHealthy,
          errorCode: restoredHealthy ? "update_swap_failed" : "update_swap_restore_failed",
        };
      }
    }
  }

  appendSupervisorLog(`Activating proxy v${targetVersion}.`, env);
  const activationCommand = stagedActivation ? "start" : "restart";
  const { commandSucceeded: activationCommandSucceeded, healthy } = await runCliThenCheckHealth({
    runCli, scriptPath: newScript, command: activationCommand, healthCheck, port, expectedVersion: targetVersion,
    requireUpstream: true,
    phase: `Activating proxy v${targetVersion}`, env,
  });
  if (healthy) {
    const imagePluginInstalled = installImagePlugin
      ? cliRunSucceeded(runCli(newScript, ["plugin", "install"], 120_000))
      : false;
    writeSupervisorStatus({
      status: "active",
      current: targetVersion,
      latest: targetVersion,
      previous: previousVersion,
      hasUpdate: false,
      checkFailed: false,
      rolledBack: false,
      imagePluginInstalled,
      activationMode,
      activationCommandSucceeded,
    }, env);
    appendSupervisorLog(`Proxy v${targetVersion} passed health verification.`, env);
    appendSupervisorLog(imagePluginInstalled
      ? "MOMO Image plugin installation verified after update."
      : (installImagePlugin ? "MOMO Image plugin installation needs a manual retry." : "MOMO Image plugin installation was skipped by configuration."), env);
    restoreTray(true, `activation of v${targetVersion}`);
    if (activationMode === "inplace" && stagingDir) {
      try { remove(stagingDir); } catch {}
    }
    return { activated: true, rolledBack: false, imagePluginInstalled, activationMode };
  }

  appendSupervisorLog(`Proxy v${targetVersion} failed health verification; starting rollback.`, env);
  if (activationMode === "inplace") {
    if (pathExists(newScript)) runCli(newScript, "stop", 15_000);
    let restoredTree = false;
    try {
      replaceContents(rootDir, backupDir);
      restoredTree = installedTreeVersion(rootDir) === previousVersion;
    } catch (error) {
      appendSupervisorLog(`In-place health rollback failed: ${error?.code || error?.name || "unknown_error"}.`, env);
    }
    const restoredScript = join(rootDir, "bin", "momoapi-proxy.mjs");
    const restoredHealthy = restoredTree
      ? (await runCliThenCheckHealth({
          runCli, scriptPath: restoredScript, command: "start", healthCheck, port, expectedVersion: previousVersion,
          phase: `Rolling back to proxy v${previousVersion}`, env,
        })).healthy
      : false;
    writeSupervisorStatus({
      status: restoredHealthy ? "rolled_back" : "rollback_failed",
      current: previousVersion, latest: targetVersion, previous: previousVersion,
      hasUpdate: true, checkFailed: !restoredHealthy, rolledBack: restoredTree,
      errorCode: restoredHealthy ? "update_activation_failed" : "update_inplace_restore_failed",
    }, env);
    restoreTray(restoredHealthy, "the health-check rollback");
    if (restoredHealthy) {
      try { pruneFailedUpdateDirectories(rootDir); } catch {}
    }
    return {
      activated: false, rolledBack: restoredTree, restoredHealthy,
      errorCode: restoredHealthy ? "update_activation_failed" : "update_inplace_restore_failed",
    };
  }

  if (pathExists(backupScript)) runCli(backupScript, "stop", 15_000);

  const failedDir = rootDir + `.failed-${Date.now()}-${process.pid}`;
  try {
    if (pathExists(rootDir)) await retry(() => move(rootDir, failedDir));
    await retry(() => move(backupDir, rootDir));
  } catch (error) {
    try {
      if (!pathExists(rootDir) && pathExists(failedDir)) await retry(() => move(failedDir, rootDir));
    } catch {}
    const recoverableScript = join(rootDir, "bin", "momoapi-proxy.mjs");
    if (pathExists(recoverableScript)) runCli(recoverableScript, "start");
    writeSupervisorStatus({
      status: "rollback_failed",
      current: targetVersion,
      latest: targetVersion,
      previous: previousVersion,
      hasUpdate: false,
      checkFailed: true,
      rolledBack: false,
      errorCode: "update_rollback_swap_failed",
    }, env);
    appendSupervisorLog(`Rollback file swap failed: ${error?.code || error?.name || "unknown_error"}.`, env);
    restoreTray(false, "the failed rollback");
    return { activated: false, rolledBack: false, errorCode: "update_rollback_swap_failed" };
  }

  const restoredScript = join(rootDir, "bin", "momoapi-proxy.mjs");
  const { healthy: restoredHealthy } = await runCliThenCheckHealth({
    runCli, scriptPath: restoredScript, command: "start", healthCheck, port, expectedVersion: previousVersion,
    phase: `Rolling back to proxy v${previousVersion}`, env,
  });
  writeSupervisorStatus({
    status: restoredHealthy ? "rolled_back" : "rollback_failed",
    current: previousVersion,
    latest: targetVersion,
    previous: previousVersion,
    hasUpdate: true,
    checkFailed: !restoredHealthy,
    rolledBack: true,
    errorCode: restoredHealthy ? "update_activation_failed" : "update_rollback_restart_failed",
  }, env);
  appendSupervisorLog(restoredHealthy
    ? `Rollback to proxy v${previousVersion} completed.`
    : `Rollback restored proxy v${previousVersion}, but its health check failed.`, env);
  restoreTray(restoredHealthy, `rollback to v${previousVersion}`);
  if (restoredHealthy) {
    try { pruneFailedUpdateDirectories(rootDir); } catch {}
  }
  return {
    activated: false,
    rolledBack: true,
    restoredHealthy,
    failedDir,
    errorCode: restoredHealthy ? "update_activation_failed" : "update_rollback_restart_failed",
  };
}

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath && invokedPath.toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  try {
    const result = await superviseUpdate({
      rootDir: arg("--root"),
      stagingDir: arg("--staging"),
      backupDir: arg("--backup"),
      targetVersion: arg("--target"),
      previousVersion: arg("--previous"),
      port: Number(arg("--port") || 18789),
      parentPid: Number(arg("--parent-pid") || 0),
      installImagePlugin: !process.argv.includes("--no-image-plugin"),
    });
    process.exitCode = result.activated || result.restoredHealthy ? 0 : 1;
  } finally {
    if (basename(invokedPath).startsWith(".momoapi-proxy-update-supervisor-")) {
      try { rmSync(invokedPath, { force: true }); } catch {}
    }
  }
}
