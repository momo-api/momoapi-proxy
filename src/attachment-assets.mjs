import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { appHome } from "./config.mjs";

const ASSET_ID_RE = /^asset_[a-f0-9]{64}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const OBJECT_KEY_RE = /^chat-temp\/u_[a-f0-9]{12}\/(?:chat-image|chat-document|chat-attachment)\//;

function validMetadata(value) {
  return value && typeof value === "object"
    && ASSET_ID_RE.test(String(value.asset_id || ""))
    && SHA256_RE.test(String(value.sha256 || ""))
    && OBJECT_KEY_RE.test(String(value.object_key || ""))
    && Number.isSafeInteger(value.bytes)
    && value.bytes > 0
    && typeof value.mime_type === "string"
    && value.mime_type.length > 0;
}

async function atomicWrite(path, value) {
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
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

export class AttachmentAssetStore {
  constructor({ rootDir } = {}) {
    if (!rootDir) throw new Error("Attachment asset rootDir is required.");
    this.rootDir = rootDir;
    this.cache = new Map();
  }

  pathFor(assetId) {
    if (!ASSET_ID_RE.test(String(assetId || ""))) throw new Error("Invalid attachment asset id.");
    return join(this.rootDir, `${assetId}.json`);
  }

  async getBySha256(sha256) {
    const normalized = String(sha256 || "").toLowerCase();
    if (!SHA256_RE.test(normalized)) return null;
    const assetId = `asset_${normalized}`;
    const cached = this.cache.get(assetId);
    if (cached) return { ...cached };
    let parsed;
    try {
      parsed = JSON.parse(await readFile(this.pathFor(assetId), "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT" || error instanceof SyntaxError) return null;
      throw error;
    }
    if (!validMetadata(parsed) || parsed.asset_id !== assetId || parsed.sha256 !== normalized) return null;
    this.cache.set(assetId, parsed);
    return { ...parsed };
  }

  async put(metadata) {
    const value = {
      version: 1,
      asset_id: String(metadata.asset_id || ""),
      object_key: String(metadata.object_key || ""),
      sha256: String(metadata.sha256 || "").toLowerCase(),
      bytes: Number(metadata.bytes),
      mime_type: String(metadata.mime_type || "").toLowerCase(),
      file_name: String(metadata.file_name || "attachment").slice(0, 160),
      created_at: metadata.created_at || new Date().toISOString(),
    };
    if (!validMetadata(value) || value.asset_id !== `asset_${value.sha256}`) {
      throw new Error("Invalid attachment asset metadata.");
    }
    await mkdir(this.rootDir, { recursive: true, mode: 0o700 });
    await atomicWrite(this.pathFor(value.asset_id), value);
    this.cache.set(value.asset_id, value);
    return { ...value };
  }
}

export function createAttachmentAssetStore(settings = {}, env = process.env) {
  return new AttachmentAssetStore({
    rootDir: settings.attachmentAssetDirectory || join(appHome(env), "attachments"),
  });
}
