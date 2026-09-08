const IMAGE_MODELS = new Set([
  "gpt-image-2",
  "gpt-image-2-momoapi",
  "gemini-3.1-flash-image",
]);

const MODEL_RULES = {
  "gpt-image-2": { maxN: 1, operations: ["generate", "edit"], aspectRatios: ["1:1", "16:9", "9:16"], resolutions: ["1k", "2k", "4k"] },
  "gpt-image-2-momoapi": { maxN: 4, operations: ["generate", "edit"], aspectRatios: ["1:1", "16:9", "9:16"], resolutions: ["1k", "2k", "4k"] },
  "gemini-3.1-flash-image": { maxN: 1, operations: ["generate"], aspectRatios: ["1:1", "16:9", "9:16"], resolutions: ["1k", "2k", "4k"] },
};

export const IMAGE_CAPABILITIES = {
  version: 1,
  models: [
    {
      id: "gpt-image-2",
      display_name: "GPT Image 2",
      operations: MODEL_RULES["gpt-image-2"].operations,
      parameters: ["prompt", "n", "aspect_ratio", "resolution", "reference_images"],
      limits: { max_n: MODEL_RULES["gpt-image-2"].maxN, aspect_ratios: MODEL_RULES["gpt-image-2"].aspectRatios, resolutions: MODEL_RULES["gpt-image-2"].resolutions },
    },
    {
      id: "gpt-image-2-momoapi",
      display_name: "GPT Image 2 MOMO",
      operations: MODEL_RULES["gpt-image-2-momoapi"].operations,
      parameters: ["prompt", "n", "aspect_ratio", "resolution", "reference_images"],
      limits: { max_n: MODEL_RULES["gpt-image-2-momoapi"].maxN, aspect_ratios: MODEL_RULES["gpt-image-2-momoapi"].aspectRatios, resolutions: MODEL_RULES["gpt-image-2-momoapi"].resolutions },
    },
    {
      id: "gemini-3.1-flash-image",
      display_name: "Gemini 3.1 Flash Image",
      operations: MODEL_RULES["gemini-3.1-flash-image"].operations,
      parameters: ["prompt", "n", "aspect_ratio", "resolution"],
      limits: { max_n: MODEL_RULES["gemini-3.1-flash-image"].maxN, aspect_ratios: MODEL_RULES["gemini-3.1-flash-image"].aspectRatios, resolutions: MODEL_RULES["gemini-3.1-flash-image"].resolutions },
    },
  ],
  defaults: { model: "gpt-image-2-momoapi", n: 1, aspect_ratio: "1:1", resolution: "1k" },
};

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
  if (typeof value !== "string") return null;
  if (/^data:image\/[A-Za-z0-9.+-]+;base64,/i.test(value)) return value;
  return null;
}

function sizeFrom(aspectRatio) {
  return ({
    "1:1": "1024x1024",
    "16:9": "1536x1024",
    "9:16": "1024x1536",
    "4:3": "1365x1024",
    "3:4": "1024x1365",
    "3:2": "1536x1024",
    "2:3": "1024x1536",
  })[aspectRatio] || "1024x1024";
}

export function normalizeImageRequest(input, operation = "generate") {
  if (!input || typeof input !== "object") throw fail("Image request must be a JSON object.");
  const model = typeof input.model === "string" && input.model.trim() ? input.model.trim() : IMAGE_CAPABILITIES.defaults.model;
  if (!IMAGE_MODELS.has(model)) throw fail(`Unsupported image model: ${model}`);
  const rules = MODEL_RULES[model];
  if (!rules.operations.includes(operation)) throw fail("Model " + model + " does not support " + operation + ".");
  const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
  if (!prompt) throw fail("prompt is required.");
  if (prompt.length > 32000) throw fail("prompt is too long.");
  const n = input.n === undefined ? 1 : Number(input.n);
  if (!Number.isInteger(n) || n < 1 || n > rules.maxN) throw fail("n must be an integer between 1 and " + rules.maxN + ".");
  const aspect_ratio = input.aspect_ratio || input.aspectRatio || IMAGE_CAPABILITIES.defaults.aspect_ratio;
  if (!rules.aspectRatios.includes(aspect_ratio)) throw fail("Unsupported aspect_ratio for " + model + ": " + aspect_ratio);
  const requestedResolution = input.resolution || input.imageSize || IMAGE_CAPABILITIES.defaults.resolution;
  const resolutionAliases = { low: "1k", medium: "2k", high: "4k", "1K": "1k", "2K": "2k", "4K": "4k" };
  const resolution = resolutionAliases[requestedResolution] || String(requestedResolution).toLowerCase();
  if (!rules.resolutions.includes(resolution)) throw fail("Unsupported resolution for " + model + ": " + requestedResolution);
  const references = input.reference_images || input.referenceImages || [];
  if (operation === "edit" && (!Array.isArray(references) || references.length === 0)) {
    throw fail("reference_images must contain at least one image for edit.");
  }
  if (!Array.isArray(references) || references.length > 16) throw fail("reference_images must be an array with at most 16 items.");
  if (operation === "generate" && references.length > 0) throw fail("Use image_edit when reference_images are provided.");
  for (const ref of references) {
    if (typeof ref !== "string" || (!asDataUrl(ref) && !/^https?:\/\//i.test(ref))) {
      throw fail("reference_images must contain image data URLs or HTTPS URLs.");
    }
  }
  return { model, prompt, n, aspect_ratio, resolution, reference_images: references, operation };
}

function upstreamJsonBody(request) {
  const body = { model: request.model, prompt: request.prompt, n: request.n, response_format: "b64_json" };
  if (request.model === "gemini-3.1-flash-image") {
    body.aspectRatio = request.aspect_ratio;
    body.imageSize = request.resolution.toUpperCase();
  } else {
    body.size = sizeFrom(request.aspect_ratio);
    body.quality = request.resolution === "1k" ? "low" : request.resolution === "4k" ? "high" : "medium";
  }
  return body;
}

function decodeDataUrl(value) {
  const match = /^data:(image\/[A-Za-z0-9.+-]+);base64,([A-Za-z0-9+/=\r\n]+)$/i.exec(value || "");
  if (!match) return null;
  return { mimeType: match[1], bytes: Buffer.from(match[2].replace(/[\r\n]/g, ""), "base64") };
}

function validateReferenceUrl(value) {
  const parsed = new URL(value);
  if (parsed.protocol !== "https:") throw fail("reference image URLs must use HTTPS.");
  const hostname = parsed.hostname.toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "metadata.google.internal" || /^127\.|^10\.|^192\.168\.|^169\.254\.|^0\./.test(hostname)) {
    throw fail("reference image URL host is not allowed.");
  }
  const octets = hostname.split(".").map((part) => Number(part));
  if (octets.length === 4 && octets.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)) {
    if (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) throw fail("reference image URL host is not allowed.");
    throw fail("reference image URLs must use a hostname, not a raw IP address.");
  }
  return parsed;
}

async function imageFormData(request, fetchImpl) {
  const form = new FormData();
  form.set("model", request.model);
  form.set("prompt", request.prompt);
  form.set("n", String(request.n));
  form.set("response_format", "b64_json");
  if (request.model === "gemini-3.1-flash-image") {
    form.set("aspectRatio", request.aspect_ratio);
    form.set("imageSize", request.resolution.toUpperCase());
  } else {
    form.set("size", sizeFrom(request.aspect_ratio));
    form.set("quality", request.resolution === "1k" ? "low" : request.resolution === "4k" ? "high" : "medium");
  }
  for (const ref of request.reference_images) {
    const decoded = decodeDataUrl(ref);
    if (decoded) form.append("image", new Blob([decoded.bytes], { type: decoded.mimeType }), "reference.png");
    else {
      const parsed = validateReferenceUrl(ref);
      const response = await fetchImpl(parsed, { redirect: "error" });
      if (!response.ok) throw fail("Unable to download reference image (HTTP " + response.status + ").", 400, "reference_image_error");
      const bytes = await response.arrayBuffer();
      const mimeType = response.headers.get("content-type")?.split(";", 1)[0] || "image/png";
      if (!mimeType.toLowerCase().startsWith("image/")) throw fail("reference image URL did not return an image.", 400, "reference_image_error");
      if (bytes.byteLength > 20 * 1024 * 1024) throw fail("reference image is too large.", 400, "reference_image_error");
      form.append("image", new Blob([bytes], { type: mimeType }), parsed.pathname.split("/").pop() || "reference.png");
    }
  }
  return form;
}

export function extractImageResults(payload) {
  const images = [];
  const taskIds = [];
  const seen = new Set();
  const visit = (value, depth = 0) => {
    if (depth > 6 || value === null || value === undefined) return;
    if (typeof value !== "object") return;
    if (seen.has(value)) return;
    seen.add(value);
    const url = [value.url, value.image_url, value.result_url].find((item) => typeof item === "string" && /^https?:\/\//i.test(item));
    const directBase64 = [value.b64_json, value.base64, value.image_base64, value.partial_image_b64].find((item) => typeof item === "string" && item.length > 0);
    const resultBase64 = typeof value.result === "string" && value.result.length > 256 && /^[A-Za-z0-9+/=\r\n]+$/.test(value.result) ? value.result : null;
    const b64_json = directBase64 || resultBase64;
    if (url || b64_json) images.push({ ...(url ? { url } : {}), ...(b64_json ? { b64_json } : {}) });
    if (typeof value.task_id === "string") taskIds.push(value.task_id);
    for (const child of Array.isArray(value) ? value : Object.values(value)) visit(child, depth + 1);
  };
  visit(payload);
  const uniqueImages = images.filter((image, index, list) => list.findIndex((item) => item.url === image.url && item.b64_json === image.b64_json) === index);
  const task_id = taskIds[0] || null;
  return { images: uniqueImages, task_id, raw_status: payload?.status || null };
}

async function materializeImages(result, fetchImpl) {
  const images = [];
  for (const image of result.images) {
    if (image.b64_json) { images.push(image); continue; }
    if (!image.url || !/^https?:\/\//i.test(image.url)) { images.push(image); continue; }
    try {
      const response = await fetchImpl(image.url);
      if (!response.ok) { images.push(image); continue; }
      const bytes = Buffer.from(await response.arrayBuffer());
      const mimeType = response.headers.get("content-type") || "image/png";
      images.push({ ...image, b64_json: bytes.toString("base64"), mime_type: mimeType });
    } catch { images.push(image); }
  }
  return { ...result, images };
}

export async function generateImage({ settings, request, fetchImpl = fetch, signal, operation = "generate" }) {
  const normalized = normalizeImageRequest(request, operation);
  const isEdit = operation === "edit";
  const init = { method: "POST", headers: { authorization: "Bearer " + settings.apiKey }, signal: imageSignal(signal) };
  if (isEdit) init.body = await imageFormData(normalized, fetchImpl);
  else { init.headers["content-type"] = "application/json"; init.body = JSON.stringify(upstreamJsonBody(normalized)); }
  const endpoint = settings.endpoint + (isEdit ? "/v1/images/edits" : "/v1/images/generations");
  const upstream = await fetchImpl(endpoint, init);
  const text = await upstream.text();
  let payload;
  try { payload = JSON.parse(text); } catch { payload = { error: { message: text || `Image upstream returned HTTP ${upstream.status}` } }; }
  if (!upstream.ok) {
    const error = fail(payload?.error?.message || `Image upstream returned HTTP ${upstream.status}`, upstream.status >= 400 && upstream.status < 500 ? upstream.status : 502, "image_upstream_error");
    throw error;
  }
  return materializeImages(extractImageResults(payload), fetchImpl);
}

export async function getImageTask({ settings, taskId, fetchImpl = fetch, signal }) {
  if (!/^[A-Za-z0-9._:-]{1,256}$/.test(taskId || "")) throw fail("Invalid task_id.");
  const upstream = await fetchImpl(settings.endpoint + "/v1/images/generations/" + encodeURIComponent(taskId), { headers: { authorization: "Bearer " + settings.apiKey }, signal: imageSignal(signal, 60000) });
  const text = await upstream.text();
  let payload;
  try { payload = JSON.parse(text); } catch { payload = { error: { message: text } }; }
  if (!upstream.ok) throw fail(payload?.error?.message || `Image task returned HTTP ${upstream.status}`, upstream.status, "image_task_error");
  return materializeImages(extractImageResults(payload), fetchImpl);
}
