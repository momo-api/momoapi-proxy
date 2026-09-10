import assert from "node:assert/strict";
import test from "node:test";
import { checkAndRecordLatestVersion, checkLatestVersion, getCurrentVersion, isNewer, readUpdateStatus, updateSelf } from "../src/updater.mjs";
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
  const fakeFetch = async (url) => {
    if (url.includes("bridge-latest.json")) {
      return new Response(JSON.stringify({
        version: "0.12.1",
        url: "https://momoapi.us/install/packages/momoapi-proxy-0.12.1.tgz",
        latest_url: "https://momoapi.us/install/packages/momoapi-proxy-latest.tgz",
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("Not found", { status: 404 });
  };

  const info = await checkLatestVersion({ endpoint: "https://mock.momo", fetchImpl: fakeFetch });
  assert.equal(info.latest, "0.12.1");
  assert.equal(info.hasUpdate, true);
  assert.equal(info.downloadUrl, "https://momoapi.us/install/packages/momoapi-proxy-0.12.1.tgz");
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
        url: "https://api.github.com/repos/momo-api/momoapi-proxy/releases/1",
        assets: [{ browser_download_url: "https://github.com/momo-api/momoapi-proxy/releases/download/v0.9.6/momoapi-proxy-0.9.6.tgz" }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("Not found", { status: 404 });
  };

  const info = await checkLatestVersion({ endpoint: "https://mock.momo", fetchImpl: fakeFetch });
  assert.equal(info.latest, "0.9.6");
  assert.equal(info.downloadUrl, "https://github.com/momo-api/momoapi-proxy/releases/download/v0.9.6/momoapi-proxy-0.9.6.tgz");
});

test("GitHub releases select the named proxy package instead of the first arbitrary asset", async () => {
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
  assert.equal(info.downloadUrl, "https://example/momoapi-proxy-0.11.1.tgz");
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
  assert.equal(info.downloadUrl, "https://github.example/momoapi-proxy-0.12.1.tgz");
});

test("GitHub API metadata URL is never treated as an install package", async () => {
  const fakeFetch = async (url) => url.includes("api.github.com")
    ? new Response(JSON.stringify({
        tag_name: "v0.12.1",
        url: "https://api.github.com/repos/momo-api/momoapi-proxy/releases/123",
      }), { status: 200 })
    : new Response("missing", { status: 404 });
  const info = await checkLatestVersion({ endpoint: "https://mock.momo", fetchImpl: fakeFetch });
  assert.equal(info.latest, "0.12.1");
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

test("self-update refuses unsigned release metadata before downloading", async () => {
  await assert.rejects(updateSelf({
    endpoint: "https://mock.momo",
    fetchImpl: async (url) => url.includes("bridge-latest.json")
      ? new Response(JSON.stringify({ version: "0.12.1", url: "https://mock.momo/momoapi-proxy-0.12.1.tgz" }), { status: 200 })
      : new Response("missing", { status: 404 }),
  }), (error) => error.code === "update_checksum_missing");
});
