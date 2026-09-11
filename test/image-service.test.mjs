import assert from "node:assert/strict";
import test from "node:test";
import { IMAGE_CAPABILITIES, extractImageResults, generateImage, normalizeImageRequest, resolveImageCapabilities } from "../src/image-service.mjs";

const settings = { endpoint: "https://gateway.example", apiKey: "test-key-not-real" };
const tinyPng = "data:image/png;base64,iVBORw0KGgo=";
const publicLookup = async () => [{ address: "203.0.113.10", family: 4 }];

test("advertises the verified model-specific capability matrix", () => {
  const byId = Object.fromEntries(IMAGE_CAPABILITIES.models.map((model) => [model.id, model]));
  assert.equal(IMAGE_CAPABILITIES.version, 4);
  assert.equal(byId["gpt-image-2"].limits.max_reference_images, 1);
  assert.equal(byId["gpt-image-2"].transports.edit, "images-generations-reference");
  assert.equal(byId["gpt-image-2-momoapi"].limits.max_reference_images, 4);
  assert.equal(byId["gpt-image-2-momoapi"].transports.edit, "chat-completions-multimodal-stream");
  assert.deepEqual(byId["gemini-3.1-flash-image"].operations, ["generate", "edit"]);
  assert.equal(byId["gemini-3.1-flash-image"].transports.edit, "chat-completions-multimodal");
  assert.equal(byId["gemini-3.1-flash-image"].mask_edits, false);
  assert.equal(byId["gpt-image-2.5-sunburst"].limits.max_reference_images, 16);
  assert.equal(byId["gpt-image-2.5-sunburst"].limits.max_n, 10);
  assert.equal(byId["gpt-image-2.5-sunburst"].mask_edits, true);
  assert.equal(byId["gpt-image-2.5-sunburst"].available, false);
  assert.equal(byId["gpt-image-2.5-flare"].transports.edit, "images-edits-url-or-multipart");
});

test("enables GPT Image 2.5 only when the authenticated model catalog contains it", async () => {
  const capabilities = await resolveImageCapabilities({
    settings,
    fetchImpl: async () => new Response(JSON.stringify({ data: [{ id: "gpt-image-2.5-sunburst" }] }), { status: 200, headers: { "content-type": "application/json" } }),
  });
  const byId = Object.fromEntries(capabilities.models.map((model) => [model.id, model]));
  assert.equal(byId["gpt-image-2.5-sunburst"].available, true);
  assert.equal(byId["gpt-image-2.5-flare"].available, false);
  assert.equal(capabilities.catalog_status, "available");
});

test("validates GPT Image 2.5 native controls and 16 references", () => {
  const references = Array.from({ length: 16 }, () => tinyPng);
  const request = normalizeImageRequest({
    model: "gpt-image-2.5-sunburst", prompt: "x", n: 10, size: "1536x864", quality: "max",
    reference_images: references, mask: tinyPng, input_fidelity: "high", output_format: "webp",
    output_compression: 70, background: "transparent", moderation: "low", stream: true, partial_images: 3,
  }, "edit");
  assert.equal(request.reference_images.length, 16);
  assert.equal(request.size, "1536x864");
  assert.equal(request.quality, "max");
  assert.equal(request.input_fidelity, "high");
  assert.throws(() => normalizeImageRequest({ model: "gpt-image-2.5-flare", prompt: "x", size: "1025x1024" }), /multiples of 16/);
  assert.throws(() => normalizeImageRequest({ model: "gpt-image-2.5-flare", prompt: "x", background: "transparent", output_format: "jpeg" }), /requires png or webp/);
  assert.throws(() => normalizeImageRequest({ model: "gpt-image-2.5-flare", prompt: "x", partial_images: 1 }), /requires stream=true/);
  assert.throws(() => normalizeImageRequest({ model: "gpt-image-2.5-flare", prompt: "x", reference_images: [...references, tinyPng] }, "edit"), /at most 16/);
});

test("routes GPT Image 2.5 generation with all native JSON controls", async () => {
  const calls = [];
  const result = await generateImage({
    settings,
    request: { model: "gpt-image-2.5-flare", prompt: "a tree", n: 2, size: "1536x864", quality: "xhigh", output_format: "jpeg", output_compression: 55, background: "opaque", moderation: "low", stream: true, partial_images: 2 },
    fetchImpl: async (url, init = {}) => {
      calls.push({ url: String(url), init });
      if (String(url).endsWith("/v1/models")) return new Response(JSON.stringify({ data: [{ id: "gpt-image-2.5-flare" }] }), { status: 200, headers: { "content-type": "application/json" } });
      return new Response([
        "data: " + JSON.stringify({ type: "image_generation.partial_image", partial_image_b64: "cGFydGlhbA==" }),
        "", "data: " + JSON.stringify({ type: "image_generation.completed", b64_json: "ZmluYWw=" }), "", "data: [DONE]", "",
      ].join("\n"), { status: 200, headers: { "content-type": "text/event-stream" } });
    },
  });
  assert.equal(calls[1].url, "https://gateway.example/v1/images/generations");
  assert.deepEqual(JSON.parse(calls[1].init.body), {
    model: "gpt-image-2.5-flare", prompt: "a tree", n: 2, size: "1536x864", quality: "xhigh",
    output_format: "jpeg", background: "opaque", moderation: "low", stream: true, output_compression: 55, partial_images: 2,
  });
  assert.equal(result.images.length, 2);
  assert.equal(result.images[0].mime_type, "image/jpeg");
});

test("routes GPT Image 2.5 editing as multipart with 16 images and mask", async () => {
  const references = Array.from({ length: 16 }, () => tinyPng);
  let call;
  await generateImage({
    settings, operation: "edit",
    request: { model: "gpt-image-2.5-sunburst", prompt: "preserve the subject", reference_images: references, mask: tinyPng, input_fidelity: "high", size: "1024x1024", quality: "max", output_format: "png" },
    fetchImpl: async (url, init = {}) => {
      if (String(url).endsWith("/v1/models")) return new Response(JSON.stringify({ data: [{ id: "gpt-image-2.5-sunburst" }] }), { status: 200, headers: { "content-type": "application/json" } });
      call = { url: String(url), init };
      return new Response(JSON.stringify({ data: [{ b64_json: "aGVsbG8=" }] }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  assert.equal(call.url, "https://gateway.example/v1/images/edits");
  assert.equal(call.init.headers["content-type"], undefined);
  assert.equal(call.init.body.getAll("image[]").length, 16);
  assert.equal(call.init.body.get("model"), "gpt-image-2.5-sunburst");
  assert.equal(call.init.body.get("mask") instanceof Blob, true);
  assert.equal(call.init.body.get("input_fidelity"), "high");
  assert.equal(call.init.body.get("quality"), "max");
});

test("uses the singular multipart image field for one GPT Image 2.5 reference", async () => {
  let form;
  await generateImage({
    settings, operation: "edit",
    request: { model: "gpt-image-2.5-flare", prompt: "edit", reference_images: [tinyPng] },
    fetchImpl: async (url, init = {}) => {
      if (String(url).endsWith("/v1/models")) return new Response(JSON.stringify({ data: [{ id: "gpt-image-2.5-flare" }] }), { status: 200, headers: { "content-type": "application/json" } });
      form = init.body;
      return new Response(JSON.stringify({ data: [{ b64_json: "aGVsbG8=" }] }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  assert.equal(form.getAll("image").length, 1);
  assert.equal(form.getAll("image[]").length, 0);
});

test("passes 16 public GPT Image 2.5 reference URLs without downloading them", async () => {
  const referenceUrls = Array.from({ length: 16 }, (_, index) => `https://assets.example/reference-${index + 1}.png?signature=test`);
  const maskUrl = "https://assets.example/mask.png?signature=test";
  const calls = [];
  await generateImage({
    settings, operation: "edit",
    request: {
      model: "gpt-image-2.5-flare", prompt: "edit", reference_images: referenceUrls,
      mask: maskUrl, input_fidelity: "high",
    },
    lookupImpl: publicLookup,
    fetchImpl: async (url, init = {}) => {
      calls.push({ url: String(url), init });
      if (String(url).endsWith("/v1/models")) {
        return new Response(JSON.stringify({ data: [{ id: "gpt-image-2.5-flare" }] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ data: [{ b64_json: "aGVsbG8=" }] }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, "https://gateway.example/v1/images/edits");
  assert.equal(calls[1].init.headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(calls[1].init.body), {
    model: "gpt-image-2.5-flare", prompt: "edit", n: 1, size: "auto", quality: "auto",
    output_format: "png", background: "auto", moderation: "auto", stream: false,
    images: referenceUrls.map((image_url) => ({ image_url })), mask: { image_url: maskUrl }, input_fidelity: "high",
  });
});

test("returns model_unavailable before calling a hidden GPT Image 2.5 route", async () => {
  let calls = 0;
  await assert.rejects(() => generateImage({
    settings, request: { model: "gpt-image-2.5-flare", prompt: "x" },
    fetchImpl: async () => { calls += 1; return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { "content-type": "application/json" } }); },
  }), (error) => error.code === "model_unavailable" && error.statusCode === 503);
  assert.equal(calls, 1);
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
  assert.throws(() => normalizeImageRequest({ model: "gpt-image-2-momoapi", prompt: "x", quality: "max" }), /only for GPT Image 2.5/);
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

test("resolves local asset IDs only through the configured asset resolver", async () => {
  const assetId = "img_" + "a".repeat(64);
  let resolved;
  await generateImage({
    settings,
    request: { model: "gpt-image-2-momoapi", prompt: "edit", reference_images: ["asset:" + assetId] },
    operation: "edit",
    assetResolver: async (reference) => {
      resolved = reference;
      return tinyPng;
    },
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      assert.equal(body.messages[0].content[1].image_url.url, tinyPng);
      return new Response("data: " + JSON.stringify({ choices: [{ delta: { content: "data:image/png;base64,aGVsbG8=" } }] }) + "\n\ndata: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });
    },
  });
  assert.equal(resolved, "asset:" + assetId);
  assert.throws(() => normalizeImageRequest({ model: "gpt-image-2-momoapi", prompt: "edit", reference_images: ["C:\\Users\\example\\secret.png"] }, "edit"), /local asset IDs/);
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

test("retains only same-origin HTTPS image URLs as trusted vision sources", async () => {
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2mYQAAAAASUVORK5CYII=";
  for (const [url, expected] of [
    ["https://gateway.example/generated/a.png", "https://gateway.example/generated/a.png"],
    ["http://gateway.example/generated/a.png", null],
    ["https://cdn.example/generated/a.png", null],
  ]) {
    const result = await generateImage({
      settings,
      request: { model: "gpt-image-2-momoapi", prompt: "x" },
      fetchImpl: async () => new Response(JSON.stringify({ data: [{ url, b64_json: png }] }), { status: 200, headers: { "content-type": "application/json" } }),
    });
    assert.equal(result.images[0].source_url || null, expected);
  }
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
