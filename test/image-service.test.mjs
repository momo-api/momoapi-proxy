import assert from "node:assert/strict";
import test from "node:test";
import { IMAGE_CAPABILITIES, extractImageResults, generateImage, normalizeImageRequest, resolveImageCapabilities } from "../src/image-service.mjs";

const settings = { endpoint: "https://gateway.example", apiKey: "test-key-not-real" };
const tinyPng = "data:image/png;base64,iVBORw0KGgo=";
const publicLookup = async () => [{ address: "203.0.113.10", family: 4 }];

test("advertises the verified model-specific capability matrix", () => {
  const byId = Object.fromEntries(IMAGE_CAPABILITIES.models.map((model) => [model.id, model]));
  assert.equal(IMAGE_CAPABILITIES.version, 5);
  assert.equal(byId["momoapi-gpt-image-2-5-flare"].available, false);
  assert.deepEqual(byId["momoapi-gpt-image-2-5-flare"].limits.qualities, ["low", "medium", "high"]);
  assert.equal(byId["gpt-image-2"].limits.max_reference_images, 1);
  assert.equal(byId["gpt-image-2"].transports.edit, "images-generations-reference");
  assert.equal(byId["gpt-image-2-momoapi"].limits.max_reference_images, 0);
  assert.deepEqual(byId["gpt-image-2-momoapi"].operations, ["generate"]);
  assert.equal(byId["gpt-image-2-momoapi"].transports.edit, null);
  assert.deepEqual(byId["gemini-3.1-flash-image"].operations, ["generate", "edit"]);
  assert.equal(byId["gemini-3.1-flash-image"].transports.edit, "chat-completions-multimodal");
  assert.equal(byId["gemini-3.1-flash-image"].mask_edits, false);
  assert.equal(byId["gpt-image-2.5-sunburst"].limits.max_reference_images, 16);
  assert.equal(byId["gpt-image-2.5-sunburst"].limits.max_n, 4);
  assert.equal(byId["gpt-image-2.5-sunburst"].mask_edits, false);
  assert.equal(byId["gpt-image-2.5-sunburst"].available, false);
  assert.equal(byId["gpt-image-2.5-flare"].transports.edit, "images-generations-image-urls");
});

test("uses the authenticated media capability contract and prefers Adobe primary models", async () => {
  const capabilities = await resolveImageCapabilities({
    settings,
    fetchImpl: async () => new Response(JSON.stringify({ models: [
      { id: "momoapi-gpt-image-2-5-flare", modality: "image", role: "primary", available: true, operations: ["generate", "edit"], parameters: { n: { allowed: [1, 2, 3, 4] }, quality: { allowed: ["low", "medium", "high"] }, max_reference_images: { maximum: 4 } } },
      { id: "gpt-image-2.5-sunburst", modality: "image", role: "fallback", available: true, operations: ["generate", "edit"], parameters: { n: { allowed: [1, 2, 3, 4] }, quality: { allowed: ["auto", "low", "medium", "high", "xhigh", "max"] }, max_reference_images: { maximum: 16 } } },
    ] }), { status: 200, headers: { "content-type": "application/json" } }),
  });
  const byId = Object.fromEntries(capabilities.models.map((model) => [model.id, model]));
  assert.equal(byId["momoapi-gpt-image-2-5-flare"].available, true);
  assert.equal(byId["momoapi-gpt-image-2-5-flare"].role, "primary");
  assert.deepEqual(byId["momoapi-gpt-image-2-5-flare"].limits.qualities, ["low", "medium", "high"]);
  assert.deepEqual(byId["momoapi-gpt-image-2-5-flare"].parameter_schema.quality.allowed, ["low", "medium", "high"]);
  assert.equal(byId["gpt-image-2.5-sunburst"].available, true);
  assert.equal(capabilities.defaults.model, "momoapi-gpt-image-2-5-flare");
  assert.equal(capabilities.catalog_status, "available");
});

test("rejects a known model omitted by an authoritative partial capability catalog", () => {
  const capabilities = {
    ...structuredClone(IMAGE_CAPABILITIES),
    catalog_status: "available",
    models: [{ id: "momoapi-gpt-image-2-5-flare", available: true, operations: ["generate"], limits: { max_n: 1, max_reference_images: 0, qualities: ["low"] } }],
  };
  assert.throws(
    () => normalizeImageRequest({ model: "gpt-image-2.5-flare", prompt: "x" }, "generate", capabilities),
    (error) => error.code === "model_unavailable" && error.statusCode === 503,
  );
});

test("validates Adobe primary controls from the returned model profile", () => {
  const capabilities = {
    ...structuredClone(IMAGE_CAPABILITIES),
    defaults: { ...IMAGE_CAPABILITIES.defaults, model: "momoapi-gpt-image-2-5-flare" },
    models: [{
      id: "momoapi-gpt-image-2-5-flare", available: true, operations: ["generate", "edit"],
      parameters: { n: { allowed: [1, 2] }, quality: { allowed: ["low", "medium", "high"] }, max_reference_images: { maximum: 2 } },
    }],
  };
  assert.equal(normalizeImageRequest({ prompt: "x", n: 2, quality: "high" }, "generate", capabilities).model, "momoapi-gpt-image-2-5-flare");
  assert.throws(() => normalizeImageRequest({ prompt: "x", n: 3 }, "generate", capabilities), /between 1 and 2/);
  assert.throws(() => normalizeImageRequest({ prompt: "x", quality: "max" }, "generate", capabilities), /Unsupported quality/);
  assert.throws(() => normalizeImageRequest({ prompt: "x", reference_images: [tinyPng, tinyPng, tinyPng] }, "edit", capabilities), /at most 2/);
});

test("accepts every advertised image enum and enforces numeric boundaries", () => {
  const capabilities = {
    ...structuredClone(IMAGE_CAPABILITIES),
    catalog_status: "available",
    defaults: { model: "momoapi-gpt-image-2-5-flare", n: 1, aspect_ratio: "1:1", resolution: "1k" },
    models: [
      { id: "momoapi-gpt-image-2-5-flare", available: true, operations: ["generate", "edit"], parameters: { n: { allowed: [1, 2, 3, 4] }, quality: { allowed: ["low", "medium", "high"] }, max_reference_images: { maximum: 4 } } },
      { id: "momoapi-gemini-nano-banana-3", available: true, operations: ["generate", "edit"], parameters: { n: { allowed: [1] }, aspect_ratio: { allowed: ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"] }, resolution: { allowed: ["1k", "2k", "4k"] }, max_reference_images: { maximum: 4 } } },
      { id: "gpt-image-2.5-flare", available: true, operations: ["generate", "edit"], parameters: { n: { allowed: [1, 2, 3, 4] }, quality: { allowed: ["auto", "low", "medium", "high", "xhigh", "max"] }, resolution: { allowed: ["1k", "2k", "4k"] }, max_reference_images: { maximum: 16 } } },
    ],
  };
  for (const n of [1, 2, 3, 4]) assert.equal(normalizeImageRequest({ model: "momoapi-gpt-image-2-5-flare", prompt: "x", n }, "generate", capabilities).n, n);
  for (const quality of ["low", "medium", "high"]) assert.equal(normalizeImageRequest({ model: "momoapi-gpt-image-2-5-flare", prompt: "x", quality }, "generate", capabilities).quality, quality);
  for (const aspect_ratio of ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"]) {
    assert.equal(normalizeImageRequest({ model: "momoapi-gemini-nano-banana-3", prompt: "x", aspect_ratio }, "generate", capabilities).aspect_ratio, aspect_ratio);
  }
  for (const resolution of ["1k", "2k", "4k"]) assert.equal(normalizeImageRequest({ model: "momoapi-gemini-nano-banana-3", prompt: "x", resolution }, "generate", capabilities).resolution, resolution);
  for (const quality of ["auto", "low", "medium", "high", "xhigh", "max"]) assert.equal(normalizeImageRequest({ model: "gpt-image-2.5-flare", prompt: "x", quality }, "generate", capabilities).quality, quality);
  for (const resolution of ["1k", "2k", "4k"]) assert.equal(normalizeImageRequest({ model: "gpt-image-2.5-flare", prompt: "x", resolution }, "generate", capabilities).resolution, resolution);
  for (const output_format of ["png", "jpeg", "webp"]) assert.equal(normalizeImageRequest({ model: "gpt-image-2.5-flare", prompt: "x", output_format }, "generate", capabilities).output_format, output_format);
  for (const background of ["auto", "opaque", "transparent"]) assert.equal(normalizeImageRequest({ model: "gpt-image-2.5-flare", prompt: "x", background }, "generate", capabilities).background, background);
  for (const moderation of ["auto", "low"]) assert.equal(normalizeImageRequest({ model: "gpt-image-2.5-flare", prompt: "x", moderation }, "generate", capabilities).moderation, moderation);
  for (const output_compression of [0, 100]) assert.equal(normalizeImageRequest({ model: "gpt-image-2.5-flare", prompt: "x", output_format: "webp", output_compression }, "generate", capabilities).output_compression, output_compression);
  for (const size of ["auto", "1:1", "1024x1024", "3840x2160", "1536x864"]) assert.equal(normalizeImageRequest({ model: "gpt-image-2.5-flare", prompt: "x", size }, "generate", capabilities).size, size);
  assert.throws(() => normalizeImageRequest({ model: "gpt-image-2.5-flare", prompt: "x", output_format: "webp", output_compression: -1 }, "generate", capabilities), /between 0 and 100/);
  assert.throws(() => normalizeImageRequest({ model: "gpt-image-2.5-flare", prompt: "x", output_format: "webp", output_compression: 101 }, "generate", capabilities), /between 0 and 100/);
});

test("validates GPT Image 2.5 native controls and 16 references", () => {
  const references = Array.from({ length: 16 }, () => tinyPng);
  const capabilities = structuredClone(IMAGE_CAPABILITIES);
  for (const model of capabilities.models) {
    if (model.id === "gpt-image-2.5-sunburst" || model.id === "gpt-image-2.5-flare") model.available = true;
  }
  const request = normalizeImageRequest({
    model: "gpt-image-2.5-sunburst", prompt: "x", n: 4, size: "1536x864", quality: "max",
    reference_images: references, output_format: "webp",
    output_compression: 70, background: "transparent", moderation: "low",
  }, "edit", capabilities);
  assert.equal(request.reference_images.length, 16);
  assert.equal(request.size, "1536x864");
  assert.equal(request.quality, "max");
  assert.equal(request.resolution, "1k");
  assert.equal(request.mask, undefined);
  assert.throws(() => normalizeImageRequest({ model: "gpt-image-2.5-flare", prompt: "x", size: "1025x1024" }, "generate", capabilities), /multiples of 16/);
  assert.throws(() => normalizeImageRequest({ model: "gpt-image-2.5-flare", prompt: "x", background: "transparent", output_format: "jpeg" }, "generate", capabilities), /requires png or webp/);
  assert.throws(() => normalizeImageRequest({ model: "gpt-image-2.5-flare", prompt: "x", stream: true }, "generate", capabilities), /does not support streaming/);
  assert.throws(() => normalizeImageRequest({ model: "gpt-image-2.5-flare", prompt: "x", partial_images: 1 }, "generate", capabilities), /does not support partial_images/);
  assert.throws(() => normalizeImageRequest({ model: "gpt-image-2.5-flare", prompt: "x", input_fidelity: "high" }, "edit", capabilities), /input_fidelity is not supported/);
  assert.throws(() => normalizeImageRequest({ model: "gpt-image-2.5-flare", prompt: "x", mask: tinyPng, reference_images: [tinyPng] }, "edit", capabilities), /mask is not supported/);
  assert.throws(() => normalizeImageRequest({ model: "gpt-image-2.5-flare", prompt: "x", reference_images: [...references, tinyPng] }, "edit", capabilities), /at most 16/);
});

test("routes GPT Image 2.5 generation with all native JSON controls", async () => {
  const calls = [];
  const result = await generateImage({
    settings,
    request: { model: "gpt-image-2.5-flare", prompt: "a tree", n: 2, size: "1536x864", resolution: "2k", quality: "xhigh", output_format: "jpeg", output_compression: 55, background: "opaque", moderation: "low" },
    fetchImpl: async (url, init = {}) => {
      calls.push({ url: String(url), init });
      if (String(url).endsWith("/agent/media-capabilities")) return new Response(JSON.stringify({ models: [{ id: "gpt-image-2.5-flare", modality: "image", available: true, operations: ["generate", "edit"], parameters: {} }] }), { status: 200, headers: { "content-type": "application/json" } });
      return new Response(JSON.stringify({ code: 200, data: [{ status: "submitted", task_id: "task-25" }] }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  assert.equal(calls[1].url, "https://gateway.example/v1/images/generations");
  assert.deepEqual(JSON.parse(calls[1].init.body), {
    model: "gpt-image-2.5-flare", prompt: "a tree", n: 2, size: "1536x864", resolution: "2k", quality: "xhigh",
    output_format: "jpeg", background: "opaque", moderation: "low", output_compression: 55,
  });
  assert.equal(result.task_id, "task-25");
});

test("routes GPT Image 2.5 editing with 16 public image_urls", async () => {
  const referenceUrls = Array.from({ length: 16 }, (_, index) => "https://assets.example/reference-" + (index + 1) + ".png");
  let call;
  await generateImage({
    settings, operation: "edit",
    request: { model: "gpt-image-2.5-sunburst", prompt: "preserve the subject", reference_images: referenceUrls, size: "1:1", resolution: "2k", quality: "max", output_format: "png" },
    lookupImpl: publicLookup,
    fetchImpl: async (url, init = {}) => {
      if (String(url).endsWith("/agent/media-capabilities")) return new Response(JSON.stringify({ models: [{ id: "gpt-image-2.5-sunburst", modality: "image", available: true, operations: ["generate", "edit"], parameters: {} }] }), { status: 200, headers: { "content-type": "application/json" } });
      call = { url: String(url), init };
      return new Response(JSON.stringify({ code: 200, data: [{ status: "submitted", task_id: "task-edit-25" }] }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  assert.equal(call.url, "https://gateway.example/v1/images/generations");
  assert.equal(call.init.headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(call.init.body), {
    model: "gpt-image-2.5-sunburst", prompt: "preserve the subject", n: 1, size: "1:1", resolution: "2k", quality: "max",
    output_format: "png", background: "auto", moderation: "low", image_urls: referenceUrls,
  });
});

test("passes data URL references directly to APIMart GPT Image 2.5 editing", async () => {
  const calls = [];
  await generateImage({
    settings, operation: "edit",
    request: { model: "gpt-image-2.5-flare", prompt: "edit", reference_images: [tinyPng] },
    fetchImpl: async (url, init = {}) => {
      if (String(url).endsWith("/agent/media-capabilities")) return new Response(JSON.stringify({ models: [{ id: "gpt-image-2.5-flare", modality: "image", available: true, operations: ["generate", "edit"], parameters: {} }] }), { status: 200, headers: { "content-type": "application/json" } });
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ code: 200, data: [{ status: "submitted", task_id: "task-upload-25" }] }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://gateway.example/v1/images/generations");
  assert.deepEqual(JSON.parse(calls[0].init.body).image_urls, [tinyPng]);
});

test("passes 16 public GPT Image 2.5 reference URLs without downloading them", async () => {
  const referenceUrls = Array.from({ length: 16 }, (_, index) => `https://assets.example/reference-${index + 1}.png?signature=test`);
  const calls = [];
  await generateImage({
    settings, operation: "edit",
    request: {
      model: "gpt-image-2.5-flare", prompt: "edit", reference_images: referenceUrls,
    },
    lookupImpl: publicLookup,
    fetchImpl: async (url, init = {}) => {
      calls.push({ url: String(url), init });
      if (String(url).endsWith("/agent/media-capabilities")) {
        return new Response(JSON.stringify({ models: [{ id: "gpt-image-2.5-flare", modality: "image", available: true, operations: ["generate", "edit"], parameters: {} }] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ data: [{ b64_json: "aGVsbG8=" }] }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, "https://gateway.example/v1/images/generations");
  assert.equal(calls[1].init.headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(calls[1].init.body), {
    model: "gpt-image-2.5-flare", prompt: "edit", n: 1, size: "auto", resolution: "1k", quality: "auto",
    output_format: "png", background: "auto", moderation: "low", image_urls: referenceUrls,
  });
});

test("polls APIMart GPT Image 2.5 tasks and extracts result.images[].url[]", async () => {
  const calls = [];
  const result = await generateImage({
    settings,
    request: { model: "gpt-image-2.5-flare", prompt: "a tree" },
    fetchImpl: async (url) => {
      if (String(url).endsWith("/agent/media-capabilities")) return new Response(JSON.stringify({ models: [{ id: "gpt-image-2.5-flare", modality: "image", available: true, operations: ["generate", "edit"], parameters: {} }] }), { status: 200, headers: { "content-type": "application/json" } });
      return new Response(JSON.stringify({ code: 200, data: [{ status: "submitted", task_id: "task-poll-25" }] }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  assert.equal(result.task_id, "task-poll-25");
  const { getImageTask } = await import("../src/image-service.mjs");
  const task = await getImageTask({
    settings, taskId: result.task_id,
    fetchImpl: async (url, init = {}) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ code: 200, data: { id: "task-poll-25", status: "completed", result: { images: [{ url: ["https://upload.apimart.ai/f/image/result.png"] }] } } }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  assert.equal(calls[0].url, "https://gateway.example/v1/tasks/task-poll-25");
  assert.equal(task.raw_status, "completed");
  assert.deepEqual(task.images, [{ url: "https://upload.apimart.ai/f/image/result.png" }]);
});

test("returns model_unavailable before calling a hidden GPT Image 2.5 route", async () => {
  let calls = 0;
  await assert.rejects(() => generateImage({
    settings, request: { model: "gpt-image-2.5-flare", prompt: "x" },
    fetchImpl: async (url) => { calls += 1; return new Response(JSON.stringify(String(url).endsWith("/agent/media-capabilities") ? { models: [] } : { data: [] }), { status: 200, headers: { "content-type": "application/json" } }); },
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
  assert.throws(() => normalizeImageRequest({ model: "gpt-image-2-momoapi", prompt: "x", reference_images: [tinyPng] }, "edit"), /does not support edit/);
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

test("rejects editing through the retired gpt-image-2-momoapi route", async () => {
  await assert.rejects(() => generateImage({
    settings,
    request: { model: "gpt-image-2-momoapi", prompt: "edit", reference_images: ["https://127.0.0.1/private.png"] },
    fetchImpl: async () => { throw new Error("must not fetch blocked host"); },
    operation: "edit",
  }), /does not support edit/);
});

test("rejects local asset editing through the retired gpt-image-2-momoapi route", async () => {
  const assetId = "img_" + "a".repeat(64);
  await assert.rejects(() => generateImage({
    settings,
    request: { model: "gpt-image-2-momoapi", prompt: "edit", reference_images: ["asset:" + assetId] },
    operation: "edit",
    assetResolver: async () => tinyPng,
  }), /does not support edit/);
  assert.throws(() => normalizeImageRequest({ model: "gpt-image-2-momoapi", prompt: "edit", reference_images: ["C:\\Users\\example\\secret.png"] }, "edit"), /does not support edit/);
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
