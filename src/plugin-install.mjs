import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
export const BUNDLED_MARKETPLACE_ROOT = dirname(MODULE_DIR);
export const IMAGE_PLUGIN_ID = "momo-image@momo-api";
export const IMAGE_PLUGIN_NAME = "momo-image";
export const IMAGE_MARKETPLACE_NAME = "momo-api";

function executeCodex(args, { env = process.env, timeoutMs = 120_000 } = {}) {
  const result = spawnSync("codex", args, {
    encoding: "utf8",
    env,
    windowsHide: true,
    timeout: timeoutMs,
    shell: false,
  });
  return {
    status: result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    error: result.error || null,
  };
}

function parseJson(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  try { return JSON.parse(raw); } catch {}
  const objectStart = raw.indexOf("{");
  const arrayStart = raw.indexOf("[");
  const start = objectStart < 0 ? arrayStart : (arrayStart < 0 ? objectStart : Math.min(objectStart, arrayStart));
  if (start < 0) return null;
  try { return JSON.parse(raw.slice(start)); } catch { return null; }
}

function commandFailure(result, fallbackCode) {
  if (result?.error?.code === "ENOENT") {
    return {
      errorCode: "codex_cli_not_found",
      message: "Codex CLI was not found. Install or update Codex, then run 'momoapi plugin install'.",
    };
  }
  const output = String(result?.stderr || "") + "\n" + String(result?.stdout || "");
  const lowerOutput = output.toLowerCase();
  if (lowerOutput.includes("unrecognized subcommand") || lowerOutput.includes("unknown command")) {
    return {
      errorCode: "codex_plugin_cli_unsupported",
      message: "This Codex version does not support plugins. Update Codex, then run 'momoapi plugin install'.",
    };
  }
  if (result?.error?.code === "ETIMEDOUT") {
    return {
      errorCode: "codex_plugin_install_timeout",
      message: "Codex plugin installation timed out. Run 'momoapi plugin install' to retry.",
    };
  }
  return {
    errorCode: fallbackCode,
    message: "MOMO Image plugin installation did not complete. Run 'momoapi plugin install' to retry.",
  };
}

function normalizeComparablePath(value) {
  if (!value) return "";
  return normalize(String(value).replace(/^\\\\\?\\/, "")).toLowerCase();
}

function installedPluginFrom(payload) {
  return payload?.installed?.find?.((plugin) => plugin.pluginId === IMAGE_PLUGIN_ID || (
    plugin.name === IMAGE_PLUGIN_NAME && plugin.marketplaceName === IMAGE_MARKETPLACE_NAME
  )) || null;
}

export function getImagePluginStatus({ env = process.env, runCodex = executeCodex } = {}) {
  const result = runCodex(["plugin", "list", "--json"], { env });
  if (result.status !== 0 || result.error) {
    const failure = commandFailure(result, "codex_plugin_status_failed");
    return {
      attempted: true,
      installed: false,
      enabled: false,
      pluginId: IMAGE_PLUGIN_ID,
      marketplace: IMAGE_MARKETPLACE_NAME,
      ...failure,
    };
  }
  const payload = parseJson(result.stdout);
  const plugin = installedPluginFrom(payload);
  return {
    attempted: true,
    installed: Boolean(plugin?.installed),
    enabled: Boolean(plugin?.enabled),
    pluginId: IMAGE_PLUGIN_ID,
    marketplace: IMAGE_MARKETPLACE_NAME,
    version: plugin?.version || null,
    installedPath: plugin?.installedPath || null,
    errorCode: null,
    message: plugin?.installed
      ? (plugin.enabled ? "MOMO Image plugin is installed and enabled." : "MOMO Image plugin is installed but disabled.")
      : "MOMO Image plugin is not installed.",
  };
}

export function installImagePlugin({
  env = process.env,
  marketplaceRoot = BUNDLED_MARKETPLACE_ROOT,
  runCodex = executeCodex,
} = {}) {
  const resolvedRoot = resolve(marketplaceRoot);
  const manifest = join(resolvedRoot, ".agents", "plugins", "marketplace.json");
  if (!existsSync(manifest)) {
    return {
      attempted: true,
      installed: false,
      enabled: false,
      pluginId: IMAGE_PLUGIN_ID,
      marketplace: IMAGE_MARKETPLACE_NAME,
      errorCode: "bundled_marketplace_missing",
      message: "The MOMO Image plugin files are missing from this proxy installation.",
    };
  }

  const marketplaceList = runCodex(["plugin", "marketplace", "list", "--json"], { env });
  if (marketplaceList.status !== 0 || marketplaceList.error) {
    const failure = commandFailure(marketplaceList, "codex_marketplace_status_failed");
    return {
      attempted: true,
      installed: false,
      enabled: false,
      pluginId: IMAGE_PLUGIN_ID,
      marketplace: IMAGE_MARKETPLACE_NAME,
      ...failure,
    };
  }

  const marketplaces = parseJson(marketplaceList.stdout)?.marketplaces || [];
  const configured = marketplaces.find((marketplace) => marketplace.name === IMAGE_MARKETPLACE_NAME);
  let marketplaceSource = "configured";

  if (!configured) {
    const addMarketplace = runCodex(["plugin", "marketplace", "add", resolvedRoot, "--json"], { env });
    if (addMarketplace.status !== 0 || addMarketplace.error) {
      const failure = commandFailure(addMarketplace, "codex_marketplace_add_failed");
      return {
        attempted: true,
        installed: false,
        enabled: false,
        pluginId: IMAGE_PLUGIN_ID,
        marketplace: IMAGE_MARKETPLACE_NAME,
        marketplaceSource: "bundled",
        ...failure,
      };
    }
    marketplaceSource = "bundled";
  } else if (normalizeComparablePath(configured.root) !== normalizeComparablePath(resolvedRoot)) {
    const removeMarketplace = runCodex(["plugin", "marketplace", "remove", IMAGE_MARKETPLACE_NAME, "--json"], { env });
    if (removeMarketplace.status !== 0 || removeMarketplace.error) {
      const failure = commandFailure(removeMarketplace, "codex_marketplace_replace_failed");
      return {
        attempted: true,
        installed: false,
        enabled: false,
        pluginId: IMAGE_PLUGIN_ID,
        marketplace: IMAGE_MARKETPLACE_NAME,
        marketplaceSource: "configured",
        ...failure,
      };
    }
    const addMarketplace = runCodex(["plugin", "marketplace", "add", resolvedRoot, "--json"], { env });
    if (addMarketplace.status !== 0 || addMarketplace.error) {
      const failure = commandFailure(addMarketplace, "codex_marketplace_add_failed");
      return {
        attempted: true,
        installed: false,
        enabled: false,
        pluginId: IMAGE_PLUGIN_ID,
        marketplace: IMAGE_MARKETPLACE_NAME,
        marketplaceSource: "bundled",
        ...failure,
      };
    }
    marketplaceSource = "bundled";
  } else {
    marketplaceSource = "bundled";
  }

  const addPlugin = runCodex(["plugin", "add", IMAGE_PLUGIN_ID, "--json"], { env });
  const finalStatus = getImagePluginStatus({ env, runCodex });
  if (addPlugin.status !== 0 || addPlugin.error) {
    if (finalStatus.installed && finalStatus.enabled) {
      return {
        ...finalStatus,
        marketplaceSource,
        message: "MOMO Image plugin is already installed and enabled.",
      };
    }
    const failure = commandFailure(addPlugin, "codex_plugin_install_failed");
    return {
      ...finalStatus,
      marketplaceSource,
      ...failure,
    };
  }

  if (!finalStatus.installed || !finalStatus.enabled) {
    return {
      ...finalStatus,
      marketplaceSource,
      errorCode: finalStatus.installed ? "codex_plugin_disabled" : "codex_plugin_install_unverified",
      message: finalStatus.installed
        ? "MOMO Image plugin was installed but is not enabled. Enable it in Codex before starting a new conversation."
        : "Codex completed the install command, but the MOMO Image plugin could not be verified.",
    };
  }

  return {
    ...finalStatus,
    marketplaceSource,
    message: "MOMO Image plugin is installed and enabled. Start a new Codex conversation to load it.",
  };
}
