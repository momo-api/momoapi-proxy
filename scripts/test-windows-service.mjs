// Real Task Scheduler acceptance; creates only a random, isolated task/home.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { installWindowsService, uninstallWindowsService, windowsTaskName } from "../src/service.mjs";
import { installAutostart, uninstallAutostart } from "../src/autostart.mjs";

assert.equal(process.platform, "win32");
const root = mkdtempSync(join(tmpdir(), "momo-task-acceptance-"));
const env = { USERPROFILE: root, APPDATA: join(root, "Roaming"), MOMO_PROXY_HOME: join(root, "proxy & isolated!") };
const task = windowsTaskName(env);
const schtasks = join(process.env.SystemRoot, "System32", "schtasks.exe");
const query = () => spawnSync(schtasks, ["/query", "/tn", task], { stdio: "ignore", windowsHide: true, timeout: 15000 }).status;
let created = false;
try {
  assert.notEqual(query(), 0, "unique task must not exist before test");
  const cli = join(root, "fixture.mjs");
  const marker = join(env.MOMO_PROXY_HOME, "acceptance-marker.json");
  mkdirSync(env.MOMO_PROXY_HOME, { recursive: true });
  writeFileSync(cli, 'import {writeFileSync} from "node:fs"; import {join} from "node:path"; writeFileSync(join(process.env.MOMO_PROXY_HOME,"acceptance-marker.json"),JSON.stringify({home:process.env.MOMO_PROXY_HOME,node:process.execPath,args:process.argv.slice(2)}));');
  const startup = installAutostart({}, { osPlatform: "win32", env });
  // Substitute only the synthetic fixture in the generated launcher: no real daemon.
  const launch = readFileSync(startup.target, "utf8").replace(/"[^"]*momoapi-proxy\.mjs" serve/, '"' + cli + '" serve');
  assert.ok(launch.includes('"' + cli + '" serve'));
  writeFileSync(startup.target, launch);
  const startupRun = spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/c", startup.target], { windowsHide: true, stdio: "ignore", timeout: 15000 });
  assert.equal(startupRun.status, 0);
  const startupDeadline = Date.now() + 10000;
  while (!existsSync(marker) && Date.now() < startupDeadline) await new Promise(r => setTimeout(r, 100));
  assert.ok(existsSync(marker), "Startup fallback launches in the selected home");
  const startupData = JSON.parse(readFileSync(marker, "utf8"));
  assert.equal(startupData.home, env.MOMO_PROXY_HOME); assert.equal(startupData.node, process.execPath);
  assert.deepEqual(startupData.args, ["serve"]);
  uninstallAutostart({ osPlatform: "win32", env }); unlinkSync(marker);
  console.log("Windows Startup fallback: real CMD launcher, absolute Node and isolated home passed");
  if (process.argv.includes("--startup-only")) process.exitCode = 0;
  else {
  const result = installWindowsService(cli, { env, spawnSyncImpl(command, args, options) {
    const result = spawnSync(command, args, { ...options, stdio: "pipe", encoding: "utf8" });
    if (result.status !== 0) console.log("Isolated scheduled task: " + String(result.stderr || result.error?.message || "operation failed").trim());
    return result;
  } });
  created = query() === 0;
  assert.equal(result.installed, true, "Task Scheduler registration/run must succeed");
  assert.equal(result.taskName, task);
  const deadline = Date.now() + 20000;
  while (!existsSync(marker) && Date.now() < deadline) await new Promise(r => setTimeout(r, 100));
  assert.ok(existsSync(marker), "real scheduled wrapper must execute");
  const data = JSON.parse(readFileSync(marker, "utf8"));
  assert.equal(data.home, env.MOMO_PROXY_HOME);
  assert.equal(data.node, process.execPath);
  assert.deepEqual(data.args, ["serve"]);
  console.log("Windows Task Scheduler: register, hidden launcher, absolute Node, isolated home and serve arguments passed");
  }
} finally {
  if (created) { uninstallWindowsService({ env }); assert.notEqual(query(), 0, "isolated task cleanup"); }
  assert.ok(root.startsWith(join(tmpdir(), "momo-task-acceptance-")));
  rmSync(root, { recursive: true, force: true });
}
