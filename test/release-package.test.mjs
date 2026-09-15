import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildReleasePackage } from "../scripts/build-release-package.mjs";
import { validateUpdateArchive } from "../src/updater.mjs";

test("release package uses the updater-compatible root and version", () => {
  const fixture = mkdtempSync(join(tmpdir(), "momoapi-proxy-release-test-"));
  try {
    const result = buildReleasePackage({ outputDir: fixture });
    assert.equal(result.root, "momoapi-proxy/");
    assert.equal(existsSync(result.archive), true);
    assert.equal(existsSync(result.checksumFile), true);
    assert.deepEqual(validateUpdateArchive(result.archive), {
      entries: result.entries,
      expandedBytes: result.expandedBytes,
    });

    const names = execFileSync("tar", ["-tzf", result.archive], { encoding: "utf8" })
      .split(/\r?\n/)
      .filter(Boolean);
    assert.ok(names.length > 0);
    assert.ok(names.every((name) => name.startsWith("momoapi-proxy/")));
    assert.ok(names.includes("momoapi-proxy/bin/momoapi-proxy.mjs"));
    assert.ok(names.includes("momoapi-proxy/src/update-supervisor.mjs"));
    assert.ok(names.includes("momoapi-proxy/.agents/plugins/marketplace.json"));
    assert.ok(names.includes("momoapi-proxy/plugins/momo-image/.codex-plugin/plugin.json"));
    assert.ok(names.includes("momoapi-proxy/plugins/momo-image/skills/momo-image/SKILL.md"));

    const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    assert.equal(result.version, packageJson.version);
    assert.equal(
      readFileSync(result.checksumFile, "utf8"),
      result.sha256 + "  momoapi-proxy-" + packageJson.version + ".tgz\n",
    );
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
