#!/usr/bin/env node
import { readSettings, resolveSettings } from "../src/config.mjs";
import { listen } from "../src/server.mjs";
import { rollback, setup, uninstall } from "../src/setup.mjs";
import { readCatalog } from "../src/catalog.mjs";
import { syncCatalog, startAutoSync } from "../src/sync.mjs";
import { runDoctor } from "../src/doctor.mjs";
import { logPath, readRecentLogs } from "../src/logger.mjs";
import { checkLatestVersion, getCurrentVersion, updateSelf } from "../src/updater.mjs";

const [command = "help", ...args] = process.argv.slice(2);
const value = (name) => {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
};
const hasFlag = (name) => args.includes(name);

async function main() {
  if (command === "setup" || command === "install") {
    const apiKey = value("--api-key") || process.env.MOMO_API_KEY;
    if (!apiKey) {
      console.error("Error: --api-key <MOMO_KEY> is required (or set MOMO_API_KEY environment variable).");
      process.exit(1);
    }
    const endpoint = value("--endpoint");
    const port = Number(value("--port") || 18789);
    const autostart = !hasFlag("--no-autostart");
    const desktopAliases = !hasFlag("--no-desktop-aliases");

    console.log("Configuring MOMO Codex Bridge...");
    const result = await setup({ apiKey, endpoint, port, autostart, desktopAliases });
    console.log("MOMO Codex Bridge configured successfully!");
    console.log("  - Endpoint: " + (endpoint || "https://momoapi.us"));
    console.log("  - Local Bridge: http://127.0.0.1:" + port + "/v1");
    console.log("  - Models synced: " + result.models + " (default: " + result.defaultModel + ")");
    console.log("  - Autostart: " + (result.autostart?.installed ? "Enabled (" + result.autostart.type + ")" : "Disabled"));
    console.log("\nRun 'momo-codex-bridge doctor' to verify health, or 'momo-codex-bridge serve' to start now.");
  } else if (command === "serve" || command === "start") {
    const settings = resolveSettings();
    const server = await listen(settings);
    console.log("MOMO Codex Bridge listening at http://" + settings.host + ":" + settings.port + "/v1");
    
    const autoSync = startAutoSync({
      settings,
      onSync: (err, res) => {
        if (err) console.warn("[auto-sync] sync failed:", err.message);
        else if (res.changed) console.log("[auto-sync] catalog updated (" + res.count + " models).");
      },
    });

    const stop = () => {
      console.log("\nStopping MOMO Codex Bridge...");
      autoSync.stop();
      server.close(() => process.exit(0));
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  } else if (command === "status") {
    let settings = null;
    try {
      settings = resolveSettings();
    } catch {
      settings = readSettings();
    }
    let isRunning = false;
    if (settings.port) {
      try {
        const res = await fetch("http://127.0.0.1:" + settings.port + "/healthz");
        if (res.ok) isRunning = true;
      } catch {}
    }
    const catalog = readCatalog();
    console.log(JSON.stringify({
      service: "momo-codex-bridge",
      running: isRunning,
      endpoint: settings.endpoint || "https://momoapi.us",
      host: settings.host || "127.0.0.1",
      port: settings.port || 18789,
      keyConfigured: Boolean(settings.apiKey),
      localTokenConfigured: Boolean(settings.localToken),
      catalogModelsCount: catalog?.models?.length || 0,
      lastSyncTime: settings.lastSyncTime || null,
      lastSyncStatus: settings.lastSyncStatus || null,
      lastError: settings.lastError || null,
    }, null, 2));
  } else if (command === "models") {
    const catalog = readCatalog();
    if (!catalog?.models?.length) {
      console.log("No models synced yet. Run 'momo-codex-bridge sync' or 'momo-codex-bridge setup'.");
      return;
    }
    console.log("Available MOMO Codex Models (" + catalog.models.length + "):");
    for (const m of catalog.models) {
      const vis = m.visibility === "list" ? "[stable]" : "[experimental]";
      const reasoning = m.default_reasoning_level ? " (reasoning: " + m.default_reasoning_level + ")" : "";
      console.log("  * " + m.slug.padEnd(28) + " - " + m.display_name + " " + vis + reasoning);
    }
  } else if (command === "sync") {
    const settings = resolveSettings();
    console.log("Syncing models from " + settings.endpoint + "...");
    const res = await syncCatalog({
      apiKey: settings.apiKey,
      endpoint: settings.endpoint,
      desktopAliases: settings.desktopAliases,
    });
    console.log("Sync completed. Total models: " + res.count + " (catalog " + (res.changed ? "updated" : "unchanged") + ").");
  } else if (command === "doctor") {
    const report = await runDoctor();
    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) process.exitCode = 1;
  } else if (command === "logs" || command === "log") {
    const count = Number(value("-n") || value("--lines") || 50);
    const logs = readRecentLogs(count);
    if (!logs.length) {
      console.log("No log entries yet. (Log path: " + logPath() + ")");
    } else {
      console.log("=== Recent MOMO Codex Bridge Logs (Last " + logs.length + " entries) ===");
      console.log(logs.join("\n"));
      console.log("Log file: " + logPath());
    }
  } else if (command === "test") {
    const model = args[0] || "gpt-5.5";
    const settings = resolveSettings();
    console.log("Sending test stream request for model '" + model + "' to http://127.0.0.1:" + settings.port + "/v1/responses ...");
    try {
      const res = await fetch("http://127.0.0.1:" + settings.port + "/v1/responses", {
        method: "POST",
        headers: {
          authorization: "Bearer " + settings.localToken,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model,
          stream: true,
          input: [{ role: "user", content: [{ type: "input_text", text: "Reply with MOMO_TEST_OK" }] }],
        }),
      });
      if (!res.ok) {
        console.error("Test failed (" + res.status + "):", await res.text());
        process.exit(1);
      }
      const text = await res.text();
      console.log("Test succeeded! Received SSE response length: " + text.length + " bytes.");
      console.log("Sample response:", text.slice(0, 300));
    } catch (err) {
      console.error("Test failed:", err.message);
      console.error("Make sure 'momo-codex-bridge serve' is running.");
      process.exit(1);
    }
    } else if (command === "tray") {
    const settings = resolveSettings();
    if (process.platform === "win32") {
      const { spawn } = await import("node:child_process");
      const { dirname, join } = await import("node:path");
      const { fileURLToPath } = await import("node:url");
      const scriptDir = dirname(fileURLToPath(import.meta.url));
      const trayScript = join(scriptDir, "tray.ps1");
      const child = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", trayScript, "-Port", String(settings.port || 18789)], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      child.unref();
      console.log("MOMO Codex Bridge System Tray Companion launched.");
    } else {
      console.log("System Tray Companion is currently supported on Windows.");
    }
  } else if (command === "migrate-history" || command === "history") {
    const { migrateHistory } = await import("../src/history.mjs");
    const { codexHome } = await import("../src/catalog.mjs");
    const { join } = await import("node:path");
    const dbPath = join(codexHome(), "state_5.sqlite");
    console.log("Migrating past session history in " + dbPath + " to 'momoapi-proxy'...");
    const res = await migrateHistory({ dbPath, targetProvider: "momoapi-proxy" });
    if (!res.dbFound) {
      console.log("No Codex state_5.sqlite database found (no previous sessions).");
    } else if (res.error) {
      console.error("Migration error:", res.error);
    } else {
      console.log("Successfully migrated " + res.migrated + " session(s) to 'momoapi-proxy' (method: " + res.method + ")!");
      console.log("Your previous conversation histories are now unified and preserved under MOMO API Proxy.");
    }
  } else if (command === "rollback") {
    const restored = rollback();
    console.log("Restored backup files:", restored);
  } else if (command === "update" || command === "upgrade") {
    const settings = resolveSettings();
    const force = hasFlag("--force");
    console.log("Checking for MOMO Codex Bridge updates (current: v" + getCurrentVersion() + ")...");
    const res = await updateSelf({ endpoint: settings.endpoint, force });
    if (res.updated) {
      console.log(res.message);
      console.log("Syncing model catalogs...");
      try { await syncCatalog({ apiKey: settings.apiKey, endpoint: settings.endpoint, desktopAliases: settings.desktopAliases }); } catch {}
      console.log("Update completed. Please restart 'momo-codex-bridge serve' if running.");
    } else {
      console.log(res.message);
    }
  } else if (command === "version" || command === "-v" || command === "--version") {
    console.log("momo-codex-bridge v" + getCurrentVersion());
  } else if (command === "uninstall") {
    const result = uninstall({ removeKey: hasFlag("--remove-key") });
    console.log("Uninstall complete:", result);
  } else {
    console.log("MOMO Codex Bridge - Lightweight local Responses & Desktop Proxy\n\nUsage:\n  momo-codex-bridge install --api-key <MOMO_KEY> [--endpoint URL] [--port PORT]\n  momo-codex-bridge serve\n  momo-codex-bridge status\n  momo-codex-bridge models\n  momo-codex-bridge sync\n  momo-codex-bridge update [--force]\n  momo-codex-bridge doctor\n  momo-codex-bridge migrate-history\n  momo-codex-bridge logs [-n 50]\n  momo-codex-bridge test <model>\n  momo-codex-bridge rollback\n  momo-codex-bridge uninstall [--remove-key]\n");
  }
}

main().catch((err) => {
  console.error("Fatal error:", err.message);
  process.exit(1);
});
