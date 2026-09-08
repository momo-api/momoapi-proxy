import { createInterface } from "node:readline";
import { resolveSettings } from "./config.mjs";

function result(id, content = [], isError = false) {
  return { jsonrpc: "2.0", id, result: { content, ...(isError ? { isError: true } : {}) } };
}

function text(value) {
  return { type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) };
}

function imageContent(image) {
  if (image.b64_json) return { type: "image", data: image.b64_json, mimeType: image.mime_type || "image/png" };
  if (image.url) return text(`Image URL: ${image.url}`);
  return null;
}

const TOOL_DEFS = [
  { name: "image_capabilities", description: "List the MOMO image models and their supported operations.", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "image_generate", description: "Generate one or more images through the local MOMO API Proxy. Call image_capabilities for model-specific limits.", inputSchema: { type: "object", properties: { model: { type: "string", enum: ["gpt-image-2-momoapi", "gpt-image-2", "gemini-3.1-flash-image"] }, prompt: { type: "string" }, n: { type: "integer", minimum: 1, maximum: 4 }, aspect_ratio: { type: "string", enum: ["1:1", "3:2", "2:3", "16:9", "9:16"] }, resolution: { type: "string", enum: ["1k", "2k", "4k"] } }, required: ["prompt"], additionalProperties: false } },
  { name: "image_edit", description: "Edit reference images through the local MOMO API Proxy. Use data:image/...;base64 or HTTPS image URLs; model-specific limits are returned by image_capabilities.", inputSchema: { type: "object", properties: { model: { type: "string", enum: ["gpt-image-2-momoapi", "gpt-image-2", "gemini-3.1-flash-image"] }, prompt: { type: "string" }, n: { type: "integer", minimum: 1, maximum: 4 }, aspect_ratio: { type: "string", enum: ["1:1", "3:2", "2:3", "16:9", "9:16"] }, resolution: { type: "string", enum: ["1k", "2k", "4k"] }, reference_images: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 4 } }, required: ["prompt", "reference_images"], additionalProperties: false } },
  { name: "image_task_status", description: "Check an asynchronous MOMO image task.", inputSchema: { type: "object", properties: { task_id: { type: "string" } }, required: ["task_id"], additionalProperties: false } },
];

async function callProxy(path, method = "GET", body) {
  const settings = resolveSettings();
  let proxySettings = settings;
  try {
    const health = await fetch(`http://127.0.0.1:${settings.port}/healthz`);
    if (!health.ok) throw new Error("MOMO API Proxy is not healthy.");
  } catch (error) {
    throw new Error(`MOMO API Proxy is unavailable on 127.0.0.1:${settings.port}. Start it with 'momoapi-proxy start'.`);
  }
  const response = await fetch(`http://127.0.0.1:${proxySettings.port}${path}`, {
    method,
    headers: { "x-local-token": proxySettings.localToken, ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload?.error?.message || `MOMO API Proxy returned HTTP ${response.status}`);
  return payload;
}

function toolResult(payload) {
  const content = [text({ task_id: payload.task_id || null, images: payload.images?.map((image) => ({ url: image.url, mime_type: image.mime_type })) || [], status: payload.raw_status || null, terminal: Boolean(payload.terminal), ...(payload.error ? { error: payload.error } : {}) })];
  for (const image of payload.images || []) {
    const block = imageContent(image);
    if (block) content.push(block);
  }
  return content;
}

export async function runImageMcp() {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let request;
    try { request = JSON.parse(line); } catch { continue; }
    if (request.method === "notifications/initialized" || request.method === "notifications/cancelled") continue;
    if (request.method === "initialize") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: request.params?.protocolVersion || "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "momo-image", version: "0.2.0" } } }) + "\n");
      continue;
    }
    try {
      if (request.method === "tools/list") {
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { tools: TOOL_DEFS } }) + "\n");
        continue;
      }
      if (request.method === "tools/call") {
        const name = request.params?.name;
        const args = request.params?.arguments || {};
        let payload;
        if (name === "image_capabilities") payload = await callProxy("/internal/images/capabilities");
        else if (name === "image_generate") payload = await callProxy("/internal/images/generate", "POST", args);
        else if (name === "image_edit") payload = await callProxy("/internal/images/edit", "POST", args);
        else if (name === "image_task_status") payload = await callProxy(`/internal/images/tasks/${encodeURIComponent(args.task_id || "")}`);
        else throw new Error(`Unknown tool: ${name}`);
        const content = name === "image_capabilities" ? [text(payload)] : toolResult(payload);
        process.stdout.write(JSON.stringify(result(request.id, content)) + "\n");
        continue;
      }
      if (request.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: `Method not found: ${request.method}` } }) + "\n");
    } catch (error) {
      if (request.id !== undefined) process.stdout.write(JSON.stringify(result(request.id, [text(error.message)], true)) + "\n");
    }
  }
}
