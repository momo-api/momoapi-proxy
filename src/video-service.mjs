import { lookup } from "node:dns/promises";
import { resolveImageReferenceDataUrls } from "./image-service.mjs";

const VIDEO_MODEL_IDS = new Set([
  "momoapi-gemini-omni-flash",
  "momoapi-veo-3-1-lite",
  "momoapi-kling-3-standard",
]);

export const VIDEO_CAPABILITIES = {
  version: 1,
  models: [
    { id: "momoapi-gemini-omni-flash", display_name: "MOMO Gemini Omni Flash", modality: "video", available: false },
    { id: "momoapi-veo-3-1-lite", display_name: "MOMO Veo 3.1 Lite", modality: "video", available: false },
    { id: "momoapi-kling-3-standard", display_name: "MOMO Kling 3 Standard", modality: "video", available: false },
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
    transport: "openai-video-task",
  };
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
    if (models.length) capabilities.models = models;
    const preferred = ["momoapi-gemini-omni-flash", "momoapi-veo-3-1-lite", "momoapi-kling-3-standard"];
    capabilities.defaults.model = preferred.find((id) => models.some((model) => model.id === id && model.available !== false)) || models[0]?.id || capabilities.defaults.model;
    capabilities.catalog_status = "available";
  } catch {
    capabilities.catalog_status = "unavailable";
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
  return {
    model, prompt, reference_images: references,
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
  const id = payload?.id || payload?.task_id || taskId || null;
  const remoteUrl = [payload?.url, payload?.video_url, payload?.metadata?.url, payload?.result?.url]
    .find((value) => typeof value === "string" && /^https:\/\//i.test(value)) || null;
  const status = String(payload?.status || "queued").toLowerCase();
  return {
    task_id: id,
    status,
    terminal: ["completed", "failed", "cancelled", "canceled", "expired"].includes(status),
    remote_url: remoteUrl,
    content_url: id ? endpoint + "/v1/videos/" + encodeURIComponent(id) + "/content" : null,
    ...(payload?.progress !== undefined ? { progress: payload.progress } : {}),
    ...(payload?.error ? { error: payload.error } : {}),
  };
}

export async function generateVideo({ settings, request, fetchImpl = fetch, lookupImpl = lookup, assetResolver, signal }) {
  const capabilities = await resolveVideoCapabilities({ settings, fetchImpl, signal });
  const normalized = normalizeVideoRequest(request, capabilities);
  const endpoint = String(settings.endpoint || "").replace(/\/+$/, "");
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
  return videoResult(payload, endpoint, taskId);
}
