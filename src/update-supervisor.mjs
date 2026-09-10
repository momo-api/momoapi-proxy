import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

export async function superviseUpdate({
  rootDir,
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
  pathExists = existsSync,
  installImagePlugin = true,
} = {}) {
  const newScript = join(rootDir, "bin", "momoapi-proxy.mjs");
  const backupScript = join(backupDir, "bin", "momoapi-proxy.mjs");
  await waitForParent(parentPid);

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
    }, env);
    appendSupervisorLog(`Proxy v${targetVersion} passed health verification.`, env);
    appendSupervisorLog(imagePluginInstalled
      ? "MOMO Image plugin installation verified after update."
      : (installImagePlugin ? "MOMO Image plugin installation needs a manual retry." : "MOMO Image plugin installation was skipped by configuration."), env);
    return { activated: true, rolledBack: false, imagePluginInstalled };
  }

  appendSupervisorLog(`Proxy v${targetVersion} failed health verification; starting rollback.`, env);
  if (pathExists(backupScript)) runCli(backupScript, "stop", 15_000);

  const failedDir = rootDir + `.failed-${Date.now()}-${process.pid}`;
  try {
    if (pathExists(rootDir)) move(rootDir, failedDir);
    move(backupDir, rootDir);
  } catch (error) {
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
  const result = await superviseUpdate({
    rootDir: arg("--root"),
    backupDir: arg("--backup"),
    targetVersion: arg("--target"),
    previousVersion: arg("--previous"),
    port: Number(arg("--port") || 18789),
    parentPid: Number(arg("--parent-pid") || 0),
    installImagePlugin: !process.argv.includes("--no-image-plugin"),
  });
  process.exitCode = result.activated || result.restoredHealthy ? 0 : 1;
}
