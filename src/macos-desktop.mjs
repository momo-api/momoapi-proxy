import { existsSync, mkdirSync, cpSync, renameSync, rmSync, rmdirSync, writeFileSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { userHome, appHome } from "./config.mjs";
import { MACOS_LAUNCHD_LABEL } from "./autostart.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export function macRuntimePath(env = process.env) {
  return join(userHome(env), "Library", "Application Support", "MOMO API Proxy", "runtime.json");
}

function atomicFile(file, contents) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = file + "." + randomBytes(8).toString("hex") + ".tmp";
  try {
    writeFileSync(temporary, contents, { mode: 0o600, flag: "wx" });
    renameSync(temporary, file);
  } finally { rmSync(temporary, { force: true }); }
}

export function openMacDesktop({ env = process.env, spawnSyncImpl = spawnSync } = {}) {
  const target = join(userHome(env), "Applications", "MOMO API Proxy.app");
  if (!existsSync(target) || !existsSync(macRuntimePath(env))) throw new Error("Mac companion is not installed. Run momoapi desktop install first.");
  const result = spawnSyncImpl("/usr/bin/open", [target], { encoding: "utf8", timeout: 30000 });
  if (result.error || result.status !== 0) throw new Error("Mac companion could not be opened.");
  return { opened: true, appPath: target };
}

export function installMacDesktop({ env = process.env, osPlatform = process.platform, source = join(ROOT, "resources", "macos", "MOMO API Proxy.app"), spawnSyncImpl = spawnSync, nodePath = process.execPath, cliPath = join(ROOT, "bin", "momoapi-proxy.mjs"), userId = process.getuid?.() } = {}) {
  if (osPlatform !== "darwin") return { installed: false, reason: "not_macos" };
  if (!existsSync(source)) return { installed: false, reason: "signed_app_unavailable", message: "此发布包未包含已签名的 Mac 菜单栏 App；可用 momoapi key change 管理 Key。" };
  const run = (command, args) => {
    const result = spawnSyncImpl(command, args, { encoding: "utf8", timeout: 30000 });
    if (result.error || result.status !== 0) throw new Error("Mac companion signature or installation verification failed.");
  };
  run("/usr/bin/codesign", ["--verify", "--deep", "--strict", source]);
  run("/usr/sbin/spctl", ["--assess", "--type", "execute", source]);
  if (!Number.isInteger(userId) || !isAbsolute(nodePath) || !isAbsolute(cliPath)) throw new Error("Mac companion requires absolute installed runtime paths and a user login domain.");
  const parent = join(userHome(env), "Applications");
  mkdirSync(parent, { recursive: true });
  const target = join(parent, "MOMO API Proxy.app");
  const temporary = join(parent, ".momo-app-" + randomBytes(8).toString("hex") + ".app");
  const previous = temporary + ".previous";
  const descriptor = macRuntimePath(env);
  const agent = join(userHome(env), "Library", "LaunchAgents", "us.momoapi.menu-bar.plist");
  const domain = "gui/" + userId;
  const label = domain + "/us.momoapi.menu-bar";
  const lock = join(parent, ".momo-desktop-install.lock");
  try { mkdirSync(lock, { mode: 0o700 }); } catch { throw new Error("Mac companion installation is busy. Retry later."); }
  let priorAgent, priorDescriptor, wasLoaded = false, registrationTouched = false, swapped = false, succeeded = false;
  try {
    priorAgent = existsSync(agent) ? readFileSync(agent) : null;
    priorDescriptor = existsSync(descriptor) ? readFileSync(descriptor) : null;
    const state = spawnSyncImpl("/bin/launchctl", ["print", label], { encoding: "utf8", timeout: 15000 });
    if (state.error) throw new Error("Cannot inspect Mac companion login agent.");
    wasLoaded = state.status === 0;
    if (wasLoaded && !priorAgent) throw new Error("Existing Mac companion agent has no managed plist; repair it before installation.");
    cpSync(source, temporary, { recursive: true });
    run("/usr/bin/codesign", ["--verify", "--deep", "--strict", temporary]);
    if (wasLoaded) run("/bin/launchctl", ["bootout", label]);
    registrationTouched = true;
    if (existsSync(target)) renameSync(target, previous);
    renameSync(temporary, target);
    swapped = true;
    // Non-secret descriptor lives outside the signed bundle. Never serialize
    // process.env or settings here: launchd does not inherit terminal PATH.
    atomicFile(descriptor, JSON.stringify({ schema: 1, node: nodePath, cli: cliPath, appHome: resolve(appHome(env)) }) + "\n");
    const escape = (value) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    atomicFile(agent, '<?xml version="1.0"?><plist version="1.0"><dict><key>Label</key><string>us.momoapi.menu-bar</string><key>ProgramArguments</key><array><string>' + escape(join(target, "Contents", "MacOS", "MomoMenuBar")) + '</string></array><key>RunAtLoad</key><true/></dict></plist>\n');
    run("/bin/launchctl", ["bootstrap", domain, agent]);
    run("/bin/launchctl", ["print", label]);
    run("/usr/bin/open", [target]);
    succeeded = true;
    return { installed: true, appPath: target };
  } catch (error) {
    if (registrationTouched) {
      try {
        const state = spawnSyncImpl("/bin/launchctl", ["print", label], { encoding: "utf8", timeout: 15000 });
        if (state.error) throw new Error("state unavailable");
        if (state.status === 0) run("/bin/launchctl", ["bootout", label]);
        if (swapped) rmSync(target, { recursive: true, force: true });
        if (existsSync(previous)) renameSync(previous, target);
        for (const [file, contents] of [[agent, priorAgent], [descriptor, priorDescriptor]]) {
          if (contents === null) rmSync(file, { force: true }); else atomicFile(file, contents);
        }
        if (wasLoaded) run("/bin/launchctl", ["bootstrap", domain, agent]);
      } catch {
        // Keep the uniquely named previous bundle if restoration failed.
        throw new Error("Mac companion installation failed; rollback could not be verified. Previous bundle, if any, is retained at " + previous);
      }
    }
    throw error;
  } finally {
    if (existsSync(temporary)) rmSync(temporary, { recursive: true, force: true });
    if (succeeded && existsSync(previous)) rmSync(previous, { recursive: true, force: true });
    rmdirSync(lock);
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
