import assert from "node:assert/strict";
import test from "node:test";
import { extractImageResults, generateImage, normalizeImageRequest } from "../src/image-service.mjs";

test("normalizes image requests and maps Gemini controls", async () => {
  const calls = [];
  const result = await generateImage({
    settings: { endpoint: "https://gateway.example", apiKey: "secret" },
    request: { model: "gemini-3.1-flash-image", prompt: "a tree", aspect_ratio: "16:9", resolution: "2K", n: 1 },
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ data: [{ b64_json: "aGVsbG8=" }] }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  assert.equal(calls[0].url, "https://gateway.example/v1/images/generations");
  assert.equal(JSON.parse(calls[0].init.body).aspectRatio, "16:9");
  assert.equal(JSON.parse(calls[0].init.body).imageSize, "2K");
  assert.equal(result.images[0].b64_json, "aGVsbG8=");
});

test("rejects references on generation and requires them for edit", () => {
  assert.throws(() => normalizeImageRequest({ prompt: "x", reference_images: ["https://example.com/a.png"] }, "generate"), /Use image_edit/);
  assert.throws(() => normalizeImageRequest({ prompt: "x" }, "edit"), /reference_images/);
});

test("extracts direct, nested, and async image response shapes", () => {
  assert.deepEqual(extractImageResults({ url: "https://example.com/a.png" }), { images: [{ url: "https://example.com/a.png" }], task_id: null, raw_status: null });
  assert.deepEqual(extractImageResults({ data: [{ task_id: "task-1" }] }).task_id, "task-1");
  assert.equal(extractImageResults({ item: { result: "ignored" }, response: { output: [{ image_url: "https://example.com/b.png" }] } }).images[0].url, "https://example.com/b.png");
});

test("turns HTTPS references into multipart files and blocks obvious SSRF targets", async () => {
  let upload;
  const result = await generateImage({
    settings: { endpoint: "https://gateway.example", apiKey: "secret" },
    request: { model: "gpt-image-2-momoapi", prompt: "edit", reference_images: ["https://cdn.example/reference.png"] },
    operation: "edit",
    fetchImpl: async (url, init = {}) => {
      if (String(url).startsWith("https://cdn.example")) return new Response(new Uint8Array([137, 80, 78, 71]), { status: 200, headers: { "content-type": "image/png" } });
      upload = init;
      return new Response(JSON.stringify({ data: [{ b64_json: "aGVsbG8=" }] }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  assert.equal(result.images[0].b64_json, "aGVsbG8=");
  assert.match(upload.headers.authorization, /^Bearer secret$/);
  assert.equal(upload.body instanceof FormData, true);
  await assert.rejects(() => generateImage({
    settings: { endpoint: "https://gateway.example", apiKey: "secret" },
    request: { model: "gpt-image-2-momoapi", prompt: "edit", reference_images: ["https://127.0.0.1/private.png"] },
    fetchImpl: async () => { throw new Error("must not fetch blocked host"); },
    operation: "edit",
  }), /host is not allowed/);
});
