import { createInterface } from "node:readline";
import { resolveSettings } from "./config.mjs";

function responseResult(id, content = [], isError = false) {
  return { jsonrpc: "2.0", id, result: { content, ...(isError ? { isError: true } : {}) } };
}

function text(value) {
  return { type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) };
}

const LEGACY_MODELS = ["momoapi-gemini-omni-flash", "momoapi-veo-3-1-lite", "momoapi-kling-3-standard"];

function unions(capabilities, key) {
  return [...new Set((capabilities?.models || []).filter((model) => model.available !== false).flatMap((model) => model?.limits?.[key] || []))];
}

export function videoToolDefs(capabilities) {
  const available = (capabilities?.models || []).filter((model) => model.available !== false);
  const models = available.map((model) => model.id);
  const maxReferences = Math.max(1, ...available.map((model) => Number(model?.limits?.max_reference_images) || 0));
  const durations = unions(capabilities, "durations");
  const ratios = unions(capabilities, "aspect_ratios");
  const resolutions = unions(capabilities, "resolutions");
  const properties = {
    model: { type: "string", enum: models.length ? models : LEGACY_MODELS },
    prompt: { type: "string" },
    duration: { type: "integer", ...(durations.length ? { enum: durations } : { minimum: 1 }) },
    aspect_ratio: { type: "string", ...(ratios.length ? { enum: ratios } : {}) },
    resolution: { type: "string", ...(resolutions.length ? { enum: resolutions } : {}) },
    generate_audio: { type: "boolean" },
    reference_images: {
      type: "array", minItems: 1, maxItems: maxReferences,
      items: { type: "string", description: "asset:img_..., an image data URL, or a public HTTPS image URL" },
    },
  };
  return [
    { name: "video_capabilities", description: "List currently available MOMO video models and their exact duration, resolution, aspect-ratio, audio, and reference-image limits.", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
    { name: "video_generate", description: "Submit a MOMO text-to-video or image-to-video task. When complete, use playable_url or remote_url for browser playback/download. authenticated_content_url requires the MOMO API bearer token and must not be shown as a clickable browser link.", inputSchema: { type: "object", properties, required: ["prompt"], additionalProperties: false } },
    { name: "video_task_status", description: "Check a MOMO video task. Use playable_url or remote_url for browser playback/download. authenticated_content_url is only for authenticated API clients and must not be shown as a clickable browser link.", inputSchema: { type: "object", properties: { task_id: { type: "string" } }, required: ["task_id"], additionalProperties: false } },
  ];
}

async function callProxy(path, method = "GET", body) {
  const settings = resolveSettings();
  try {
    const health = await fetch("http://127.0.0.1:" + settings.port + "/healthz");
    if (!health.ok) throw new Error("MOMO API Proxy is not healthy.");
  } catch {
    throw new Error("MOMO API Proxy is unavailable on 127.0.0.1:" + settings.port + ". Start it with 'momoapi-proxy start'.");
  }
  const response = await fetch("http://127.0.0.1:" + settings.port + path, {
    method,
    headers: { "x-local-token": settings.localToken, ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload?.error?.message || "MOMO API Proxy returned HTTP " + response.status);
  return payload;
}

export async function runVideoMcp() {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let capabilities;
  for await (const line of rl) {
    if (!line.trim()) continue;
    let request;
    try { request = JSON.parse(line); } catch { continue; }
    if (request.method === "notifications/initialized" || request.method === "notifications/cancelled") continue;
    if (request.method === "initialize") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: request.params?.protocolVersion || "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "momo-video", version: "0.1.1" } } }) + "\n");
      continue;
    }
    try {
      if (request.method === "tools/list") {
        try { capabilities = await callProxy("/internal/videos/capabilities"); } catch {}
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { tools: videoToolDefs(capabilities) } }) + "\n");
        continue;
      }
      if (request.method === "tools/call") {
        const name = request.params?.name;
        const args = request.params?.arguments || {};
        let payload;
        if (name === "video_capabilities") {
          payload = await callProxy("/internal/videos/capabilities");
          capabilities = payload;
        } else if (name === "video_generate") {
          payload = await callProxy("/internal/videos/generate", "POST", args);
        } else if (name === "video_task_status") {
          payload = await callProxy("/internal/videos/tasks/" + encodeURIComponent(args.task_id || ""));
        } else throw new Error("Unknown tool: " + name);
        process.stdout.write(JSON.stringify(responseResult(request.id, [text(payload)])) + "\n");
        continue;
      }
      if (request.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Method not found: " + request.method } }) + "\n");
    } catch (error) {
      if (request.id !== undefined) process.stdout.write(JSON.stringify(responseResult(request.id, [text(error.message)], true)) + "\n");
    }
  }
}
