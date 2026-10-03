// Invoke as a disposable container's non-root user with a live user manager.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "node:net";
import { installAutostart, uninstallAutostart } from "../src/autostart.mjs";
import { writeSettings } from "../src/config.mjs";

assert.equal(process.platform, "linux");
assert.ok(existsSync("/run/.containerenv") || existsSync("/.dockerenv"), "must run only in a disposable container");
assert.notEqual(process.getuid(), 0, "acceptance must use a real non-root user manager");
const env = { ...process.env, MOMO_PROXY_HOME: join(process.env.HOME, "proxy % isolated") };
const listener = createServer(); await new Promise(r => listener.listen(0, "127.0.0.1", r));
const port = listener.address().port; await new Promise(r => listener.close(r));
writeSettings({ apiKey: "synthetic-only", localToken: "synthetic-local-only", endpoint: "http://127.0.0.1:1", port }, env);
const control = args => {
  const result = spawnSync("systemctl", ["--user", ...args], { encoding: "utf8", timeout: 15000 });
  assert.equal(result.status, 0, "systemctl user operation failed");
};
const ready = async () => {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch('http://127.0.0.1:' + port + '/internal/metrics', { headers: { "x-local-token": "synthetic-local-only" }, signal: AbortSignal.timeout(1000) });
      if (response.ok && (await response.json()).ok) return;
    } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error("systemd-managed proxy did not become authenticated-ready");
};
try {
  const result = installAutostart({}, { osPlatform: "linux", env });
  assert.equal(result.activated, true);
  control(["is-enabled", "momo-codex-bridge.service"]);
  await ready();
  control(["restart", "momo-codex-bridge.service"]); await ready();
  control(["stop", "momo-codex-bridge.service"]);
  await assert.rejects(fetch('http://127.0.0.1:' + port + '/healthz', { signal: AbortSignal.timeout(1000) }));
  control(["start", "momo-codex-bridge.service"]); await ready();
  const cli = args => {
    const result = spawnSync(process.execPath, ["bin/momoapi-proxy.mjs", ...args, "--no-desktop"], { env, encoding: "utf8", timeout: 20000 });
    assert.equal(result.status, 0, "managed Linux CLI lifecycle failed");
  };
  cli(["restart"]); await ready(); control(["is-active", "momo-codex-bridge.service"]);
  cli(["stop"]);
  const stopped = spawnSync("systemctl", ["--user", "is-active", "momo-codex-bridge.service"], { encoding: "utf8", timeout: 15000 });
  assert.notEqual(stopped.status, 0, "CLI stop must stop systemd unit");
  cli(["start"]); await ready(); control(["is-active", "momo-codex-bridge.service"]);
  const dropIn = join(process.env.HOME, ".config/systemd/user/momo-codex-bridge.service.d");
  mkdirSync(dropIn, { recursive: true });
  writeFileSync(join(dropIn, "acceptance.conf"), "[Service]\nEnvironment=MOMO_PROXY_HOME=/another-installation\n");
  control(["daemon-reload"]);
  try {
    assert.throws(() => uninstallAutostart({ osPlatform: "linux", env }), /does not match this installation/);
    assert.ok(existsSync(join(process.env.HOME, ".config/systemd/user/momo-codex-bridge.service")), "refused uninstall must preserve unit");
    const refused = spawnSync(process.execPath, ["bin/momoapi-proxy.mjs", "restart", "--no-desktop"], { env, encoding: "utf8", timeout: 20000 });
    assert.equal(refused.status, 1, "customized drop-in must refuse managed CLI action");
    assert.match(refused.stderr, /does not match this installation/);
  } finally { rmSync(dropIn, { recursive: true }); control(["daemon-reload"]); }
  cli(["start"]); await ready(); control(["is-active", "momo-codex-bridge.service"]);
  console.log("Linux CLI start/stop/restart stay systemd-managed; no detached orphan accepted");
  console.log("Linux real systemd drop-in override is refused, recovery after exact test cleanup passes");
  console.log("Linux systemd user: enable, authenticated readiness, restart, stop and start passed");
} finally { uninstallAutostart({ osPlatform: "linux", env }); }
const check = spawnSync("systemctl", ["--user", "is-active", "momo-codex-bridge.service"], { encoding: "utf8", timeout: 15000 });
assert.notEqual(check.status, 0);
console.log("Linux systemd user: disable, stop, remove and reload passed");
