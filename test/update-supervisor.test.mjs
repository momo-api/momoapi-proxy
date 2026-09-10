import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { superviseUpdate } from "../src/update-supervisor.mjs";

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
  const commands = [];
  try {
    const result = await superviseUpdate({
      rootDir: root, stagingDir: staging, backupDir: backup, targetVersion: "0.13.3", previousVersion: "0.13.2", port: 18789,
      env: { MOMO_PROXY_HOME: home }, waitForParent: async () => true,
      runCli: (script, command) => { commands.push({ script, command }); return true; },
      healthCheck: async ({ expectedVersion }) => expectedVersion === "0.13.3",
    });
    assert.equal(result.activated, true);
    assert.equal(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version, "0.13.3");
    assert.equal(JSON.parse(readFileSync(join(backup, "package.json"), "utf8")).version, "0.13.2");
    assert.equal(commands[0].command, "stop");
    assert.equal(commands[1].command, "restart");
    assert.deepEqual(commands[2].command, ["plugin", "install"]);
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
