#!/usr/bin/env node
import { spawnSync, spawn } from "node:child_process";
import { openSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promptApiKey, readApiKeyStdin } from "../src/key-input.mjs";
import { rotateApiKey, validateApiKey, credentialError } from "../src/credentials.mjs";
import { upgradeMacInstallRuntime } from "../src/install-runtime.mjs";
import { probeManagedRuntime, stopManagedRuntime } from "../src/runtime-control.mjs";
import { installMacDesktop, openMacDesktop } from "../src/macos-desktop.mjs";
import { installAutostart, uninstallAutostart } from "../src/autostart.mjs";
import { updateSettings } from "../src/config.mjs";
import { controlMacService } from "../src/macos-desktop.mjs";
import { readSettings, resolveSettings, resolveDaemonSettings, appHome, daemonEnvironment } from "../src/config.mjs";
import { listen } from "../src/server.mjs";
import { migrateManagedCompactionConfig, rollback, setup, uninstall } from "../src/setup.mjs";
import { catalogPath, readCatalog } from "../src/catalog.mjs";
import { syncCatalog, startAutoSync } from "../src/sync.mjs";
import { runDoctor } from "../src/doctor.mjs";
import { logPath, readRecentLogReport, logInfo, logError } from "../src/logger.mjs";
import { readLogTail } from "../src/log-tail.mjs";
import { checkAndRecordLatestVersion, getCurrentVersion, readUpdateStatus, startUpdateChecker, updateSelf, writeUpdateStatus } from "../src/updater.mjs";
import { writeRuntimePort, writeHeartbeat } from "../src/service.mjs";
import { installWindowsDesktop, refreshWindowsTray } from "../src/desktop-install.mjs";
import { runImageMcp } from "../src/mcp-image.mjs";
import { runVideoMcp } from "../src/mcp-video.mjs";
import { createImageAssetStore } from "../src/image-assets.mjs";
import { configureDiagnostics, readRecentDiagnosticReport, recordDiagnosticEvent } from "../src/diagnostics.mjs";
import { closeLogging, configureLoggingRuntime, createLoggingRuntime } from "../src/logging-runtime.mjs";
import { createSignalStopper } from "../src/process-shutdown.mjs";
import { getImagePluginStatus, installImagePlugin } from "../src/plugin-install.mjs";
import { codexRouteStatus, migrateManagedRouteAliases, readCodexCredential, resolveInstalledCliPath, restoreCodexRoute, switchCodexRoute } from "../src/codex-route.mjs";

process.on("uncaughtException", (err) => {
  logError("Uncaught Exception", err);
});
process.on("unhandledRejection", (reason) => {
  logError("Unhandled Rejection", reason);
});

function reportLogTailLimit(report) {
  if (!report.available && report.error !== "not_found") {
    console.error("Log tail unavailable: " + report.error);
    process.exitCode = 1;
  } else if (report.byteLimitReached) {
    const maxMiB = Math.max(1, Math.ceil((report.maxBytes || 1024 * 1024) / (1024 * 1024)));
    console.error("Log tail reached the " + maxMiB + " MiB read limit; older data and a leading partial record were omitted. Fewer than the requested lines may be shown.");
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
      if ((await probeManagedRuntime({ ...readSettings(), port })).running) return true;
    } catch (error) { if (error.code === "runtime_untrusted") throw error; }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

async function startDaemon(binFile, scriptDir, port) {
  if (await waitForHealth(port, 400)) {
    if (process.platform === "win32" && !hasFlag("--no-desktop")) {
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
    env: { ...daemonEnvironment(process.env), MOMO_PROXY_CONSOLE_MIRROR: "0" },
    windowsHide: true,
  });
  daemon.unref();

  if (process.platform === "win32" && !hasFlag("--no-desktop")) {
    installWindowsDesktop({ port });
  }

  const ok = await waitForHealth(port, 4000);
  if (!ok) {
    const recentError = readLogTail(logFile, 8).lines.join("\n");
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

async function inputKey() {
  if (value("--api-key")) throw new Error("Do not pass API Keys in command arguments. Use hidden input, --api-key-stdin or --api-key-env.");
  if (hasFlag("--api-key-stdin")) return readApiKeyStdin();
  if (hasFlag("--api-key-env")) return String(process.env.MOMO_API_KEY || "").trim();
  return promptApiKey();
}

async function changeConfiguredKey(apiKey, { allowLegacyInstallUpgrade = false } = {}) {
  const saved = readSettings();
  if (!saved.localToken) throw new Error("Install MOMO API Proxy first.");
  const port = Number(saved.port || 18789);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid saved proxy port.");
  let response;
  try {
    if (allowLegacyInstallUpgrade) {
      const capabilities = await fetch("http://127.0.0.1:" + port + "/internal/capabilities", {
        redirect: "error", signal: AbortSignal.timeout(3000), headers: { "x-local-token": saved.localToken },
      });
      if (capabilities.status === 404) {
        await capabilities.body?.cancel();
        await upgradeMacInstallRuntime({ ...saved, port }, { startRuntime: async () => {
          const script = fileURLToPath(import.meta.url);
          await startDaemon(script, dirname(script), port);
        } });
      } else {
        const result = await capabilities.json().catch(() => null);
        if (!capabilities.ok || result?.ok !== true || result.apiKeyChange !== true) throw new Error("Runtime credential capability could not be authenticated.");
      }
    }
    response = await fetch("http://127.0.0.1:" + port + "/internal/settings/api-key", {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(20000),
      headers: { "content-type": "application/json", "x-local-token": saved.localToken }, body: JSON.stringify({ apiKey }),
    });
  } catch (error) {
    if (error?.cause?.code !== "ECONNREFUSED") throw new Error("Cannot confirm runtime Key change. Check status before retrying.");
    return rotateApiKey(apiKey);
  }
  const result = await response.json().catch(() => null);
  if (!response.ok || !result?.ok) {
    // Never echo an arbitrary local server response, which may reflect a Key.
    const code = result?.error?.code;
    if (typeof code === "string" && /^key_[a-z_]+$/.test(code)) throw credentialError(code);
    throw new Error("Running proxy cannot complete safe Key changes. Check status or update/restart it first.");
  }
  return { ok: true, runtime: result.runtime === "reloaded" ? "reloaded" : "offline" };
}

async function main() {
  if (process.platform === "darwin" && ["start", "up", "daemon", "stop", "down", "restart"].includes(command)) {
    const action = ["start", "up", "daemon"].includes(command) ? "start" : ["stop", "down"].includes(command) ? "stop" : "restart";
    console.log(JSON.stringify(controlMacService(action)));
    return;
  }
  if (process.platform !== "darwin" && ["stop", "down", "restart"].includes(command)) {
    const settings = readSettings();
    await stopManagedRuntime(settings);
    if (command === "restart") {
      const binFile = fileURLToPath(import.meta.url);
      await startDaemon(binFile, dirname(binFile), Number(settings.port || 18789));
    } else writeHeartbeat({ running: false, port: settings.port });
    console.log(JSON.stringify({ ok: true, action: command }));
    return;
  }
  if (command === "service" && ["start", "stop", "restart"].includes(args[0]) && process.platform === "darwin") {
    console.log(JSON.stringify(controlMacService(args[0])));
    return;
  }
  if (command === "desktop" && ["install", "open"].includes(args[0]) && process.platform === "darwin") {
    console.log(JSON.stringify(args[0] === "open" ? openMacDesktop() : installMacDesktop()));
    return;
  }
  if (command === "autostart" && ["on", "off"].includes(args[0])) {
    const enabled = args[0] === "on";
    const settings = resolveDaemonSettings();
    if (enabled) installAutostart(settings); else uninstallAutostart();
    updateSettings({ autostart: enabled });
    console.log(JSON.stringify({ ok: true, autostart: enabled }));
    return;
  }
  if (command === "credential") {
    try {
      process.stdout.write(readCodexCredential(args[0]));
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
    return;
  }
  if (command === "desktop" && String(args[0] || "").toLowerCase() === "refresh") {
    const result = refreshWindowsTray();
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (command === "key" && args[0] === "change") {
    const apiKey = await inputKey();
    if (!apiKey) throw new Error("Key change cancelled; existing settings were not changed.");
    console.log(JSON.stringify(await changeConfiguredKey(apiKey)));
    return;
  }
  if (command === "auto") {
    let settings = null;
    let imagePluginResult = null;
    try { settings = resolveDaemonSettings(); } catch { settings = readSettings(); }
    const port = settings?.port || 18789;

    const binFile = fileURLToPath(import.meta.url);
    const scriptDir = dirname(binFile);

    if (!settings?.apiKey) {
      throw new Error("MOMO API Proxy is not configured. Run 'momoapi install' in a terminal first.");
    } else if (settings.imagePluginEnabled !== false) {
      imagePluginResult = getImagePluginStatus();
      if (!imagePluginResult.installed || !imagePluginResult.enabled) {
        imagePluginResult = installImagePlugin();
      }
    }

    if (imagePluginResult) {
      if (imagePluginResult.installed && imagePluginResult.enabled) {
        console.log("✅ MOMO Image / Video 媒体插件已安装并启用；新建 Codex 会话后生效。");
      } else {
        console.warn("⚠️ 媒体插件未自动启用: " + imagePluginResult.message);
      }
    }

    let isRunning = false;
    isRunning = (await probeManagedRuntime(settings)).running;

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
    const apiKey = await inputKey();
    if (!apiKey) throw new Error("Installation cancelled; no new settings were written.");
    const endpoint = value("--endpoint");
    const port = value("--port") ? Number(value("--port")) : undefined;
    const autostart = hasFlag("--no-autostart") ? false : undefined;
    const imagePlugin = hasFlag("--no-image-plugin") ? false : undefined;

    console.log("正在配置 MOMO API Proxy...");
    const existing = readSettings();
    // A previously trusted credential validation must not permit setup to
    // subsequently send the candidate to a different --endpoint.
    await validateApiKey(apiKey, { endpoint: endpoint || existing.endpoint || "https://momoapi.us" });
    if (existing.apiKey && existing.localToken) await changeConfiguredKey(apiKey, { allowLegacyInstallUpgrade: true });
    let result, installedSettings, desktop;
    try {
      result = await setup({ apiKey, endpoint, port, autostart, imagePlugin });
      installedSettings = readSettings();
      desktop = hasFlag("--no-desktop") ? { installed: false, message: "Headless installation requested." } : process.platform === "darwin" ? installMacDesktop() : installWindowsDesktop({ port: installedSettings.port, autostart: installedSettings.autostart });
    } catch {
      throw new Error(existing.apiKey && existing.localToken
        ? "API Key was changed, but remaining installation steps failed. This is partial success, not a full rollback. Run momoapi doctor."
        : "Installation did not complete. Some configuration may have been written; run momoapi doctor before retrying.");
    }
    console.log("MOMO API Proxy 配置成功！");
    console.log("  - 上游端点: " + (endpoint || "https://momoapi.us"));
    console.log("  - 本地代理: http://127.0.0.1:" + installedSettings.port + "/v1");
    console.log("  - 模型已同步: " + result.models + " (默认: " + result.defaultModel + ")");
    console.log("  - MOMO Image / Video 插件: " + (result.imagePlugin.installed && result.imagePlugin.enabled ? "已安装并启用" : result.imagePlugin.message));
    console.log("  - 桌面管理入口: " + (desktop?.installed ? "已安装" : (desktop?.message || "无")));
    if (result.imagePlugin.installed && result.imagePlugin.enabled) {
      console.log("  - 生图和生视频能力将在新建的 Codex 会话中加载");
    }
    console.log("\n运行 'momoapi start' 启动后台服务，或直接双击桌面 'MOMO API Proxy' 图标。");
  } else if (command === "start" || command === "up" || command === "daemon") {
    let settings = null;
    try { settings = resolveDaemonSettings(); } catch { settings = readSettings(); }
    const port = settings.port || 18789;
    let isRunning = false;
    isRunning = (await probeManagedRuntime(settings)).running;
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
  } else if (command === "serve") {
    try {
      const currentCliPath = fileURLToPath(import.meta.url);
      const migration = migrateManagedRouteAliases({ cliPath: resolveInstalledCliPath(currentCliPath) });
      if (migration.changed) console.log("Repaired managed Codex route aliases and model catalog for existing conversations. Restart Codex Desktop or VS Code to apply the route.");
    } catch (error) {
      console.warn("Managed Codex route aliases could not be updated:", error.message);
    }
    try {
      const migration = migrateManagedCompactionConfig();
      if (migration.changed) console.log("Removed legacy MOMO Codex compaction overrides. Start a new conversation to use the Codex defaults.");
    } catch (error) {
      console.warn("Managed Codex compaction settings could not be updated:", error.message);
    }
    const settings = resolveDaemonSettings();
    const loggingRuntime = createLoggingRuntime({ settings, diagnosticsEnabled: settings.diagnosticsEnabled });
    configureLoggingRuntime(loggingRuntime);
    configureDiagnostics({ settings, runtime: loggingRuntime });
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
    const server = await listen(settings, { loggingRuntime, onCredentialChanged: async (apiKey) => { settings.apiKey = apiKey; } });
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
        if (info.hasUpdate && settings.autoUpdateEnabled && !info.automaticUpdateBlocked && !automaticUpdateStarted) {
          automaticUpdateStarted = true;
          writeUpdateStatus({ status: "automatic_update_starting", latest: info.latest, hasUpdate: true, checkFailed: false });
          try {
            const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "update", "--automatic"], {
              detached: true,
              stdio: "ignore",
              windowsHide: true,
              env: daemonEnvironment(process.env),
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

    const stop = createSignalStopper({ server, loggingRuntime, timeoutMs: 1000, beforeStop: () => {
      console.log("\nStopping MOMO Codex Bridge...");
      clearInterval(heartbeatTimer);
      writeHeartbeat({ running: false, port: settings.port });
      autoSync.stop();
      updateChecker.stop();
    } });
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  } else if (command === "mcp" && args[0] === "image") {
    await runImageMcp();
  } else if (command === "mcp" && args[0] === "video") {
    await runVideoMcp();
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
    let health = null;
    let daemonMetrics = null;
    let metricsReason = "daemon_offline";
    if (settings.port) {
      try {
        const res = await fetch("http://127.0.0.1:" + settings.port + "/healthz", { signal: AbortSignal.timeout(1000) });
        if (res.ok) {
          isRunning = true;
          try { health = await res.json(); } catch {}
          if (settings.localToken) {
            try {
              const metricsResponse = await fetch("http://127.0.0.1:" + settings.port + "/internal/metrics", {
                headers: { "x-local-token": settings.localToken },
                signal: AbortSignal.timeout(1000),
              });
              if (metricsResponse.ok) daemonMetrics = await metricsResponse.json();
              else metricsReason = "daemon_metrics_rejected";
            } catch { metricsReason = "daemon_metrics_unavailable"; }
          } else metricsReason = "local_token_unavailable";
        }
      } catch {}
    }
    const catalog = readCatalog();
    isRunning = isRunning && health?.ok === true && health?.service === "momo-codex-bridge" && daemonMetrics?.ok === true;
    console.log(JSON.stringify({
      service: "momo-codex-bridge",
      running: isRunning,
      authenticatedRuntime: isRunning,
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
      version: getCurrentVersion(),
      runtimeVersion: daemonMetrics?.version || health?.version || null,
      diagnostics: daemonMetrics?.diagnostics || { available: false, reason: metricsReason },
      logging: daemonMetrics?.logging || { available: false, reason: metricsReason },
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
    });
    console.log("Sync completed. Total models: " + res.count + " (catalog " + (res.changed ? "updated" : "unchanged") + ").");
  } else if (command === "doctor") {
    const report = await runDoctor();
    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) process.exitCode = 1;
  } else if (command === "logs" || command === "log") {
    const count = Number(value("-n") || value("--lines") || 50);
    const report = readRecentLogReport(count);
    reportLogTailLimit(report);
    const logs = report.lines;
    if (!logs.length) {
      if (report.available || report.error === "not_found") console.log("No log entries in the bounded tail. (Log path: " + logPath() + ")");
    } else {
      console.log("=== Recent MOMO Codex Bridge Logs (Last " + logs.length + " entries) ===");
      console.log(logs.join("\n"));
      console.log("Log file: " + logPath());
    }
  } else if (command === "diagnostics" || command === "diagnostic") {
    const count = Number(value("-n") || value("--lines") || 100);
    const report = readRecentDiagnosticReport(count);
    reportLogTailLimit(report);
    const events = report.lines;
    if (!events.length) {
      if (report.available || report.error === "not_found") console.log("No diagnostic events in the bounded tail.");
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
      if (process.platform === "darwin") console.log(JSON.stringify(installMacDesktop()));
      else console.log("System Tray Companion is supported on Windows and macOS.");
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
  } else if (command === "route" || command === "codex-route") {
    const action = String(args[0] || "status").toLowerCase();
    if (action === "status") {
      console.log(JSON.stringify(codexRouteStatus(), null, 2));
    } else if (action === "restore" || action === "rollback") {
      const result = restoreCodexRoute();
      console.log("Codex route configuration restored:", result.restored);
    } else if (action === "direct" || action === "proxy") {
      const currentCliPath = fileURLToPath(import.meta.url);
      const settings = resolveSettings();
      if (action === "proxy" && !existsSync(catalogPath())) {
        await syncCatalog({ apiKey: settings.apiKey, endpoint: settings.endpoint });
      }
      const result = switchCodexRoute(action, { cliPath: resolveInstalledCliPath(currentCliPath), settings });
      console.log("Codex route switched to " + action + ": " + result.baseUrl);
      console.log("Codex model catalog switched to " + (result.catalog || "the built-in official catalog") + ".");
      console.log("Restart open Codex sessions to load the new route.");
    } else {
      throw new Error("Usage: momoapi-proxy route [status|direct|proxy|restore]");
    }
  } else if (command === "rollback") {
    const restored = rollback();
    console.log("Restored backup files:", restored);
  } else if (command === "update" || command === "upgrade") {
    const settings = resolveSettings();
    const force = hasFlag("--force");
    const automatic = hasFlag("--automatic");
    console.log("Checking for MOMO Codex Bridge updates (current: v" + getCurrentVersion() + ")...");
    let res;
    try {
      res = await updateSelf({ endpoint: settings.endpoint, force, automatic });
    } catch (error) {
      recordDiagnosticEvent({ event: "proxy_update_error", errorCode: error.code || "update_failed" }, { settings });
      throw error;
    }
    if (res.updated) {
      console.log(res.message);
      console.log("Syncing model catalogs...");
      try { await syncCatalog({ apiKey: settings.apiKey, endpoint: settings.endpoint }); } catch {}
      console.log("Update package verified. The proxy will restart in the background; the previous version will be restored automatically if startup fails.");
      try {
        const supervisor = res.supervisorPath || join(res.rootDir, "src", "update-supervisor.mjs");
        const child = spawn(process.execPath, [
          supervisor,
          "--root", res.rootDir,
          ...(res.stagingDir ? ["--staging", res.stagingDir] : []),
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
          cwd: dirname(res.rootDir),
          env: daemonEnvironment(process.env),
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
    console.log("MOMO API Proxy - Lightweight local Responses & Desktop Proxy\n\nUsage:\n  momoapi-proxy start                     - Start daemon & taskbar tray in background\n  momoapi-proxy stop                      - Stop running proxy service\n  momoapi-proxy restart                   - Restart proxy daemon & taskbar tray\n  momoapi-proxy serve                     - Run in foreground (live debug logs)\n  momoapi-proxy status                    - Check running status\n  momoapi-proxy route [status|direct|proxy|restore] - Switch the Codex route\n  momoapi-proxy models                    - List available synced models\n  momoapi-proxy plugin [status|install]   - Check or repair the MOMO Image plugin\n  momoapi-proxy images [list|info|clean]  - Manage images saved on this computer\n  momoapi-proxy sync                      - Sync model catalog from MOMO API\n  momoapi-proxy check-update              - Check and persist update availability\n  momoapi-proxy update [--force]          - Update to latest version\n  momoapi-proxy doctor                    - Run health diagnostics\n  momoapi-proxy diagnostics [-n 100]       - Print local-only error metadata for support\n  momoapi-proxy migrate-history           - Unify previous conversation histories\n  momoapi-proxy logs [-n 50]              - View recent request logs\n  momoapi-proxy tray                      - Launch taskbar tray companion\n  momoapi-proxy test <model>              - Run quick response test\n  momoapi-proxy rollback                  - Restore previous Codex config\n  momoapi-proxy uninstall [--remove-key]  - Uninstall proxy\n");
  }
}

main().catch((err) => {
  let settings;
  try { settings = resolveSettings(); } catch { settings = { diagnosticsEnabled: true }; }
  recordDiagnosticEvent({ event: "proxy_start_error", errorCode: err.code || "proxy_start_failed" }, { settings });
  console.error("Fatal error:", err.message);
  void closeLogging({ timeoutMs: 1000 }).finally(() => process.exit(1));
});
