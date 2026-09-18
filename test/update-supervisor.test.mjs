import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isManagedImageMcpProcess, isManagedTrayProcess, pruneFailedUpdateDirectories, restoreManagedTray, startManagedTray, stopManagedImageMcpProcesses, stopManagedTrayProcesses, superviseUpdate, waitForExpectedHealth } from "../src/update-supervisor.mjs";

function createVersion(root, version) {
  mkdirSync(join(root, "bin"), { recursive: true });
  writeFileSync(join(root, "bin", "momoapi-proxy.mjs"), `// ${version}\n`);
  writeFileSync(join(root, "package.json"), JSON.stringify({ version }));
}

test("failed update directory retention is bounded to the newest three", (t) => {
  const home = mkdtempSync(join(tmpdir(), "momo-supervisor-retention-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const root = join(home, "app");
  createVersion(root, "0.13.28");
  for (const stamp of [100, 200, 300, 400, 500]) mkdirSync(`${root}.failed-${stamp}-1`);
  const result = pruneFailedUpdateDirectories(root);
  assert.equal(result.kept.length, 3);
  assert.equal(result.removed.length, 2);
  assert.deepEqual(
    result.kept.map((entry) => entry.split(".failed-")[1]),
    ["500-1", "400-1", "300-1"],
  );
});

test("update readiness checks authenticated upstream reachability while rollback health stays local", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return Response.json({ ok: true, version: "0.13.28" });
  };
  assert.equal(await waitForExpectedHealth({ port: 18789, expectedVersion: "0.13.28", requireUpstream: true, timeoutMs: 50, fetchImpl }), true);
  assert.match(calls[0], /\/readyz$/);
  calls.length = 0;
  assert.equal(await waitForExpectedHealth({ port: 18789, expectedVersion: "0.13.28", timeoutMs: 50, fetchImpl }), true);
  assert.match(calls[0], /\/healthz$/);
});

test("update supervisor records activation after matching health check", async () => {
  const home = mkdtempSync(join(tmpdir(), "momo-supervisor-"));
  const root = join(home, "app");
  const backup = join(home, "app.update-backup");
  createVersion(root, "0.12.0");
  createVersion(backup, "0.11.0");
  const commands = [];
  try {
    const result = await superviseUpdate({
      rootDir: root, backupDir: backup, targetVersion: "0.12.0", previousVersion: "0.11.0", port: 18789,
      env: { MOMO_PROXY_HOME: home },
      waitForParent: async () => true,
      runCli: (_script, command) => { commands.push(command); return true; },
      healthCheck: async ({ expectedVersion, requireUpstream }) => expectedVersion === "0.12.0" && requireUpstream,
    });
    assert.equal(result.activated, true);
    assert.equal(result.imagePluginInstalled, true);
    assert.deepEqual(commands, ["restart", ["plugin", "install"]]);
    assert.equal(JSON.parse(readFileSync(join(home, "update-status.json"), "utf8")).status, "active");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("update supervisor honors an explicit image plugin opt-out", async () => {
  const home = mkdtempSync(join(tmpdir(), "momo-supervisor-"));
  const root = join(home, "app");
  const backup = join(home, "app.update-backup");
  createVersion(root, "0.13.1");
  createVersion(backup, "0.13.0");
  const commands = [];
  try {
    const result = await superviseUpdate({
      rootDir: root, backupDir: backup, targetVersion: "0.13.1", previousVersion: "0.13.0", port: 18789,
      env: { MOMO_PROXY_HOME: home },
      waitForParent: async () => true,
      runCli: (_script, command) => { commands.push(command); return true; },
      healthCheck: async () => true,
      installImagePlugin: false,
    });
    assert.equal(result.activated, true);
    assert.equal(result.imagePluginInstalled, false);
    assert.deepEqual(commands, ["restart"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("update supervisor restores the backup when the new version is unhealthy", async () => {
  const home = mkdtempSync(join(tmpdir(), "momo-supervisor-"));
  const root = join(home, "app");
  const backup = join(home, "app.update-backup");
  createVersion(root, "0.12.0");
  createVersion(backup, "0.11.0");
  const healthVersions = [];
  try {
    const result = await superviseUpdate({
      rootDir: root, backupDir: backup, targetVersion: "0.12.0", previousVersion: "0.11.0", port: 18789,
      env: { MOMO_PROXY_HOME: home },
      waitForParent: async () => true,
      runCli: () => true,
      healthCheck: async ({ expectedVersion }) => {
        healthVersions.push(expectedVersion);
        return expectedVersion === "0.11.0";
      },
    });
    assert.equal(result.rolledBack, true);
    assert.equal(result.restoredHealthy, true);
    assert.deepEqual(healthVersions, ["0.12.0", "0.11.0"]);
    assert.equal(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version, "0.11.0");
    assert.equal(JSON.parse(readFileSync(join(home, "update-status.json"), "utf8")).status, "rolled_back");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("staged Windows-style activation stops the old service before swapping directories", async () => {
  const home = mkdtempSync(join(tmpdir(), "momo-supervisor-stage-"));
  const root = join(home, "app");
  const staging = join(home, ".momoapi-proxy-update-stage");
  const backup = join(home, "app.update-backup");
  createVersion(root, "0.13.2");
  createVersion(staging, "0.13.3");
  const operations = [];
  try {
    const result = await superviseUpdate({
      rootDir: root, stagingDir: staging, backupDir: backup, targetVersion: "0.13.3", previousVersion: "0.13.2", port: 18789,
      env: { MOMO_PROXY_HOME: home }, waitForParent: async () => true,
      runCli: (script, command) => { operations.push({ type: "cli", script, command }); return true; },
      stopTrayProcesses: async () => { operations.push({ type: "tray" }); return [2345]; },
      stopMcpProcesses: async () => { operations.push({ type: "mcp" }); return [1234]; },
      move: (source, destination) => { operations.push({ type: "move", source, destination }); return renameSync(source, destination); },
      healthCheck: async ({ expectedVersion }) => expectedVersion === "0.13.3",
    });
    assert.equal(result.activated, true);
    assert.equal(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version, "0.13.3");
    assert.equal(JSON.parse(readFileSync(join(backup, "package.json"), "utf8")).version, "0.13.2");
    assert.equal(operations[0].command, "stop");
    assert.equal(operations[1].type, "tray");
    assert.equal(operations[2].type, "mcp");
    assert.deepEqual(operations[3].command, ["plugin", "install"]);
    assert.equal(operations[4].type, "move");
    assert.equal(operations[6].command, "start");
    assert.deepEqual(operations[7].command, ["plugin", "install"]);
    assert.equal(result.activationMode, "swap");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("managed image MCP matching is exact to the old proxy script and image subcommand", () => {
  const root = join("C:\\Users\\test user\\.momoapi-proxy", "app");
  const target = join(root, "bin", "momoapi-proxy.mjs");
  assert.equal(isManagedImageMcpProcess({ ProcessId: 4321, Name: "node.exe", CommandLine: `node.exe "${target}" mcp image` }, root), true);
  assert.equal(isManagedImageMcpProcess({ ProcessId: 4321, Name: "node.exe", CommandLine: `node.exe ${target} mcp image --stdio` }, root), true);
  assert.equal(isManagedImageMcpProcess({ ProcessId: 4321, Name: "node.exe", CommandLine: `node.exe "${target}" serve` }, root), false);
  assert.equal(isManagedImageMcpProcess({ ProcessId: 4321, Name: "cmd.exe", CommandLine: `cmd /c node "${target}" mcp image` }, root), false);
  assert.equal(isManagedImageMcpProcess({ ProcessId: 4321, Name: "node.exe", CommandLine: `node.exe "${root}-other\\bin\\momoapi-proxy.mjs" mcp image` }, root), false);
});

test("managed tray matching accepts only the exact application or stable install path", () => {
  const root = "C:\\Users\\test user\\.momoapi-proxy\\app";
  assert.equal(isManagedTrayProcess({ Name: "MomoApiProxyTray.exe", ExecutablePath: `${root}\\bin\\MomoApiProxyTray.exe` }, root), true);
  assert.equal(isManagedTrayProcess({ Name: "MomoApiProxyTray.exe", ExecutablePath: "C:\\Users\\test user\\.momoapi-proxy\\bin\\MomoApiProxyTray.exe" }, root), true);
  assert.equal(isManagedTrayProcess({ Name: "momoapi-tray.exe", ExecutablePath: `${root}\\bin\\momoapi-tray.exe` }, root), true);
  assert.equal(isManagedTrayProcess({ Name: "MomoApiProxyTray.exe", ExecutablePath: "C:\\Temp\\MomoApiProxyTray.exe" }, root), false);
  assert.equal(isManagedTrayProcess({ Name: "other.exe", ExecutablePath: `${root}\\bin\\MomoApiProxyTray.exe` }, root), false);
});

test("managed tray launch prefers the stable install path and passes the configured port", () => {
  const root = "C:\\Users\\test\\.momoapi-proxy\\app";
  const stableTray = "C:\\Users\\test\\.momoapi-proxy\\bin\\MomoApiProxyTray.exe";
  const calls = [];
  let unrefCalled = false;
  const started = startManagedTray(root, 19001, {
    platform: "win32",
    runningCheck: () => false,
    pathExists: (candidate) => candidate.toLowerCase() === stableTray.toLowerCase(),
    spawnImpl: (executable, args, options) => {
      calls.push({ executable, args, options });
      return { pid: 321, unref: () => { unrefCalled = true; } };
    },
  });
  assert.equal(started, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].executable.toLowerCase(), stableTray.toLowerCase());
  assert.deepEqual(calls[0].args, ["--port", "19001"]);
  assert.equal(calls[0].options.detached, true);
  assert.equal(unrefCalled, true);
});

test("managed tray restore retries when the first launch does not stay alive", async () => {
  let launches = 0;
  let checks = 0;
  const restored = await restoreManagedTray("C:\\Users\\test\\.momoapi-proxy\\app", 18789, {
    startTray: () => { launches += 1; return true; },
    runningCheck: () => { checks += 1; return checks >= 2; },
    wait: async () => {},
  });
  assert.equal(restored, true);
  assert.equal(launches, 2);
  assert.equal(checks, 2);
});

test("managed tray shutdown terminates only exact installed tray paths", async () => {
  const root = "C:\\Users\\test\\.momoapi-proxy\\app";
  const terminated = [];
  const waited = [];
  const stopped = await stopManagedTrayProcesses(root, {
    platform: "win32",
    listProcesses: () => [
      { ProcessId: 201, Name: "MomoApiProxyTray.exe", ExecutablePath: `${root}\\bin\\MomoApiProxyTray.exe` },
      { ProcessId: 202, Name: "MomoApiProxyTray.exe", ExecutablePath: "C:\\Users\\test\\.momoapi-proxy\\bin\\MomoApiProxyTray.exe" },
      { ProcessId: 203, Name: "MomoApiProxyTray.exe", ExecutablePath: "C:\\Temp\\MomoApiProxyTray.exe" },
    ],
    terminate: (pid) => terminated.push(pid),
    waitForExit: async (pid) => { waited.push(pid); return true; },
  });
  assert.deepEqual(stopped, [201, 202]);
  assert.deepEqual(terminated, [201, 202]);
  assert.deepEqual(waited, [201, 202]);
});

test("managed tray shutdown fails closed when an exact installed tray remains alive", async () => {
  const root = "C:\\Users\\test\\.momoapi-proxy\\app";
  await assert.rejects(stopManagedTrayProcesses(root, {
    platform: "win32",
    listProcesses: () => [{ ProcessId: 201, Name: "MomoApiProxyTray.exe", ExecutablePath: `${root}\\bin\\MomoApiProxyTray.exe` }],
    terminate: () => {},
    waitForExit: async () => false,
  }), (error) => error.code === "update_tray_stop_failed");
});

test("successful update restores a previously running tray only after health succeeds", async () => {
  const home = mkdtempSync(join(tmpdir(), "momo-supervisor-tray-"));
  const root = join(home, "app");
  const backup = join(home, "app.update-backup");
  createVersion(root, "0.13.22");
  createVersion(backup, "0.13.21");
  const events = [];
  try {
    const result = await superviseUpdate({
      rootDir: root, backupDir: backup, targetVersion: "0.13.22", previousVersion: "0.13.21", port: 18789,
      env: { MOMO_PROXY_HOME: home }, waitForParent: async () => true,
      trayRunningCheck: () => { events.push("tray-detected"); return true; },
      runCli: (_script, command) => { events.push(`cli:${Array.isArray(command) ? command.join(" " ) : command}`); return true; },
      healthCheck: async () => { events.push("healthy"); return true; },
      startTray: () => { events.push("tray-restored"); return true; },
    });
    assert.equal(result.activated, true);
    assert.equal(events.filter((event) => event === "tray-restored").length, 1);
    assert.ok(events.indexOf("tray-restored") > events.indexOf("healthy"));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("update leaves the tray closed when it was closed before activation", async () => {
  const home = mkdtempSync(join(tmpdir(), "momo-supervisor-no-tray-"));
  const root = join(home, "app");
  const backup = join(home, "app.update-backup");
  createVersion(root, "0.13.22");
  createVersion(backup, "0.13.21");
  let startCalls = 0;
  try {
    await superviseUpdate({
      rootDir: root, backupDir: backup, targetVersion: "0.13.22", previousVersion: "0.13.21", port: 18789,
      env: { MOMO_PROXY_HOME: home }, waitForParent: async () => true, trayRunningCheck: () => false,
      runCli: () => true, healthCheck: async () => true, startTray: () => { startCalls += 1; return true; },
    });
    assert.equal(startCalls, 0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("rollback restores a tray that was running before the failed update", async () => {
  const home = mkdtempSync(join(tmpdir(), "momo-supervisor-tray-rollback-"));
  const root = join(home, "app");
  const backup = join(home, "app.update-backup");
  createVersion(root, "0.13.22");
  createVersion(backup, "0.13.21");
  const healthVersions = [];
  let startCalls = 0;
  try {
    const result = await superviseUpdate({
      rootDir: root, backupDir: backup, targetVersion: "0.13.22", previousVersion: "0.13.21", port: 18789,
      env: { MOMO_PROXY_HOME: home }, waitForParent: async () => true, trayRunningCheck: () => true,
      runCli: () => true,
      healthCheck: async ({ expectedVersion }) => { healthVersions.push(expectedVersion); return expectedVersion === "0.13.21"; },
      startTray: () => { startCalls += 1; return true; },
    });
    assert.equal(result.rolledBack, true);
    assert.equal(result.restoredHealthy, true);
    assert.deepEqual(healthVersions, ["0.13.22", "0.13.21"]);
    assert.equal(startCalls, 1);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("managed image MCP shutdown terminates only exact matching node processes", async () => {
  const root = join("C:\\Users\\test\\.momoapi-proxy", "app");
  const target = join(root, "bin", "momoapi-proxy.mjs");
  const terminated = [];
  const waited = [];
  const stopped = await stopManagedImageMcpProcesses(root, {
    platform: "win32",
    listProcesses: () => [
      { ProcessId: 101, Name: "node.exe", CommandLine: `node "${target}" mcp image` },
      { ProcessId: 102, Name: "node.exe", CommandLine: `node "${target}" serve` },
      { ProcessId: 103, Name: "node.exe", CommandLine: "node unrelated.mjs mcp image" },
    ],
    terminate: (pid) => terminated.push(pid),
    waitForExit: async (pid) => { waited.push(pid); return true; },
  });
  assert.deepEqual(stopped, [101]);
  assert.deepEqual(terminated, [101]);
  assert.deepEqual(waited, [101]);
});

test("managed image MCP shutdown fails closed when an exact match remains alive", async () => {
  const root = join("C:\\Users\\test\\.momoapi-proxy", "app");
  const target = join(root, "bin", "momoapi-proxy.mjs");
  await assert.rejects(stopManagedImageMcpProcesses(root, {
    platform: "win32",
    listProcesses: () => [{ ProcessId: 101, Name: "node.exe", CommandLine: `node "${target}" mcp image` }],
    terminate: () => {},
    waitForExit: async () => false,
  }), (error) => error.code === "update_mcp_stop_failed");
});

test("managed image MCP shutdown still verifies exit when termination reports an error", async () => {
  const root = join("C:\\Users\\test\\.momoapi-proxy", "app");
  const target = join(root, "bin", "momoapi-proxy.mjs");
  const waited = [];
  const stopped = await stopManagedImageMcpProcesses(root, {
    platform: "win32",
    listProcesses: () => [{ ProcessId: 101, Name: "node.exe", CommandLine: `node "${target}" mcp image` }],
    terminate: () => { throw Object.assign(new Error("already exited"), { code: "ESRCH" }); },
    waitForExit: async (pid) => { waited.push(pid); return true; },
  });
  assert.deepEqual(stopped, [101]);
  assert.deepEqual(waited, [101]);
});

test("staged activation keeps the old tree and restores service when managed MCP shutdown fails", async () => {
  const home = mkdtempSync(join(tmpdir(), "momo-supervisor-mcp-failure-"));
  const root = join(home, "app");
  const staging = join(home, ".momoapi-proxy-update-stage");
  const backup = join(home, "app.update-backup");
  createVersion(root, "0.13.3");
  createVersion(staging, "0.13.4");
  const commands = [];
  try {
    const result = await superviseUpdate({
      rootDir: root, stagingDir: staging, backupDir: backup, targetVersion: "0.13.4", previousVersion: "0.13.3", port: 18789,
      env: { MOMO_PROXY_HOME: home }, waitForParent: async () => true,
      runCli: (_script, command) => { commands.push(command); return true; },
      stopMcpProcesses: async () => { throw Object.assign(new Error("still running"), { code: "update_mcp_stop_failed" }); },
      healthCheck: async ({ expectedVersion }) => expectedVersion === "0.13.3",
    });
    assert.deepEqual(result, { activated: false, rolledBack: false, restoredHealthy: true, errorCode: "update_mcp_stop_failed" });
    assert.deepEqual(commands, ["stop", "start"]);
    assert.equal(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version, "0.13.3");
    assert.equal(JSON.parse(readFileSync(join(staging, "package.json"), "utf8")).version, "0.13.4");
    const status = JSON.parse(readFileSync(join(home, "update-status.json"), "utf8"));
    assert.equal(status.status, "activation_failed");
    assert.equal(status.errorCode, "update_mcp_stop_failed");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("staged activation keeps the old tree and restores service when managed tray shutdown fails", async () => {
  const home = mkdtempSync(join(tmpdir(), "momo-supervisor-tray-failure-"));
  const root = join(home, "app");
  const staging = join(home, ".momoapi-proxy-update-stage");
  const backup = join(home, "app.update-backup");
  createVersion(root, "0.13.22");
  createVersion(staging, "0.13.23");
  const commands = [];
  let trayRestoreCalls = 0;
  try {
    const result = await superviseUpdate({
      rootDir: root, stagingDir: staging, backupDir: backup, targetVersion: "0.13.23", previousVersion: "0.13.22", port: 18789,
      env: { MOMO_PROXY_HOME: home }, waitForParent: async () => true, trayRunningCheck: () => true,
      runCli: (_script, command) => { commands.push(command); return true; },
      stopTrayProcesses: async () => { throw Object.assign(new Error("still running"), { code: "update_tray_stop_failed" }); },
      healthCheck: async ({ expectedVersion }) => expectedVersion === "0.13.22",
      startTray: () => { trayRestoreCalls += 1; return true; },
    });
    assert.deepEqual(result, { activated: false, rolledBack: false, restoredHealthy: true, errorCode: "update_tray_stop_failed" });
    assert.deepEqual(commands, ["stop", "start"]);
    assert.equal(trayRestoreCalls, 1);
    assert.equal(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version, "0.13.22");
    assert.equal(JSON.parse(readFileSync(join(staging, "package.json"), "utf8")).version, "0.13.23");
    const status = JSON.parse(readFileSync(join(home, "update-status.json"), "utf8"));
    assert.equal(status.status, "activation_failed");
    assert.equal(status.errorCode, "update_tray_stop_failed");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("staged activation falls back to transactional in-place replacement when directory swap is blocked", async () => {
  const home = mkdtempSync(join(tmpdir(), "momo-supervisor-stage-failure-"));
  const root = join(home, "app");
  const staging = join(home, ".momoapi-proxy-update-stage");
  const backup = join(home, "app.update-backup");
  createVersion(root, "0.13.2");
  createVersion(staging, "0.13.3");
  const commands = [];
  try {
    const result = await superviseUpdate({
      rootDir: root, stagingDir: staging, backupDir: backup, targetVersion: "0.13.3", previousVersion: "0.13.2", port: 18789,
      env: { MOMO_PROXY_HOME: home }, waitForParent: async () => true,
      runCli: (script, command) => { commands.push({ script, command }); return true; },
      healthCheck: async ({ expectedVersion }) => expectedVersion === "0.13.3",
      retry: async (operation) => operation(),
      move: (source, destination) => {
        if (source === staging) throw Object.assign(new Error("locked"), { code: "EPERM" });
        return renameSync(source, destination);
      },
    });
    assert.deepEqual(commands.map(({ command }) => command), ["stop", ["plugin", "install"], "start", ["plugin", "install"]]);
    assert.equal(result.activated, true);
    assert.equal(result.rolledBack, false);
    assert.equal(result.activationMode, "inplace");
    assert.equal(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version, "0.13.3");
    assert.equal(JSON.parse(readFileSync(join(backup, "package.json"), "utf8")).version, "0.13.2");
    assert.equal(JSON.parse(readFileSync(join(home, "update-status.json"), "utf8")).status, "active");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("transactional in-place activation restores the complete backup when replacement fails", async () => {
  const home = mkdtempSync(join(tmpdir(), "momo-supervisor-inplace-copy-failure-"));
  const root = join(home, "app");
  const staging = join(home, ".momoapi-proxy-update-stage");
  const backup = join(home, "app.update-backup");
  createVersion(root, "0.13.4");
  createVersion(staging, "0.13.5");
  writeFileSync(join(root, "previous-only.txt"), "preserve me");
  const commands = [];
  let replacementCalls = 0;
  try {
    const result = await superviseUpdate({
      rootDir: root, stagingDir: staging, backupDir: backup, targetVersion: "0.13.5", previousVersion: "0.13.4", port: 18789,
      env: { MOMO_PROXY_HOME: home }, waitForParent: async () => true,
      runCli: (_script, command) => { commands.push(command); return true; },
      healthCheck: async ({ expectedVersion }) => expectedVersion === "0.13.4",
      retry: async (operation) => operation(),
      move: (source, destination) => {
        if (source === staging) throw Object.assign(new Error("locked"), { code: "EPERM" });
        return renameSync(source, destination);
      },
      replaceContents: (destination, source) => {
        replacementCalls += 1;
        const version = JSON.parse(readFileSync(join(source, "package.json"), "utf8")).version;
        createVersion(destination, version);
        if (replacementCalls === 1) {
          writeFileSync(join(destination, "partial-new-file.txt"), "partial");
          throw Object.assign(new Error("copy failed"), { code: "EIO" });
        }
        rmSync(join(destination, "partial-new-file.txt"), { force: true });
        writeFileSync(join(destination, "previous-only.txt"), readFileSync(join(source, "previous-only.txt"), "utf8"));
      },
    });
    assert.deepEqual(result, { activated: false, rolledBack: true, restoredHealthy: true, errorCode: "update_inplace_failed" });
    assert.equal(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version, "0.13.4");
    assert.equal(readFileSync(join(root, "previous-only.txt"), "utf8"), "preserve me");
    assert.equal(JSON.parse(readFileSync(join(home, "update-status.json"), "utf8")).status, "rolled_back");
    assert.deepEqual(commands, ["stop", ["plugin", "install"], "start"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("transactional in-place activation restores the backup when target health fails", async () => {
  const home = mkdtempSync(join(tmpdir(), "momo-supervisor-inplace-health-failure-"));
  const root = join(home, "app");
  const staging = join(home, ".momoapi-proxy-update-stage");
  const backup = join(home, "app.update-backup");
  createVersion(root, "0.13.4");
  createVersion(staging, "0.13.5");
  const commands = [];
  const healthVersions = [];
  try {
    const result = await superviseUpdate({
      rootDir: root, stagingDir: staging, backupDir: backup, targetVersion: "0.13.5", previousVersion: "0.13.4", port: 18789,
      env: { MOMO_PROXY_HOME: home }, waitForParent: async () => true,
      runCli: (_script, command) => { commands.push(command); return true; },
      healthCheck: async ({ expectedVersion }) => { healthVersions.push(expectedVersion); return expectedVersion === "0.13.4"; },
      retry: async (operation) => operation(),
      move: (source, destination) => {
        if (source === staging) throw Object.assign(new Error("locked"), { code: "EPERM" });
        return renameSync(source, destination);
      },
    });
    assert.equal(result.activated, false);
    assert.equal(result.rolledBack, true);
    assert.equal(result.restoredHealthy, true);
    assert.equal(result.errorCode, "update_activation_failed");
    assert.deepEqual(healthVersions, ["0.13.5", "0.13.4"]);
    assert.deepEqual(commands, ["stop", ["plugin", "install"], "start", "stop", "start"]);
    assert.equal(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version, "0.13.4");
    assert.equal(JSON.parse(readFileSync(join(home, "update-status.json"), "utf8")).status, "rolled_back");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("staged activation accepts matching health after the start command times out", async () => {
  const home = mkdtempSync(join(tmpdir(), "momo-supervisor-start-timeout-"));
  const root = join(home, "app");
  const staging = join(home, ".momoapi-proxy-update-stage");
  const backup = join(home, "app.update-backup");
  createVersion(root, "0.10.2");
  createVersion(staging, "0.13.18");
  const healthVersions = [];
  try {
    const result = await superviseUpdate({
      rootDir: root, stagingDir: staging, backupDir: backup, targetVersion: "0.13.18", previousVersion: "0.10.2", port: 18789,
      env: { MOMO_PROXY_HOME: home }, waitForParent: async () => true,
      runCli: (_script, command) => command === "start"
        ? { ok: false, errorCode: "ETIMEDOUT" }
        : { ok: true, errorCode: null },
      healthCheck: async ({ expectedVersion }) => { healthVersions.push(expectedVersion); return expectedVersion === "0.13.18"; },
    });
    assert.equal(result.activated, true);
    assert.equal(result.activationMode, "swap");
    assert.deepEqual(healthVersions, ["0.13.18"]);
    const status = JSON.parse(readFileSync(join(home, "update-status.json"), "utf8"));
    assert.equal(status.status, "active");
    assert.equal(status.current, "0.13.18");
    assert.equal(status.activationCommandSucceeded, false);
    const log = readFileSync(join(home, "update-supervisor.log"), "utf8");
    assert.match(log, /ETIMEDOUT/);
    assert.match(log, /expected healthy version despite the command failure or timeout/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("rollback accepts delayed previous-version health after its start command times out", async () => {
  const home = mkdtempSync(join(tmpdir(), "momo-supervisor-rollback-timeout-"));
  const root = join(home, "app");
  const staging = join(home, ".momoapi-proxy-update-stage");
  const backup = join(home, "app.update-backup");
  createVersion(root, "0.10.2");
  createVersion(staging, "0.13.18");
  const healthVersions = [];
  try {
    const result = await superviseUpdate({
      rootDir: root, stagingDir: staging, backupDir: backup, targetVersion: "0.13.18", previousVersion: "0.10.2", port: 18789,
      env: { MOMO_PROXY_HOME: home }, waitForParent: async () => true,
      runCli: (_script, command) => command === "start"
        ? { ok: false, errorCode: "ETIMEDOUT" }
        : { ok: true, errorCode: null },
      healthCheck: async ({ expectedVersion }) => {
        healthVersions.push(expectedVersion);
        return expectedVersion === "0.10.2";
      },
    });
    assert.equal(result.activated, false);
    assert.equal(result.rolledBack, true);
    assert.equal(result.restoredHealthy, true);
    assert.equal(result.errorCode, "update_activation_failed");
    assert.deepEqual(healthVersions, ["0.13.18", "0.10.2"]);
    const status = JSON.parse(readFileSync(join(home, "update-status.json"), "utf8"));
    assert.equal(status.status, "rolled_back");
    assert.equal(status.checkFailed, false);
    assert.equal(status.failedTarget, "0.13.18");
    assert.equal(status.automaticRetryBlocked, true);
    assert.match(status.failedAt, /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("staged activation refuses directories outside the expected sibling layout", async () => {
  const home = mkdtempSync(join(tmpdir(), "momo-supervisor-layout-"));
  const root = join(home, "app");
  const unsafeStaging = join(home, "untrusted-stage");
  const backup = join(home, "app.update-backup");
  createVersion(root, "0.13.2");
  createVersion(unsafeStaging, "0.13.3");
  try {
    await assert.rejects(superviseUpdate({
      rootDir: root, stagingDir: unsafeStaging, backupDir: backup, targetVersion: "0.13.3", previousVersion: "0.13.2", port: 18789,
      env: { MOMO_PROXY_HOME: home }, waitForParent: async () => true,
      runCli: () => true, healthCheck: async () => true,
    }), (error) => error.code === "update_layout_unsafe");
    assert.equal(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version, "0.13.2");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
