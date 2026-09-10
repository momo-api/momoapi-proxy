import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { appHome } from "./config.mjs";

const MEBIBYTE = 1024 * 1024;
const MIME_TO_EXTENSION = new Map([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/webp", "webp"],
]);
const EXTENSION_TO_MIME = new Map([...MIME_TO_EXTENSION].map(([mimeType, extension]) => [extension, mimeType]));
const ASSET_ID = /^img_[a-f0-9]{64}$/;

function assetError(message, statusCode = 400, code = "image_asset_error") {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function positiveNumber(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

function normalizeMimeType(value) {
  const normalized = String(value || "").split(";", 1)[0].trim().toLowerCase();
  if (normalized === "image/jpg") return "image/jpeg";
  return normalized;
}

function sniffMimeType(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return null;
}

function decodeBase64(value, maxBytes) {
  const compact = String(value || "").replace(/[\r\n\t ]/g, "");
  if (!compact || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact) || compact.length % 4 === 1) {
    throw assetError("Image result did not contain valid base64 data.", 502, "image_asset_invalid_data");
  }
  if (Math.floor(compact.length * 3 / 4) > maxBytes) {
    throw assetError("Image result is too large to store locally.", 413, "image_asset_too_large");
  }
  const bytes = Buffer.from(compact, "base64");
  if (!bytes.length || bytes.length > maxBytes) {
    throw assetError("Image result is too large to store locally.", 413, "image_asset_too_large");
  }
  return bytes;
}

function normalizeAssetId(value) {
  const raw = String(value || "");
  const assetId = raw.startsWith("asset:") ? raw.slice(6) : raw;
  if (!ASSET_ID.test(assetId)) throw assetError("Invalid local image asset_id.", 400, "invalid_image_asset_id");
  return assetId;
}

async function ensurePrivateDirectory(rootDir) {
  await mkdir(rootDir, { recursive: true, mode: 0o700 });
  try { await chmod(rootDir, 0o700); } catch { /* Windows has no POSIX mode enforcement. */ }
}

async function atomicWrite(path, data, mode = 0o600) {
  const temporary = path + ".tmp-" + process.pid + "-" + randomBytes(6).toString("hex");
  await writeFile(temporary, data, { mode });
  try { await chmod(temporary, mode); } catch { /* Windows has no POSIX mode enforcement. */ }
  try {
    await rename(temporary, path);
  } catch (error) {
    if (error?.code !== "EEXIST" && error?.code !== "EPERM") {
      await rm(temporary, { force: true });
      throw error;
    }
    await rm(path, { force: true });
    await rename(temporary, path);
  }
}

function publicMetadata(metadata) {
  return {
    asset_id: metadata.asset_id,
    reference: "asset:" + metadata.asset_id,
    local_path: metadata.local_path,
    mime_type: metadata.mime_type,
    bytes: metadata.bytes,
    sha256: metadata.sha256,
    created_at: metadata.created_at,
    last_accessed_at: metadata.last_accessed_at,
  };
}

export function isImageAssetReference(value) {
  const raw = String(value || "");
  return ASSET_ID.test(raw) || (raw.startsWith("asset:") && ASSET_ID.test(raw.slice(6)));
}

export class ImageAssetStore {
  constructor({ rootDir, maxAssetBytes = 20 * MEBIBYTE, maxTotalBytes = 2 * 1024 * MEBIBYTE, maxAssets = 2000, retentionDays = 30 } = {}) {
    if (!rootDir) throw new Error("Image asset rootDir is required.");
    this.rootDir = rootDir;
    this.maxAssetBytes = Math.floor(positiveNumber(maxAssetBytes, 20 * MEBIBYTE, MEBIBYTE, 20 * MEBIBYTE));
    this.maxTotalBytes = Math.floor(positiveNumber(maxTotalBytes, 2 * 1024 * MEBIBYTE, this.maxAssetBytes, 64 * 1024 * MEBIBYTE));
    this.maxAssets = Math.floor(positiveNumber(maxAssets, 2000, 10, 100000));
    this.retentionMs = positiveNumber(retentionDays, 30, 1, 3650) * 24 * 60 * 60 * 1000;
    this.activeAssetIds = new Map();
  }

  beginUse(assetId) {
    this.activeAssetIds.set(assetId, (this.activeAssetIds.get(assetId) || 0) + 1);
  }

  endUse(assetId) {
    const remaining = (this.activeAssetIds.get(assetId) || 1) - 1;
    if (remaining > 0) this.activeAssetIds.set(assetId, remaining);
    else this.activeAssetIds.delete(assetId);
  }

  isInUse(assetId) {
    return (this.activeAssetIds.get(assetId) || 0) > 0;
  }

  metadataPath(assetId) {
    return join(this.rootDir, normalizeAssetId(assetId) + ".json");
  }

  imagePath(assetId, extension) {
    const normalized = normalizeAssetId(assetId);
    if (!EXTENSION_TO_MIME.has(extension)) throw assetError("Unsupported local image asset extension.");
    return join(this.rootDir, normalized + "." + extension);
  }

  async readMetadata(assetId) {
    const normalized = normalizeAssetId(assetId);
    let metadata;
    try {
      metadata = JSON.parse(await readFile(this.metadataPath(normalized), "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT" || error instanceof SyntaxError) throw assetError("Local image asset was not found.", 404, "image_asset_not_found");
      throw error;
    }
    const extension = String(metadata?.extension || "").toLowerCase();
    if (metadata?.asset_id !== normalized || !EXTENSION_TO_MIME.has(extension)) {
      throw assetError("Local image asset metadata is invalid.", 500, "image_asset_metadata_invalid");
    }
    const localPath = this.imagePath(normalized, extension);
    let fileStat;
    try { fileStat = await stat(localPath); } catch (error) {
      if (error?.code === "ENOENT") throw assetError("Local image asset file was not found.", 404, "image_asset_not_found");
      throw error;
    }
    if (!fileStat.isFile() || fileStat.size !== metadata.bytes || fileStat.size > this.maxAssetBytes) {
      throw assetError("Local image asset file is invalid.", 500, "image_asset_file_invalid");
    }
    return { ...metadata, local_path: localPath };
  }

  async putBase64({ b64_json, mime_type }) {
    await ensurePrivateDirectory(this.rootDir);
    const bytes = decodeBase64(b64_json, this.maxAssetBytes);
    const detectedMimeType = sniffMimeType(bytes);
    if (!detectedMimeType) throw assetError("Image result is not a supported PNG, JPEG, or WebP file.", 502, "image_asset_unsupported_format");
    const declaredMimeType = normalizeMimeType(mime_type);
    if (declaredMimeType && !MIME_TO_EXTENSION.has(declaredMimeType)) {
      throw assetError("Image result declared an unsupported MIME type.", 502, "image_asset_unsupported_format");
    }
    if (declaredMimeType && declaredMimeType !== detectedMimeType) {
      throw assetError("Image result MIME type does not match its file contents.", 502, "image_asset_mime_mismatch");
    }
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const assetId = "img_" + sha256;
    const extension = MIME_TO_EXTENSION.get(detectedMimeType);
    const localPath = this.imagePath(assetId, extension);
    this.beginUse(assetId);
    try {
      const now = new Date().toISOString();
      let createdAt = now;
      try {
        const existing = await this.readMetadata(assetId);
        createdAt = existing.created_at || now;
      } catch (error) {
        if (error?.code !== "image_asset_not_found") throw error;
        await atomicWrite(localPath, bytes);
      }
      const metadata = {
        version: 1,
        asset_id: assetId,
        extension,
        mime_type: detectedMimeType,
        bytes: bytes.length,
        sha256,
        created_at: createdAt,
        last_accessed_at: now,
      };
      await atomicWrite(this.metadataPath(assetId), JSON.stringify(metadata, null, 2) + "\n");
      await this.cleanup({ preserveAssetIds: new Set([assetId]) });
      return publicMetadata({ ...metadata, local_path: localPath });
    } finally {
      this.endUse(assetId);
    }
  }

  async get(assetId, { includeData = false, touch = true } = {}) {
    const normalized = normalizeAssetId(assetId);
    this.beginUse(normalized);
    try {
      const metadata = await this.readMetadata(normalized);
      let bytes;
      if (includeData) {
        bytes = await readFile(metadata.local_path);
        const sha256 = createHash("sha256").update(bytes).digest("hex");
        if (sha256 !== metadata.sha256 || sniffMimeType(bytes) !== metadata.mime_type) {
          throw assetError("Local image asset failed integrity verification.", 500, "image_asset_integrity_error");
        }
      }
      if (touch) {
        metadata.last_accessed_at = new Date().toISOString();
        const persisted = { ...metadata };
        delete persisted.local_path;
        await atomicWrite(this.metadataPath(metadata.asset_id), JSON.stringify(persisted, null, 2) + "\n");
      }
      return {
        ...publicMetadata(metadata),
        ...(includeData ? { b64_json: bytes.toString("base64") } : {}),
      };
    } finally {
      this.endUse(normalized);
    }
  }

  async dataUrl(reference) {
    const asset = await this.get(reference, { includeData: true });
    return "data:" + asset.mime_type + ";base64," + asset.b64_json;
  }

  async list({ limit = 100 } = {}) {
    await ensurePrivateDirectory(this.rootDir);
    const cappedLimit = Math.floor(positiveNumber(limit, 100, 1, 100000));
    const names = await readdir(this.rootDir);
    const assets = [];
    for (const name of names) {
      const match = /^(img_[a-f0-9]{64})\.json$/.exec(name);
      if (!match) continue;
      try { assets.push(publicMetadata(await this.readMetadata(match[1]))); } catch { /* Ignore damaged entries in listings. */ }
    }
    assets.sort((left, right) => String(right.last_accessed_at).localeCompare(String(left.last_accessed_at)));
    return assets.slice(0, cappedLimit);
  }

  async remove(assetId) {
    const normalized = normalizeAssetId(assetId);
    if (this.isInUse(normalized)) throw assetError("Local image asset is currently in use.", 409, "image_asset_in_use");
    const metadata = await this.readMetadata(normalized);
    await rm(metadata.local_path, { force: true });
    await rm(this.metadataPath(metadata.asset_id), { force: true });
    return publicMetadata(metadata);
  }

  async cleanup({ preserveAssetIds = new Set(), now = Date.now() } = {}) {
    await ensurePrivateDirectory(this.rootDir);
    const protectedAssetIds = new Set([...preserveAssetIds, ...this.activeAssetIds.keys()]);
    const assets = await this.list({ limit: 100000 });
    const expired = assets.filter((asset) => !protectedAssetIds.has(asset.asset_id) && now - Date.parse(asset.last_accessed_at || asset.created_at) > this.retentionMs);
    let removed = 0;
    let bytesRemoved = 0;
    for (const asset of expired) {
      if (this.isInUse(asset.asset_id)) continue;
      try { await this.remove(asset.asset_id); removed += 1; bytesRemoved += asset.bytes; } catch { /* Best-effort expiry. */ }
    }
    const survivors = (await this.list({ limit: 100000 })).sort((left, right) => String(left.last_accessed_at).localeCompare(String(right.last_accessed_at)));
    let totalBytes = survivors.reduce((sum, asset) => sum + asset.bytes, 0);
    let totalAssets = survivors.length;
    for (const asset of survivors) {
      if (totalAssets <= this.maxAssets && totalBytes <= this.maxTotalBytes) break;
      if (protectedAssetIds.has(asset.asset_id) || this.isInUse(asset.asset_id)) continue;
      try {
        await this.remove(asset.asset_id);
        removed += 1;
        bytesRemoved += asset.bytes;
        totalBytes -= asset.bytes;
        totalAssets -= 1;
      } catch { /* Best-effort quota cleanup. */ }
    }
    if (totalAssets > this.maxAssets || totalBytes > this.maxTotalBytes) {
      throw assetError("Local image asset library is full. Remove old images or raise its local quota.", 507, "image_asset_storage_full");
    }
    return { removed, bytes_removed: bytesRemoved, assets: totalAssets, bytes: totalBytes };
  }
}

export function createImageAssetStore(settings = {}) {
  const policy = settings.imageAssets && typeof settings.imageAssets === "object" ? settings.imageAssets : {};
  return new ImageAssetStore({
    rootDir: settings.imageAssetDirectory || join(appHome(), "images"),
    maxAssetBytes: positiveNumber(policy.maxAssetMb, 20, 1, 20) * MEBIBYTE,
    maxTotalBytes: positiveNumber(policy.maxTotalMb, 2048, 20, 65536) * MEBIBYTE,
    maxAssets: positiveNumber(policy.maxAssets, 2000, 10, 100000),
    retentionDays: positiveNumber(policy.retentionDays, 30, 1, 3650),
  });
}

export async function persistImageResult(store, result, { includePreview = false } = {}) {
  const images = [];
  for (const image of result?.images || []) {
    if (!image?.b64_json) {
      throw assetError("Generated image could not be materialized for local storage.", 502, "image_asset_materialization_failed");
    }
    const asset = await store.putBase64(image);
    images.push({ ...asset, ...(includePreview ? { b64_json: image.b64_json } : {}) });
  }
  return { ...result, images };
}
