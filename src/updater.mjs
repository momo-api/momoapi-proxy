import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = dirname(__dirname);
const OFFICIAL_MANIFEST_URLS = Object.freeze([
  "https://momoapi.us/install/bridge-latest.json",
  "https://api.github.com/repos/momo-api/momoapi-proxy/releases/latest",
]);
const TRUSTED_PACKAGE_HOSTS = new Set([
  "momoapi.us",
  "github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
]);
const TRUSTED_MANIFEST_HOSTS = new Set(["momoapi.us", "api.github.com"]);
const MAX_UPDATE_ARCHIVE_BYTES = 64 * 1024 * 1024;
const MAX_UPDATE_EXPANDED_BYTES = 128 * 1024 * 1024;
const MAX_UPDATE_ENTRIES = 4096;
const WINDOWS_RESERVED_SEGMENT = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

function isTgzUrl(value) {
  if (typeof value !== "string" || !value) return false;
  try {
    return new URL(value).pathname.toLowerCase().endsWith(".tgz");
  } catch {
    return false;
  }
}

export function isTrustedUpdateUrl(value) {
  if (!isTgzUrl(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && TRUSTED_PACKAGE_HOSTS.has(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

export function isTrustedVersionedPackageUrl(value, version) {
  if (!isTrustedUpdateUrl(value) || !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$/.test(String(version || ""))) return false;
  try {
    return new URL(value).pathname.endsWith(`/momoapi-proxy-${version}.tgz`);
  } catch {
    return false;
  }
}

export function isTrustedResolvedPackageUrl(value, version) {
  if (isTrustedVersionedPackageUrl(value, version)) return true;
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    return url.protocol === "https:" && !url.username && !url.password &&
      (hostname === "objects.githubusercontent.com" || hostname === "release-assets.githubusercontent.com");
  } catch {
    return false;
  }
}

function isTrustedManifestUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || !TRUSTED_MANIFEST_HOSTS.has(url.hostname.toLowerCase())) return false;
    if (url.hostname.toLowerCase() === "momoapi.us") return url.pathname === "/install/bridge-latest.json";
    return url.pathname === "/repos/momo-api/momoapi-proxy/releases/latest";
  } catch {
    return false;
  }
}

function uniqueTgzUrls(values) {
  return [...new Set(values.filter(isTrustedUpdateUrl))];
}

function preferPackageMirror(releases, version) {
  const urls = releases.map((release) => release.downloadUrl).filter((value) => isTrustedVersionedPackageUrl(value, version));
  return urls.find((value) => new URL(value).hostname.toLowerCase() === "momoapi.us") || urls[0] || null;
}

function archiveError(message, code = "update_archive_unsafe") {
  return Object.assign(new Error(message), { code });
}

function validateArchivePath(name) {
  if (!name || name.includes("\0") || name.includes("\\") || name.startsWith("/") || /^[A-Za-z]:/.test(name)) {
    throw archiveError("Update archive contains an unsafe path.");
  }
  const normalized = name.endsWith("/") ? name.slice(0, -1) : name;
  if (normalized.length > 4096) throw archiveError("Update archive path is too long.");
  const segments = normalized.split("/");
  if (segments[0] !== "momoapi-proxy" || segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw archiveError("Update archive must contain one momoapi-proxy root directory.");
  }
  for (const segment of segments) {
    if (segment.length > 255 || /[:\u0000-\u001f\u007f]/.test(segment) || /[. ]$/.test(segment) || WINDOWS_RESERVED_SEGMENT.test(segment)) {
      throw archiveError("Update archive contains a platform-unsafe path.");
    }
  }
}

export function assertSafeArchiveListing(names, verboseLines) {
  if (!Array.isArray(names) || names.length === 0 || names.length > MAX_UPDATE_ENTRIES) {
    throw archiveError("Update archive has an invalid number of entries.");
  }
  const details = Array.isArray(verboseLines) ? verboseLines.filter(Boolean) : [];
  if (details.length !== names.length) throw archiveError("Update archive listing is inconsistent.");

  let expandedBytes = 0;
  for (let index = 0; index < names.length; index += 1) {
    validateArchivePath(names[index]);
    const detail = details[index];
    const type = detail[0];
    if (type !== "-" && type !== "d") {
      throw archiveError("Update archive links and special files are not allowed.");
    }
    if (type === "-") {
      const fields = detail.trim().split(/\s+/);
      const size = /^\d+$/.test(fields[1] || "") && /^\d+$/.test(fields[4] || "")
        ? Number(fields[4])
        : Number(fields[2]);
      if (!Number.isSafeInteger(size) || size < 0) throw archiveError("Update archive file size could not be verified.");
      expandedBytes += size;
      if (!Number.isSafeInteger(expandedBytes) || expandedBytes > MAX_UPDATE_EXPANDED_BYTES) {
        throw archiveError("Update archive expands beyond the allowed size.", "update_archive_too_large");
      }
    }
  }
  return { entries: names.length, expandedBytes };
}

export function validateUpdateArchive(archivePath) {
  let names;
  let details;
  try {
    names = execFileSync("tar", ["-tzf", archivePath], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 })
      .split(/\r?\n/)
      .filter(Boolean);
    details = execFileSync("tar", ["-tvzf", archivePath], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 })
      .split(/\r?\n/)
      .filter(Boolean);
  } catch (error) {
    throw archiveError("Downloaded update package is not a readable gzip tar archive.", "update_archive_invalid");
  }
  return assertSafeArchiveListing(names, details);
}

async function readResponseBodyLimited(response, maxBytes) {
  const declaredLength = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw archiveError("Downloaded update package exceeds the allowed size.", "update_archive_too_large");
  }
  if (!response.body?.getReader) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length === 0 || buffer.length > maxBytes) {
      throw archiveError("Downloaded update package exceeds the allowed size.", "update_archive_too_large");
    }
    return buffer;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      total += chunk.length;
      if (total > maxBytes) {
        await reader.cancel("update archive too large").catch(() => {});
        throw archiveError("Downloaded update package exceeds the allowed size.", "update_archive_too_large");
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  if (total === 0) throw archiveError("Downloaded update package is empty.", "update_archive_invalid");
  return Buffer.concat(chunks, total);
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
  const candidates = OFFICIAL_MANIFEST_URLS;

  const releases = [];
  const errors = [];
  for (const url of candidates) {
    try {
      const res = await fetchImpl(url, { headers: { "user-agent": "momo-codex-bridge" } });
      if (res.url && !isTrustedManifestUrl(res.url)) {
        errors.push({ source: url, code: "untrusted_redirect" });
        continue;
      }
      if (!res.ok) {
        errors.push({ source: url, code: "http_" + res.status });
        continue;
      }
      const data = await res.json();
      const latestVersion = data.version || data.tag_name?.replace(/^v/, "");
      if (/^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$/.test(latestVersion || "")) {
        const githubAuthority = url === "https://api.github.com/repos/momo-api/momoapi-proxy/releases/latest";
        const assets = Array.isArray(data.assets) ? data.assets : [];
        const releaseAsset = assets.find((asset) => asset?.name === `momoapi-proxy-${latestVersion}.tgz`)
          || assets.find((asset) => String(asset?.browser_download_url || "").endsWith(`/momoapi-proxy-${latestVersion}.tgz`))
          || assets.find((asset) => /^momoapi-proxy-[0-9].*\.tgz$/i.test(asset?.name || ""));
        const notesSha = typeof data.body === "string" ? data.body.match(/SHA-256:\s*`?([a-f0-9]{64})`?/i)?.[1] : null;
        const assetSha = typeof releaseAsset?.digest === "string" ? releaseAsset.digest.match(/^sha256:([a-f0-9]{64})$/i)?.[1] : null;
        releases.push({
          latest: latestVersion,
          downloadUrl: uniqueTgzUrls([
            releaseAsset?.browser_download_url,
            data.url,
            data.tarballUrl,
            data.latest_url,
          ]).find((value) => isTrustedVersionedPackageUrl(value, latestVersion)) || null,
          releaseNotes: data.body || null,
          sha256: githubAuthority ? (assetSha || notesSha)?.toLowerCase() || null : null,
          githubAuthority,
          source: url,
        });
      }
    } catch (error) {
      errors.push({ source: url, code: error?.code || error?.name || "fetch_failed" });
    }
  }
  const authority = releases
    .filter((release) => release.githubAuthority && /^[a-f0-9]{64}$/.test(release.sha256 || ""))
    .reduce((best, release) => !best || isNewer(release.latest, best.latest) ? release : best, null);
  if (!authority) {
    return {
      current,
      latest: current,
      hasUpdate: false,
      downloadUrl: null,
      sha256: null,
      checkFailed: true,
      errors: [...errors, { source: "github-release", code: "release_attestation_missing" }],
    };
  }
  const sameVersion = releases.filter((release) => release.latest === authority.latest);
  return {
    current,
    ...authority,
    downloadUrl: preferPackageMirror(sameVersion, authority.latest) || authority.downloadUrl,
    hasUpdate: isNewer(authority.latest, current),
    checkFailed: false,
    errors,
  };
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
  const tmpExtract = mkdtempSync(join(dirname(ROOT_DIR), ".momoapi-proxy-update-"));
  const supervisorPath = join(dirname(ROOT_DIR), ".momoapi-proxy-update-supervisor-" + updateId + ".mjs");
  const urls = uniqueTgzUrls([
    info.downloadUrl,
    "https://momoapi.us/install/packages/momoapi-proxy-" + info.latest + ".tgz",
    "https://github.com/momo-api/momoapi-proxy/releases/download/v" + info.latest + "/momoapi-proxy-" + info.latest + ".tgz",
  ]);

  let downloaded = false;
  let downloadedUrl = null;
  let checksumMismatch = false;
  let staged = false;
  try {
    for (const url of urls) {
      try {
        const res = await fetchImpl(url);
        if (res.ok) {
          if (res.url && !isTrustedResolvedPackageUrl(res.url, info.latest)) {
            throw archiveError("Update download redirected to an untrusted host.", "update_source_untrusted");
          }
          const buffer = await readResponseBodyLimited(res, MAX_UPDATE_ARCHIVE_BYTES);
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

    validateUpdateArchive(tmpTgz);
    try {
      execFileSync("tar", ["-xz", "-f", tmpTgz, "-C", tmpExtract, "--strip-components=1", "--no-same-owner", "--no-same-permissions"], { stdio: "ignore" });
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

    // Windows may keep the running application directory busy while the
    // updater, daemon, tray, or an MCP child still uses it. Stage the verified
    // tree beside the application and copy a standalone, built-in-only
    // supervisor outside ROOT_DIR. It performs the swap after this process
    // exits and after the old service is stopped.
    copyFileSync(join(tmpExtract, "src", "update-supervisor.mjs"), supervisorPath);
    staged = true;
    writeUpdateStatus({
      status: "awaiting_activation",
      latest: info.latest,
      hasUpdate: true,
      checkFailed: false,
      previous: info.current,
      target: info.latest,
    }, env);
    return {
      updated: true,
      staged: true,
      previous: info.current,
      current: info.latest,
      rootDir: ROOT_DIR,
      stagingDir: tmpExtract,
      supervisorPath,
      downloadedUrl,
      backupDir: ROOT_DIR + ".update-backup",
      message: "Downloaded and verified MOMO API Proxy v" + info.latest + ". Activation will continue after the updater exits.",
    };
  } finally {
    rmSync(tmpTgz, { force: true });
    if (!staged) {
      rmSync(tmpExtract, { recursive: true, force: true });
      rmSync(supervisorPath, { force: true });
    }
  }
}
