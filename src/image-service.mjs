import { lookup } from "node:dns/promises";
import { isImageAssetReference } from "./image-assets.mjs";

const MAX_REFERENCE_BYTES = 20 * 1024 * 1024;
const ASPECT_RATIOS = ["1:1", "3:2", "2:3", "4:3", "3:4", "5:4", "4:5", "16:9", "9:16", "2:1", "1:2", "21:9", "9:21", "3:1", "1:3"];
const GPT_IMAGE_25_MODELS = new Set(["gpt-image-2.5-sunburst", "gpt-image-2.5-flare"]);
const GPT_IMAGE_25_QUALITY = ["auto", "low", "medium", "high", "xhigh", "max"];
const OUTPUT_FORMATS = ["png", "jpeg", "webp"];

const MODEL_RULES = {
  "gpt-image-2": {
    maxN: 1, maxReferenceImages: 1, operations: ["generate", "edit"],
    aspectRatios: ASPECT_RATIOS, resolutions: ["1k", "2k", "4k"],
    generateTransport: "images-generations", editTransport: "images-generations-reference",
  },
  "gpt-image-2-momoapi": {
    maxN: 4, maxReferenceImages: 4, operations: ["generate", "edit"],
    aspectRatios: ASPECT_RATIOS, resolutions: ["1k", "2k", "4k"],
    generateTransport: "images-generations", editTransport: "chat-completions-multimodal-stream",
  },
  "gemini-3.1-flash-image": {
    maxN: 1, maxReferenceImages: 1, operations: ["generate", "edit"],
    aspectRatios: ASPECT_RATIOS, resolutions: ["1k", "2k", "4k"],
    generateTransport: "images-generations", editTransport: "chat-completions-multimodal",
  },
  "gpt-image-2.5-sunburst": {
    maxN: 4, maxReferenceImages: 16, operations: ["generate", "edit"],
    generateTransport: "images-generations", editTransport: "images-generations-image-urls",
    nativeControls: true, requiresCatalog: true, maskEdits: false,
  },
  "gpt-image-2.5-flare": {
    maxN: 4, maxReferenceImages: 16, operations: ["generate", "edit"],
    generateTransport: "images-generations", editTransport: "images-generations-image-urls",
    nativeControls: true, requiresCatalog: true, maskEdits: false,
  },
};
const IMAGE_MODELS = new Set(Object.keys(MODEL_RULES));

function capability(model, displayName) {
  const rules = MODEL_RULES[model];
  const nativeParameters = [
    "prompt", "n", "size", "resolution", "quality", "reference_images",
    "output_format", "output_compression", "background", "moderation",
  ];
  return {
    id: model,
    display_name: displayName,
    operations: rules.operations,
    parameters: rules.nativeControls ? nativeParameters : ["prompt", "n", "aspect_ratio", "resolution", "reference_images"],
    transports: { generate: rules.generateTransport, edit: rules.editTransport },
    limits: {
      max_n: rules.maxN,
      max_reference_images: rules.maxReferenceImages,
      ...(rules.aspectRatios ? { aspect_ratios: rules.aspectRatios } : {}),
      ...(rules.resolutions ? { resolutions: rules.resolutions } : {}),
      ...(rules.nativeControls ? {
        sizes: { ratios: ASPECT_RATIOS, arbitrary: true, multiple_of: 16, aspect_ratio_range: "1:3 to 3:1", max_edge: 3840, min_pixels: 655360, max_pixels: 8294400 },
        qualities: GPT_IMAGE_25_QUALITY, output_formats: OUTPUT_FORMATS, partial_images: { supported: false },
      } : {}),
      max_reference_bytes_each: MAX_REFERENCE_BYTES,
    },
    mask_edits: Boolean(rules.maskEdits),
    available: !rules.requiresCatalog,
    availability: rules.requiresCatalog ? "requires_upstream_model_catalog" : "verified",
    protocol_status: rules.requiresCatalog ? "implemented_not_live_verified" : "verified",
  };
}

export const IMAGE_CAPABILITIES = {
  version: 4,
  models: [
    capability("gpt-image-2", "GPT Image 2"),
    capability("gpt-image-2-momoapi", "GPT Image 2 MOMO"),
    capability("gemini-3.1-flash-image", "Gemini 3.1 Flash Image"),
    capability("gpt-image-2.5-sunburst", "GPT Image 2.5 Sunburst"),
    capability("gpt-image-2.5-flare", "GPT Image 2.5 Flare"),
  ],
  defaults: { model: "gpt-image-2-momoapi", n: 1, aspect_ratio: "1:1", resolution: "1k" },
  notes: {
    gpt_aspect_ratio_aliases: {
      "16:9": "1536x1024 (3:2 output canvas)",
      "9:16": "1024x1536 (2:3 output canvas)",
    },
    gpt_resolution: "1k/2k/4k map to low/medium/high quality hints; they are not guaranteed output pixel dimensions.",
    gemini_resolution: "1k/2k/4k are sent as 1K/2K/4K image_size controls.",
    mask_edits: "APIMart GPT Image 2.5 does not document a mask field; edits use image_urls.",
    gpt_image_2_5: "Sunburst and Flare are advertised to tools only after the authenticated MOMO model catalog reports them.",
    reference_url_transport: "APIMart GPT Image 2.5 edits use POST /v1/images/generations with image_urls (up to 16 public HTTP(S) URLs); the proxy does not download HTTPS references.",
    apimart_tasks: "Generation returns data[0].task_id; poll /v1/tasks/{task_id} (MOMO compatibility also accepts /v1/images/generations/{task_id}).",
  },
};

function catalogModelIds(payload) {
  const rows = Array.isArray(payload?.data) ? payload.data : (Array.isArray(payload?.models) ? payload.models : []);
  return new Set(rows.map((item) => typeof item === "string" ? item : item?.id).filter((id) => typeof id === "string"));
}

export async function resolveImageCapabilities({ settings, fetchImpl = fetch, signal } = {}) {
  const capability = structuredClone(IMAGE_CAPABILITIES);
  const gated = capability.models.filter((model) => MODEL_RULES[model.id]?.requiresCatalog);
  if (!settings || gated.length === 0) return capability;
  try {
    const endpoint = String(settings.endpoint || "").replace(/\/+$/, "");
    const response = await fetchImpl(endpoint + "/v1/models", {
      headers: { authorization: "Bearer " + settings.apiKey },
      signal: imageSignal(signal, 15000),
    });
    if (!response.ok) throw new Error("model catalog returned HTTP " + response.status);
    const ids = catalogModelIds(await response.json());
    for (const model of gated) {
      model.available = ids.has(model.id);
      model.availability = model.available ? "upstream_catalog" : "not_in_upstream_catalog";
    }
    capability.catalog_status = "available";
  } catch {
    capability.catalog_status = "unavailable";
  }
  return capability;
}

function fail(message, statusCode = 400, code = "invalid_request_error") {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function imageSignal(parentSignal, timeoutMs = 300000) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return parentSignal ? AbortSignal.any([parentSignal, timeoutSignal]) : timeoutSignal;
}

function asDataUrl(value) {
  return typeof value === "string" && /^data:image\/[A-Za-z0-9.+-]+;base64,/i.test(value) ? value : null;
}

function gptSizeFrom(aspectRatio) {
  return ({
    "1:1": "1024x1024",
    "3:2": "1536x1024",
    "16:9": "1536x1024",
    "2:3": "1024x1536",
    "9:16": "1024x1536",
  })[aspectRatio] || "1024x1024";
}

function gptQualityFrom(resolution) {
  if (resolution === "1k") return "low";
  if (resolution === "4k") return "high";
  return "medium";
}

function nativeSize(value) {
  const size = String(value || "auto").toLowerCase();
  if (size === "auto") return size;
  if (ASPECT_RATIOS.includes(size)) return size;
  const match = /^(\d+)x(\d+)$/.exec(size);
  if (!match) throw fail("size must be auto or WIDTHxHEIGHT.");
  const width = Number(match[1]);
  const height = Number(match[2]);
  const pixels = width * height;
  if (width % 16 !== 0 || height % 16 !== 0) throw fail("size width and height must be multiples of 16.");
  if (width > 3840 || height > 3840) throw fail("size edges must not exceed 3840 pixels.");
  if (Math.max(width, height) / Math.min(width, height) > 3) throw fail("size aspect ratio must be between 1:3 and 3:1.");
  if (pixels < 655360 || pixels > 8294400) throw fail("size total pixels must be between 655360 and 8294400.");
  return `${width}x${height}`;
}

function optionalEnum(input, key, values, fallback) {
  const value = input[key] === undefined ? fallback : String(input[key]).toLowerCase();
  if (value === undefined) return undefined;
  if (!values.includes(value)) throw fail(`Unsupported ${key}: ${input[key]}`);
  return value;
}

export function normalizeImageRequest(input, operation = "generate") {
  if (!input || typeof input !== "object") throw fail("Image request must be a JSON object.");
  const model = typeof input.model === "string" && input.model.trim() ? input.model.trim() : IMAGE_CAPABILITIES.defaults.model;
  if (!IMAGE_MODELS.has(model)) throw fail("Unsupported image model: " + model);
  const rules = MODEL_RULES[model];
  if (!rules.operations.includes(operation)) throw fail("Model " + model + " does not support " + operation + ".");

  const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
  if (!prompt) throw fail("prompt is required.");
  if (prompt.length > 32000) throw fail("prompt is too long.");

  const n = input.n === undefined ? 1 : Number(input.n);
  if (!Number.isInteger(n) || n < 1 || n > rules.maxN) throw fail("n must be an integer between 1 and " + rules.maxN + " for " + model + ".");

  let aspectRatio;
  let resolution;
  let nativeControls = {};
  if (rules.nativeControls) {
    const legacyAspect = input.aspect_ratio || input.aspectRatio;
    if (legacyAspect && !ASPECT_RATIOS.includes(legacyAspect)) throw fail("Unsupported aspect_ratio for " + model + ": " + legacyAspect);
    const requestedSize = input.size ?? (legacyAspect || "auto");
    const legacyResolution = input.resolution || input.imageSize || "1k";
    resolution = String(legacyResolution).toLowerCase();
    if (!["1k", "2k", "4k"].includes(resolution)) throw fail("resolution must be 1k, 2k, or 4k for " + model + ".");
    const quality = optionalEnum(input, "quality", GPT_IMAGE_25_QUALITY, "auto");
    const outputFormat = optionalEnum(input, "output_format", OUTPUT_FORMATS, "png");
    const outputCompression = input.output_compression === undefined ? undefined : Number(input.output_compression);
    if (outputCompression !== undefined && (!Number.isInteger(outputCompression) || outputCompression < 0 || outputCompression > 100)) throw fail("output_compression must be an integer between 0 and 100.");
    if (outputCompression !== undefined && outputFormat === "png") throw fail("output_compression is supported only for jpeg or webp output.");
    const background = optionalEnum(input, "background", ["auto", "opaque", "transparent"], "auto");
    if (background === "transparent" && !["png", "webp"].includes(outputFormat)) throw fail("transparent background requires png or webp output.");
    const moderation = optionalEnum(input, "moderation", ["auto", "low"], "low");
    const inputFidelity = input.input_fidelity === undefined ? undefined : optionalEnum(input, "input_fidelity", ["low", "high"]);
    if (inputFidelity !== undefined) throw fail("input_fidelity is not supported by the APIMart GPT Image 2.5 protocol.");
    if (input.stream !== undefined && input.stream !== false) throw fail("APIMart GPT Image 2.5 does not support streaming image output.");
    if (input.partial_images !== undefined && Number(input.partial_images) !== 0) throw fail("APIMart GPT Image 2.5 does not support partial_images.");
    nativeControls = {
      size: nativeSize(requestedSize), resolution, quality, output_format: outputFormat,
      ...(outputCompression !== undefined ? { output_compression: outputCompression } : {}),
      background, moderation,
    };
  } else {
    const nativeOnly = ["size", "quality", "output_format", "output_compression", "background", "moderation", "input_fidelity", "stream", "partial_images"];
    const unsupported = nativeOnly.find((key) => input[key] !== undefined);
    if (unsupported) throw fail(unsupported + " is supported only for GPT Image 2.5 models.");
    aspectRatio = input.aspect_ratio || input.aspectRatio || IMAGE_CAPABILITIES.defaults.aspect_ratio;
    if (!rules.aspectRatios.includes(aspectRatio)) throw fail("Unsupported aspect_ratio for " + model + ": " + aspectRatio);
    const requestedResolution = input.resolution || input.imageSize || IMAGE_CAPABILITIES.defaults.resolution;
    const aliases = { low: "1k", medium: "2k", high: "4k", "1K": "1k", "2K": "2k", "4K": "4k" };
    resolution = aliases[requestedResolution] || String(requestedResolution).toLowerCase();
    if (!rules.resolutions.includes(resolution)) throw fail("Unsupported resolution for " + model + ": " + requestedResolution);
  }

  const references = input.reference_images || input.referenceImages || [];
  if (!Array.isArray(references)) throw fail("reference_images must be an array.");
  if (operation === "edit" && references.length === 0) throw fail("reference_images must contain at least one image for edit.");
  if (references.length > rules.maxReferenceImages) throw fail("reference_images supports at most " + rules.maxReferenceImages + " item(s) for " + model + ".");
  if (operation === "generate" && references.length > 0) throw fail("Use image_edit when reference_images are provided.");
  for (const reference of references) {
    if (typeof reference !== "string" || (!asDataUrl(reference) && !/^https?:\/\//i.test(reference) && !isImageAssetReference(reference))) {
      throw fail("reference_images must contain local asset IDs, image data URLs, or HTTPS URLs.");
    }
  }
  const mask = input.mask || input.mask_image || input.maskImage;
  if (mask !== undefined && operation !== "edit") throw fail("mask is supported only for image_edit.");
  if (mask !== undefined && !rules.maskEdits) throw fail("mask is not supported for " + model + " by the APIMart image protocol; use image_urls for reference editing.");
  if (mask !== undefined && (typeof mask !== "string" || (!asDataUrl(mask) && !/^https?:\/\//i.test(mask) && !isImageAssetReference(mask)))) throw fail("mask must be a local asset ID, image data URL, or HTTPS URL.");
  return { model, prompt, n, aspect_ratio: aspectRatio, resolution, reference_images: references, operation, ...nativeControls, ...(mask ? { mask } : {}) };
}

function decodeDataUrl(value) {
  const match = /^data:(image\/[A-Za-z0-9.+-]+);base64,([A-Za-z0-9+/=\r\n]+)$/i.exec(value || "");
  if (!match) return null;
  const base64 = match[2].replace(/[\r\n]/g, "");
  if (Math.floor(base64.length * 3 / 4) > MAX_REFERENCE_BYTES) throw fail("reference image is too large.", 400, "reference_image_error");
  const bytes = Buffer.from(base64, "base64");
  if (bytes.byteLength > MAX_REFERENCE_BYTES) throw fail("reference image is too large.", 400, "reference_image_error");
  return { mimeType: match[1].toLowerCase(), dataUrl: "data:" + match[1].toLowerCase() + ";base64," + base64 };
}

function validateReferenceUrl(value) {
  const parsed = new URL(value);
  if (parsed.protocol !== "https:") throw fail("reference image URLs must use HTTPS.");
  if (parsed.username || parsed.password) throw fail("reference image URLs must not contain credentials.");
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") ||
    hostname === "metadata.google.internal" || hostname.includes(":") ||
    /^127\.|^10\.|^192\.168\.|^169\.254\.|^0\./.test(hostname)
  ) throw fail("reference image URL host is not allowed.");
  const octets = hostname.split(".").map((part) => Number(part));
  if (octets.length === 4 && octets.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)) {
    if (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) throw fail("reference image URL host is not allowed.");
    throw fail("reference image URLs must use a hostname, not a raw IP address.");
  }
  return parsed;
}

function isForbiddenAddress(address) {
  const normalized = String(address || "").toLowerCase().replace(/^\[|\]$/g, "");
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized);
  if (mapped) return isForbiddenAddress(mapped[1]);
  if (normalized.includes(":")) {
    return normalized === "::" || normalized === "::1" || /^f[cd]/.test(normalized) || /^fe[89ab]/.test(normalized) || /^ff/.test(normalized);
  }
  const octets = normalized.split(".").map((part) => Number(part));
  if (octets.length !== 4 || !octets.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)) return true;
  return octets[0] === 0 || octets[0] === 10 || octets[0] === 127 || octets[0] >= 224 ||
    (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127) ||
    (octets[0] === 169 && octets[1] === 254) ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168);
}

async function assertPublicHostname(parsed, lookupImpl) {
  let addresses;
  try {
    addresses = await lookupImpl(parsed.hostname, { all: true, verbatim: true });
  } catch {
    throw fail("reference image URL hostname could not be resolved.", 400, "reference_image_error");
  }
  if (!Array.isArray(addresses) || addresses.length === 0 || addresses.some((entry) => isForbiddenAddress(entry?.address))) {
    throw fail("reference image URL resolved to a non-public address.", 400, "reference_image_error");
  }
}

async function responseBytesWithinLimit(response) {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REFERENCE_BYTES) throw fail("reference image is too large.", 400, "reference_image_error");
  if (!response.body?.getReader) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength > MAX_REFERENCE_BYTES) throw fail("reference image is too large.", 400, "reference_image_error");
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_REFERENCE_BYTES) throw fail("reference image is too large.", 400, "reference_image_error");
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

async function resolveReferenceDataUrls(request, fetchImpl, signal, lookupImpl, assetResolver) {
  const dataUrls = [];
  for (const reference of request.reference_images) {
    if (isImageAssetReference(reference)) {
      if (typeof assetResolver !== "function") throw fail("Local image asset resolution is unavailable.", 500, "image_asset_unavailable");
      dataUrls.push(await assetResolver(reference));
      continue;
    }
    const decoded = decodeDataUrl(reference);
    if (decoded) {
      dataUrls.push(decoded.dataUrl);
      continue;
    }
    const parsed = validateReferenceUrl(reference);
    await assertPublicHostname(parsed, lookupImpl);
    const response = await fetchImpl(parsed, { redirect: "error", signal: imageSignal(signal, 60000) });
    if (!response.ok) throw fail("Unable to download reference image (HTTP " + response.status + ").", 400, "reference_image_error");
    const mimeType = (response.headers.get("content-type") || "").split(";", 1)[0].toLowerCase();
    if (!mimeType.startsWith("image/")) throw fail("reference image URL did not return an image.", 400, "reference_image_error");
    const bytes = await responseBytesWithinLimit(response);
    dataUrls.push("data:" + mimeType + ";base64," + bytes.toString("base64"));
  }
  return dataUrls;
}

function nativeImageBody(request) {
  return {
    model: request.model, prompt: request.prompt, n: request.n, size: request.size, resolution: request.resolution, quality: request.quality,
    output_format: request.output_format, background: request.background, moderation: request.moderation,
    ...(request.output_compression !== undefined ? { output_compression: request.output_compression } : {}),
  };
}

function generationBody(request) {
  if (request.model === "gemini-3.1-flash-image") {
    return { model: request.model, prompt: request.prompt, n: request.n, size: request.aspect_ratio, quality: request.resolution.toUpperCase() };
  }
  if (GPT_IMAGE_25_MODELS.has(request.model)) return nativeImageBody(request);
  return { model: request.model, prompt: request.prompt, n: request.n, size: gptSizeFrom(request.aspect_ratio), quality: gptQualityFrom(request.resolution) };
}

function dataUrlFile(value, name) {
  const decoded = decodeDataUrl(value);
  if (!decoded) throw fail(name + " must contain valid base64 image data.");
  const bytes = Buffer.from(decoded.dataUrl.slice(decoded.dataUrl.indexOf(",") + 1), "base64");
  const subtype = decoded.mimeType.split("/")[1]?.replace(/[^A-Za-z0-9.+-]/g, "") || "png";
  return { blob: new Blob([bytes], { type: decoded.mimeType }), filename: `${name}.${subtype}` };
}

async function uploadApimartReference(dataUrl, endpoint, settings, fetchImpl, signal, name) {
  const file = dataUrlFile(dataUrl, name);
  const form = new FormData();
  form.append("file", file.blob, file.filename);
  const response = await fetchImpl(endpoint + "/v1/uploads/images", {
    method: "POST",
    headers: { authorization: "Bearer " + settings.apiKey },
    body: form,
    signal: imageSignal(signal, 60000),
  });
  const payload = await readUpstreamPayload(response);
  if (!response.ok) throw fail(payload?.error?.message || "APIMart image upload returned HTTP " + response.status, response.status >= 400 && response.status < 500 ? response.status : 502, "image_upload_error");
  const url = [payload?.url, payload?.data?.url, payload?.data?.[0]?.url].find((value) => typeof value === "string" && /^https:\/\//i.test(value));
  if (!url) throw fail("APIMart image upload returned no public URL.", 502, "image_upload_error");
  return url;
}

async function apimartReferenceUrls(request, endpoint, settings, fetchImpl, signal, lookupImpl, assetResolver) {
  const urls = [];
  for (const [index, reference] of request.reference_images.entries()) {
    if (/^https:\/\//i.test(reference)) {
      const parsed = validateReferenceUrl(reference);
      await assertPublicHostname(parsed, lookupImpl);
      urls.push(parsed.href);
      continue;
    }
    let dataUrl;
    if (isImageAssetReference(reference)) {
      if (typeof assetResolver !== "function") throw fail("Local image asset resolution is unavailable.", 500, "image_asset_unavailable");
      dataUrl = await assetResolver(reference);
    } else {
      dataUrl = decodeDataUrl(reference)?.dataUrl;
    }
    if (!dataUrl) throw fail("APIMart reference images must be HTTPS URLs or valid image data URLs.", 400, "reference_image_error");
    urls.push(await uploadApimartReference(dataUrl, endpoint, settings, fetchImpl, signal, `reference-${index + 1}`));
  }
  return urls;
}

function multimodalContent(prompt, references) {
  return [{ type: "text", text: prompt }, ...references.map((url) => ({ type: "image_url", image_url: { url } }))];
}

function gptMomoEditBody(request, references) {
  const prompt = request.prompt + "\n\nOutput requirements: create exactly " + request.n + " edited image(s); canvas " +
    gptSizeFrom(request.aspect_ratio) + " (requested aspect " + request.aspect_ratio + "); " +
    request.resolution.toUpperCase() + " / " + gptQualityFrom(request.resolution) + " quality hint.";
  return { model: request.model, stream: true, messages: [{ role: "user", content: multimodalContent(prompt, references) }] };
}

function geminiEditBody(request, references) {
  return {
    model: request.model,
    messages: [{ role: "user", content: multimodalContent(request.prompt, references) }],
    modalities: ["text", "image"],
    extra_body: { google: { image_config: { aspect_ratio: request.aspect_ratio, image_size: request.resolution.toUpperCase() } } },
  };
}

function parseSseEvents(text) {
  const events = [];
  for (const frame of String(text || "").split(/\r?\n\r?\n/)) {
    const data = frame.split(/\r?\n/).filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart()).join("\n").trim();
    if (!data || data === "[DONE]") continue;
    try { events.push(JSON.parse(data)); } catch {}
  }
  return events;
}

function collectText(value, output, depth = 0) {
  if (depth > 12 || value === null || value === undefined) return;
  if (typeof value === "string") { output.push(value); return; }
  if (typeof value !== "object") return;
  if (Array.isArray(value)) { for (const item of value) collectText(item, output, depth + 1); return; }
  if (typeof value.content === "string") output.push(value.content);
  else if (value.content !== undefined) collectText(value.content, output, depth + 1);
  if (typeof value.text === "string") output.push(value.text);
}

function normalizeSsePayload(text) {
  const events = parseSseEvents(text);
  const deltas = [];
  for (const event of events) {
    for (const choice of Array.isArray(event?.choices) ? event.choices : []) {
      collectText(choice?.delta?.content, deltas);
      collectText(choice?.message?.content, deltas);
    }
  }
  return { events, content: deltas.join("") };
}

export function extractImageResults(payload) {
  const images = [];
  const taskIds = [];
  const statuses = [];
  const seen = new Set();
  const addDataUrls = (value) => {
    const pattern = /data:(image\/[A-Za-z0-9.+-]+);base64,([A-Za-z0-9+/=\r\n]+)/gi;
    let match;
    while ((match = pattern.exec(value)) !== null) images.push({ b64_json: match[2].replace(/[\r\n]/g, ""), mime_type: match[1].toLowerCase() });
  };
  const visit = (value, depth = 0) => {
    if (depth > 12 || value === null || value === undefined) return;
    if (typeof value === "string") { addDataUrls(value); return; }
    if (typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    const urlCandidates = [value.url, value.image_url, value.result_url];
    const url = urlCandidates.find((item) => typeof item === "string" && /^https?:\/\//i.test(item));
    if (Array.isArray(value.url)) {
      for (const item of value.url) {
        if (typeof item === "string" && /^https?:\/\//i.test(item)) images.push({ url: item });
      }
    }
    const directBase64 = [value.b64_json, value.base64, value.image_base64, value.partial_image_b64].find((item) => typeof item === "string" && item.length > 0);
    const resultBase64 = typeof value.result === "string" && value.result.length > 256 && /^[A-Za-z0-9+/=\r\n]+$/.test(value.result) ? value.result : null;
    const b64Json = directBase64 || resultBase64;
    if (url || b64Json) images.push({ ...(url ? { url } : {}), ...(b64Json ? { b64_json: b64Json } : {}) });
    if (typeof value.task_id === "string") taskIds.push(value.task_id);
    if (typeof value.status === "string") statuses.push(value.status);
    for (const child of Array.isArray(value) ? value : Object.values(value)) visit(child, depth + 1);
  };
  visit(payload);
  const uniqueImages = images.filter((image, index, list) => list.findIndex((item) => item.url === image.url && item.b64_json === image.b64_json) === index);
  const rawStatus = statuses[0] || null;
  const terminal = ["failed", "error", "cancelled", "canceled", "expired"].includes(String(rawStatus || "").toLowerCase());
  const rawError = payload?.error?.message || payload?.error || payload?.failure_reason || payload?.fail_reason;
  const error = typeof rawError === "string" ? rawError.replace(/[\r\n]+/g, " ").slice(0, 1000) : null;
  return { images: uniqueImages, task_id: taskIds[0] || null, raw_status: rawStatus, terminal, ...(error ? { error } : {}) };
}

function trustedSourceUrl(value, endpoint) {
  try {
    const parsed = new URL(String(value || ""));
    const trustedOrigin = new URL(String(endpoint || "")).origin;
    if (parsed.protocol !== "https:" || parsed.origin !== trustedOrigin || parsed.username || parsed.password) return null;
    parsed.hash = "";
    return parsed.href;
  } catch {
    return null;
  }
}

async function materializeImages(result, fetchImpl, signal, lookupImpl, endpoint) {
  const images = [];
  for (const image of result.images) {
    const sourceUrl = trustedSourceUrl(image.url, endpoint);
    const materialized = sourceUrl ? { ...image, source_url: sourceUrl } : image;
    if (image.b64_json || !image.url || !/^https?:\/\//i.test(image.url)) { images.push(materialized); continue; }
    try {
      const parsed = validateReferenceUrl(image.url);
      await assertPublicHostname(parsed, lookupImpl);
      const response = await fetchImpl(parsed, { redirect: "error", signal: imageSignal(signal, 60000) });
      if (!response.ok) { images.push(materialized); continue; }
      const mimeType = (response.headers.get("content-type") || "image/png").split(";", 1)[0];
      if (!mimeType.toLowerCase().startsWith("image/")) { images.push(materialized); continue; }
      const bytes = await responseBytesWithinLimit(response);
      images.push({ ...materialized, b64_json: bytes.toString("base64"), mime_type: mimeType });
    } catch { images.push(materialized); }
  }
  return { ...result, images };
}

async function readUpstreamPayload(upstream) {
  const text = await upstream.text();
  const contentType = upstream.headers.get("content-type") || "";
  if (contentType.includes("text/event-stream") || /^\s*data:/m.test(text)) return normalizeSsePayload(text);
  try { return JSON.parse(text); } catch {
    const looksLikeHtml = /<!doctype\s+html|<html[\s>]/i.test(text);
    const suffix = upstream.status === 524 ? " (Cloudflare timeout)" : "";
    const message = looksLikeHtml
      ? "Image upstream returned HTTP " + upstream.status + suffix + "."
      : (text || "Image upstream returned an empty response.").replace(/[\r\n]+/g, " ").slice(0, 1000);
    return { error: { message } };
  }
}

export async function generateImage({ settings, request, fetchImpl = fetch, lookupImpl = lookup, assetResolver, signal, operation = "generate" }) {
  const normalized = normalizeImageRequest(request, operation);
  if (MODEL_RULES[normalized.model]?.requiresCatalog) {
    const capabilities = await resolveImageCapabilities({ settings, fetchImpl, signal });
    const model = capabilities.models.find((item) => item.id === normalized.model);
    if (!model?.available) {
      throw fail(
        "Image model " + normalized.model + " is not currently available in the authenticated MOMO model catalog.",
        503,
        "model_unavailable",
      );
    }
  }
  const endpoint = String(settings.endpoint || "").replace(/\/+$/, "");
  let path = "/v1/images/generations";
  let body;
  let multipart = false;
  if (operation === "generate") body = generationBody(normalized);
  else {
    if (GPT_IMAGE_25_MODELS.has(normalized.model)) {
      body = { ...nativeImageBody(normalized), image_urls: await apimartReferenceUrls(normalized, endpoint, settings, fetchImpl, signal, lookupImpl, assetResolver) };
    }
    else {
      const references = await resolveReferenceDataUrls(normalized, fetchImpl, signal, lookupImpl, assetResolver);
      if (normalized.model === "gpt-image-2") body = { ...generationBody(normalized), image_urls: references };
      else if (normalized.model === "gpt-image-2-momoapi") { path = "/v1/chat/completions"; body = gptMomoEditBody(normalized, references); }
      else { path = "/v1/chat/completions"; body = geminiEditBody(normalized, references); }
    }
  }
  const upstream = await fetchImpl(endpoint + path, {
    method: "POST",
    headers: { authorization: "Bearer " + settings.apiKey, ...(!multipart ? { "content-type": "application/json" } : {}) },
    body: multipart ? body : JSON.stringify(body),
    signal: imageSignal(signal),
  });
  const payload = await readUpstreamPayload(upstream);
  if (!upstream.ok) throw fail(payload?.error?.message || "Image upstream returned HTTP " + upstream.status, upstream.status >= 400 && upstream.status < 500 ? upstream.status : 502, "image_upstream_error");
  const result = await materializeImages(extractImageResults(payload), fetchImpl, signal, lookupImpl, endpoint);
  if (!GPT_IMAGE_25_MODELS.has(normalized.model)) return result;
  const mimeType = normalized.output_format === "jpeg" ? "image/jpeg" : "image/" + normalized.output_format;
  return { ...result, images: result.images.map((image) => image.b64_json && !image.mime_type ? { ...image, mime_type: mimeType } : image) };
}

export async function getImageTask({ settings, taskId, fetchImpl = fetch, lookupImpl = lookup, signal }) {
  if (!/^[A-Za-z0-9._:-]{1,256}$/.test(taskId || "")) throw fail("Invalid task_id.");
  const endpoint = String(settings.endpoint || "").replace(/\/+$/, "");
  const upstream = await fetchImpl(endpoint + "/v1/tasks/" + encodeURIComponent(taskId), {
    headers: { authorization: "Bearer " + settings.apiKey },
    signal: imageSignal(signal, 60000),
  });
  const payload = await readUpstreamPayload(upstream);
  if (!upstream.ok) throw fail(payload?.error?.message || "Image task returned HTTP " + upstream.status, upstream.status, "image_task_error");
  return materializeImages(extractImageResults(payload), fetchImpl, signal, lookupImpl, endpoint);
}
