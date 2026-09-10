import assert from "node:assert/strict";
import test from "node:test";
import { assertSafeArchiveListing, checkAndRecordLatestVersion, checkLatestVersion, getCurrentVersion, isNewer, isTrustedUpdateUrl, isTrustedVersionedPackageUrl, readUpdateStatus, updateSelf } from "../src/updater.mjs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("isNewer compares semantic versions correctly", () => {
  assert.equal(isNewer("0.6.0", "0.5.9"), true);
  assert.equal(isNewer("0.5.10", "0.5.9"), true);
  assert.equal(isNewer("1.0.0", "0.5.9"), true);
  assert.equal(isNewer("0.5.9", "0.5.9"), false);
  assert.equal(isNewer("0.5.8", "0.5.9"), false);
  assert.equal(isNewer("v0.6.0", "0.5.9"), true);
});

test("checkLatestVersion detects updates from CDN JSON payload", async () => {
  const checksum = "d".repeat(64);
  const fakeFetch = async (url) => {
    if (url.includes("bridge-latest.json")) {
      return new Response(JSON.stringify({
        version: "0.13.1",
        url: "https://momoapi.us/install/packages/momoapi-proxy-0.13.1.tgz",
        latest_url: "https://momoapi.us/install/packages/momoapi-proxy-latest.tgz",
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.includes("api.github.com")) {
      return new Response(JSON.stringify({
        tag_name: "v0.13.1",
        assets: [{
          name: "momoapi-proxy-0.13.1.tgz",
          browser_download_url: "https://github.com/momo-api/momoapi-proxy/releases/download/v0.13.1/momoapi-proxy-0.13.1.tgz",
          digest: `sha256:${checksum}`,
        }],
      }), { status: 200 });
    }
    return new Response("Not found", { status: 404 });
  };

  const info = await checkLatestVersion({ endpoint: "https://mock.momo", fetchImpl: fakeFetch });
  assert.equal(info.latest, "0.13.1");
  assert.equal(info.hasUpdate, true);
  assert.equal(info.downloadUrl, "https://momoapi.us/install/packages/momoapi-proxy-0.13.1.tgz");
});

test("checkLatestVersion prefers a newer GitHub release over a stale CDN manifest", async () => {
  const fakeFetch = async (url) => {
    if (url.includes("bridge-latest.json")) {
      return new Response(JSON.stringify({
        version: "0.9.3",
        latest_url: "https://momoapi.us/install/packages/momoapi-proxy-latest.tgz",
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.includes("api.github.com")) {
      return new Response(JSON.stringify({
        tag_name: "v0.9.6",
        assets: [{
          browser_download_url: "https://github.com/momo-api/momoapi-proxy/releases/download/v0.9.6/momoapi-proxy-0.9.6.tgz",
          digest: `sha256:${"e".repeat(64)}`,
        }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("Not found", { status: 404 });
  };

  const info = await checkLatestVersion({ endpoint: "https://mock.momo", fetchImpl: fakeFetch });
  assert.equal(info.latest, "0.9.6");
  assert.equal(info.downloadUrl, "https://github.com/momo-api/momoapi-proxy/releases/download/v0.9.6/momoapi-proxy-0.9.6.tgz");
});

test("GitHub releases reject named packages hosted outside the trusted release hosts", async () => {
  const fakeFetch = async (url) => url.includes("api.github.com")
    ? new Response(JSON.stringify({
        tag_name: "v0.11.1",
        assets: [
          { name: "checksums.txt", browser_download_url: "https://example/checksums.txt" },
          { name: "momoapi-proxy-0.11.1.tgz", browser_download_url: "https://example/momoapi-proxy-0.11.1.tgz" },
        ],
      }), { status: 200 })
    : new Response("missing", { status: 404 });
  const info = await checkLatestVersion({ endpoint: "https://mock.momo", fetchImpl: fakeFetch });
  assert.equal(info.checkFailed, true);
  assert.equal(info.downloadUrl, null);
});

test("equal-version GitHub metadata supplies checksum for a CDN manifest", async () => {
  const checksum = "a".repeat(64);
  const fakeFetch = async (url) => {
    if (url.includes("bridge-latest.json")) {
      return new Response(JSON.stringify({
        version: "0.12.1",
        url: "https://momoapi.us/install/packages/momoapi-proxy-0.12.1.tgz",
      }), { status: 200 });
    }
    if (url.includes("api.github.com")) {
      return new Response(JSON.stringify({
        tag_name: "v0.12.1",
        body: `SHA-256: ${checksum}`,
        assets: [{ name: "momoapi-proxy-0.12.1.tgz", browser_download_url: "https://github.example/momoapi-proxy-0.12.1.tgz" }],
      }), { status: 200 });
    }
    return new Response("missing", { status: 404 });
  };
  const info = await checkLatestVersion({ endpoint: "https://mock.momo", fetchImpl: fakeFetch });
  assert.equal(info.sha256, checksum);
  assert.equal(info.downloadUrl, "https://momoapi.us/install/packages/momoapi-proxy-0.12.1.tgz");
  assert.equal(info.sha256, checksum);
});

test("GitHub API metadata URL is never treated as an install package", async () => {
  const fakeFetch = async (url) => url.includes("api.github.com")
    ? new Response(JSON.stringify({
        tag_name: "v0.12.1",
        url: "https://api.github.com/repos/momo-api/momoapi-proxy/releases/123",
      }), { status: 200 })
    : new Response("missing", { status: 404 });
  const info = await checkLatestVersion({ endpoint: "https://mock.momo", fetchImpl: fakeFetch });
  assert.equal(info.checkFailed, true);
  assert.equal(info.downloadUrl, null);
});

test("duplicate official manifest candidates are requested only once", async () => {
  const requested = [];
  await checkLatestVersion({
    endpoint: "https://momoapi.us",
    fetchImpl: async (url) => {
      requested.push(url);
      return new Response("missing", { status: 404 });
    },
  });
  assert.equal(requested.filter((url) => url === "https://momoapi.us/install/bridge-latest.json").length, 1);
});

test("a CDN-provided checksum is not an update trust root", async () => {
  const fakeFetch = async (url) => {
    if (url.includes("bridge-latest.json")) {
      return new Response(JSON.stringify({
        version: "0.12.1",
        url: "https://momoapi.us/install/packages/momoapi-proxy-0.12.1.tgz",
        sha256: "b".repeat(64),
      }), { status: 200 });
    }
    if (url.includes("api.github.com")) {
      return new Response(JSON.stringify({
        tag_name: "v0.12.1",
        assets: [{ name: "momoapi-proxy-0.12.1.tgz", browser_download_url: "https://github.com/momo-api/momoapi-proxy/releases/download/v0.12.1/momoapi-proxy-0.12.1.tgz" }],
      }), { status: 200 });
    }
    return new Response("missing", { status: 404 });
  };
  const info = await checkLatestVersion({ fetchImpl: fakeFetch });
  assert.equal(info.sha256, null);
  assert.equal(info.checkFailed, true);
});

test("GitHub asset digests can attest the update checksum", async () => {
  const checksum = "c".repeat(64);
  const fakeFetch = async (url) => url.includes("api.github.com")
    ? new Response(JSON.stringify({
        tag_name: "v0.12.1",
        assets: [{
          name: "momoapi-proxy-0.12.1.tgz",
          browser_download_url: "https://github.com/momo-api/momoapi-proxy/releases/download/v0.12.1/momoapi-proxy-0.12.1.tgz",
          digest: `sha256:${checksum}`,
        }],
      }), { status: 200 })
    : new Response("missing", { status: 404 });
  const info = await checkLatestVersion({ fetchImpl: fakeFetch });
  assert.equal(info.sha256, checksum);
});

test("custom model endpoints are never queried for update metadata", async () => {
  const requested = [];
  await checkLatestVersion({
    endpoint: "https://third-party.example/v1",
    fetchImpl: async (url) => {
      requested.push(url);
      return new Response("missing", { status: 404 });
    },
  });
  assert.equal(requested.some((url) => url.includes("third-party.example")), false);
});

test("manifest redirects cannot switch to another repository or path", async () => {
  const info = await checkLatestVersion({
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      url: "https://api.github.com/repos/attacker/repository/releases/latest",
      json: async () => ({ tag_name: "v9.9.9" }),
    }),
  });
  assert.equal(info.checkFailed, true);
  assert.ok(info.errors.every((error) => error.code === "untrusted_redirect" || error.code === "release_attestation_missing"));
});

test("update packages require HTTPS and an official download host", () => {
  assert.equal(isTrustedUpdateUrl("https://momoapi.us/install/packages/momoapi-proxy-0.12.1.tgz"), true);
  assert.equal(isTrustedUpdateUrl("https://github.com/momo-api/momoapi-proxy/releases/download/v0.12.1/momoapi-proxy-0.12.1.tgz"), true);
  assert.equal(isTrustedUpdateUrl("http://momoapi.us/install/packages/momoapi-proxy-0.12.1.tgz"), false);
  assert.equal(isTrustedUpdateUrl("https://attacker.example/momoapi-proxy-0.12.1.tgz"), false);
  assert.equal(isTrustedVersionedPackageUrl("https://momoapi.us/install/packages/momoapi-proxy-0.12.1.tgz", "0.12.1"), true);
  assert.equal(isTrustedVersionedPackageUrl("https://momoapi.us/install/packages/momoapi-proxy-latest.tgz", "0.12.1"), false);
  assert.equal(isTrustedVersionedPackageUrl("https://momoapi.us/install/packages/momoapi-proxy-0.12.0.tgz", "0.12.1"), false);
});

test("archive admission rejects traversal, links, and special files", () => {
  const regular = "-rw-r--r-- 0 root root 42 2026-09-10 00:00 momoapi-proxy/package.json";
  const directory = "drwxr-xr-x 0 root root 0 2026-09-10 00:00 momoapi-proxy/";
  assert.deepEqual(
    assertSafeArchiveListing(["momoapi-proxy/", "momoapi-proxy/package.json"], [directory, regular]),
    { entries: 2, expandedBytes: 42 },
  );
  assert.throws(() => assertSafeArchiveListing(
    ["momoapi-proxy/../outside"],
    ["-rw-r--r-- 0 root root 1 2026-09-10 00:00 momoapi-proxy/../outside"],
  ), (error) => error.code === "update_archive_unsafe");
  assert.throws(() => assertSafeArchiveListing(
    ["momoapi-proxy/link"],
    ["lrwxrwxrwx 0 root root 0 2026-09-10 00:00 momoapi-proxy/link -> outside"],
  ), (error) => error.code === "update_archive_unsafe");
});

test("failed update checks are persisted instead of being reported as latest", async () => {
  const home = mkdtempSync(join(tmpdir(), "momo-update-status-"));
  try {
    const info = await checkAndRecordLatestVersion({
      endpoint: "https://mock.momo",
      fetchImpl: async () => { throw Object.assign(new Error("offline"), { code: "ENETUNREACH" }); },
      env: { MOMO_PROXY_HOME: home },
    });
    assert.equal(info.checkFailed, true);
    const status = readUpdateStatus({ MOMO_PROXY_HOME: home });
    assert.equal(status.checkFailed, true);
    assert.equal(status.errorCode, "all_update_sources_failed");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("self-update fails closed when GitHub release attestation is missing", async () => {
  await assert.rejects(updateSelf({
    endpoint: "https://mock.momo",
    fetchImpl: async (url) => url.includes("bridge-latest.json")
      ? new Response(JSON.stringify({ version: "0.12.1", url: "https://mock.momo/momoapi-proxy-0.12.1.tgz" }), { status: 200 })
      : new Response("missing", { status: 404 }),
  }), (error) => error.code === "update_check_failed");
});
