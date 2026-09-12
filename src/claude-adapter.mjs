import { randomUUID } from "node:crypto";
import { extractFunctions } from "./tools.mjs";
import { INLINE_DATA_URL, attachmentFromPart, imageFromPart, outputParts, safeTextValue } from "./protocol-content.mjs";

const KNOWN_METADATA_TYPES = new Set([
  "session_meta", "event_msg", "task_started", "world_state", "turn_context",
  "item_completed", "token_count", "web_search_call", "task_complete",
  "thread_settings_applied", "compacted", "turn_aborted", "inter_agent_communication_metadata",
  "agent_message",
]);

const CLAUDE_REASONING_BUDGETS = {
  minimal: 1024,
  low: 2048,
  medium: 4048,
  high: 8192,
  xhigh: 16384,
  max: 24576,
  ultra: 32768,
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

function claudeImagePart(image) {
  return {
    type: "image",
    source: image.kind === "url"
      ? { type: "url", url: image.url }
      : { type: "base64", media_type: image.mimeType, data: image.data },
  };
}

function claudeFilePart(file) {
  if (!file || typeof file !== "object" || typeof file.file_data !== "string") return null;
  const match = INLINE_DATA_URL.exec(file.file_data);
  if (!match || match[1].toLowerCase() !== "application/pdf") return null;
  return {
    type: "document",
    source: {
      type: "base64",
      media_type: match[1],
      data: match[2].replace(/[\r\n]/g, ""),
    },
    ...(typeof file.filename === "string" && file.filename ? { title: file.filename } : {}),
  };
}

function claudeToolResultContent(value) {
  const output = outputParts(value);
  const documents = output.files.map(claudeFilePart).filter(Boolean);
  if (output.images.length === 0 && documents.length === 0) return output.text;
  const safeText = output.responseText || (output.images.length ? "[image output attached]" : "");
  return [
    ...(safeText ? [{ type: "text", text: safeText }] : []),
    ...output.images.map(claudeImagePart),
    ...documents,
  ];
}

export function buildClaudeMessages(input, calls) {
  const items = asArray(input);
  calls?.requireContinuation?.(items, "claudeMessages");
  const hasOnlyToolResults = items.length > 0 && items.every((i) => i && (i.type === "function_call_output" || i.type === "custom_tool_call_output"));
  const firstCallId = hasOnlyToolResults ? items[0].call_id : null;
  const knownFirst = firstCallId ? calls?.get(firstCallId) : null;

  if (hasOnlyToolResults && knownFirst?.claudeMessages) {
    const messages = structuredClone(knownFirst.claudeMessages);
    const assistantContent = [];
    const seenCallIds = new Set();
    for (const item of items) {
      const callId = item.call_id || firstCallId;
      if (!callId || seenCallIds.has(callId)) continue;
      const known = calls?.get(callId);
      if (known?.toolUseBlock) {
        assistantContent.push(structuredClone(known.toolUseBlock));
      } else {
        assistantContent.push({
          type: "tool_use",
          id: callId,
          name: known?.name || item.name || "tool",
          input: known?.arguments || {},
        });
      }
      seenCallIds.add(callId);
    }
    messages.push({ role: "assistant", content: assistantContent });
    messages.push({
      role: "user",
      content: items.map((item) => ({
        type: "tool_result",
        tool_use_id: item.call_id || firstCallId,
        content: claudeToolResultContent(item.output),
      })),
    });
    return messages;
  }

  const messages = [];
  let currentRole = null;
  let currentContent = [];

  function flush() {
    if (currentRole && currentContent.length > 0) {
      messages.push({
        role: currentRole,
        content: currentContent.length === 1 && typeof currentContent[0] === "string"
          ? currentContent[0]
          : currentContent,
      });
      currentRole = null;
      currentContent = [];
    }
  }

  for (const item of items) {
    if (!item) continue;
    if (typeof item === "string") {
      if (currentRole && currentRole !== "user") flush();
      currentRole = "user";
      currentContent.push({ type: "text", text: safeTextValue(item) });
      continue;
    }
    if (typeof item !== "object") continue;
    if (item.type && KNOWN_METADATA_TYPES.has(item.type)) continue;

    if (item.type === "message" || item.role) {
      const role = item.role === "assistant" ? "assistant" : "user";
      if (currentRole && currentRole !== role) flush();
      currentRole = role;
      const rawParts = Array.isArray(item.content) ? item.content : [item.content];
      for (const part of rawParts) {
        if (!part) continue;
        if (typeof part === "string") {
          currentContent.push({ type: "text", text: safeTextValue(part) });
        } else if (part.type === "input_text" || part.type === "output_text" || part.type === "text") {
          if (part.text) currentContent.push({ type: "text", text: safeTextValue(part.text) });
        } else {
          const image = imageFromPart(part);
          if (image) {
            currentContent.push(claudeImagePart(image));
          } else {
            const attachment = attachmentFromPart(part);
            if (attachment) {
              const document = claudeFilePart(attachment.native);
              currentContent.push(document || { type: "text", text: attachment.marker });
            }
          }
        }
      }
      continue;
    }

    if (item.type === "function_call" || item.type === "custom_tool_call") {
      if (currentRole && currentRole !== "assistant") flush();
      currentRole = "assistant";
      const known = calls?.get(item.call_id);
      const name = known?.name || item.name || "tool";
      const args = known?.arguments || parseJsonSafe(item.arguments || item.input);
      currentContent.push({
        type: "tool_use",
        id: item.call_id || ("call_" + randomUUID()),
        name,
        input: typeof args === "object" && args !== null ? args : { value: args },
      });
      continue;
    }

    if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
      if (currentRole && currentRole !== "user") flush();
      currentRole = "user";
      currentContent.push({
        type: "tool_result",
        tool_use_id: item.call_id || "call_unknown",
        content: claudeToolResultContent(item.output),
      });
    }
  }

  flush();
  return messages.length ? messages : [{ role: "user", content: "Continue." }];
}

export function claudeRequest(request, model, calls) {
  const functions = extractFunctions(request);
  const messages = buildClaudeMessages(request.input, calls);
  const rawEffort = String(request.reasoning_effort || request.model_reasoning_effort || request.reasoning?.effort || "").toLowerCase();
  const isThinkingModel = model.includes("-thinking") || Boolean(rawEffort);
  const budget = CLAUDE_REASONING_BUDGETS[rawEffort] || 4048;
  const maxTokens = Math.max(8192, budget + 8192);

  return {
    body: {
      model,
      max_tokens: maxTokens,
      stream: true,
      ...(request.instructions ? { system: safeTextValue(String(request.instructions)) } : {}),
      messages,
      ...(functions.length ? { tools: functions.map(({ name, description, parameters }) => ({ name, description, input_schema: parameters })) } : {}),
      ...(isThinkingModel ? { thinking: { type: "enabled", budget_tokens: budget } } : {}),
    },
    functions,
  };
}
