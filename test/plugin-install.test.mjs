import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUNDLED_MARKETPLACE_ROOT, getImagePluginStatus, installImagePlugin, marketplaceMirrorRoot, materializeMarketplaceMirror } from "../src/plugin-install.mjs";

function result(stdout = "", status = 0, stderr = "", error = null) {
  return { status, stdout, stderr, error };
}

test("image plugin installer adds the bundled marketplace and enables the plugin", () => {
  const calls = [];
  const proxyHome = mkdtempSync(join(tmpdir(), "momo-plugin-install-"));
  const env = { MOMO_PROXY_HOME: proxyHome };
  const mirrorRoot = marketplaceMirrorRoot({ env });
  const runCodex = (args) => {
    calls.push(args);
    if (args[0] === "plugin" && args[1] === "marketplace" && args[2] === "list") {
      return result(JSON.stringify({ marketplaces: [{ name: "personal", root: "C:/Users/test" }] }));
    }
    if (args[0] === "plugin" && args[1] === "list") {
      return result(JSON.stringify({ installed: [{
        pluginId: "momo-image@momo-api",
        name: "momo-image",
        marketplaceName: "momo-api",
        version: "0.4.0",
        installed: true,
        enabled: true,
      }] }));
    }
    return result("{}");
  };

  try {
    const installed = installImagePlugin({ env, runCodex });
    assert.equal(installed.installed, true);
    assert.equal(installed.enabled, true);
    assert.equal(installed.marketplaceSource, "bundled");
    assert.deepEqual(calls, [
      ["plugin", "marketplace", "list", "--json"],
      ["plugin", "marketplace", "add", mirrorRoot, "--json"],
      ["plugin", "add", "momo-image@momo-api", "--json"],
      ["plugin", "list", "--json"],
    ]);
  } finally {
    rmSync(proxyHome, { recursive: true, force: true });
  }
});

test("image plugin installer is idempotent for its bundled local marketplace", () => {
  const calls = [];
  const proxyHome = mkdtempSync(join(tmpdir(), "momo-plugin-install-"));
  const env = { MOMO_PROXY_HOME: proxyHome };
  const mirrorRoot = materializeMarketplaceMirror({ env });
  const runCodex = (args) => {
    calls.push(args);
    if (args[1] === "marketplace") {
      return result(JSON.stringify({ marketplaces: [{ name: "momo-api", root: mirrorRoot }] }));
    }
    if (args[1] === "list") {
      return result(JSON.stringify({ installed: [{
        pluginId: "momo-image@momo-api",
        installed: true,
        enabled: true,
      }] }));
    }
    return result("{}");
  };

  try {
    const installed = installImagePlugin({ env, runCodex });
    assert.equal(installed.installed, true);
    assert.equal(installed.enabled, true);
    assert.equal(calls.some((args) => args[2] === "add" && args[1] === "marketplace"), false);
    assert.equal(calls.some((args) => args[2] === "upgrade"), false);
  } finally {
    rmSync(proxyHome, { recursive: true, force: true });
  }
});

test("image plugin installer replaces a previously configured marketplace with the bundled copy", () => {
  const calls = [];
  const runCodex = (args) => {
    calls.push(args);
    if (args[1] === "marketplace" && args[2] === "list") {
      return result(JSON.stringify({ marketplaces: [{ name: "momo-api", root: "C:/codex/cache/momo-api" }] }));
    }
    if (args[1] === "list") {
      return result(JSON.stringify({ installed: [{ pluginId: "momo-image@momo-api", installed: true, enabled: true }] }));
    }
    return result("{}");
  };

  const installed = installImagePlugin({ runCodex });
  assert.equal(installed.installed, true);
  assert.equal(installed.marketplaceSource, "bundled");
  assert.ok(calls.some((args) => args.join(" ") === "plugin marketplace remove momo-api --json"));
  assert.ok(calls.some((args) => args[0] === "plugin" && args[1] === "marketplace" && args[2] === "add"));
});

test("missing or old Codex does not make proxy setup unsafe", () => {
  const missing = installImagePlugin({
    runCodex: () => result("", null, "", Object.assign(new Error("missing"), { code: "ENOENT" })),
  });
  assert.equal(missing.installed, false);
  assert.equal(missing.errorCode, "codex_cli_not_found");

  const old = getImagePluginStatus({
    runCodex: () => result("", 2, "error: unrecognized subcommand 'plugin'"),
  });
  assert.equal(old.installed, false);
  assert.equal(old.errorCode, "codex_plugin_cli_unsupported");
});

test("Codex commands are passed as argument arrays without a shell", () => {
  const calls = [];
  const runCodex = (args) => {
    calls.push(args);
    if (args[1] === "marketplace" && args[2] === "list") return result(JSON.stringify({ marketplaces: [] }));
    if (args[1] === "list") return result(JSON.stringify({ installed: [] }));
    return result("{}");
  };
  installImagePlugin({ marketplaceRoot: BUNDLED_MARKETPLACE_ROOT, runCodex });
  assert.ok(calls.every(Array.isArray));
  assert.equal(calls.flat().some((value) => String(value).includes("&&")), false);
});

test("marketplace mirror contains only the public plugin bundle outside the application tree", () => {
  const proxyHome = mkdtempSync(join(tmpdir(), "momo-plugin-mirror-"));
  const env = { MOMO_PROXY_HOME: proxyHome };
  try {
    const mirror = materializeMarketplaceMirror({ env });
    assert.equal(mirror.startsWith(join(proxyHome, "marketplaces")), true);
    assert.notEqual(mirror, BUNDLED_MARKETPLACE_ROOT);
    assert.equal(materializeMarketplaceMirror({ env }), mirror);
  } finally {
    rmSync(proxyHome, { recursive: true, force: true });
  }
});
