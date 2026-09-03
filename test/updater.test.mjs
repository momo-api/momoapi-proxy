import assert from "node:assert/strict";
import test from "node:test";
import { checkLatestVersion, getCurrentVersion, isNewer } from "../src/updater.mjs";

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
        version: "0.9.9",
        url: "https://momoapi.us/install/packages/momo-api-codex-bridge-0.9.9.tgz",
        latest_url: "https://momoapi.us/install/packages/momo-api-codex-bridge-latest.tgz",
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("Not found", { status: 404 });
  };

  const info = await checkLatestVersion({ endpoint: "https://mock.momo", fetchImpl: fakeFetch });
  assert.equal(info.latest, "0.9.9");
  assert.equal(info.hasUpdate, true);
  assert.equal(info.downloadUrl, "https://momoapi.us/install/packages/momo-api-codex-bridge-latest.tgz");
});
