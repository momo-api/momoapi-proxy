const MODEL_PATHS = new Set(["/v1/models", "/models"]);
const CHAT_PATHS = new Set(["/v1/chat/completions", "/chat/completions"]);
const COMPACT_PATHS = new Set(["/v1/responses/compact", "/responses/compact"]);
const RESPONSES_PATHS = new Set(["/v1/responses", "/responses"]);

function postRoute(method, pathname, paths) {
  return method === "POST" && paths.has(pathname);
}

export function isModelsRoute(method, pathname) {
  return method === "GET" && MODEL_PATHS.has(pathname);
}

export function isChatCompletionsRoute(method, pathname) {
  return postRoute(method, pathname, CHAT_PATHS);
}

export function isCompactRoute(method, pathname) {
  return postRoute(method, pathname, COMPACT_PATHS);
}

export function isResponsesRoute(method, pathname) {
  return postRoute(method, pathname, RESPONSES_PATHS);
}

export function classifyPublicRoute(method, pathname) {
  if (isModelsRoute(method, pathname)) return "models";
  if (isChatCompletionsRoute(method, pathname)) return "chat";
  if (isCompactRoute(method, pathname)) return "compact";
  if (isResponsesRoute(method, pathname)) return "responses";
  return null;
}
