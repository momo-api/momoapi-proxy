import { lookup } from "node:dns/promises";
import { resolveImageReferenceDataUrls } from "./image-service.mjs";

const VIDEO_MODEL_IDS = new Set([
  "momoapi-gemini-omni-flash",
  "momoapi-veo-3-1-fast",
  "momoapi-veo-3-1-lite",
  "momoapi-kling-3-standard",
  "MiniMax-H3-Max",
  "seedance-2.5",
]);

export const VIDEO_CAPABILITIES = {
  version: 1,
  models: [
    { id: "momoapi-gemini-omni-flash", display_name: "MOMO Gemini Omni Flash", modality: "video", available: false },
    { id: "momoapi-veo-3-1-fast", display_name: "MOMO Veo 3.1 Fast", modality: "video", available: false },
    { id: "momoapi-veo-3-1-lite", display_name: "MOMO Veo 3.1 Lite", modality: "video", available: false },
    { id: "momoapi-kling-3-standard", display_name: "MOMO Kling 3 Standard", modality: "video", available: false },
    { id: "MiniMax-H3-Max", display_name: "MiniMax H3 Max (APIMart)", modality: "video", available: false },
    { id: "seedance-2.5", display_name: "Seedance 2.5 (APIMart)", modality: "video", available: false },
  ],
  defaults: { model: "momoapi-gemini-omni-flash" },
  storage: {
    mode: "remote_url",
    downloads_by_default: false,
    note: "Completed Adobe output URLs are returned without downloading the video to the local computer or VPS.",
  },
};

function fail(message, statusCode = 400, code = "invalid_request_error") {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function videoSignal(parentSignal, timeoutMs = 60000) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return parentSignal ? AbortSignal.any([parentSignal, timeoutSignal]) : timeoutSignal;
}

function allowedValues(parameter) {
  return Array.isArray(parameter?.allowed) ? parameter.allowed : [];
}

function maximum(parameter, fallback = 0) {
  if (Number.isInteger(parameter?.maximum)) return parameter.maximum;
  const values = allowedValues(parameter).filter(Number.isInteger);
  return values.length ? Math.max(...values) : fallback;
}

function publicCapability(model) {
  const parameters = model?.parameters || {};
  return {
    ...model,
    parameter_schema: parameters,
    parameters: Object.keys(parameters),
    limits: {
      durations: allowedValues(parameters.duration),
      aspect_ratios: allowedValues(parameters.aspect_ratio),
      resolutions: allowedValues(parameters.resolution),
      generate_audio: allowedValues(parameters.generate_audio),
      max_reference_images: maximum(parameters.max_reference_images, 0),
    },
    transport: model?.provider === "APIMart" ? "newapi-video-json-task" : "openai-video-task",
  };
}

// NewAPI currently exposes image-only media capabilities. Video availability
// must be checked against the authenticated, group-scoped model list instead.
function apimartVideoCapabilities(ids) {
  const common = { modality: "video", role: "fallback", provider: "APIMart", operations: ["generate", "image_to_video", "style_reference"] };
  const duration = (minimum, maximum) => ({ type: "integer", allowed: Array.from({ length: maximum - minimum + 1 }, (_, i) => i + minimum), default: minimum });
  return [
    { ...common, id: "MiniMax-H3-Max", available: ids.has("MiniMax-H3-Max"), parameters: {
      duration: duration(5, 15), resolution: { allowed: ["480P", "768P", "1080P"], default: "768P" },
      aspect_ratio: { allowed: ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16", "adaptive"] },
      max_reference_images: { maximum: 9 },
    } },
    { ...common, id: "seedance-2.5", available: ids.has("seedance-2.5"), parameters: {
      duration: duration(4, 30), resolution: { allowed: ["480p", "720p", "1080p"], default: "480p" },
      max_reference_images: { maximum: 30 },
    } },
  ].map(publicCapability);
}

export async function resolveVideoCapabilities({ settings, fetchImpl = fetch, signal } = {}) {
  const capabilities = structuredClone(VIDEO_CAPABILITIES);
  if (!settings) return capabilities;
  try {
    const endpoint = String(settings.endpoint || "").replace(/\/+$/, "");
    const response = await fetchImpl(endpoint + "/agent/media-capabilities", {
      headers: { authorization: "Bearer " + settings.apiKey },
      signal: videoSignal(signal, 15000),
    });
    if (!response.ok) throw new Error("media capability catalog returned HTTP " + response.status);
    const payload = await response.json();
    if (!Array.isArray(payload?.models)) throw new Error("media capability catalog has no models");
    const models = payload.models
      .filter((model) => model?.modality === "video" && VIDEO_MODEL_IDS.has(model.id))
      .map(publicCapability);
    try {
      const catalog = await fetchImpl(endpoint + "/v1/models", {
        headers: { authorization: "Bearer " + settings.apiKey }, signal: videoSignal(signal, 15000),
      });
      if (catalog?.ok) {
        const data = await catalog.json();
        const ids = new Set((Array.isArray(data?.data) ? data.data : []).map((item) => item?.id));
        models.push(...apimartVideoCapabilities(ids).filter((item) => item.available));
      }
    } catch {}
    if (models.length) capabilities.models = models;
    const preferred = ["MiniMax-H3-Max", "seedance-2.5", "momoapi-gemini-omni-flash", "momoapi-veo-3-1-fast", "momoapi-veo-3-1-lite", "momoapi-kling-3-standard"];
    capabilities.defaults.model = preferred.find((id) => models.some((model) => model.id === id && model.available !== false)) || models[0]?.id || capabilities.defaults.model;
    capabilities.catalog_status = "available";
  } catch {
    capabilities.catalog_status = "unavailable";
    try {
      const endpoint = String(settings.endpoint || "").replace(/\/+$/, "");
      const response = await fetchImpl(endpoint + "/v1/models", { headers: { authorization: "Bearer " + settings.apiKey }, signal: videoSignal(signal, 15000) });
      if (response.ok) {
        const payload = await response.json();
        const ids = new Set((Array.isArray(payload?.data) ? payload.data : []).map((item) => item?.id));
        capabilities.models = apimartVideoCapabilities(ids).filter((item) => item.available);
        capabilities.defaults.model = capabilities.models[0]?.id || capabilities.defaults.model;
        capabilities.catalog_status = "model_list_fallback";
      }
    } catch {}
  }
  return capabilities;
}

function selectedValue(input, key, parameter) {
  const allowed = allowedValues(parameter);
  const value = input[key] ?? parameter?.default;
  if (value === undefined || value === null || value === "") return undefined;
  if (allowed.length && !allowed.includes(value)) {
    throw fail("Unsupported " + key + " for " + input.model + ". Allowed: " + allowed.join(", ") + ".");
  }
  return value;
}

export function normalizeVideoRequest(input, capabilities = VIDEO_CAPABILITIES) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw fail("Video request must be an object.");
  const model = String(input.model || capabilities.defaults.model || "").trim();
  const capability = capabilities.models?.find((item) => item.id === model);
  if (!capability || !VIDEO_MODEL_IDS.has(model)) throw fail("Unsupported video model: " + model + ".");
  if (capability.available === false) throw fail("Video model is not currently available: " + model + ".", 503, "model_unavailable");
  const prompt = String(input.prompt || "").trim();
  if (!prompt) throw fail("prompt is required.");
  const parameters = capability.parameter_schema || (capability.parameters && !Array.isArray(capability.parameters) ? capability.parameters : {});
  const durationRaw = input.duration ?? input.seconds ?? parameters.duration?.default;
  const duration = durationRaw === undefined ? undefined : Number(durationRaw);
  if (duration !== undefined && !Number.isInteger(duration)) throw fail("duration must be an integer number of seconds.");
  const durationAllowed = allowedValues(parameters.duration);
  if (durationAllowed.length && !durationAllowed.includes(duration)) {
    throw fail("Unsupported duration for " + model + ". Allowed: " + durationAllowed.join(", ") + ".");
  }
  const aspectRatio = selectedValue({ ...input, model }, "aspect_ratio", parameters.aspect_ratio);
  const resolution = selectedValue({ ...input, model }, "resolution", parameters.resolution);
  let generateAudio = input.generate_audio ?? input.audio ?? parameters.generate_audio?.default;
  if (generateAudio !== undefined && typeof generateAudio !== "boolean") throw fail("generate_audio must be true or false.");
  const audioAllowed = allowedValues(parameters.generate_audio);
  if (audioAllowed.length && !audioAllowed.includes(generateAudio)) {
    throw fail("Unsupported generate_audio for " + model + ". Allowed: " + audioAllowed.join(", ") + ".");
  }
  const references = Array.isArray(input.reference_images) ? input.reference_images : [];
  if (input.reference_images !== undefined && !Array.isArray(input.reference_images)) throw fail("reference_images must be an array.");
  const maxReferences = maximum(parameters.max_reference_images, 0);
  if (references.length > maxReferences) throw fail(model + " accepts at most " + maxReferences + " reference images.");
  const operations = Array.isArray(capability.operations) ? capability.operations : ["generate"];
  if (references.length && !operations.some((operation) => operation === "image_to_video" || operation === "style_reference")) {
    throw fail(model + " does not support reference images.");
  }
  if (model === "MiniMax-H3-Max" || model === "seedance-2.5") {
    if (input.generate_audio !== undefined || input.audio !== undefined) throw fail("Audio controls are not supported by the MOMO APIMart video route.");
    if (prompt.length > 7000) throw fail("APIMart video prompt must be at most 7000 characters.");
    const first = input.first_frame_image;
    const last = input.last_frame_image;
    if ((first !== undefined || last !== undefined) && references.length) throw fail("Frame images and reference images cannot be combined.");
    if (first !== undefined && (typeof first !== "string" || !first.startsWith("https://"))) throw fail("first_frame_image must be a public HTTPS URL.");
    if (last !== undefined && (typeof last !== "string" || !last.startsWith("https://"))) throw fail("last_frame_image must be a public HTTPS URL.");
    if (references.length && aspectRatio && aspectRatio !== "adaptive" && model === "seedance-2.5")
      throw fail("Seedance reference images require adaptive aspect_ratio.");
    if ((first || last) && aspectRatio && aspectRatio !== "adaptive") throw fail("Frame images require adaptive aspect_ratio.");
  }
  return {
    model, prompt, reference_images: references,
    ...(input.first_frame_image ? { first_frame_image: input.first_frame_image } : {}),
    ...(input.last_frame_image ? { last_frame_image: input.last_frame_image } : {}),
    ...(duration !== undefined ? { duration } : {}),
    ...(aspectRatio !== undefined ? { aspect_ratio: aspectRatio } : {}),
    ...(resolution !== undefined ? { resolution } : {}),
    ...(generateAudio !== undefined ? { generate_audio: generateAudio } : {}),
  };
}

function dataUrlFile(value, index) {
  const match = /^data:(image\/[A-Za-z0-9.+-]+);base64,([A-Za-z0-9+/=\r\n]+)$/i.exec(value || "");
  if (!match) throw fail("reference image could not be encoded for upload.", 400, "reference_image_error");
  const mimeType = match[1].toLowerCase();
  const bytes = Buffer.from(match[2].replace(/[\r\n]/g, ""), "base64");
  const subtype = mimeType.split("/")[1]?.replace(/[^A-Za-z0-9.+-]/g, "") || "png";
  return { blob: new Blob([bytes], { type: mimeType }), filename: "reference-" + (index + 1) + "." + subtype };
}

async function readPayload(response) {
  const text = await response.text();
  try { return JSON.parse(text); } catch {
    return { error: { message: (text || "Video upstream returned HTTP " + response.status + ".").replace(/[\r\n]+/g, " ").slice(0, 1000) } };
  }
}

function videoResult(payload, endpoint, taskId) {
  const id = payload?.task_id || payload?.id || taskId || null;
  const remoteUrl = [payload?.url, payload?.video_url, payload?.metadata?.url, payload?.result?.url]
    .find((value) => typeof value === "string" && /^https:\/\//i.test(value)) || null;
  const status = String(payload?.status || "queued").toLowerCase();
  return {
    task_id: id,
    status,
    terminal: ["completed", "failed", "cancelled", "canceled", "expired"].includes(status),
    remote_url: remoteUrl,
    // This gateway route requires the caller's API bearer token. It is useful
    // to SDK clients, but it must not be presented as a browser-playable URL.
    authenticated_content_url: id && !String(id).startsWith("task_") ? endpoint + "/v1/videos/" + encodeURIComponent(id) + "/content" : null,
    playable_url: remoteUrl,
    ...(payload?.progress !== undefined ? { progress: payload.progress } : {}),
    ...(payload?.error ? { error: payload.error } : {}),
  };
}

export async function generateVideo({ settings, request, fetchImpl = fetch, lookupImpl = lookup, assetResolver, signal }) {
  const capabilities = await resolveVideoCapabilities({ settings, fetchImpl, signal });
  const normalized = normalizeVideoRequest(request, capabilities);
  const endpoint = String(settings.endpoint || "").replace(/\/+$/, "");
  if (normalized.model === "MiniMax-H3-Max" || normalized.model === "seedance-2.5") {
    // JSON is required by NewAPI's APIMart adapter. Keep HTTPS references as
    // URLs (never upload to an imaginary gateway endpoint).
    const references = normalized.reference_images.map((reference) => {
      if (!/^https:\/\/[^/?#]+/i.test(reference)) throw fail("APIMart video references must be public HTTPS URLs.", 400, "reference_image_error");
      const url = new URL(reference);
      if (url.username || url.password || url.hostname === "localhost" || /^(?:127\.|10\.|192\.168\.|169\.254\.)/.test(url.hostname)) throw fail("APIMart video references must be public HTTPS URLs.", 400, "reference_image_error");
      return reference;
    });
    const body = { model: normalized.model, prompt: normalized.prompt, duration: normalized.duration,
      resolution: normalized.resolution, ...(references.length ? { image_urls: references } : {}),
      ...(normalized.first_frame_image ? { first_frame_image: normalized.first_frame_image } : {}),
      ...(normalized.last_frame_image ? { last_frame_image: normalized.last_frame_image } : {}),
      ...(normalized.aspect_ratio ? { aspect_ratio: normalized.aspect_ratio } : {}),
    };
    const response = await fetchImpl(endpoint + "/v1/video/generations", {
      method: "POST", headers: { authorization: "Bearer " + settings.apiKey, "content-type": "application/json" },
      body: JSON.stringify(body), signal: videoSignal(signal, 60000),
    });
    const payload = await readPayload(response);
    if (!response.ok) throw fail(payload?.error?.message || "Video submission returned HTTP " + response.status + ". Do not retry an uncertain submission.", response.status, "video_upstream_error");
    return videoResult(payload, endpoint);
  }
  const form = new FormData();
  form.set("model", normalized.model);
  form.set("prompt", normalized.prompt);
  if (normalized.duration !== undefined) form.set("seconds", String(normalized.duration));
  if (normalized.aspect_ratio) form.set("size", normalized.aspect_ratio);
  if (normalized.resolution) form.set("resolution_name", normalized.resolution);
  if (normalized.generate_audio !== undefined) form.set("generate_audio", String(normalized.generate_audio));
  if (normalized.reference_images.length) {
    const dataUrls = await resolveImageReferenceDataUrls(normalized, fetchImpl, signal, lookupImpl, assetResolver);
    dataUrls.forEach((value, index) => {
      const file = dataUrlFile(value, index);
      form.append("input_reference[]", file.blob, file.filename);
    });
  }
  const response = await fetchImpl(endpoint + "/v1/videos", {
    method: "POST",
    headers: { authorization: "Bearer " + settings.apiKey },
    body: form,
    signal: videoSignal(signal, 60000),
  });
  const payload = await readPayload(response);
  if (!response.ok) throw fail(payload?.error?.message || payload?.detail?.error || "Video upstream returned HTTP " + response.status + ".", response.status >= 400 && response.status < 500 ? response.status : 502, "video_upstream_error");
  return videoResult(payload, endpoint);
}

export async function getVideoTask({ settings, taskId, fetchImpl = fetch, signal }) {
  if (!/^[A-Za-z0-9._:-]{1,256}$/.test(taskId || "")) throw fail("Invalid task_id.");
  const endpoint = String(settings.endpoint || "").replace(/\/+$/, "");
  const response = await fetchImpl(endpoint + "/v1/videos/" + encodeURIComponent(taskId), {
    headers: { authorization: "Bearer " + settings.apiKey },
    signal: videoSignal(signal, 60000),
  });
  const payload = await readPayload(response);
  if (!response.ok) throw fail(payload?.error?.message || "Video task returned HTTP " + response.status + ".", response.status, "video_task_error");
  return videoResult(payload?.data?.task_id ? { ...payload.data, status: payload.data.status === "SUCCESS" ? "completed" : payload.data.status === "FAILURE" ? "failed" : payload.data.status === "SUBMITTED" || payload.data.status === "QUEUED" ? "queued" : "processing", url: payload.data.result_url } : payload, endpoint, taskId);
}
