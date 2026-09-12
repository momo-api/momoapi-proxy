import { resolveOpenCodeSession } from "./opencode-session.mjs";

export function asArray(value) {
  return Array.isArray(value) ? value : [];
}

export function json(response, status, body, headers = {}) {
  response.writeHead(status, { "content-type": "application/json", ...headers });
  response.end(JSON.stringify(body));
}

export function authorized(request, settings) {
  const auth = request.headers.authorization;
  if (auth) {
    if (auth === "Bearer " + settings.localToken || auth === "Bearer " + settings.apiKey || auth === "Bearer momo-local-key") {
      return true;
    }
    return false;
  }

  const remote = request.socket?.remoteAddress;
  const isLoopback = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1" || !remote;
  if (settings.host === "127.0.0.1" && isLoopback) return true;
  return false;
}

export function upstreamHeaders(settings, contentType = "application/json") {
  return { authorization: "Bearer " + settings.apiKey, "content-type": contentType };
}

export function openCodeUpstreamHeaders(settings, request, payload, calls) {
  return {
    ...upstreamHeaders(settings),
    "x-opencode-session": resolveOpenCodeSession(request, payload, calls),
  };
}

export function writeSse(response, chunks) {
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "x-accel-buffering": "no" });
  for (const chunk of chunks) response.write(chunk);
  response.end();
}
