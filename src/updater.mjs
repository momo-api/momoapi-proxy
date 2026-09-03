import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = dirname(__dirname);

export function getCurrentVersion() {
  try {
    const pkg = JSON.parse(readFileSync(join(ROOT_DIR, "package.json"), "utf8"));
    return pkg.version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export function isNewer(latest, current) {
  const parse = (v) => String(v).replace(/^v/, "").split(".").map((n) => parseInt(n, 10) || 0);
  const l = parse(latest);
  const c = parse(current);
  for (let i = 0; i < Math.max(l.length, c.length); i++) {
    const a = l[i] || 0;
    const b = c[i] || 0;
    if (a > b) return true;
    if (a < b) return false;
  }
  return false;
}

export async function checkLatestVersion({ endpoint = "https://momoapi.us", fetchImpl = fetch } = {}) {
  const current = getCurrentVersion();
  const candidates = [
    endpoint.replace(/\/$/, "") + "/install/bridge-latest.json",
    "https://momoapi.us/install/bridge-latest.json",
    "https://api.github.com/repos/momo-api/momo-codex-bridge/releases/latest",
  ];

  for (const url of candidates) {
    try {
      const res = await fetchImpl(url, { headers: { "user-agent": "momo-codex-bridge" } });
      if (!res.ok) continue;
      const data = await res.json();
      const latestVersion = data.version || data.tag_name?.replace(/^v/, "");
      const downloadUrl = data.latest_url || data.url || data.assets?.[0]?.browser_download_url;
      if (latestVersion) {
        return {
          current,
          latest: latestVersion,
          hasUpdate: isNewer(latestVersion, current),
          downloadUrl: downloadUrl || null,
          releaseNotes: data.body || null,
        };
      }
    } catch {}
  }
  return { current, latest: current, hasUpdate: false, downloadUrl: null };
}

export async function updateSelf({ endpoint = "https://momoapi.us", fetchImpl = fetch, force = false } = {}) {
  const info = await checkLatestVersion({ endpoint, fetchImpl });
  if (!info.hasUpdate && !force) {
    return { updated: false, current: info.current, latest: info.latest, message: "Already on the latest version (v" + info.current + ")." };
  }

  const tmpTgz = join(tmpdir(), "momo-codex-bridge-update.tgz");
  const urls = [
    info.downloadUrl,
    "https://momoapi.us/install/packages/momo-api-codex-bridge-latest.tgz",
    "https://github.com/momo-api/momo-codex-bridge/releases/download/v" + info.latest + "/momo-api-codex-bridge-" + info.latest + ".tgz",
  ].filter(Boolean);

  let downloaded = false;
  for (const url of urls) {
    try {
      const res = await fetchImpl(url);
      if (res.ok) {
        const buffer = Buffer.from(await res.arrayBuffer());
        writeFileSync(tmpTgz, buffer);
        downloaded = true;
        break;
      }
    } catch {}
  }

  if (!downloaded) {
    throw new Error("Failed to download update package from all mirrors.");
  }

  execFileSync("tar", ["-xz", "-f", tmpTgz, "-C", ROOT_DIR, "--strip-components=1"], { stdio: "ignore" });

  try {
    const { unlinkSync, existsSync } = await import("node:fs");
    const p1 = join(ROOT_DIR, "bin", "momo-codex-bridge.ps1");
    const p2 = join(ROOT_DIR, "bin", "momo-codex-switch.ps1");
    if (existsSync(p1)) unlinkSync(p1);
    if (existsSync(p2)) unlinkSync(p2);
  } catch {}

  const newVersion = getCurrentVersion();
  return {
    updated: true,
    previous: info.current,
    current: newVersion,
    message: "Successfully updated MOMO Codex Bridge from v" + info.current + " to v" + newVersion + "!",
  };
}
