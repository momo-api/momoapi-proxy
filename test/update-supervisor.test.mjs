import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
