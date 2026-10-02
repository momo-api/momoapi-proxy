import { existsSync, mkdirSync, cpSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { userHome } from "./config.mjs";
import { MACOS_LAUNCHD_LABEL } from "./autostart.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export function installMacDesktop({ env = process.env, osPlatform = process.platform, source = join(ROOT, "resources", "macos", "MOMO API Proxy.app"), spawnSyncImpl = spawnSync } = {}) {
  if (osPlatform !== "darwin") return { installed: false, reason: "not_macos" };
  if (!existsSync(source)) return { installed: false, reason: "signed_app_unavailable", message: "此发布包未包含已签名的 Mac 菜单栏 App；可用 momoapi key change 管理 Key。" };
  const run = (command, args) => {
    const result = spawnSyncImpl(command, args, { encoding: "utf8", timeout: 30000 });
    if (result.error || result.status !== 0) throw new Error("Mac companion signature or installation verification failed.");
  };
  run("/usr/bin/codesign", ["--verify", "--deep", "--strict", source]);
  run("/usr/sbin/spctl", ["--assess", "--type", "execute", source]);
  const parent = join(userHome(env), "Applications");
  mkdirSync(parent, { recursive: true });
  const target = join(parent, "MOMO API Proxy.app");
  const temporary = join(parent, ".momo-app-" + randomBytes(8).toString("hex") + ".app");
  const previous = temporary + ".previous";
  try {
    cpSync(source, temporary, { recursive: true });
    run("/usr/bin/codesign", ["--verify", "--deep", "--strict", temporary]);
    if (existsSync(target)) renameSync(target, previous);
    try { renameSync(temporary, target); } catch (error) { if (existsSync(previous)) renameSync(previous, target); throw error; }
    try { run("/usr/bin/open", [target]); } catch (error) {
      rmSync(target, { recursive: true, force: true });
      if (existsSync(previous)) renameSync(previous, target);
      throw error;
    }
    const agentDir = join(userHome(env), "Library", "LaunchAgents");
    mkdirSync(agentDir, { recursive: true });
    const agent = join(agentDir, "us.momoapi.menu-bar.plist");
    const escape = (value) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    writeFileSync(agent, '<?xml version="1.0"?><plist version="1.0"><dict><key>Label</key><string>us.momoapi.menu-bar</string><key>ProgramArguments</key><array><string>' + escape(join(target, "Contents", "MacOS", "MomoMenuBar")) + '</string></array><key>RunAtLoad</key><true/></dict></plist>\n');
    return { installed: true, appPath: target };
  } finally {
    if (existsSync(temporary)) rmSync(temporary, { recursive: true, force: true });
    if (existsSync(previous)) rmSync(previous, { recursive: true, force: true });
  }
}

export function controlMacService(action, { env = process.env, userId = process.getuid?.(), spawnSyncImpl = spawnSync } = {}) {
  if (!["start", "stop", "restart"].includes(action) || !Number.isInteger(userId)) throw new Error("Invalid macOS service action.");
  const domain = "gui/" + userId;
  const plist = join(userHome(env), "Library", "LaunchAgents", MACOS_LAUNCHD_LABEL + ".plist");
  if (!existsSync(plist)) throw new Error("Managed LaunchAgent not found. Run momoapi install in a terminal.");
  const args = action === "stop" ? ["bootout", domain, plist] : action === "start" ? ["bootstrap", domain, plist] : ["kickstart", "-k", domain + "/" + MACOS_LAUNCHD_LABEL];
  const result = spawnSyncImpl("/bin/launchctl", args, { encoding: "utf8", timeout: 15000 });
  if (result.error || result.status !== 0) throw new Error("The managed LaunchAgent could not be controlled. Check momoapi doctor.");
  return { ok: true, action };
}
