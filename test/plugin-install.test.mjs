import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { BUNDLED_MARKETPLACE_ROOT, codexExecutableCandidates, getImagePluginStatus, installImagePlugin, marketplaceMirrorRoot, materializeMarketplaceMirror } from "../src/plugin-install.mjs";

function result(stdout = "", status = 0, stderr = "", error = null) {
  return { status, stdout, stderr, error };
}

test("media plugin installer adds the bundled marketplace and enables both plugins", () => {
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
      }, {
        pluginId: "momo-video@momo-api",
        name: "momo-video",
        marketplaceName: "momo-api",
        version: "0.1.0",
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
    assert.deepEqual(Object.keys(installed.plugins), ["momo-image", "momo-video"]);
    assert.equal(installed.marketplaceSource, "bundled");
    assert.deepEqual(calls, [
      ["plugin", "marketplace", "list", "--json"],
      ["plugin", "marketplace", "add", mirrorRoot, "--json"],
      ["plugin", "add", "momo-image@momo-api", "--json"],
      ["plugin", "add", "momo-video@momo-api", "--json"],
      ["plugin", "list", "--json"],
    ]);
  } finally {
    rmSync(proxyHome, { recursive: true, force: true });
  }
});

test("media plugin installer is idempotent for its bundled local marketplace", () => {
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
      }, {
        pluginId: "momo-video@momo-api",
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

test("media plugin installer replaces a previously configured marketplace with the bundled copy", () => {
  const calls = [];
  const proxyHome = mkdtempSync(join(tmpdir(), "momo-plugin-install-"));
  const env = { MOMO_PROXY_HOME: proxyHome };
  const runCodex = (args) => {
    calls.push(args);
    if (args[1] === "marketplace" && args[2] === "list") {
      return result(JSON.stringify({ marketplaces: [{ name: "momo-api", root: "C:/codex/cache/momo-api" }] }));
    }
    if (args[1] === "list") {
      return result(JSON.stringify({ installed: [
        { pluginId: "momo-image@momo-api", installed: true, enabled: true },
        { pluginId: "momo-video@momo-api", installed: true, enabled: true },
      ] }));
    }
    return result("{}");
  };

  try {
    const installed = installImagePlugin({ env, runCodex });
    assert.equal(installed.installed, true);
    assert.equal(installed.marketplaceSource, "bundled");
    assert.ok(calls.some((args) => args.join(" ") === "plugin marketplace remove momo-api --json"));
    assert.ok(calls.some((args) => args[0] === "plugin" && args[1] === "marketplace" && args[2] === "add"));
  } finally {
    rmSync(proxyHome, { recursive: true, force: true });
  }
});

test("missing or old Codex does not make proxy setup unsafe", () => {
  const proxyHome = mkdtempSync(join(tmpdir(), "momo-plugin-install-"));
  const env = { MOMO_PROXY_HOME: proxyHome };
  try {
    const missing = installImagePlugin({
      env,
      runCodex: () => result("", null, "", Object.assign(new Error("missing"), { code: "ENOENT" })),
    });
    assert.equal(missing.installed, false);
    assert.equal(missing.errorCode, "codex_cli_not_found");

    const old = getImagePluginStatus({
      env,
      runCodex: () => result("", 2, "error: unrecognized subcommand 'plugin'"),
    });
    assert.equal(old.installed, false);
    assert.equal(old.errorCode, "codex_plugin_cli_unsupported");
  } finally {
    rmSync(proxyHome, { recursive: true, force: true });
  }
});

test("discovers the Codex Desktop executable without relying on PATH", () => {
  const root = mkdtempSync(join(tmpdir(), "momo-codex-desktop-"));
  const localAppData = join(root, "AppData", "Local");
  const desktopExecutable = join(localAppData, "OpenAI", "Codex", "bin", "runtime-1", "codex.exe");
  try {
    mkdirSync(dirname(desktopExecutable), { recursive: true });
    writeFileSync(desktopExecutable, "test executable placeholder");
    const candidates = codexExecutableCandidates({
      platform: "win32",
      env: { USERPROFILE: root, LOCALAPPDATA: localAppData, APPDATA: join(root, "AppData", "Roaming"), PATH: "" },
    });
    assert.equal(candidates[0], desktopExecutable);
    assert.equal(candidates.at(-1), "codex.exe");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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

test("marketplace mirror contains only the public media plugin bundle outside the application tree", () => {
  const proxyHome = mkdtempSync(join(tmpdir(), "momo-plugin-mirror-"));
  const env = { MOMO_PROXY_HOME: proxyHome };
  try {
    const mirror = materializeMarketplaceMirror({ env });
    assert.equal(mirror.startsWith(join(proxyHome, "marketplaces")), true);
    assert.notEqual(mirror, BUNDLED_MARKETPLACE_ROOT);
    assert.match(readFileSync(join(mirror, "plugins", "momo-video", ".codex-plugin", "plugin.json"), "utf8"), /momo-video/);
    assert.equal(materializeMarketplaceMirror({ env }), mirror);
  } finally {
    rmSync(proxyHome, { recursive: true, force: true });
  }
});

test("MOMO Image declares the default routing preference in plugin metadata and skill instructions", () => {
  const pluginRoot = join(BUNDLED_MARKETPLACE_ROOT, "plugins", "momo-image");
  const manifest = JSON.parse(readFileSync(join(pluginRoot, ".codex-plugin", "plugin.json"), "utf8"));
  const skill = readFileSync(join(pluginRoot, "skills", "momo-image", "SKILL.md"), "utf8");
  const agent = readFileSync(join(pluginRoot, "skills", "momo-image", "agents", "openai.yaml"), "utf8");
  for (const value of [manifest.interface.defaultPrompt, skill, agent]) {
    assert.match(value, /MOMO Image.*default/i);
    assert.match(value, /official ImageGen.*explicit/i);
  }
});

test("MOMO Video declares dynamic capabilities and remote-only default storage", () => {
  const pluginRoot = join(BUNDLED_MARKETPLACE_ROOT, "plugins", "momo-video");
  const manifest = JSON.parse(readFileSync(join(pluginRoot, ".codex-plugin", "plugin.json"), "utf8"));
  const skill = readFileSync(join(pluginRoot, "skills", "momo-video", "SKILL.md"), "utf8");
  assert.match(manifest.interface.defaultPrompt, /video_capabilities/);
  assert.match(skill, /Do not infer capabilities from model names/);
  assert.match(skill, /Do not download or duplicate the video/);
});
