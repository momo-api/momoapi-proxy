import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = dirname(__dirname);

function isTgzUrl(value) {
  if (typeof value !== "string" || !value) return false;
  try {
    return new URL(value).pathname.toLowerCase().endsWith(".tgz");
  } catch {
    return false;
  }
}

function uniqueTgzUrls(values) {
  return [...new Set(values.filter(isTgzUrl))];
}

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
  const candidates = [...new Set([
    endpoint.replace(/\/$/, "") + "/install/bridge-latest.json",
    "https://momoapi.us/install/bridge-latest.json",
    "https://api.github.com/repos/momo-api/momoapi-proxy/releases/latest",
  ])];

  const releases = [];
  const errors = [];
  for (const url of candidates) {
    try {
      const res = await fetchImpl(url, { headers: { "user-agent": "momo-codex-bridge" } });
      if (!res.ok) {
        errors.push({ source: url, code: "http_" + res.status });
        continue;
      }
      const data = await res.json();
      const latestVersion = data.version || data.tag_name?.replace(/^v/, "");
      if (latestVersion) {
        const assets = Array.isArray(data.assets) ? data.assets : [];
        const releaseAsset = assets.find((asset) => asset?.name === `momoapi-proxy-${latestVersion}.tgz`)
          || assets.find((asset) => String(asset?.browser_download_url || "").endsWith(`/momoapi-proxy-${latestVersion}.tgz`))
          || assets.find((asset) => /^momoapi-proxy-[0-9].*\.tgz$/i.test(asset?.name || ""));
        const notesSha = typeof data.body === "string" ? data.body.match(/SHA-256:\s*`?([a-f0-9]{64})`?/i)?.[1] : null;
        releases.push({
          latest: latestVersion,
          downloadUrl: uniqueTgzUrls([
            releaseAsset?.browser_download_url,
            data.url,
            data.tarballUrl,
            data.latest_url,
          ])[0] || null,
          releaseNotes: data.body || null,
          sha256: (typeof data.sha256 === "string" ? data.sha256 : notesSha)?.toLowerCase() || null,
          source: url,
        });
      }
    } catch (error) {
      errors.push({ source: url, code: error?.code || error?.name || "fetch_failed" });
    }
  }
  const latest = releases.reduce((best, release) => {
    if (!best || isNewer(release.latest, best.latest)) return release;
    if (release.latest !== best.latest) return best;
    return {
      ...best,
      downloadUrl: best.sha256 && best.downloadUrl ? best.downloadUrl : release.downloadUrl || best.downloadUrl,
      releaseNotes: best.releaseNotes || release.releaseNotes,
      sha256: best.sha256 || release.sha256,
      source: best.sha256 ? best.source : release.source || best.source,
    };
  }, null);
  if (!latest) return { current, latest: current, hasUpdate: false, downloadUrl: null, checkFailed: true, errors };
  return { current, ...latest, hasUpdate: isNewer(latest.latest, current), checkFailed: false, errors };
}

export function updateStatusPath(env = process.env) {
  const root = env.MOMO_PROXY_HOME || env.MOMO_BRIDGE_HOME || join(env.USERPROFILE || env.HOME || tmpdir(), ".momoapi-proxy");
  return join(root, "update-status.json");
}

export function writeUpdateStatus(status, env = process.env) {
  const target = updateStatusPath(env);
  try {
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    writeFileSync(target, JSON.stringify({ checkedAt: new Date().toISOString(), current: getCurrentVersion(), ...status }, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  } catch {}
  return target;
}

export function readUpdateStatus(env = process.env) {
  const target = updateStatusPath(env);
  if (!existsSync(target)) return null;
  try { return JSON.parse(readFileSync(target, "utf8")); } catch { return null; }
}

export async function checkAndRecordLatestVersion({ endpoint = "https://momoapi.us", fetchImpl = fetch, env = process.env } = {}) {
  const info = await checkLatestVersion({ endpoint, fetchImpl });
  writeUpdateStatus({
    latest: info.latest,
    hasUpdate: info.hasUpdate,
    checkFailed: info.checkFailed,
    errorCode: info.checkFailed ? "all_update_sources_failed" : null,
  }, env);
  return info;
}

export function startUpdateChecker({ endpoint = "https://momoapi.us", fetchImpl = fetch, env = process.env, enabled = true, initialDelayMs = 60_000, intervalHours = 12, onCheck } = {}) {
  if (!enabled) return { checkNow: async () => null, stop: () => {} };
  let stopped = false;
  let timer = null;
  const intervalMs = Math.max(1, Number(intervalHours) || 12) * 60 * 60 * 1000;
  const schedule = (delay) => {
    timer = setTimeout(run, Math.max(0, delay));
    if (timer.unref) timer.unref();
  };
  const run = async () => {
    if (stopped) return null;
    const info = await checkAndRecordLatestVersion({ endpoint, fetchImpl, env });
    if (onCheck) onCheck(info);
    if (!stopped) schedule(intervalMs + Math.floor(Math.random() * 15 * 60_000));
    return info;
  };
  schedule(initialDelayMs);
  return {
    checkNow: () => checkAndRecordLatestVersion({ endpoint, fetchImpl, env }),
    stop: () => { stopped = true; if (timer) clearTimeout(timer); },
  };
}

export async function updateSelf({ endpoint = "https://momoapi.us", fetchImpl = fetch, force = false, env = process.env } = {}) {
  const info = await checkLatestVersion({ endpoint, fetchImpl });
  if (info.checkFailed) {
    throw Object.assign(new Error("Unable to check for updates: all release sources failed."), { code: "update_check_failed" });
  }
  if (isNewer(info.current, info.latest)) {
    return { updated: false, current: info.current, latest: info.latest, message: "Refusing to downgrade from v" + info.current + " to v" + info.latest + "." };
  }
  if (!info.hasUpdate && !force) {
    return { updated: false, current: info.current, latest: info.latest, message: "Already on the latest version (v" + info.current + ")." };
  }
  if (!/^[a-f0-9]{64}$/.test(info.sha256 || "")) {
    throw Object.assign(new Error("Release metadata does not include a valid SHA-256 checksum."), { code: "update_checksum_missing" });
  }

  const updateId = process.pid + "-" + Date.now();
  const tmpTgz = join(tmpdir(), "momoapi-proxy-update-" + updateId + ".tgz");
  const tmpExtract = join(dirname(ROOT_DIR), ".momoapi-proxy-update-" + updateId);
  const urls = uniqueTgzUrls([
    info.downloadUrl,
    endpoint.replace(/\/$/, "") + "/install/packages/momoapi-proxy-" + info.latest + ".tgz",
    "https://momoapi.us/install/packages/momoapi-proxy-" + info.latest + ".tgz",
    "https://github.com/momo-api/momoapi-proxy/releases/download/v" + info.latest + "/momoapi-proxy-" + info.latest + ".tgz",
    "https://momoapi.us/install/packages/momoapi-proxy-latest.tgz",
  ]);

  let downloaded = false;
  let downloadedUrl = null;
  let checksumMismatch = false;
  try {
    for (const url of urls) {
      try {
        const res = await fetchImpl(url);
        if (res.ok) {
          const buffer = Buffer.from(await res.arrayBuffer());
          if (info.sha256) {
            const actual = createHash("sha256").update(buffer).digest("hex");
            if (actual !== info.sha256) {
              checksumMismatch = true;
              continue;
            }
          }
          writeFileSync(tmpTgz, buffer);
          downloaded = true;
          downloadedUrl = url;
          break;
        }
      } catch {}
    }

    if (!downloaded) {
      if (checksumMismatch) {
        throw Object.assign(new Error("Downloaded update package failed SHA-256 verification."), { code: "update_checksum_mismatch" });
      }
      throw Object.assign(new Error("Failed to download update package from all mirrors."), { code: "update_download_failed" });
    }

    mkdirSync(tmpExtract, { recursive: true });
    try {
      execFileSync("tar", ["-xz", "-f", tmpTgz, "-C", tmpExtract, "--strip-components=1"], { stdio: "ignore" });
    } catch (error) {
      throw Object.assign(new Error("Failed to extract the downloaded update package."), { code: "update_extract_failed", cause: error });
    }

    let extractedPackage;
    try {
      extractedPackage = JSON.parse(readFileSync(join(tmpExtract, "package.json"), "utf8"));
    } catch (error) {
      throw Object.assign(new Error("Downloaded update package is missing a valid package.json."), { code: "update_package_invalid", cause: error });
    }
    if (extractedPackage.version !== info.latest) {
      throw Object.assign(new Error(`Downloaded package version ${extractedPackage.version || "unknown"} does not match v${info.latest}.`), { code: "update_version_mismatch" });
    }
    for (const requiredPath of ["bin/momoapi-proxy.mjs", "src/update-supervisor.mjs"]) {
      if (!existsSync(join(tmpExtract, ...requiredPath.split("/")))) {
        throw Object.assign(new Error(`Downloaded update package is missing ${requiredPath}.`), { code: "update_package_invalid" });
      }
    }

    const backupDir = ROOT_DIR + ".update-backup";
    rmSync(backupDir, { recursive: true, force: true });
    renameSync(ROOT_DIR, backupDir);
    try {
      renameSync(tmpExtract, ROOT_DIR);
    } catch (error) {
      if (!existsSync(ROOT_DIR) && existsSync(backupDir)) renameSync(backupDir, ROOT_DIR);
      throw Object.assign(new Error("Failed to activate the downloaded update package."), { code: "update_swap_failed", cause: error });
    }

    try {
      const { unlinkSync } = await import("node:fs");
      const p1 = join(ROOT_DIR, "bin", "momo-codex-bridge.ps1");
      const p2 = join(ROOT_DIR, "bin", "momo-codex-switch.ps1");
      if (existsSync(p1)) unlinkSync(p1);
      if (existsSync(p2)) unlinkSync(p2);
    } catch {}

    const newVersion = getCurrentVersion();
    writeUpdateStatus({
      status: "awaiting_restart",
      latest: info.latest,
      hasUpdate: false,
      checkFailed: false,
      previous: info.current,
      target: newVersion,
    }, env);
    return {
      updated: true,
      previous: info.current,
      current: newVersion,
      rootDir: ROOT_DIR,
      downloadedUrl,
      backupDir,
      message: "Successfully updated MOMO Codex Bridge from v" + info.current + " to v" + newVersion + "!",
    };
  } finally {
    rmSync(tmpTgz, { force: true });
    rmSync(tmpExtract, { recursive: true, force: true });
  }
}
