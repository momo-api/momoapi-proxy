import { buildLocalCompactResponse, encodeLocalCompaction } from "./compaction.mjs";

const MIB = 1024 * 1024;
const COMPACT_RESPONSE_MAX_BYTES = 32 * MIB;

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
