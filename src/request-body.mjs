import { admissionError } from "./request-admission.mjs";
import { performance } from "node:perf_hooks";

export function getMaxRequestBodyBytes(settings = {}) {
  const mb = parseInt(process.env.MOMO_MAX_REQUEST_BODY_MB || settings.maxRequestBodyMb || "64", 10);
  return (isNaN(mb) || mb < 1 || mb > 256 ? 64 : mb) * 1024 * 1024;
}
export function declaredBodyBytes(request, settings = {}) {
  const value = request.headers?.["content-length"];
  if (value === undefined) return null;
  if (typeof value !== "string" || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw admissionError(400, "invalid_content_length", "Content-Length must be a nonnegative safe integer.");
  }
  const bytes = Number(value);
  if (bytes > getMaxRequestBodyBytes(settings)) throw oversized(settings);
  return bytes;
}
function oversized(settings) {
  return admissionError(413, "payload_too_large", "Payload Too Large: request body exceeds limit of " + (getMaxRequestBodyBytes(settings) / (1024 * 1024)) + "MB.");
}
export function requestReservationBytes(request, settings = {}) {
  return Math.max(64 * 1024, declaredBodyBytes(request, settings) ?? getMaxRequestBodyBytes(settings));
}

// Event-based collection permits an early HTTP error before closing an unread
// upload. IncomingMessage's async iterator destroys the socket on early exit.
export async function bodyOf(request, settings = {}, { signal, timeoutMs = 120000 } = {}) {
  if (signal?.aborted || request.aborted) throw admissionError(499, "request_cancelled", "Client cancelled the upload.");
  const expected = declaredBodyBytes(request, settings);
  const maxBytes = getMaxRequestBodyBytes(settings);
  const readStart = performance.now();
  const raw = await new Promise((resolve, reject) => {
    let target = expected === null ? null : Buffer.allocUnsafe(expected);
    let chunks = [];
    let slab = null;
    let slabUsed = 0;
    let total = 0;
    let settled = false;
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("error", onError);
      request.off("aborted", onAbort);
      request.off("close", onClose);
      signal?.removeEventListener("abort", onAbort);
    };
    const finish = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) {
        request.momoBodyReadMs = performance.now() - readStart;
        request.pause();
        chunks = [];
        target = null;
        slab = null;
        reject(error);
      } else {
        if (slabUsed) chunks.push(slab.subarray(0, slabUsed));
        const buffer = target || Buffer.concat(chunks, total);
        chunks = [];
        target = null;
        slab = null;
        const text = buffer.toString("utf8");
        request.momoBodyReadMs = performance.now() - readStart;
        resolve(text);
      }
    };
    const onError = () => finish(admissionError(400, "request_body_interrupted", "Request body stream was interrupted."));
    const onAbort = () => finish(admissionError(499, "request_cancelled", "Client cancelled the upload."));
    const onClose = () => { if (!request.complete) onError(); };
    const onData = (chunk) => {
      total += chunk.length;
      request.momoRequestBodyBytes = total;
      if (total > maxBytes) return finish(oversized(settings));
      if (expected !== null && total > expected) return finish(admissionError(400, "content_length_mismatch", "Body length differs from Content-Length."));
      if (target) chunk.copy(target, total - chunk.length);
      else {
        // Bound metadata too: one array entry per 64KiB, not per network chunk.
        let offset = 0;
        while (offset < chunk.length) {
          if (!slab) slab = Buffer.allocUnsafe(64 * 1024);
          const count = Math.min(slab.length - slabUsed, chunk.length - offset);
          chunk.copy(slab, slabUsed, offset, offset + count);
          offset += count;
          slabUsed += count;
          if (slabUsed === slab.length) { chunks.push(slab); slab = null; slabUsed = 0; }
        }
      }
    };
    const onEnd = () => {
      if (expected !== null && expected !== total) return finish(admissionError(400, "content_length_mismatch", "Body length differs from Content-Length."));
      finish();
    };
    request.on("data", onData);
    request.once("end", onEnd);
    request.once("error", onError);
    request.once("aborted", onAbort);
    request.once("close", onClose);
    signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => finish(admissionError(408, "request_body_timeout", "Request body read deadline exceeded.")), timeoutMs);
    if (signal?.aborted || request.aborted) onAbort();
    else if (request.destroyed) onError();
  });
  const parseStart = performance.now();
  try { return JSON.parse(raw); }
  catch { throw admissionError(400, "invalid_json", "Request body must be valid JSON."); }
  finally { request.momoBodyParseMs = performance.now() - parseStart; }
}
