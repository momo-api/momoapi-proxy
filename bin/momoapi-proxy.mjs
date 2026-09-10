#!/usr/bin/env node
import { spawnSync, spawn, execSync } from "node:child_process";
import { openSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline/promises";
import { readSettings, resolveSettings, appHome } from "../src/config.mjs";
import { listen } from "../src/server.mjs";
import { rollback, setup, uninstall } from "../src/setup.mjs";
import { readCatalog } from "../src/catalog.mjs";
import { syncCatalog, startAutoSync } from "../src/sync.mjs";
import { runDoctor } from "../src/doctor.mjs";
import { logPath, readRecentLogs, logInfo, logError } from "../src/logger.mjs";
import { checkAndRecordLatestVersion, getCurrentVersion, readUpdateStatus, startUpdateChecker, updateSelf, writeUpdateStatus } from "../src/updater.mjs";
import { writeRuntimePort, writeHeartbeat, stopWindowsService } from "../src/service.mjs";
import { installWindowsDesktop } from "../src/desktop-install.mjs";
import { runImageMcp } from "../src/mcp-image.mjs";
import { createImageAssetStore } from "../src/image-assets.mjs";
import { configureDiagnostics, getDiagnosticsMetrics, readRecentDiagnostics, recordDiagnosticEvent } from "../src/diagnostics.mjs";
import { getImagePluginStatus, installImagePlugin } from "../src/plugin-install.mjs";

process.on("uncaughtException", (err) => {
  logError("Uncaught Exception", err);
});
process.on("unhandledRejection", (reason) => {
  logError("Unhandled Rejection", reason);
});

function killWindowsProcessByPattern(pattern) {
  if (process.platform !== "win32") return;
  try {
    const wql = "CommandLine LIKE '%" + pattern.replace(/'/g, "''") + "%'";
    spawnSync("powershell.exe", [
      "-NoProfile",
      "-Command",
      "Get-CimInstance Win32_Process -Filter '" + wql + "' -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
    ], { stdio: "ignore" });
  } catch {}
}

function isWindowsProcessRunning(pattern) {
  if (process.platform !== "win32") return false;
  try {
    const wql = "CommandLine LIKE '%" + pattern.replace(/'/g, "''") + "%'";
    const res = spawnSync("powershell.exe", [
      "-NoProfile",
      "-Command",
      "Get-CimInstance Win32_Process -Filter '" + wql + "' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty ProcessId",
    ], { encoding: "utf8" });
    return Boolean(res.stdout && res.stdout.trim());
  } catch {
    return false;
  }
}

function daemonLogPath() {
  const dir = appHome();
  mkdirSync(dir, { recursive: true });
  return join(dir, "daemon.log");
}

async function waitForHealth(port, maxWaitMs = 3500) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      const res = await fetch("http://127.0.0.1:" + port + "/healthz");
      if (res.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

async function startDaemon(binFile, scriptDir, port) {
  if (await waitForHealth(port, 400)) {
    if (process.platform === "win32") {
      installWindowsDesktop({ port });
    }
    return true;
  }

  const logFile = daemonLogPath();
  let outStream = "ignore";
  try {
    const fd = openSync(logFile, "a");
    outStream = fd;
  } catch {}

  const daemon = spawn(process.execPath, [binFile, "serve"], {
    detached: true,
    stdio: ["ignore", outStream, outStream],
    windowsHide: true,
  });
  daemon.unref();

  if (process.platform === "win32") {
    installWindowsDesktop({ port });
  }

  const ok = await waitForHealth(port, 4000);
  if (!ok) {
    let recentError = "";
    if (existsSync(logFile)) {
      try {
        const lines = readFileSync(logFile, "utf8").trim().split("\n").slice(-8);
        recentError = lines.join("\n");
      } catch {}
    }
    throw new Error("MOMO API Proxy daemon failed to start on port " + port + (recentError ? ":\n" + recentError : "."));
  }
  return true;
}

const rawArgv = process.argv.slice(2);
const command = rawArgv.length === 0 ? "auto" : rawArgv[0];
const args = rawArgv.slice(1);
const value = (name) => {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
};
const hasFlag = (name) => args.includes(name);

async function promptApiKey() {
  console.log("\n==================================================================");
  console.log("             MOMO API Proxy — Windows 一键向导");
  console.log("==================================================================");
  console.log("欢迎使用 MOMO API Proxy 本地加速与协议网关！");
  console.log("检测到您是首次使用或尚未配置 API Key。");
  console.log("👉 如果您还没有 API Key，请在控制台获取: https://momoapi.us/console/token\n");

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const answer = await rl.question("请输入您的 MOMO API Key (例如 sk-...): ");
    return answer.trim();
  } finally {
    rl.close();
  }
}

async function main() {
  if (command === "auto") {
    let settings = null;
    let imagePluginResult = null;
    try { settings = resolveSettings(); } catch { settings = readSettings(); }
    const port = settings?.port || 18789;

    const binFile = fileURLToPath(import.meta.url);
    const scriptDir = dirname(binFile);

    if (!settings?.apiKey) {
      const enteredKey = await promptApiKey();
      if (!enteredKey) {
        console.error("❌ 错误: 未输入有效的 API Key，配置已中止。");
        process.exit(1);
      }
      console.log("\n正在为您自动配置 Codex 与模型目录...");
      const result = await setup({ apiKey: enteredKey, endpoint: "https://momoapi.us", port, autostart: true, desktopAliases: true, imagePlugin: true });
      console.log("✅ [1/4] 已写入 Codex 配置: ~/.codex/config.toml (Provider: momoapi-proxy)");
      console.log("✅ [2/4] 已同步模型目录: " + result.models + " 个模型 (默认: " + result.defaultModel + ")");
      imagePluginResult = result.imagePlugin;
      settings = { apiKey: enteredKey, endpoint: "https://momoapi.us", port, imagePluginEnabled: true };
    } else if (settings.imagePluginEnabled !== false) {
      imagePluginResult = getImagePluginStatus();
      if (!imagePluginResult.installed || !imagePluginResult.enabled) {
        imagePluginResult = installImagePlugin();
      }
    }

    if (imagePluginResult) {
      if (imagePluginResult.installed && imagePluginResult.enabled) {
        console.log("✅ MOMO Image 生图插件已安装并启用；新建 Codex 会话后生效。");
      } else {
        console.warn("⚠️ 生图插件未自动启用: " + imagePluginResult.message);
      }
    }

    let isRunning = false;
    try {
      const res = await fetch("http://127.0.0.1:" + port + "/healthz");
      if (res.ok) isRunning = true;
    } catch {}

    if (!isRunning) {
      console.log("✅ [3/5] 启动本地代理服务: http://127.0.0.1:" + port + "/v1");
      await startDaemon(binFile, scriptDir, port);
      
      const desktop = installWindowsDesktop({ port });
      if (desktop?.installed) {
        console.log("✅ [4/5] 已创建桌面快捷方式与开始菜单: 'MOMO API Proxy.lnk'");
        console.log("✅ [5/5] 系统托盘常驻就绪 (右下角任务栏已点亮图标)");
      } else {
        console.log("✅ [4/4] 代理服务常驻就绪");
      }

      console.log("\n🎉 MOMO API Proxy 安装与启动完成！");
      console.log("在 Codex 中选择 'momoapi-proxy' 即可开始享受极速编程与工具调用体验。");
      console.log("\n常用命令:\n  momoapi status   - 查看服务状态\n  momoapi models   - 查看可用模型\n  momoapi restart  - 重启代理服务\n  momoapi stop     - 停止代理服务");
    } else {
      installWindowsDesktop({ port });
      console.log("MOMO API Proxy 当前正在运行: http://127.0.0.1:" + port + "/v1 (托盘已激活)");
      const catalog = readCatalog();
      console.log("已同步模型数: " + (catalog?.models?.length || 0) + " (上游: " + (settings.endpoint || "https://momoapi.us") + ")");
      console.log("\n常用命令:\n  momoapi status   - 查看详细状态\n  momoapi models   - 查看可用模型\n  momoapi restart  - 重启服务与托盘\n  momoapi stop     - 停止服务\n  momoapi update   - 更新到最新版本");
    }
    return;
  }
  if (command === "setup" || command === "install") {
    let apiKey = value("--api-key") || process.env.MOMO_API_KEY;
    if (!apiKey) {
      apiKey = await promptApiKey();
      if (!apiKey) {
        console.error("Error: --api-key <MOMO_KEY> is required.");
        process.exit(1);
      }
    }
    const endpoint = value("--endpoint");
    const port = Number(value("--port") || 18789);
    const autostart = !hasFlag("--no-autostart");
    const desktopAliases = !hasFlag("--no-desktop-aliases");
    const imagePlugin = !hasFlag("--no-image-plugin");

    console.log("正在配置 MOMO API Proxy...");
    const result = await setup({ apiKey, endpoint, port, autostart, desktopAliases, imagePlugin });
    const desktop = installWindowsDesktop({ port });
    console.log("MOMO API Proxy 配置成功！");
    console.log("  - 上游端点: " + (endpoint || "https://momoapi.us"));
    console.log("  - 本地代理: http://127.0.0.1:" + port + "/v1");
    console.log("  - 模型已同步: " + result.models + " (默认: " + result.defaultModel + ")");
    console.log("  - MOMO Image 插件: " + (result.imagePlugin.installed && result.imagePlugin.enabled ? "已安装并启用" : result.imagePlugin.message));
    console.log("  - 桌面快捷方式: " + (desktop?.installed ? "已创建 (桌面/开始菜单/开机自启)" : "无"));
    if (result.imagePlugin.installed && result.imagePlugin.enabled) {
      console.log("  - 生图能力将在新建的 Codex 会话中加载");
    }
    console.log("\n运行 'momoapi start' 启动后台服务，或直接双击桌面 'MOMO API Proxy' 图标。");
  } else if (command === "start" || command === "up" || command === "daemon") {
    let settings = null;
    try { settings = resolveSettings(); } catch { settings = readSettings(); }
    const port = settings.port || 18789;
    let isRunning = false;
    try {
      const res = await fetch("http://127.0.0.1:" + port + "/healthz");
      if (res.ok) isRunning = true;
    } catch {}
    if (isRunning) {
      console.log("MOMO Codex Bridge is already running on http://127.0.0.1:" + port + "/v1");
      return;
    }
    console.log("Starting MOMO Codex Bridge daemon in background...");
    const binFile = fileURLToPath(import.meta.url);
    const scriptDir = dirname(binFile);
    await startDaemon(binFile, scriptDir, port);
    console.log("MOMO Codex Bridge started successfully!");
    console.log("  - Local Bridge: http://127.0.0.1:" + port + "/v1");
    console.log("  - Status: Running in background (Taskbar Tray active)");
  } else if (command === "stop" || command === "down") {
    let settings = null;
    try { settings = resolveSettings(); } catch { settings = readSettings(); }
    const port = settings.port || 18789;
    console.log("Stopping MOMO Codex Bridge on port " + port + "...");
    stopWindowsService();
    if (process.platform === "win32") {
      try {
        spawnSync("powershell.exe", [
          "-NoProfile",
          "-Command",
          `Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }`,
        ], { stdio: "ignore" });
        killWindowsProcessByPattern("tray.ps1");
        killWindowsProcessByPattern("momoapi-tray.exe");
        killWindowsProcessByPattern("MomoApiProxyTray.exe");
      } catch {}
    } else {
      try {
        execSync(`lsof -ti:${port} | xargs kill -9 2>/dev/null || fuser -k ${port}/tcp 2>/dev/null`, { stdio: "ignore" });
      } catch {}
    }
    writeHeartbeat({ running: false, port });
    console.log("MOMO Codex Bridge stopped.");
  } else if (command === "restart") {
    let settings = null;
    try { settings = resolveSettings(); } catch { settings = readSettings(); }
    const port = settings.port || 18789;
    console.log("Restarting MOMO Codex Bridge...");
    stopWindowsService();
    if (process.platform === "win32") {
      try {
        spawnSync("powershell.exe", [
          "-NoProfile",
          "-Command",
          `Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }`,
        ], { stdio: "ignore" });
        killWindowsProcessByPattern("tray.ps1");
        killWindowsProcessByPattern("momoapi-tray.exe");
        killWindowsProcessByPattern("MomoApiProxyTray.exe");
      } catch {}
    } else {
      try {
        execSync(`lsof -ti:${port} | xargs kill -9 2>/dev/null || fuser -k ${port}/tcp 2>/dev/null`, { stdio: "ignore" });
      } catch {}
    }
    await new Promise((r) => setTimeout(r, 400));
    const binFile = fileURLToPath(import.meta.url);
    const scriptDir = dirname(binFile);
    await startDaemon(binFile, scriptDir, port);
    console.log("MOMO Codex Bridge restarted successfully on http://127.0.0.1:" + port + "/v1");
  } else if (command === "serve") {
    const settings = resolveSettings();
    configureDiagnostics({ settings });
    const previousUpdateStatus = readUpdateStatus();
    if (previousUpdateStatus?.rolledBack && !previousUpdateStatus.failureReportedAt) {
      recordDiagnosticEvent({
        event: "proxy_update_error",
        errorCode: previousUpdateStatus.errorCode || "update_activation_failed",
      }, { settings });
      writeUpdateStatus({
        ...previousUpdateStatus,
        failureReportedAt: new Date().toISOString(),
      });
    }
    const server = await listen(settings);
    console.log("MOMO Codex Bridge listening at http://" + settings.host + ":" + settings.port + "/v1");
    writeRuntimePort(settings.port, process.pid);
    writeHeartbeat({ running: true, port: settings.port, endpoint: settings.endpoint });

    const autoSync = startAutoSync({
      settings,
      onSync: (err, res) => {
        writeHeartbeat({ running: true, port: settings.port, endpoint: settings.endpoint, lastSyncTime: new Date().toISOString() });
        if (err) {
          console.warn("[auto-sync] sync failed:", err.message);
          recordDiagnosticEvent({ event: "proxy_sync_error", errorCode: err.code || "catalog_sync_failed" }, { settings });
        }
        else if (res.changed) console.log("[auto-sync] catalog updated (" + res.count + " models).");
      },
    });
    let automaticUpdateStarted = false;
    const updateChecker = startUpdateChecker({
      endpoint: settings.endpoint,
      enabled: settings.updateCheckEnabled,
      intervalHours: settings.updateCheckIntervalHours,
      onCheck: (info) => {
        if (info.checkFailed) {
          recordDiagnosticEvent({ event: "proxy_update_check_error", errorCode: "all_update_sources_failed" }, { settings });
        }
        writeHeartbeat({
          running: true,
          port: settings.port,
          endpoint: settings.endpoint,
          updateAvailable: Boolean(info.hasUpdate),
          latestVersion: info.latest,
          updateCheckFailed: Boolean(info.checkFailed),
        });
        if (info.hasUpdate && settings.autoUpdateEnabled && !automaticUpdateStarted) {
          automaticUpdateStarted = true;
          writeUpdateStatus({ status: "automatic_update_starting", latest: info.latest, hasUpdate: true, checkFailed: false });
          try {
            const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "update", "--automatic"], {
              detached: true,
              stdio: "ignore",
              windowsHide: true,
            });
            if (!child.pid) throw new Error("Automatic update process did not start.");
            child.unref();
          } catch {
            automaticUpdateStarted = false;
            writeUpdateStatus({
              status: "automatic_update_start_failed",
              latest: info.latest,
              hasUpdate: true,
              checkFailed: true,
              errorCode: "automatic_update_start_failed",
            });
            recordDiagnosticEvent({ event: "proxy_update_error", errorCode: "automatic_update_start_failed" }, { settings });
          }
        }
      },
    });
    const heartbeatTimer = setInterval(() => {
      writeHeartbeat({ running: true, port: settings.port, endpoint: settings.endpoint });
    }, 5000);

    const stop = () => {
      console.log("\nStopping MOMO Codex Bridge...");
      clearInterval(heartbeatTimer);
      writeHeartbeat({ running: false, port: settings.port });
      autoSync.stop();
      updateChecker.stop();
      server.close(() => process.exit(0));
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  } else if (command === "mcp" && args[0] === "image") {
    await runImageMcp();
  } else if (command === "images" || command === "image-assets") {
    const settings = { imageAssetDirectory: join(appHome(), "images"), imageAssets: readSettings().imageAssets };
    const store = createImageAssetStore(settings);
    const action = args[0] || "list";
    if (action === "list") {
      const images = await store.list({ limit: Number(value("--limit") || 100) });
      console.log(JSON.stringify({ directory: settings.imageAssetDirectory, images }, null, 2));
    } else if (action === "info") {
      const assetId = args[1];
      if (!assetId) throw new Error("Usage: momoapi-proxy images info <asset_id>");
      console.log(JSON.stringify(await store.get(assetId), null, 2));
    } else if (action === "clean") {
      console.log(JSON.stringify(await store.cleanup(), null, 2));
    } else if (action === "delete") {
      const assetId = args[1];
      if (!assetId) throw new Error("Usage: momoapi-proxy images delete <asset_id>");
      console.log(JSON.stringify({ deleted: await store.remove(assetId) }, null, 2));
    } else {
      throw new Error("Usage: momoapi-proxy images [list|info <asset_id>|clean|delete <asset_id>]");
    }
  } else if (command === "plugin") {
    const action = args[0] || "status";
    if (action === "install" || action === "repair") {
      const result = installImagePlugin();
      console.log(JSON.stringify(result, null, 2));
      if (!result.installed || !result.enabled) process.exitCode = 1;
    } else if (action === "status") {
      const result = getImagePluginStatus();
      console.log(JSON.stringify(result, null, 2));
      if (!result.installed || !result.enabled) process.exitCode = 1;
    } else {
      throw new Error("Usage: momoapi-proxy plugin [install|repair|status]");
    }
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
      update: readUpdateStatus(),
      diagnostics: getDiagnosticsMetrics(),
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
  } else if (command === "diagnostics" || command === "diagnostic") {
    const count = Number(value("-n") || value("--lines") || 100);
    const events = readRecentDiagnostics(count);
    if (!events.length) {
      console.log("No diagnostic events recorded.");
    } else {
      console.log(events.join("\n"));
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
      const { dirname, join } = await import("node:path");
      const { fileURLToPath } = await import("node:url");
      const scriptDir = dirname(fileURLToPath(import.meta.url));
      const trayScript = join(scriptDir, "tray.ps1");
      const child = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Sta", "-WindowStyle", "Hidden", "-File", trayScript, "-Port", String(settings.port || 18789)], {
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
    let res;
    try {
      res = await updateSelf({ endpoint: settings.endpoint, force });
    } catch (error) {
      recordDiagnosticEvent({ event: "proxy_update_error", errorCode: error.code || "update_failed" }, { settings });
      throw error;
    }
    if (res.updated) {
      console.log(res.message);
      console.log("Syncing model catalogs...");
      try { await syncCatalog({ apiKey: settings.apiKey, endpoint: settings.endpoint, desktopAliases: settings.desktopAliases }); } catch {}
      console.log("Update completed. Verifying the new version; the previous version will be restored automatically if startup fails...");
      try {
        const supervisor = join(res.rootDir, "src", "update-supervisor.mjs");
        const child = spawn(process.execPath, [
          supervisor,
          "--root", res.rootDir,
          "--backup", res.backupDir,
          "--target", res.current,
          "--previous", res.previous,
          "--port", String(settings.port || 18789),
          "--parent-pid", String(process.pid),
          ...(settings.imagePluginEnabled === false ? ["--no-image-plugin"] : []),
        ], {
          detached: true,
          stdio: "ignore",
          windowsHide: true,
        });
        if (!child.pid) throw new Error("Update supervisor did not start.");
        child.unref();
      } catch (error) {
        writeUpdateStatus({
          status: "restart_supervisor_failed",
          latest: res.current,
          previous: res.previous,
          hasUpdate: false,
          checkFailed: true,
          errorCode: "update_supervisor_start_failed",
        });
        recordDiagnosticEvent({ event: "proxy_update_error", errorCode: "update_supervisor_start_failed" }, { settings });
        throw error;
      }
    } else {
      console.log(res.message);
    }
  } else if (command === "check-update") {
    const settings = resolveSettings();
    const info = await checkAndRecordLatestVersion({ endpoint: settings.endpoint });
    console.log(JSON.stringify(info, null, 2));
    if (info.checkFailed) process.exitCode = 1;
  } else if (command === "version" || command === "-v" || command === "--version") {
    console.log("momoapi-proxy v" + getCurrentVersion());
  } else if (command === "uninstall") {
    const result = uninstall({ removeKey: hasFlag("--remove-key") });
    console.log("Uninstall complete:", result);
  } else {
    console.log("MOMO API Proxy - Lightweight local Responses & Desktop Proxy\n\nUsage:\n  momoapi-proxy start                     - Start daemon & taskbar tray in background\n  momoapi-proxy stop                      - Stop running proxy service\n  momoapi-proxy restart                   - Restart proxy daemon & taskbar tray\n  momoapi-proxy serve                     - Run in foreground (live debug logs)\n  momoapi-proxy status                    - Check running status\n  momoapi-proxy models                    - List available synced models\n  momoapi-proxy plugin [status|install]   - Check or repair the MOMO Image plugin\n  momoapi-proxy images [list|info|clean]  - Manage images saved on this computer\n  momoapi-proxy sync                      - Sync model catalog from MOMO API\n  momoapi-proxy check-update              - Check and persist update availability\n  momoapi-proxy update [--force]          - Update to latest version\n  momoapi-proxy doctor                    - Run health diagnostics\n  momoapi-proxy diagnostics [-n 100]       - Print local-only error metadata for support\n  momoapi-proxy migrate-history           - Unify previous conversation histories\n  momoapi-proxy logs [-n 50]              - View recent request logs\n  momoapi-proxy tray                      - Launch taskbar tray companion\n  momoapi-proxy test <model>              - Run quick response test\n  momoapi-proxy rollback                  - Restore previous Codex config\n  momoapi-proxy uninstall [--remove-key]  - Uninstall proxy\n");
  }
}

main().catch((err) => {
  let settings;
  try { settings = resolveSettings(); } catch { settings = { diagnosticsEnabled: true }; }
  recordDiagnosticEvent({ event: "proxy_start_error", errorCode: err.code || "proxy_start_failed" }, { settings });
  console.error("Fatal error:", err.message);
  process.exit(1);
});
