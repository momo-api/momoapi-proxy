import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const profileRoot = mkdtempSync(join(tmpdir(), "momoapi-proxy-test-profile-"));
const proxyHome = join(profileRoot, ".momoapi-proxy");
const codexHome = join(profileRoot, ".codex");
const appData = join(profileRoot, "AppData", "Roaming");
const localAppData = join(profileRoot, "AppData", "Local");

for (const directory of [proxyHome, codexHome, appData, localAppData]) {
  mkdirSync(directory, { recursive: true });
}

const tests = readdirSync(join(repositoryRoot, "test"))
  .filter((name) => name.endsWith(".test.mjs"))
  .sort()
  .map((name) => join("test", name));

let result;
try {
  result = spawnSync(process.execPath, ["--test", ...tests], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      HOME: profileRoot,
      USERPROFILE: profileRoot,
      APPDATA: appData,
      LOCALAPPDATA: localAppData,
      CODEX_HOME: codexHome,
      MOMO_PROXY_HOME: proxyHome,
      MOMO_BRIDGE_HOME: proxyHome,
      MOMO_SWITCH_HOME: proxyHome,
      MOMO_PROXY_CONSOLE_MIRROR: "0",
    },
    stdio: "inherit",
  });
} finally {
  rmSync(profileRoot, { recursive: true, force: true });
}

if (result.error) throw result.error;
if (result.signal) {
  process.stderr.write(`Test runner terminated by ${result.signal}.\n`);
  process.exitCode = 1;
} else {
  process.exitCode = result.status ?? 1;
}
