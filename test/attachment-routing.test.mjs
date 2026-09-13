import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  assetizeAttachments,
  checkpointAttachmentReferences,
  parseInlineAttachment,
  stableAttachmentFingerprintObject,
  stripAttachmentMetadata,
} from "../src/attachment-routing.mjs";
import { replayItemFingerprint } from "../src/responses-state.mjs";

const MIB = 1024 * 1024;
const BASE_SETTINGS = {
  endpoint: "https://gateway.example",
  apiKey: "momo-secret",
  attachmentAssets: {
    enabled: true,
    maxFileMb: 50,
    maxBatchMb: 100,
    inlineImageMb: 6,
    inlineFileMb: 2,
    inlineBatchMb: 5.5,
    uploadTimeoutMs: 180_000,
  },
};

function pngBytes(size = 32) {
  const bytes = Buffer.alloc(Math.max(8, size));
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
  return bytes;
}

function pdfBytes(size = 32) {
  const bytes = Buffer.alloc(Math.max(5, size), 0x20);
  bytes.write("%PDF-", 0, "ascii");
  return bytes;
}

function avifBytes() {
  const bytes = Buffer.alloc(24);
  bytes.writeUInt32BE(24, 0);
  bytes.write("ftyp", 4, "ascii");
  bytes.write("avif", 8, "ascii");
  bytes.write("avif", 16, "ascii");
  return bytes;
}

function storedPart({ sha, bytes, mime = "application/pdf", currentUrl = null }) {
  const assetId = `asset_${sha}`;
  return {
    type: mime.startsWith("image/") ? "input_image" : "input_file",
    ...(mime.startsWith("image/") ? { image_url: currentUrl || `asset:${assetId}` } : { file_url: currentUrl || `asset:${assetId}`, filename: "large.pdf" }),
    momo_asset: {
      asset_id: assetId,
      object_key: `chat-temp/u_aaaaaaaaaaaa/chat-document/assets/${sha}.pdf`,
      sha256: sha,
      bytes,
      mime_type: mime,
      file_name: "large.pdf",
    },
  };
}

function dataUrl(mime, bytes) {
  return `data:${mime};base64,${bytes.toString("base64")}`;
}

function responsesPayload(parts) {
  return { model: "gpt-5.6-sol", input: [{ role: "user", content: parts }] };
}

function memoryStore(initial = []) {
  const bySha = new Map(initial.map((value) => [value.sha256, value]));
  return {
    async getBySha256(sha) { return bySha.get(sha) ? { ...bySha.get(sha) } : null; },
    async put(value) { bySha.set(value.sha256, { ...value }); return { ...value }; },
  };
}

function storageFetchRecorder({ presignStatus = 200, presignPayload = null, resignStatus = 200 } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith("/api/uploads/presign")) {
      if (presignStatus !== 200) {
        return Response.json(presignPayload || { error: "storage failed" }, { status: presignStatus });
      }
      const request = JSON.parse(init.body);
      return Response.json({
        assetId: `asset_${request.sha256}`,
        objectKey: `chat-temp/u_aaaaaaaaaaaa/${request.purpose}/assets/${request.sha256}.bin`,
        uploadUrl: `https://r2.example.test/upload/${request.sha256}`,
        downloadUrl: `https://r2.example.test/download/${request.sha256}?signature=fresh`,
        uploadHeaders: { "Content-Type": request.contentType, "Content-Length": String(request.size), Authorization: "must-not-forward" },
      });
    }
    if (String(url).endsWith("/api/uploads/resign")) {
      if (resignStatus !== 200) return Response.json({ error: "expired" }, { status: resignStatus });
      const request = JSON.parse(init.body);
      return Response.json({ downloadUrl: `https://r2.example.test/resigned/${encodeURIComponent(request.objectKey)}?signature=fresh` });
    }
    if (init.method === "PUT") return new Response(null, { status: 200 });
    throw new Error(`Unexpected fetch ${url}`);
  };
  return { calls, fetchImpl };
}

function zipFixture(entryNames) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entryName of entryNames) {
    const name = Buffer.from(entryName, "utf8");
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    locals.push(local);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centrals.push(central);
    offset += local.length;
  }
  const central = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entryNames.length, 8);
  eocd.writeUInt16LE(entryNames.length, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, central, eocd]);
}

test("small images remain inline and never touch attachment storage", async () => {
  const payload = responsesPayload([{ type: "input_image", image_url: dataUrl("image/png", pngBytes()) }]);
  let fetchCount = 0;
  const result = await assetizeAttachments(payload, BASE_SETTINGS, {
    store: memoryStore(),
    fetchImpl: async () => { fetchCount += 1; throw new Error("unexpected"); },
  });
  assert.equal(fetchCount, 0);
  assert.match(result.payload.input[0].content[0].image_url, /^data:image\/png;base64,/);
  assert.equal(result.trace.uploadedCount, 0);
});

test("images above the 6 MiB inline threshold become signed image URLs", async () => {
  const bytes = pngBytes(6 * MIB + 1);
  const payload = responsesPayload([{ type: "input_image", image_url: dataUrl("image/png", bytes) }]);
  const storage = storageFetchRecorder();
  const result = await assetizeAttachments(payload, BASE_SETTINGS, { store: memoryStore(), fetchImpl: storage.fetchImpl });
  const part = result.payload.input[0].content[0];
  assert.ok(part.image_url.startsWith("https://r2.example.test/download/"));
  assert.equal(part.momo_asset.bytes, bytes.length);
  assert.equal(storage.calls.filter((call) => call.init.method === "PUT").length, 1);
  assert.deepEqual(storage.calls.find((call) => call.init.method === "PUT").init.headers, {
    "Content-Type": "image/png",
    "Content-Length": String(bytes.length),
  });
});

test("PDF and valid OOXML documents become file URLs", async () => {
  const fixtures = [
    ["application/pdf", pdfBytes()],
    ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", zipFixture(["[Content_Types].xml", "word/document.xml"])],
    ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", zipFixture(["[Content_Types].xml", "xl/workbook.xml"])],
    ["application/vnd.openxmlformats-officedocument.presentationml.presentation", zipFixture(["[Content_Types].xml", "ppt/presentation.xml"])],
  ];
  for (const [mime, bytes] of fixtures) {
    const payload = responsesPayload([{ type: "input_file", filename: "fixture", file_data: dataUrl(mime, bytes) }]);
    const storage = storageFetchRecorder();
    const result = await assetizeAttachments(payload, { ...BASE_SETTINGS, attachmentAssets: { ...BASE_SETTINGS.attachmentAssets, inlineFileMb: 0.00001 } }, { store: memoryStore(), fetchImpl: storage.fetchImpl });
    const part = result.payload.input[0].content[0];
    assert.equal(part.file_data, undefined);
    assert.ok(part.file_url.startsWith("https://r2.example.test/download/"));
    assert.equal(part.momo_asset.mime_type, mime);
  }
});

test("fake ZIP files cannot impersonate OOXML documents", () => {
  const fakeZip = zipFixture(["payload.bin"]);
  assert.throws(
    () => parseInlineAttachment(dataUrl("application/vnd.openxmlformats-officedocument.wordprocessingml.document", fakeZip)),
    (error) => error.code === "attachment_signature_mismatch",
  );
});

test("AVIF signatures are accepted while mismatched image signatures are rejected", () => {
  const parsed = parseInlineAttachment(dataUrl("image/avif", avifBytes()));
  assert.equal(parsed.mimeType, "image/avif");
  assert.throws(() => parseInlineAttachment(dataUrl("image/png", avifBytes())), (error) => error.code === "attachment_signature_mismatch");
});

test("single-file and batch limits use decoded bytes with exact inclusive boundaries", async () => {
  const exactSha = "1".repeat(64);
  const plusSha = "2".repeat(64);
  const storage = storageFetchRecorder();
  const exact = responsesPayload([storedPart({ sha: exactSha, bytes: 50 * MIB })]);
  const exactResult = await assetizeAttachments(exact, BASE_SETTINGS, { store: memoryStore(), fetchImpl: storage.fetchImpl });
  assert.equal(exactResult.trace.currentAttachmentBytes, 50 * MIB);

  await assert.rejects(
    assetizeAttachments(responsesPayload([storedPart({ sha: plusSha, bytes: 50 * MIB + 1 })]), BASE_SETTINGS, { store: memoryStore(), fetchImpl: storage.fetchImpl }),
    (error) => error.code === "attachment_file_too_large" && error.details.actualBytes === 50 * MIB + 1
      && error.details.maxFileBytes === 50 * MIB && error.details.maxBatchBytes === 100 * MIB,
  );

  const decodedFiveBytes = dataUrl("text/plain", Buffer.from("hello"));
  assert.equal(parseInlineAttachment(decodedFiveBytes, { maxFileBytes: 5 }).byteLength, 5);
});

test("100 MiB current-turn batches are accepted and one extra byte is rejected", async () => {
  const first = storedPart({ sha: "3".repeat(64), bytes: 50 * MIB });
  const second = storedPart({ sha: "4".repeat(64), bytes: 50 * MIB });
  const storage = storageFetchRecorder();
  const exact = await assetizeAttachments(responsesPayload([first, second]), BASE_SETTINGS, { store: memoryStore(), fetchImpl: storage.fetchImpl });
  assert.equal(exact.trace.currentAttachmentBytes, 100 * MIB);

  await assert.rejects(
    assetizeAttachments(responsesPayload([first, second, storedPart({ sha: "5".repeat(64), bytes: 1 })]), BASE_SETTINGS, { store: memoryStore(), fetchImpl: storage.fetchImpl }),
    (error) => error.code === "attachment_batch_too_large" && error.details.actualBytes === 100 * MIB + 1
      && error.details.maxFileBytes === 50 * MIB && error.details.maxBatchBytes === 100 * MIB,
  );
});

test("identical current attachments upload once per request", async () => {
  const bytes = pngBytes(6 * MIB + 1);
  const url = dataUrl("image/png", bytes);
  const storage = storageFetchRecorder();
  const result = await assetizeAttachments(responsesPayload([
    { type: "input_image", image_url: url },
    { type: "input_image", image_url: url },
  ]), BASE_SETTINGS, { store: memoryStore(), fetchImpl: storage.fetchImpl });
  assert.equal(storage.calls.filter((call) => call.init.method === "PUT").length, 1);
  assert.equal(result.payload.input[0].content[0].image_url, result.payload.input[0].content[1].image_url);
});

test("stored assets are resigned without another PUT", async () => {
  const bytes = pngBytes(6 * MIB + 1);
  const sha = createHash("sha256").update(bytes).digest("hex");
  const metadata = storedPart({ sha, bytes: bytes.length, mime: "image/png" }).momo_asset;
  const storage = storageFetchRecorder();
  const result = await assetizeAttachments(responsesPayload([{ type: "input_image", image_url: dataUrl("image/png", bytes) }]), BASE_SETTINGS, {
    store: memoryStore([metadata]), fetchImpl: storage.fetchImpl,
  });
  assert.equal(result.trace.resignedCount, 1);
  assert.equal(result.trace.uploadedCount, 0);
  assert.equal(storage.calls.some((call) => call.init.method === "PUT"), false);
});

test("client-supplied asset metadata cannot override actual attachment bytes", async () => {
  const bytes = pngBytes(6 * MIB + 1);
  const actualSha = createHash("sha256").update(bytes).digest("hex");
  const forgedSha = "f".repeat(64);
  const payload = responsesPayload([{
    type: "input_image",
    image_url: dataUrl("image/png", bytes),
    momo_asset: storedPart({ sha: forgedSha, bytes: bytes.length, mime: "image/png" }).momo_asset,
  }]);
  const storage = storageFetchRecorder();
  const result = await assetizeAttachments(payload, BASE_SETTINGS, { store: memoryStore(), fetchImpl: storage.fetchImpl });
  assert.equal(result.payload.input[0].content[0].momo_asset.sha256, actualSha);
  assert.notEqual(result.payload.input[0].content[0].momo_asset.sha256, forgedSha);
});

test("only current-turn inline attachments upload; unavailable history becomes a marker", async () => {
  const old = dataUrl("image/png", pngBytes(6 * MIB + 1));
  const current = dataUrl("image/png", Buffer.concat([pngBytes(8), Buffer.alloc(6 * MIB, 1)]));
  const payload = { model: "gpt-5.6-sol", input: [
    { role: "user", content: [{ type: "input_image", image_url: old }] },
    { role: "assistant", content: [{ type: "output_text", text: "seen" }] },
    { role: "user", content: [{ type: "input_text", text: "continue" }, { type: "input_image", image_url: current }] },
  ] };
  const storage = storageFetchRecorder();
  const result = await assetizeAttachments(payload, BASE_SETTINGS, { store: memoryStore(), fetchImpl: storage.fetchImpl });
  assert.match(result.payload.input[0].content[0].text, /historical attachment/);
  assert.ok(result.payload.input[2].content[1].image_url.startsWith("https://r2.example.test/download/"));
  assert.equal(storage.calls.filter((call) => call.init.method === "PUT").length, 1);
});

test("expired stored references fail explicitly for the current turn and degrade safely in history", async () => {
  const metadata = storedPart({ sha: "6".repeat(64), bytes: 10 * MIB }).momo_asset;
  const failing = storageFetchRecorder({ resignStatus: 404 });
  await assert.rejects(
    assetizeAttachments(responsesPayload([storedPart({ sha: metadata.sha256, bytes: metadata.bytes })]), BASE_SETTINGS, { store: memoryStore([metadata]), fetchImpl: failing.fetchImpl }),
    (error) => error.statusCode === 409 && error.code === "attachment_asset_unavailable",
  );

  const historical = { model: "gpt-5.6-sol", input: [
    { role: "user", content: [storedPart({ sha: metadata.sha256, bytes: metadata.bytes })] },
    { role: "assistant", content: [{ type: "output_text", text: "seen" }] },
    { role: "user", content: [{ type: "input_text", text: "next" }] },
  ] };
  const result = await assetizeAttachments(historical, BASE_SETTINGS, { store: memoryStore([metadata]), fetchImpl: failing.fetchImpl });
  assert.match(result.payload.input[0].content[0].text, /remote asset reference unavailable/);
});

test("client aborts are not mislabeled as attachment timeouts", async () => {
  const controller = new AbortController();
  controller.abort(new DOMException("client stopped", "AbortError"));
  const bytes = pngBytes(6 * MIB + 1);
  await assert.rejects(
    assetizeAttachments(responsesPayload([{ type: "input_image", image_url: dataUrl("image/png", bytes) }]), BASE_SETTINGS, {
      store: memoryStore(), signal: controller.signal, fetchImpl: async (_url, init) => { throw init.signal.reason; },
    }),
    (error) => error.name === "AbortError" && error.code !== "attachment_upload_timeout",
  );
});

test("local upload deadline is reported as attachment_upload_timeout", async () => {
  const originalTimeout = AbortSignal.timeout;
  AbortSignal.timeout = () => AbortSignal.abort(new DOMException("deadline", "TimeoutError"));
  try {
    const bytes = pngBytes(6 * MIB + 1);
    await assert.rejects(
      assetizeAttachments(responsesPayload([{ type: "input_image", image_url: dataUrl("image/png", bytes) }]), BASE_SETTINGS, {
        store: memoryStore(), fetchImpl: async (_url, init) => { throw init.signal.reason; },
      }),
      (error) => error.statusCode === 504 && error.code === "attachment_upload_timeout",
    );
  } finally {
    AbortSignal.timeout = originalTimeout;
  }
});

test("storage errors redact credentials, signed URLs, and inline Base64", async () => {
  const secretData = dataUrl("image/png", pngBytes(6 * MIB + 1));
  const storage = storageFetchRecorder({
    presignStatus: 502,
    presignPayload: { error: `Bearer top-secret https://r2.example.test/object?signature=secret ${secretData}` },
  });
  await assert.rejects(
    assetizeAttachments(responsesPayload([{ type: "input_image", image_url: secretData }]), BASE_SETTINGS, { store: memoryStore(), fetchImpl: storage.fetchImpl }),
    (error) => {
      assert.doesNotMatch(error.message, /top-secret|signature=secret|base64,/);
      assert.ok(error.message.length < 600);
      return true;
    },
  );
});

test("checkpoint and replay identities never depend on expiring signed URLs", () => {
  const sha = "7".repeat(64);
  const first = storedPart({ sha, bytes: 123, mime: "image/png", currentUrl: "https://r2.example.test/a.png?signature=one" });
  const second = storedPart({ sha, bytes: 123, mime: "image/png", currentUrl: "https://r2.example.test/a.png?signature=two" });
  assert.deepEqual(stableAttachmentFingerprintObject(first), stableAttachmentFingerprintObject(second));
  assert.equal(replayItemFingerprint(first).value, replayItemFingerprint(second).value);
  const checkpoint = checkpointAttachmentReferences(first);
  assert.equal(checkpoint.image_url, `asset:asset_${sha}`);
  assert.doesNotMatch(JSON.stringify(checkpoint), /signature=/);
  const stripped = stripAttachmentMetadata(first);
  assert.equal(stripped.momo_asset, undefined);
});
