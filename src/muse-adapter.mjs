import { upstreamHeaders } from "./http-lifecycle.mjs";
import { ResponseStreamEmitter } from "./responses-sse.mjs";
import { initSseResponse, streamSseLines, upstreamErrorDetails, writeResponsesFailure } from "./responses-transport.mjs";

const LIMITS = Object.freeze({
  maxBytes: 256 * 1024,
  maxFiles: 32,
  maxLines: 8192,
  maxLineBytes: 16 * 1024,
});

const BEGIN = "*** Begin Patch";
const END = "*** End Patch";
const FILE_HEADER = /^\*\*\* (Add File|Update File|Delete File): (.*)$/;
const MOVE_HEADER = /^\*\*\* Move to: (.*)$/;
const FILE_DIRECTIVE_PREFIXES = [
  "*** Add File:", "*** Update File:", "*** Delete File:", "*** Move to:",
];
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

function isObject(value) {
  return value !== null && typeof value === "object";
}

function hasExactApplyPatchDeclaration(value) {
  return Array.isArray(value)
    && value.some((entry) => isObject(entry) && entry.type === "custom" && entry.name === "apply_patch");
}

export function hasApplyPatchTool(payload) {
  return isObject(payload)
    && hasExactApplyPatchDeclaration(payload.tools);
}

function containsForbiddenCharacter(text) {
  for (const character of text) {
    const code = character.codePointAt(0);
    if (code < 0x20 && code !== 0x0a && code !== 0x09) return true;
    if (code >= 0x7f && code <= 0x9f) return true;
    if (code === 0xfeff || code === 0x200e || code === 0x200f) return true;
    if (code >= 0x202a && code <= 0x202e) return true;
    if (code >= 0x2066 && code <= 0x2069) return true;
    if (code === 0x2028 || code === 0x2029) return true;
  }
  return false;
}

function isSafePatchPath(path) {
  if (typeof path !== "string" || !path || path !== path.trim()) return false;
  if (path.startsWith("/") || path.includes("\\") || path.includes(":")) return false;
  const segments = path.split("/");
  return segments.every((segment) => {
    if (!segment || segment === "." || segment === "..") return false;
    if (segment !== segment.trim() || segment.endsWith(".")) return false;
    if (segment.toLowerCase() === ".git") return false;
    if (WINDOWS_RESERVED_NAME.test(segment)) return false;
    return true;
  });
}

function parseFileHeader(line) {
  const match = FILE_HEADER.exec(line);
  if (!match || !isSafePatchPath(match[2])) return null;
  return { kind: match[1], path: match[2] };
}

function isKnownFileDirective(line) {
  return FILE_DIRECTIVE_PREFIXES.some((prefix) => line.startsWith(prefix));
}

function isValidCompletedFile(file) {
  if (!file) return true;
  if (file.kind === "Add File") return file.bodyLines > 0;
  if (file.kind === "Delete File") return file.bodyLines === 0 && file.movePath === null;
  if (file.kind !== "Update File") return false;
  if (file.bodyLines === 0) return file.movePath !== null;
  return file.sawHunk && file.sawChange;
}

export function extractStrictCodexPatch(text) {
  if (typeof text !== "string" || !text || containsForbiddenCharacter(text)) return null;
  const patch = text.endsWith("\n") ? text.slice(0, -1) : text;
  if (!patch) return null;
  if (patch !== patch.trim()) return null;

  const encoder = new TextEncoder();
  if (encoder.encode(patch).length > LIMITS.maxBytes) return null;
  const lines = patch.split("\n");
  if (lines.length > LIMITS.maxLines) return null;
  if (lines.some((line) => encoder.encode(line).length > LIMITS.maxLineBytes)) return null;
  if (lines[0] !== BEGIN || lines.at(-1) !== END) return null;
  if (lines.slice(1, -1).some((line) => line === BEGIN || line === END)) return null;

  let fileCount = 0;
  let currentFile = null;
  for (let index = 1; index < lines.length - 1; index += 1) {
    const line = lines[index];
    const header = parseFileHeader(line);
    if (header) {
      if (!isValidCompletedFile(currentFile)) return null;
      fileCount += 1;
      if (fileCount > LIMITS.maxFiles) return null;
      currentFile = { ...header, bodyLines: 0, movePath: null, sawHunk: false, sawChange: false, sawEndOfFile: false };
      continue;
    }
    const move = MOVE_HEADER.exec(line);
    if (move) {
      if (!currentFile || currentFile.kind !== "Update File" || currentFile.movePath !== null
        || currentFile.bodyLines !== 0 || !isSafePatchPath(move[1]) || move[1] === currentFile.path) return null;
      currentFile.movePath = move[1];
      continue;
    }
    if (isKnownFileDirective(line) || !currentFile) return null;
    if (currentFile.kind === "Delete File") return null;
    if (currentFile.kind === "Add File") {
      if (!line.startsWith("+")) return null;
      currentFile.bodyLines += 1;
      continue;
    }
    if (currentFile.sawEndOfFile) return null;
    if (line === "*** End of File") {
      if (!currentFile.sawHunk) return null;
      currentFile.sawEndOfFile = true;
      currentFile.bodyLines += 1;
      continue;
    }
    if (line === "@@" || line.startsWith("@@ ")) {
      currentFile.sawHunk = true;
      currentFile.bodyLines += 1;
      continue;
    }
    if (!currentFile.sawHunk || !(line.startsWith("+") || line.startsWith("-") || line.startsWith(" "))) return null;
    if (line.startsWith("+") || line.startsWith("-")) currentFile.sawChange = true;
    currentFile.bodyLines += 1;
  }

  return fileCount > 0 && isValidCompletedFile(currentFile) ? patch : null;
}

export function latestMuseUserTask(input) {
  if (!Array.isArray(input)) return "";
  let latest = "";
  for (const item of input) {
    if (!isObject(item) || item.role !== "user" || !Array.isArray(item.content)) continue;
    const text = item.content
      .filter((part) => isObject(part) && part.type === "input_text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("");
    if (text) latest = text;
  }
  return latest;
}

const SYSTEM_CONTRACT = [
  "You are a patch-generation assistant.",
  "You have no access to the user's local filesystem, repository, shell, server, or test environment.",
  "Do not claim that you inspected files, ran commands, changed files, or ran tests.",
  "Return exactly one valid Codex apply_patch document and no text outside it.",
  "The patch must start with *** Begin Patch and end with *** End Patch.",
  "Use only safe relative paths. For Add File entries, every content line must begin with '+'.",
].join("\n");

export function buildMuseChatBody(payload) {
  const source = isObject(payload) ? payload : {};
  return {
    model: source.model,
    messages: [
      { role: "system", content: SYSTEM_CONTRACT },
      { role: "user", content: latestMuseUserTask(source.input) },
    ],
    stream: true,
  };
}

export { LIMITS as MUSE_PATCH_LIMITS };

export async function bridgeMuseResponses(request, response, settings, payload, fetchImpl, signal) {
  if (payload?.model !== "muse-auto") {
    return writeResponsesFailure(response, payload?.model || "unknown", 400, "Muse adapter only accepts muse-auto", "invalid_model");
  }

  const body = buildMuseChatBody(payload);
  let upstream;
  try {
    upstream = await fetchImpl(settings.endpoint + "/v1/chat/completions", {
      method: "POST",
      headers: upstreamHeaders(settings),
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    return writeResponsesFailure(response, payload.model, 502, error?.message || "Muse upstream request failed", "upstream_request_failed");
  }

  if (!upstream.ok) {
    const error = await upstreamErrorDetails(upstream);
    return writeResponsesFailure(response, payload.model, upstream.status, error.message, error.code);
  }

  let fullText = "";
  const encoder = new TextEncoder();
  let receivedBytes = 0;

  try {
    for await (const data of streamSseLines(upstream.body, response, signal, settings)) {
      if (isObject(data?.error)) throw new Error(data.error.message || "Muse upstream returned an error event");
      const delta = data?.choices?.[0]?.delta?.content;
      if (typeof delta !== "string") continue;
      receivedBytes += encoder.encode(delta).length;
      if (receivedBytes > LIMITS.maxBytes) throw new Error("Muse upstream output exceeded patch limit");
      fullText += delta;
    }
  } catch (error) {
    if (response.writableEnded || response.destroyed) return;
    return writeResponsesFailure(response, payload.model, 502, error?.message || "Muse upstream stream failed", "upstream_stream_failed");
  }

  if (response.writableEnded || response.destroyed || signal?.aborted) return;
  if (!fullText) return writeResponsesFailure(response, payload.model, 502, "Muse upstream returned no content", "empty_upstream_response");

  initSseResponse(response);
  const emitter = new ResponseStreamEmitter(response, payload.model, undefined, settings);
  try {
    emitter.start();
    const patch = extractStrictCodexPatch(fullText);
    if (patch && hasApplyPatchTool(payload)) emitter.writeCustomToolCall({ name: "apply_patch", input: patch });
    else emitter.writeTextDelta(fullText);
    emitter.complete();
  } catch (error) {
    if (!response.destroyed) response.destroy(error);
  }
}


