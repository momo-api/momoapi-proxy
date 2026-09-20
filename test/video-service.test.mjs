import assert from "node:assert/strict";
import test from "node:test";
import { generateVideo, getVideoTask, normalizeVideoRequest, resolveVideoCapabilities } from "../src/video-service.mjs";
import { videoToolDefs } from "../src/mcp-video.mjs";
import { createMomoSwitch } from "../src/server.mjs";

const settings = { endpoint: "https://gateway.example", apiKey: "test-key-not-real" };
const tinyPng = "data:image/png;base64,iVBORw0KGgo=";

function capabilityPayload() {
  return { models: [
    { id: "momoapi-gemini-omni-flash", modality: "video", role: "primary", available: true, operations: ["generate", "image_to_video", "style_reference"], parameters: {
      duration: { allowed: [3, 4, 5, 6, 7, 8, 9, 10], default: 4 }, generate_audio: { allowed: [false], default: false }, max_reference_images: { maximum: 2 },
    } },
    { id: "momoapi-veo-3-1-lite", modality: "video", role: "primary", available: true, operations: ["generate", "image_to_video", "style_reference"], parameters: {
      duration: { allowed: [4, 6, 8], default: 4 }, aspect_ratio: { allowed: ["16:9", "9:16"], default: "16:9" }, resolution: { allowed: ["720p", "1080p"], default: "720p" }, generate_audio: { allowed: [true, false], default: true }, max_reference_images: { maximum: 2 },
    } },
    { id: "momoapi-kling-3-standard", modality: "video", role: "primary", available: true, operations: ["generate", "image_to_video"], parameters: {
      duration: { allowed: [5, 10, 15], default: 5 }, resolution: { allowed: ["720p"], default: "720p" }, generate_audio: { allowed: [true, false], default: true }, max_reference_images: { maximum: 2 },
    } },
  ] };
}

test("uses authenticated video capabilities and exposes exact parameter schemas", async () => {
  const capabilities = await resolveVideoCapabilities({ settings, fetchImpl: async () => new Response(JSON.stringify(capabilityPayload()), { status: 200 }) });
  const byId = Object.fromEntries(capabilities.models.map((model) => [model.id, model]));
  assert.equal(capabilities.defaults.model, "momoapi-gemini-omni-flash");
  assert.deepEqual(byId["momoapi-veo-3-1-lite"].limits.durations, [4, 6, 8]);
  assert.deepEqual(byId["momoapi-veo-3-1-lite"].parameter_schema.resolution.allowed, ["720p", "1080p"]);
  assert.deepEqual(byId["momoapi-gemini-omni-flash"].limits.generate_audio, [false]);
  assert.equal(capabilities.storage.downloads_by_default, false);
});

test("validates every video control from the selected model capability", async () => {
  const capabilities = await resolveVideoCapabilities({ settings, fetchImpl: async () => new Response(JSON.stringify(capabilityPayload()), { status: 200 }) });
  const request = normalizeVideoRequest({ model: "momoapi-veo-3-1-lite", prompt: "ocean", duration: 8, aspect_ratio: "9:16", resolution: "1080p", generate_audio: false }, capabilities);
  assert.equal(request.duration, 8);
  assert.throws(() => normalizeVideoRequest({ model: "momoapi-veo-3-1-lite", prompt: "x", duration: 5 }, capabilities), /Allowed: 4, 6, 8/);
  assert.throws(() => normalizeVideoRequest({ model: "momoapi-gemini-omni-flash", prompt: "x", generate_audio: true }, capabilities), /Allowed: false/);
  assert.throws(() => normalizeVideoRequest({ model: "momoapi-kling-3-standard", prompt: "x", resolution: "1080p" }, capabilities), /Allowed: 720p/);
  assert.throws(() => normalizeVideoRequest({ model: "momoapi-veo-3-1-lite", prompt: "x", reference_images: [tinyPng, tinyPng, tinyPng] }, capabilities), /at most 2/);
});

test("submits multipart video tasks and does not download the completed asset", async () => {
  const calls = [];
  const result = await generateVideo({
    settings,
    request: { model: "momoapi-veo-3-1-lite", prompt: "ocean", duration: 6, aspect_ratio: "16:9", resolution: "1080p", generate_audio: true, reference_images: [tinyPng] },
    fetchImpl: async (url, init = {}) => {
      calls.push({ url: String(url), init });
      if (String(url).endsWith("/agent/media-capabilities")) return new Response(JSON.stringify(capabilityPayload()), { status: 200 });
      return new Response(JSON.stringify({ id: "task-video-1", status: "queued" }), { status: 200 });
    },
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, "https://gateway.example/v1/videos");
  assert.equal(calls[1].init.headers.authorization, "Bearer test-key-not-real");
  assert.equal(calls[1].init.body.get("model"), "momoapi-veo-3-1-lite");
  assert.equal(calls[1].init.body.get("seconds"), "6");
  assert.equal(calls[1].init.body.get("resolution_name"), "1080p");
  assert.equal(calls[1].init.body.getAll("input_reference[]").length, 1);
  assert.deepEqual(result, { task_id: "task-video-1", status: "queued", terminal: false, remote_url: null, content_url: "https://gateway.example/v1/videos/task-video-1/content" });
});

test("polls video status and returns the Adobe remote URL without fetching it", async () => {
  const calls = [];
  const result = await getVideoTask({ settings, taskId: "task-video-1", fetchImpl: async (url) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ id: "task-video-1", status: "completed", url: "https://adobe.example/output.mp4", progress: 100 }), { status: 200 });
  } });
  assert.deepEqual(calls, ["https://gateway.example/v1/videos/task-video-1"]);
  assert.equal(result.remote_url, "https://adobe.example/output.mp4");
  assert.equal(result.terminal, true);
});

test("builds MCP enums from the live video capability response", async () => {
  const capabilities = await resolveVideoCapabilities({ settings, fetchImpl: async () => new Response(JSON.stringify(capabilityPayload()), { status: 200 }) });
  const generate = videoToolDefs(capabilities).find((tool) => tool.name === "video_generate");
  assert.deepEqual(generate.inputSchema.properties.model.enum, ["momoapi-gemini-omni-flash", "momoapi-veo-3-1-lite", "momoapi-kling-3-standard"]);
  assert.deepEqual(generate.inputSchema.properties.duration.enum, [3, 4, 5, 6, 7, 8, 9, 10, 15]);
  assert.deepEqual(generate.inputSchema.properties.resolution.enum, ["720p", "1080p"]);
  assert.equal(generate.inputSchema.properties.reference_images.maxItems, 2);
});

test("serves authenticated loopback video endpoints end to end", async () => {
  const proxySettings = { ...settings, localToken: "local-test-token", host: "127.0.0.1", port: 0 };
  const calls = [];
  const server = createMomoSwitch(proxySettings, { fetchImpl: async (url, init = {}) => {
    calls.push(String(url));
    if (String(url).endsWith("/agent/media-capabilities")) return new Response(JSON.stringify(capabilityPayload()), { status: 200 });
    if (String(url).endsWith("/v1/videos")) return new Response(JSON.stringify({ id: "task-e2e", status: "queued" }), { status: 200 });
    if (String(url).endsWith("/v1/videos/task-e2e")) return new Response(JSON.stringify({ id: "task-e2e", status: "completed", url: "https://adobe.example/e2e.mp4" }), { status: 200 });
    throw new Error("unexpected upstream route");
  } });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + server.address().port;
  const headers = { "x-local-token": proxySettings.localToken };
  try {
    assert.equal((await fetch(base + "/internal/videos/capabilities")).status, 403);
    const generated = await fetch(base + "/internal/videos/generate", {
      method: "POST", headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ model: "momoapi-gemini-omni-flash", prompt: "clouds", duration: 4 }),
    });
    assert.equal(generated.status, 200);
    assert.equal((await generated.json()).task_id, "task-e2e");
    const task = await fetch(base + "/internal/videos/tasks/task-e2e", { headers });
    assert.equal((await task.json()).remote_url, "https://adobe.example/e2e.mp4");
    assert.deepEqual(calls, [
      "https://gateway.example/agent/media-capabilities",
      "https://gateway.example/v1/videos",
      "https://gateway.example/v1/videos/task-e2e",
    ]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
