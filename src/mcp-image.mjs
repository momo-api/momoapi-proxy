import { createInterface } from "node:readline";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveSettings } from "./config.mjs";

function result(id, content = [], isError = false) {
  return { jsonrpc: "2.0", id, result: { content, ...(isError ? { isError: true } : {}) } };
}

function text(value) {
  return { type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) };
}

function localResourceContent(image) {
  if (!image.local_path || !image.asset_id) return null;
  return {
    type: "resource_link",
    name: basename(image.local_path),
    uri: pathToFileURL(image.local_path).href,
    description: "MOMO image saved on this computer (" + image.asset_id + ")",
    mimeType: image.mime_type || "application/octet-stream",
    ...(Number.isFinite(image.bytes) ? { size: image.bytes } : {}),
  };
}

const LEGACY_MODELS = ["gpt-image-2-momoapi", "gpt-image-2", "gemini-3.1-flash-image"];
const COMMON_PROPERTIES = {
  prompt: { type: "string" }, n: { type: "integer", minimum: 1, maximum: 10 },
  aspect_ratio: { type: "string", enum: ["1:1", "3:2", "2:3", "16:9", "9:16"] },
  resolution: { type: "string", enum: ["1k", "2k", "4k"] },
  size: { type: "string", description: "GPT Image 2.5: auto or WIDTHxHEIGHT using official size constraints." },
  quality: { type: "string", enum: ["auto", "low", "medium", "high", "xhigh", "max"] },
  output_format: { type: "string", enum: ["png", "jpeg", "webp"] },
  output_compression: { type: "integer", minimum: 0, maximum: 100 },
  background: { type: "string", enum: ["auto", "opaque", "transparent"] },
  moderation: { type: "string", enum: ["auto", "low"] },
  stream: { type: "boolean" }, partial_images: { type: "integer", minimum: 0, maximum: 3 },
};

function toolDefs(capabilities) {
  const available = (capabilities?.models || []).filter((model) => model.available !== false).map((model) => model.id);
  const models = available.length ? available : LEGACY_MODELS;
  const model = { type: "string", enum: models };
  return [
    { name: "image_capabilities", description: "List known MOMO image models, availability, operations, and limits.", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
    { name: "image_generate", description: "Generate one or more images through the local MOMO API Proxy. Call image_capabilities for model-specific limits.", inputSchema: { type: "object", properties: { model, ...COMMON_PROPERTIES }, required: ["prompt"], additionalProperties: false } },
    { name: "image_edit", description: "Edit up to the model-specific number of reference images. Use asset:<asset_id> to reuse a locally saved result without putting Base64 in history.", inputSchema: { type: "object", properties: { model, ...COMMON_PROPERTIES, reference_images: { type: "array", items: { type: "string", description: "asset:img_..., an image data URL, or an HTTPS URL" }, minItems: 1, maxItems: 16 }, mask: { type: "string", description: "asset:img_..., an image data URL, or an HTTPS URL" }, input_fidelity: { type: "string", enum: ["low", "high"] } }, required: ["prompt", "reference_images"], additionalProperties: false } },
    { name: "image_task_status", description: "Check an asynchronous MOMO image task. Completed images are saved locally and returned as compact references, never inline Base64.", inputSchema: { type: "object", properties: { task_id: { type: "string" } }, required: ["task_id"], additionalProperties: false } },
    { name: "image_asset_get", description: "Get compact metadata for a locally saved image asset without returning inline Base64.", inputSchema: { type: "object", properties: { asset_id: { type: "string", pattern: "^img_[a-f0-9]{64}$" } }, required: ["asset_id"], additionalProperties: false } },
    { name: "image_asset_list", description: "List recently used images saved on this computer.", inputSchema: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 1000, default: 100 } }, additionalProperties: false } },
  ];
}

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
  const content = [text({
    task_id: payload.task_id || null,
    images: payload.images?.map((image) => ({
      asset_id: image.asset_id,
      reference: image.reference,
      local_path: image.local_path,
      mime_type: image.mime_type,
      bytes: image.bytes,
      sha256: image.sha256,
      created_at: image.created_at,
      last_accessed_at: image.last_accessed_at,
      vision_reference: image.vision_reference,
    })) || [],
    status: payload.raw_status || null,
    terminal: Boolean(payload.terminal),
    ...(payload.error ? { error: payload.error } : {}),
  })];
  for (const image of payload.images || []) {
    const resource = localResourceContent(image);
    if (resource) content.push(resource);
  }
  return content;
}

export async function runImageMcp() {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let capabilities;
  for await (const line of rl) {
    if (!line.trim()) continue;
    let request;
    try { request = JSON.parse(line); } catch { continue; }
    if (request.method === "notifications/initialized" || request.method === "notifications/cancelled") continue;
    if (request.method === "initialize") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: request.params?.protocolVersion || "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "momo-image", version: "0.5.0" } } }) + "\n");
      continue;
    }
    try {
      if (request.method === "tools/list") {
        try { capabilities = await callProxy("/internal/images/capabilities"); } catch {}
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { tools: toolDefs(capabilities) } }) + "\n");
        continue;
      }
      if (request.method === "tools/call") {
        const name = request.params?.name;
        const args = request.params?.arguments || {};
        let payload;
        if (name === "image_capabilities") {
          payload = await callProxy("/internal/images/capabilities");
          capabilities = payload;
        }
        else if (name === "image_generate") { const { include_preview: _ignored, ...safeArgs } = args; payload = await callProxy("/internal/images/generate", "POST", safeArgs); }
        else if (name === "image_edit") { const { include_preview: _ignored, ...safeArgs } = args; payload = await callProxy("/internal/images/edit", "POST", safeArgs); }
        else if (name === "image_task_status") payload = await callProxy(`/internal/images/tasks/${encodeURIComponent(args.task_id || "")}`);
        else if (name === "image_asset_get") payload = await callProxy(`/internal/images/assets/${encodeURIComponent(args.asset_id || "")}`);
        else if (name === "image_asset_list") payload = await callProxy(`/internal/images/assets?limit=${encodeURIComponent(args.limit || 100)}`);
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
