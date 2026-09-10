import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ImageAssetStore, isImageAssetReference, persistImageResult } from "../src/image-assets.mjs";

const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2mYQAAAAASUVORK5CYII=";

test("stores generated images locally, deduplicates content, and keeps Base64 opt-in", async () => {
  const home = mkdtempSync(join(tmpdir(), "momo-assets-"));
  try {
    const store = new ImageAssetStore({ rootDir: join(home, "images"), maxTotalBytes: 1024 * 1024, maxAssets: 100 });
    const first = await persistImageResult(store, { images: [{ b64_json: PNG_BASE64, mime_type: "image/png" }] });
    const second = await persistImageResult(store, { images: [{ b64_json: PNG_BASE64, mime_type: "image/png" }] });
    assert.equal(first.images[0].asset_id, second.images[0].asset_id);
    assert.equal("b64_json" in first.images[0], false);
    assert.equal(existsSync(first.images[0].local_path), true);
    assert.equal(readFileSync(first.images[0].local_path).toString("base64"), PNG_BASE64);
    const preview = await store.get(first.images[0].asset_id, { includeData: true });
    assert.equal(preview.b64_json, PNG_BASE64);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("accepts only opaque asset IDs and rejects arbitrary local paths or corrupt data", async () => {
  const home = mkdtempSync(join(tmpdir(), "momo-assets-"));
  try {
    const store = new ImageAssetStore({ rootDir: join(home, "images") });
    assert.equal(isImageAssetReference("C:\\Users\\example\\secret.png"), false);
    assert.equal(isImageAssetReference("asset:../../secret.png"), false);
    await assert.rejects(() => store.get("../../secret.png"), (error) => error.code === "invalid_image_asset_id");
    await assert.rejects(() => store.putBase64({ b64_json: Buffer.from("not an image").toString("base64"), mime_type: "image/png" }), (error) => error.code === "image_asset_unsupported_format");
    await assert.rejects(() => store.putBase64({ b64_json: PNG_BASE64, mime_type: "image/jpeg" }), (error) => error.code === "image_asset_mime_mismatch");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("expires least-recently-used local assets when quotas are reached", async () => {
  const home = mkdtempSync(join(tmpdir(), "momo-assets-"));
  try {
    const store = new ImageAssetStore({ rootDir: join(home, "images"), maxAssets: 10, retentionDays: 1 });
    const asset = await store.putBase64({ b64_json: PNG_BASE64, mime_type: "image/png" });
    const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    const metadataPath = join(home, "images", asset.asset_id + ".json");
    const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
    await import("node:fs/promises").then(({ writeFile }) => writeFile(metadataPath, JSON.stringify({ ...metadata, last_accessed_at: old })));
    const result = await store.cleanup();
    assert.equal(result.removed, 1);
    assert.equal(existsSync(asset.local_path), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
