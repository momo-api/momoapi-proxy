import { appendFileSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
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
    writeFileSync(target, JSON.stringify({ checkedAt: new Date().toISOString(), ...status }, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
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

export async function waitForExpectedHealth({ port, expectedVersion, timeoutMs = 15_000, fetchImpl = fetch } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetchImpl(`http://127.0.0.1:${port}/healthz`, {
        signal: typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
          ? AbortSignal.timeout(1_000)
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
  return result.status === 0 && !result.error;
}

function normalizedWindowsPath(value) {
  return String(value || "").replaceAll("/", "\\").toLowerCase();
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
  pathExists = existsSync,
  copyContents = copyDirectoryContents,
  replaceContents = replaceDirectoryContents,
  installImagePlugin = true,
} = {}) {
  const stagedActivation = Boolean(stagingDir);
  let activationMode = stagedActivation ? "swap" : "legacy";
  const newScript = join(rootDir, "bin", "momoapi-proxy.mjs");
  const backupScript = join(backupDir, "bin", "momoapi-proxy.mjs");
  await waitForParent(parentPid);

  if (stagedActivation) {
    validateStagedLayout({ rootDir, stagingDir, backupDir });
    appendSupervisorLog(`Stopping proxy v${previousVersion} before activating v${targetVersion}.`, env);
    if (pathExists(newScript)) runCli(newScript, "stop", 30_000);
    try {
      const stoppedMcpPids = await stopMcpProcesses(rootDir);
      if (stoppedMcpPids.length) appendSupervisorLog(`Stopped ${stoppedMcpPids.length} managed image MCP process(es) that referenced the old application tree.`, env);
    } catch (error) {
      const restarted = pathExists(newScript) && runCli(newScript, "start");
      const restoredHealthy = restarted && await healthCheck({ port, expectedVersion: previousVersion });
      writeSupervisorStatus({
        status: "activation_failed", current: previousVersion, latest: targetVersion, previous: previousVersion,
        hasUpdate: true, checkFailed: true, rolledBack: false,
        errorCode: error?.code || "update_mcp_stop_failed",
      }, env);
      appendSupervisorLog(`Stopping managed image MCP processes failed: ${error?.code || error?.name || "unknown_error"}.`, env);
      return { activated: false, rolledBack: false, restoredHealthy, errorCode: error?.code || "update_mcp_stop_failed" };
    }
    if (installImagePlugin) {
      const stagedScript = join(stagingDir, "bin", "momoapi-proxy.mjs");
      const marketplaceMigrated = pathExists(stagedScript) && runCli(stagedScript, ["plugin", "install"], 120_000);
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
          const restarted = restoredTreeContents && pathExists(restoredScript) && runCli(restoredScript, "start");
          const restoredHealthy = restarted && await healthCheck({ port, expectedVersion: previousVersion });
          writeSupervisorStatus({
            status: restoredHealthy ? "rolled_back" : "rollback_failed", current: previousVersion, latest: targetVersion, previous: previousVersion,
            hasUpdate: true, checkFailed: true, rolledBack: restoredTreeContents,
            errorCode: restoredHealthy ? "update_inplace_failed" : "update_inplace_restore_failed",
          }, env);
          appendSupervisorLog(`Transactional in-place activation failed: ${fallbackError?.code || fallbackError?.name || "unknown_error"}.`, env);
          return {
            activated: false, rolledBack: restoredTreeContents, restoredHealthy,
            errorCode: restoredHealthy ? "update_inplace_failed" : "update_inplace_restore_failed",
          };
        }
      } else {
        const restoredScript = join(rootDir, "bin", "momoapi-proxy.mjs");
        const restarted = restoredTree && pathExists(restoredScript) && runCli(restoredScript, "start");
        const restoredHealthy = restarted && await healthCheck({ port, expectedVersion: previousVersion });
        writeSupervisorStatus({
          status: restoredHealthy ? "rolled_back" : "rollback_failed", current: previousVersion, latest: targetVersion, previous: previousVersion,
          hasUpdate: true, checkFailed: true, rolledBack: restoredTree,
          errorCode: restoredHealthy ? "update_swap_failed" : "update_swap_restore_failed",
        }, env);
        appendSupervisorLog(`Update file swap failed: ${error?.code || error?.name || "unknown_error"}.`, env);
        return {
          activated: false, rolledBack: restoredTree, restoredHealthy,
          errorCode: restoredHealthy ? "update_swap_failed" : "update_swap_restore_failed",
        };
      }
    }
  }

  appendSupervisorLog(`Activating proxy v${targetVersion}.`, env);
  const restarted = runCli(newScript, "restart");
  const healthy = restarted && await healthCheck({ port, expectedVersion: targetVersion });
  if (healthy) {
    const imagePluginInstalled = installImagePlugin ? runCli(newScript, ["plugin", "install"], 120_000) : false;
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
    }, env);
    appendSupervisorLog(`Proxy v${targetVersion} passed health verification.`, env);
    appendSupervisorLog(imagePluginInstalled
      ? "MOMO Image plugin installation verified after update."
      : (installImagePlugin ? "MOMO Image plugin installation needs a manual retry." : "MOMO Image plugin installation was skipped by configuration."), env);
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
    const restored = restoredTree && runCli(restoredScript, "restart");
    const restoredHealthy = restored && await healthCheck({ port, expectedVersion: previousVersion });
    writeSupervisorStatus({
      status: restoredHealthy ? "rolled_back" : "rollback_failed",
      current: previousVersion, latest: targetVersion, previous: previousVersion,
      hasUpdate: true, checkFailed: !restoredHealthy, rolledBack: restoredTree,
      errorCode: restoredHealthy ? "update_activation_failed" : "update_inplace_restore_failed",
    }, env);
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
    return { activated: false, rolledBack: false, errorCode: "update_rollback_swap_failed" };
  }

  const restoredScript = join(rootDir, "bin", "momoapi-proxy.mjs");
  const restored = runCli(restoredScript, "restart");
  const restoredHealthy = restored && await healthCheck({ port, expectedVersion: previousVersion });
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
