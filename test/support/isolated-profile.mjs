import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";

export function isolatedProfile(prefix = "momo-test-profile-") {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const proxyHome = join(root, ".momoapi-proxy");
  const env = {
    ...process.env,
    HOME: root,
    USERPROFILE: root,
    APPDATA: join(root, "AppData", "Roaming"),
    LOCALAPPDATA: join(root, "AppData", "Local"),
    CODEX_HOME: join(root, ".codex"),
    MOMO_PROXY_HOME: proxyHome,
    MOMO_BRIDGE_HOME: proxyHome,
    MOMO_SWITCH_HOME: proxyHome,
    MOMO_PROXY_CONSOLE_MIRROR: "0",
  };
  for (const directory of [env.APPDATA, env.LOCALAPPDATA, env.CODEX_HOME, proxyHome]) {
    mkdirSync(directory, { recursive: true });
  }
  after(() => rmSync(root, { recursive: true, force: true }));
  return { root, env };
}
