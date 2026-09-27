import { buildLocalCompactResponse, encodeLocalCompaction } from "./compaction.mjs";
import { resolveTargetModel } from "./model-routing.mjs";

const MIB = 1024 * 1024;
const COMPACT_RESPONSE_MAX_BYTES = 32 * MIB;

// A Responses-shaped gateway is not evidence that its compact endpoint exists.
// Keep this allowlist empty until a backend/model is verified end to end.
export function nativeCompactCapability(settings, model) {
  const declared = settings?.contextPolicy?.nativeCompactModels;
  if (!Array.isArray(declared) || !declared.includes(model)) return false;
  if (resolveTargetModel(model).protocol !== "responses") return false;
  try {
    const url = new URL(settings.endpoint);
    return url.protocol === "https:" && ["momoapi.us", "api.openai.com"].includes(url.hostname) && (!url.port || url.port === "443");
  } catch {
    return false;
  }
}

export function compactUnsupportedError(model) {
  return { error: { message: `Native compaction is not verified for model ${model}.`, type: "compact_error", code: "compact_capability_unverified" } };
}

export function isReplayableNativeCompactOutput(output) {
  return Array.isArray(output) && output.length > 0 && output.every((item) =>
    item && typeof item === "object" && !["compaction", "compaction_summary"].includes(item.type)
    && !Object.hasOwn(item, "encrypted_content"));
}

export function shouldUseLocalCompact(status, message = "") {
  if (status === 413) return true;
  if (status === 405 || status === 501) return true;
  if (status === 404) return !/\bmodel\b/i.test(String(message));
  return status === 400 && /(?:compact|endpoint|route).*(?:unsupported|not supported|not found|unavailable|unknown)/i.test(String(message));
}

export async function readCompactResponseText(upstream) {
  if (!upstream.body) return "";
  const chunks = [];
  let total = 0;
  for await (const chunk of upstream.body) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk);
    total += buffer.length;
    if (total > COMPACT_RESPONSE_MAX_BYTES) {
      try { await upstream.body.cancel?.(); } catch {}
      const error = new Error("Compact response exceeded the 32 MiB safety limit.");
      error.statusCode = 502;
      error.code = "compact_response_too_large";
      throw error;
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

export function parseCompactResponseText(text) {
  let payload;
  try { payload = JSON.parse(text); } catch {
    const error = new Error("Compact endpoint returned invalid JSON.");
    error.statusCode = 502;
    error.code = "invalid_compact_response";
    throw error;
  }
  if (!payload || payload.object !== "response.compaction" || !Array.isArray(payload.output)) {
    const error = new Error("Compact endpoint returned an invalid response.compaction object.");
    error.statusCode = 502;
    error.code = "invalid_compact_response";
    throw error;
  }
  return payload;
}

export function encodeRecoverableCompaction(model, input, output) {
  try {
    return encodeLocalCompaction(output);
  } catch (error) {
    if (error?.code !== "local_compaction_envelope_too_large") throw error;
    return encodeLocalCompaction(buildLocalCompactResponse(model, input).output);
  }
}
