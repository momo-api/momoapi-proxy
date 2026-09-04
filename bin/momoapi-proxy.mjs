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
import { checkLatestVersion, getCurrentVersion, updateSelf } from "../src/updater.mjs";
import { writeRuntimePort, writeHeartbeat, stopWindowsService } from "../src/service.mjs";
import { installWindowsDesktop } from "../src/desktop-install.mjs";

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
  const logFile = daemonLogPath();
  const out = openSync(logFile, "a");
  const err = openSync(logFile, "a");

  const daemon = spawn(process.execPath, [binFile, "serve"], {
    detached: true,
    stdio: ["ignore", out, err],
    windowsHide: true,
  });
  daemon.unref();

  if (process.platform === "win32") {
    killWindowsProcessByPattern("tray.ps1");
    const trayScript = join(scriptDir, "tray.ps1");
    if (existsSync(trayScript)) {
      const tray = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Sta", "-WindowStyle", "Hidden", "-File", trayScript, "-Port", String(port)], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      tray.unref();
    }
  }

  const ok = await waitForHealth(port, 3500);
  if (!ok) {
    let recentError = "";
    if (existsSync(logFile)) {
      try {
        const lines = readFileSync(logFile, "utf8").trim().split("\n").slice(-8);
        recentError = lines.join("\n");
      } catch {}
    }
    throw new Error("MOMO Codex Bridge daemon failed to start on port " + port + (recentError ? ":\n" + recentError : "."));
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
      const result = await setup({ apiKey: enteredKey, endpoint: "https://momoapi.us", port, autostart: true, desktopAliases: true });
      console.log("✅ [1/4] 已写入 Codex 配置: ~/.codex/config.toml (Provider: momoapi-proxy)");
      console.log("✅ [2/4] 已同步模型目录: " + result.models + " 个模型 (默认: " + result.defaultModel + ")");
      settings = { apiKey: enteredKey, endpoint: "https://momoapi.us", port };
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

    console.log("正在配置 MOMO API Proxy...");
    const result = await setup({ apiKey, endpoint, port, autostart, desktopAliases });
    const desktop = installWindowsDesktop({ port });
    console.log("MOMO API Proxy 配置成功！");
    console.log("  - 上游端点: " + (endpoint || "https://momoapi.us"));
    console.log("  - 本地代理: http://127.0.0.1:" + port + "/v1");
    console.log("  - 模型已同步: " + result.models + " (默认: " + result.defaultModel + ")");
    console.log("  - 桌面快捷方式: " + (desktop?.installed ? "已创建 (桌面/开始菜单/开机自启)" : "无"));
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
    const server = await listen(settings);
    console.log("MOMO Codex Bridge listening at http://" + settings.host + ":" + settings.port + "/v1");
    writeRuntimePort(settings.port, process.pid);
    writeHeartbeat({ running: true, port: settings.port, endpoint: settings.endpoint });

    const autoSync = startAutoSync({
      settings,
      onSync: (err, res) => {
        writeHeartbeat({ running: true, port: settings.port, endpoint: settings.endpoint, lastSyncTime: new Date().toISOString() });
        if (err) console.warn("[auto-sync] sync failed:", err.message);
        else if (res.changed) console.log("[auto-sync] catalog updated (" + res.count + " models).");
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
    console.log("momoapi-proxy v" + getCurrentVersion());
  } else if (command === "uninstall") {
    const result = uninstall({ removeKey: hasFlag("--remove-key") });
    console.log("Uninstall complete:", result);
  } else {
    console.log("MOMO API Proxy - Lightweight local Responses & Desktop Proxy\n\nUsage:\n  momoapi-proxy start                     - Start daemon & taskbar tray in background\n  momoapi-proxy stop                      - Stop running proxy service\n  momoapi-proxy restart                   - Restart proxy daemon & taskbar tray\n  momoapi-proxy serve                     - Run in foreground (live debug logs)\n  momoapi-proxy status                    - Check running status\n  momoapi-proxy models                    - List available synced models\n  momoapi-proxy sync                      - Sync model catalog from MOMO API\n  momoapi-proxy update [--force]          - Update to latest version\n  momoapi-proxy doctor                    - Run health diagnostics\n  momoapi-proxy migrate-history           - Unify previous conversation histories\n  momoapi-proxy logs [-n 50]              - View recent request logs\n  momoapi-proxy tray                      - Launch taskbar tray companion\n  momoapi-proxy test <model>              - Run quick response test\n  momoapi-proxy rollback                  - Restore previous Codex config\n  momoapi-proxy uninstall [--remove-key]  - Uninstall proxy\n");
  }
}

main().catch((err) => {
  console.error("Fatal error:", err.message);
  process.exit(1);
});
