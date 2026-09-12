import { extractFunctions } from "./tools.mjs";
import { INLINE_DATA_URL, attachmentFromPart, imageFromPart, outputParts, safePartJson, safeTextValue } from "./protocol-content.mjs";

const KNOWN_METADATA_TYPES = new Set([
  "session_meta", "event_msg", "task_started", "world_state", "turn_context",
  "item_completed", "token_count", "web_search_call", "task_complete",
  "thread_settings_applied", "compacted", "turn_aborted", "inter_agent_communication_metadata",
  "agent_message",
]);

const GEMINI_REASONING_MAP = {
  none: "",
  minimal: "LOW",
  low: "LOW",
  medium: "MEDIUM",
  high: "HIGH",
  xhigh: "HIGH",
  max: "HIGH",
  ultra: "HIGH",
};

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function parseJsonSafe(value, fallback = {}) {
  if (typeof value === "object" && value !== null) return value;
  if (typeof value === "string") {
    try { return JSON.parse(value); } catch { return { raw: value }; }
  }
  return fallback;
}

function geminiOutputParts(value, name, callId) {
  const output = outputParts(value);
  const functionResponse = {
    name,
    response: { result: output.text },
    ...(callId ? { id: callId } : {}),
  };
  return [
    { functionResponse },
    ...output.images.map(geminiImagePart),
    ...output.files.map(geminiFilePart).filter(Boolean),
  ];
}

function geminiImagePart(image) {
  return image.kind === "url"
    ? { text: `[image: ${image.url}]` }
    : { inline_data: { mime_type: image.mimeType, data: image.data } };
}

function geminiFilePart(file) {
  if (!file || typeof file !== "object") return null;
  if (typeof file.file_data === "string") {
    const match = INLINE_DATA_URL.exec(file.file_data);
    if (match) {
      return {
        inline_data: {
          mime_type: match[1],
          data: match[2].replace(/[\r\n]/g, ""),
        },
      };
    }
  }
  return null;
}

function geminiFunctionResultText(part) {
  const response = part?.functionResponse?.response;
  if (response && typeof response === "object" && Object.hasOwn(response, "result")) {
    return typeof response.result === "string" ? response.result : safePartJson(response.result);
  }
  return safePartJson(response ?? part?.functionResponse ?? part);
}

export function sanitizeGeminiFunctionHistory(contents) {
  const source = asArray(contents);
  const sanitized = [];

  for (let index = 0; index < source.length; index++) {
    const content = source[index];
    if (!content || typeof content !== "object") continue;
    const parts = asArray(content.parts);
    const calls = parts.filter((part) => part?.functionCall);

    if (content.role !== "model" || calls.length === 0) {
      const orphanResponses = parts.filter((part) => part?.functionResponse);
      if (orphanResponses.length === 0) {
        if (parts.length > 0) sanitized.push(content);
        continue;
      }
      const safeParts = parts.flatMap((part) => part?.functionResponse
        ? [{ text: `[unpaired tool result: ${part.functionResponse.name || "tool"}]\n${geminiFunctionResultText(part)}` }]
        : [part]);
      if (safeParts.length > 0) sanitized.push({ ...content, parts: safeParts });
      continue;
    }

    const next = source[index + 1];
    const nextParts = next?.role === "user" ? asArray(next.parts) : [];
    const responses = nextParts.filter((part) => part?.functionResponse);
    const usedResponses = new Set();
    const keptCalls = [];
    const keptResponses = [];

    for (const callPart of calls) {
      const call = callPart.functionCall;
      let matchIndex = -1;
      if (call?.id) {
        matchIndex = responses.findIndex((part, responseIndex) =>
          !usedResponses.has(responseIndex) && part.functionResponse?.id === call.id);
      }
      if (matchIndex < 0) {
        matchIndex = responses.findIndex((part, responseIndex) =>
          !usedResponses.has(responseIndex) && part.functionResponse?.name === call?.name);
      }
      if (matchIndex < 0) continue;

      usedResponses.add(matchIndex);
      keptCalls.push(callPart);
      const responsePart = responses[matchIndex];
      keptResponses.push({
        ...responsePart,
        functionResponse: {
          ...responsePart.functionResponse,
          name: call.name,
          ...(call.id ? { id: call.id } : {}),
        },
      });
    }

    const nonCallParts = parts.filter((part) => !part?.functionCall);
    const modelParts = [...nonCallParts, ...keptCalls];
    if (modelParts.length > 0) sanitized.push({ ...content, parts: modelParts });

    if (next?.role === "user") {
      const nonResponseParts = nextParts.filter((part) => !part?.functionResponse);
      const unmatchedResponses = responses.flatMap((part, responseIndex) => usedResponses.has(responseIndex)
        ? []
        : [{ text: `[unpaired tool result: ${part.functionResponse?.name || "tool"}]\n${geminiFunctionResultText(part)}` }]);
      const userParts = [...keptResponses, ...unmatchedResponses, ...nonResponseParts];
      if (userParts.length > 0) sanitized.push({ ...next, parts: userParts });
      index += 1;
    }
  }

  return sanitized.length ? sanitized : [{ role: "user", parts: [{ text: "Continue." }] }];
}

export function buildGeminiContents(input, calls) {
  const items = asArray(input);
  calls?.requireContinuation?.(items, "geminiContents");
  const historyCalls = new Map();
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    if (item.type !== "function_call" && item.type !== "custom_tool_call") continue;
    if (!item.call_id) continue;
    const known = calls?.get(item.call_id);
    historyCalls.set(item.call_id, {
      name: known?.name || item.name || "tool",
      arguments: known?.arguments || parseJsonSafe(item.arguments || item.input),
      geminiFunctionCallPart: known?.geminiFunctionCallPart,
    });
  }
  const lookupCall = (callId) => calls?.get(callId) || historyCalls.get(callId);
  const hasOnlyToolResults = items.length > 0 && items.every((i) => i && (i.type === "function_call_output" || i.type === "custom_tool_call_output"));
  const replayBase = hasOnlyToolResults
    ? items.map((item) => lookupCall(item.call_id)).find((known) => known?.geminiContents)
    : null;
  if (replayBase) {
    const contents = structuredClone(replayBase.geminiContents);
    const callParts = [];
    const responseParts = [];
    const emittedCallIds = new Set();
    for (const item of items) {
      const known = lookupCall(item.call_id);
      if (!known && !item.name) {
        const output = outputParts(item.output);
        responseParts.push(
          { text: `[tool result without matching function call: ${item.call_id || "call_unknown"}]\n${output.text}` },
          ...output.images.map(geminiImagePart),
        );
        continue;
      }
      const callId = item.call_id;
      const name = known?.name || item.name || "tool";
      if (!emittedCallIds.has(callId)) {
        const callPart = known?.geminiFunctionCallPart
          ? structuredClone(known.geminiFunctionCallPart)
          : { functionCall: { name, args: known?.arguments || {} } };
        if (callPart.functionCall && callId) callPart.functionCall.id = callId;
        callParts.push(callPart);
        emittedCallIds.add(callId);
      }
      responseParts.push(...geminiOutputParts(item.output, name, callId));
    }
    if (callParts.length > 0) contents.push({ role: "model", parts: callParts });
    if (responseParts.length > 0) contents.push({ role: "user", parts: responseParts });
    return contents;
  }

  const contents = [];
  let currentRole = null;
  let currentParts = [];

  function flush() {
    if (currentRole && currentParts.length > 0) {
      contents.push({ role: currentRole, parts: currentParts });
      currentRole = null;
      currentParts = [];
    }
  }

  for (const item of items) {
    if (!item) continue;
    if (typeof item === "string") {
      if (currentRole && currentRole !== "user") flush();
      currentRole = "user";
      currentParts.push({ text: safeTextValue(item) });
      continue;
    }
    if (typeof item !== "object") continue;
    if (item.type && KNOWN_METADATA_TYPES.has(item.type)) continue;

    if (item.type === "message" || item.role) {
      const role = item.role === "assistant" ? "model" : "user";
      if (currentRole && currentRole !== role) flush();
      currentRole = role;
      const rawParts = Array.isArray(item.content) ? item.content : [item.content];
      for (const part of rawParts) {
        if (!part) continue;
        if (typeof part === "string") {
          currentParts.push({ text: safeTextValue(part) });
        } else if (part.type === "input_text" || part.type === "output_text" || part.type === "text") {
          if (part.text) currentParts.push({ text: safeTextValue(part.text) });
        } else {
          const image = imageFromPart(part);
          if (image) currentParts.push(geminiImagePart(image));
          else {
            const attachment = attachmentFromPart(part);
            if (attachment) {
              const nativePart = geminiFilePart(attachment.native);
              currentParts.push(nativePart || { text: attachment.marker });
            }
          }
        }
      }
      continue;
    }

    if (item.type === "function_call" || item.type === "custom_tool_call") {
      if (currentRole && currentRole !== "model") flush();
      currentRole = "model";
      const known = lookupCall(item.call_id);
      if (known?.geminiFunctionCallPart) {
        currentParts.push(structuredClone(known.geminiFunctionCallPart));
      } else {
        const name = known?.name || item.name || "tool";
        const args = known?.arguments || parseJsonSafe(item.arguments || item.input);
        currentParts.push({
          functionCall: {
            name,
            args: typeof args === "object" && args !== null ? args : { value: args },
            ...(item.call_id ? { id: item.call_id } : {}),
          },
        });
      }
      continue;
    }

    if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
      if (currentRole && currentRole !== "user") flush();
      currentRole = "user";
      const known = lookupCall(item.call_id);
      if (!known && !item.name) {
        const output = outputParts(item.output);
        currentParts.push(
          { text: `[tool result without matching function call: ${item.call_id || "call_unknown"}]\n${output.text}` },
          ...output.images.map(geminiImagePart),
        );
        continue;
      }
      const name = known?.name || item.name || "tool";
      currentParts.push(...geminiOutputParts(item.output, name, item.call_id));
    }
  }

  flush();
  return contents.length ? contents : [{ role: "user", parts: [{ text: "Continue." }] }];
}

export function geminiRequest(request, model, calls) {
  const functions = extractFunctions(request);
  const contents = sanitizeGeminiFunctionHistory(buildGeminiContents(request.input, calls));
  const body = { contents };
  if (request.instructions) body.systemInstruction = { parts: [{ text: safeTextValue(String(request.instructions)) }] };
  if (functions.length) body.tools = [{ functionDeclarations: functions.map(({ name, description, parameters }) => ({ name, description, parameters })) }];
  const rawEffort = request.reasoning_effort || request.model_reasoning_effort || request.reasoning?.effort;
  if (rawEffort) {
    const level = GEMINI_REASONING_MAP[String(rawEffort).toLowerCase()];
    if (level) {
      body.generationConfig = {
        ...(body.generationConfig || {}),
        thinkingConfig: { thinkingLevel: level },
      };
    }
  }
  return { body, functions };
}

export function geminiUsage(usage) {
  if (!usage || typeof usage !== "object") return undefined;
  const inputTokens = Number(usage.promptTokenCount || 0);
  const outputTokens = Number(usage.candidatesTokenCount || 0);
  const totalTokens = Number(usage.totalTokenCount || inputTokens + outputTokens);
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: totalTokens,
    input_tokens_details: { cached_tokens: Number(usage.cachedContentTokenCount || 0) },
    output_tokens_details: { reasoning_tokens: Number(usage.thoughtsTokenCount || 0) },
  };
}
