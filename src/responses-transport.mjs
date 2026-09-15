import { randomUUID } from "node:crypto";
import { budgetedOutputBody, readBoundedOutputText, resolveOutputPolicy } from "./output-budget.mjs";
import { failed, responseCreated, sseError } from "./responses-sse.mjs";
import { sseDataPayload, streamSseBlocks, waitForResponseDrain } from "./stream-transport.mjs";

export async function* streamSseLines(body, response, signal, settings) {
  for await (const block of streamSseBlocks(budgetedOutputBody(body, settings), resolveOutputPolicy(settings))) {
    const data = sseDataPayload(block)?.trim();
    if (!data || data === "[DONE]") continue;
    let parsed;
    try { parsed = JSON.parse(data); } catch { continue; }
    yield parsed;
    // Bridge emitters can write several events for one input frame. Drain that
    // batch before reading another frame; terminal in-memory batches are separate.
    await waitForResponseDrain(response, signal);
  }
}

export function initSseResponse(response, status = 200) {
  response.writeHead(status, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    "connection": "keep-alive",
    "x-accel-buffering": "no"
  });
}

function redactUpstreamMessage(message) {
  return String(message)
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, "Bearer [redacted]")
    .replace(/data:[^;,\s]+(?:;[^,\s]*)?;base64,[A-Za-z0-9+/=\r\n]+/gi, "[inline data redacted]")
    .slice(0, 4000);
}

export async function upstreamErrorDetails(upstream) {
  const errText = await readBoundedOutputText(upstream);
  const contentType = String(upstream.headers?.get?.("content-type") || "").toLowerCase();
  const looksLikeHtml = contentType.includes("text/html")
    || /<!doctype\s+html|<html[\s>]/i.test(errText);

  if (upstream.status === 524) {
    return {
      message: "Upstream timed out before returning a response. Please retry.",
      code: "upstream_timeout",
    };
  }

  // Never reflect an upstream HTML error page into an API response. Besides
  // being unusable to clients, it can contain proxy diagnostics and request IDs.
  if (looksLikeHtml) {
    return {
      message: `Upstream returned HTTP ${upstream.status}.`,
      code: `http_${upstream.status}`,
    };
  }

  let message;
  try {
    const parsed = JSON.parse(errText);
    message = parsed.error?.message || parsed.message || errText;
  } catch {
    message = errText || `Upstream HTTP ${upstream.status}`;
  }
  return { message: redactUpstreamMessage(message), code: `http_${upstream.status}` };
}

export async function upstreamErrorMessage(upstream) {
  return (await upstreamErrorDetails(upstream)).message;
}

export function writeResponsesFailure(response, model, status, message, code = `http_${status}`, details = null) {
  if (!response.headersSent) initSseResponse(response, status);
  const respId = response.momoResponseId || "resp_err_" + randomUUID();
  if (!response.momoResponseId) response.write(responseCreated(model, respId).data);
  response.write(failed(respId, model, message, code, details));
  response.write(sseError(message, code, details));
  response.end();
}
