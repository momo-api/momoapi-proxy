import assert from "node:assert/strict";
import test from "node:test";
import { IMAGE_CAPABILITIES, extractImageResults, generateImage, normalizeImageRequest } from "../src/image-service.mjs";

const settings = { endpoint: "https://gateway.example", apiKey: "test-key-not-real" };
const tinyPng = "data:image/png;base64,iVBORw0KGgo=";
const publicLookup = async () => [{ address: "203.0.113.10", family: 4 }];

test("advertises the verified model-specific capability matrix", () => {
  const byId = Object.fromEntries(IMAGE_CAPABILITIES.models.map((model) => [model.id, model]));
  assert.equal(IMAGE_CAPABILITIES.version, 2);
  assert.equal(byId["gpt-image-2"].limits.max_reference_images, 1);
  assert.equal(byId["gpt-image-2"].transports.edit, "images-generations-reference");
  assert.equal(byId["gpt-image-2-momoapi"].limits.max_reference_images, 4);
  assert.equal(byId["gpt-image-2-momoapi"].transports.edit, "chat-completions-multimodal-stream");
  assert.deepEqual(byId["gemini-3.1-flash-image"].operations, ["generate", "edit"]);
  assert.equal(byId["gemini-3.1-flash-image"].transports.edit, "chat-completions-multimodal");
  assert.equal(byId["gemini-3.1-flash-image"].mask_edits, false);
});

test("maps Gemini generation controls to NewAPI Images fields", async () => {
  const calls = [];
  const result = await generateImage({
    settings,
    request: { model: "gemini-3.1-flash-image", prompt: "a tree", aspect_ratio: "16:9", resolution: "2K", n: 1 },
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ data: [{ b64_json: "aGVsbG8=" }] }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  assert.equal(calls[0].url, "https://gateway.example/v1/images/generations");
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    model: "gemini-3.1-flash-image", prompt: "a tree", n: 1, size: "16:9", quality: "2K",
  });
  assert.equal(result.images[0].b64_json, "aGVsbG8=");
});

test("maps GPT generation aliases without sending response_format", async () => {
  let body;
  await generateImage({
    settings,
    request: { model: "gpt-image-2", prompt: "a tree", aspect_ratio: "16:9", resolution: "4k" },
    fetchImpl: async (_url, init) => {
      body = JSON.parse(init.body);
      return new Response(JSON.stringify({ task_id: "task-1" }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  assert.deepEqual(body, { model: "gpt-image-2", prompt: "a tree", n: 1, size: "1536x1024", quality: "high" });
  assert.equal("response_format" in body, false);
});

test("validates each model's n and reference-image limits", () => {
  assert.throws(() => normalizeImageRequest({ model: "gpt-image-2", prompt: "x", n: 2 }), /between 1 and 1/);
  assert.throws(() => normalizeImageRequest({ model: "gpt-image-2", prompt: "x", reference_images: [tinyPng] }, "generate"), /Use image_edit/);
  assert.throws(() => normalizeImageRequest({ model: "gpt-image-2", prompt: "x" }, "edit"), /reference_images/);
  assert.throws(() => normalizeImageRequest({ model: "gpt-image-2", prompt: "x", reference_images: [tinyPng, tinyPng] }, "edit"), /at most 1/);
  assert.doesNotThrow(() => normalizeImageRequest({ model: "gpt-image-2-momoapi", prompt: "x", reference_images: [tinyPng, tinyPng, tinyPng, tinyPng] }, "edit"));
  assert.throws(() => normalizeImageRequest({ model: "gemini-3.1-flash-image", prompt: "x", reference_images: [tinyPng, tinyPng] }, "edit"), /at most 1/);
});

test("routes gpt-image-2 reference editing through images/generations image_urls", async () => {
  let call;
  const result = await generateImage({
    settings,
    request: { model: "gpt-image-2", prompt: "make it blue", reference_images: [tinyPng], aspect_ratio: "3:2", resolution: "2k" },
    operation: "edit",
    fetchImpl: async (url, init) => {
      call = { url: String(url), body: JSON.parse(init.body), headers: init.headers };
      return new Response(JSON.stringify({ task_id: "official-edit-task" }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  assert.equal(call.url, "https://gateway.example/v1/images/generations");
  assert.equal(call.body.image_urls[0], tinyPng);
  assert.equal(call.body.size, "1536x1024");
  assert.equal(call.body.quality, "medium");
  assert.equal(call.headers.authorization, "Bearer test-key-not-real");
  assert.equal(result.task_id, "official-edit-task");
});

test("routes gpt-image-2-momoapi editing through streaming multimodal chat", async () => {
  let call;
  const sse = [
    "data: " + JSON.stringify({ choices: [{ delta: { content: "![image](data:image/png;base64," } }] }),
    "",
    "data: " + JSON.stringify({ choices: [{ delta: { content: "aGVsbG8=)" } }] }),
    "",
    "data: [DONE]",
    "",
  ].join("\n");
  const result = await generateImage({
    settings,
    request: { model: "gpt-image-2-momoapi", prompt: "add a hat", reference_images: [tinyPng], aspect_ratio: "1:1", resolution: "1k" },
    operation: "edit",
    fetchImpl: async (url, init) => {
      call = { url: String(url), body: JSON.parse(init.body) };
      return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
    },
  });
  assert.equal(call.url, "https://gateway.example/v1/chat/completions");
  assert.equal(call.body.stream, true);
  assert.equal(call.body.messages[0].content[1].image_url.url, tinyPng);
  assert.match(call.body.messages[0].content[0].text, /quality hint/);
  assert.equal(result.images[0].b64_json, "aGVsbG8=");
  assert.equal(result.images[0].mime_type, "image/png");
});

test("routes Gemini editing through multimodal chat and snake_case image_config", async () => {
  let call;
  const responseContent = "Edited: ![image](data:image/jpeg;base64,aGVsbG8=)";
  const result = await generateImage({
    settings,
    request: { model: "gemini-3.1-flash-image", prompt: "change the sky", reference_images: [tinyPng], aspect_ratio: "9:16", resolution: "4k" },
    operation: "edit",
    fetchImpl: async (url, init) => {
      call = { url: String(url), body: JSON.parse(init.body) };
      return new Response(JSON.stringify({ choices: [{ message: { content: responseContent } }] }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  assert.equal(call.url, "https://gateway.example/v1/chat/completions");
  assert.deepEqual(call.body.modalities, ["text", "image"]);
  assert.deepEqual(call.body.extra_body.google.image_config, { aspect_ratio: "9:16", image_size: "4K" });
  assert.equal(call.body.messages[0].content[1].image_url.url, tinyPng);
  assert.equal(result.images[0].b64_json, "aGVsbG8=");
  assert.equal(result.images[0].mime_type, "image/jpeg");
});

test("downloads HTTPS references once as data URLs and blocks SSRF targets", async () => {
  const calls = [];
  await generateImage({
    settings,
    request: { model: "gpt-image-2-momoapi", prompt: "edit", reference_images: ["https://cdn.example/reference.png"] },
    operation: "edit",
    lookupImpl: publicLookup,
    fetchImpl: async (url, init = {}) => {
      calls.push({ url: String(url), init });
      if (String(url) === "https://cdn.example/reference.png") return new Response(new Uint8Array([137, 80, 78, 71]), { status: 200, headers: { "content-type": "image/png" } });
      return new Response("data: " + JSON.stringify({ choices: [{ delta: { content: "data:image/png;base64,aGVsbG8=" } }] }) + "\n\ndata: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });
    },
  });
  assert.equal(calls.length, 2);
  const body = JSON.parse(calls[1].init.body);
  assert.match(body.messages[0].content[1].image_url.url, /^data:image\/png;base64,/);

  await assert.rejects(() => generateImage({
    settings,
    request: { model: "gpt-image-2-momoapi", prompt: "edit", reference_images: ["https://127.0.0.1/private.png"] },
    fetchImpl: async () => { throw new Error("must not fetch blocked host"); },
    operation: "edit",
  }), /host is not allowed/);
  await assert.rejects(() => generateImage({
    settings,
    request: { model: "gpt-image-2-momoapi", prompt: "edit", reference_images: ["https://cdn.example/private.png"] },
    lookupImpl: async () => [{ address: "10.10.10.10", family: 4 }],
    fetchImpl: async () => { throw new Error("must not fetch DNS-resolved private host"); },
    operation: "edit",
  }), /resolved to a non-public address/);
  await assert.rejects(() => generateImage({
    settings,
    request: { model: "gpt-image-2-momoapi", prompt: "edit", reference_images: ["http://cdn.example/reference.png"] },
    fetchImpl: async () => { throw new Error("must not fetch insecure reference"); },
    operation: "edit",
  }), /must use HTTPS/);
  await assert.rejects(() => generateImage({
    settings,
    request: { model: "gpt-image-2-momoapi", prompt: "edit", reference_images: ["https://[::1]/private.png"] },
    fetchImpl: async () => { throw new Error("must not fetch IPv6 loopback"); },
    operation: "edit",
  }), /host is not allowed/);
});

test("extracts direct, nested, data URL, and async image response shapes", () => {
  assert.deepEqual(extractImageResults({ url: "https://example.com/a.png" }), { images: [{ url: "https://example.com/a.png" }], task_id: null, raw_status: null, terminal: false });
  assert.equal(extractImageResults({ data: [{ task_id: "task-1" }] }).task_id, "task-1");
  assert.equal(extractImageResults({ response: { output: [{ image_url: "https://example.com/b.png" }] } }).images[0].url, "https://example.com/b.png");
  assert.equal(extractImageResults({ item: { result: "a".repeat(300) } }).images[0].b64_json.length, 300);
  assert.deepEqual(extractImageResults("![image](data:image/webp;base64,aGVsbG8=)").images[0], { b64_json: "aGVsbG8=", mime_type: "image/webp" });
  assert.deepEqual(extractImageResults({ status: "failed", failure_reason: "upstream rejected image" }), {
    images: [], task_id: null, raw_status: "failed", terminal: true, error: "upstream rejected image",
  });
});

test("turns an HTML Cloudflare timeout into a concise upstream error", async () => {
  await assert.rejects(() => generateImage({
    settings,
    request: { model: "gpt-image-2-momoapi", prompt: "x" },
    fetchImpl: async () => new Response("<!DOCTYPE html><html><body>large diagnostic page</body></html>", { status: 524, headers: { "content-type": "text/html" } }),
  }), (error) => {
    assert.match(error.message, /HTTP 524 \(Cloudflare timeout\)/);
    assert.doesNotMatch(error.message, /DOCTYPE|diagnostic page/);
    return true;
  });
});
