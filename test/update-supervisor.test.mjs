import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isManagedImageMcpProcess, stopManagedImageMcpProcesses, superviseUpdate } from "../src/update-supervisor.mjs";

function createVersion(root, version) {
  mkdirSync(join(root, "bin"), { recursive: true });
  writeFileSync(join(root, "bin", "momoapi-proxy.mjs"), `// ${version}\n`);
  writeFileSync(join(root, "package.json"), JSON.stringify({ version }));
}

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
      healthCheck: async ({ expectedVersion }) => expectedVersion === "0.12.0",
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
      stopMcpProcesses: async () => { operations.push({ type: "mcp" }); return [1234]; },
      move: (source, destination) => { operations.push({ type: "move", source, destination }); return renameSync(source, destination); },
      healthCheck: async ({ expectedVersion }) => expectedVersion === "0.13.3",
    });
    assert.equal(result.activated, true);
    assert.equal(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version, "0.13.3");
    assert.equal(JSON.parse(readFileSync(join(backup, "package.json"), "utf8")).version, "0.13.2");
    assert.equal(operations[0].command, "stop");
    assert.equal(operations[1].type, "mcp");
    assert.equal(operations[2].type, "move");
    assert.equal(operations[4].command, "restart");
    assert.deepEqual(operations[5].command, ["plugin", "install"]);
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

test("staged activation restores the previous tree when the new tree cannot be moved into place", async () => {
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
      healthCheck: async ({ expectedVersion }) => expectedVersion === "0.13.2",
      retry: async (operation) => operation(),
      move: (source, destination) => {
        if (source === staging) throw Object.assign(new Error("locked"), { code: "EPERM" });
        return renameSync(source, destination);
      },
    });
    assert.equal(result.activated, false);
    assert.equal(result.rolledBack, true);
    assert.equal(result.restoredHealthy, true);
    assert.equal(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version, "0.13.2");
    assert.deepEqual(commands.map(({ command }) => command), ["stop", "start"]);
    assert.equal(JSON.parse(readFileSync(join(home, "update-status.json"), "utf8")).status, "rolled_back");
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
