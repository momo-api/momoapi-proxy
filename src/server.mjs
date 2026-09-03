import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { extractFunctions, parseDsmlCalls, restoreToolName, stripDsmlMarkup } from "./tools.mjs";
import {
  rewriteRoutedNamespaceToolsForUpstream,
  rewriteRoutedCustomToolsForUpstream,
  restoreAllRoutedCallsInJson,
} from "./responses-compat.mjs";
import { ResponseStreamEmitter, completed, customToolEvents, functionEvents, parseSse, responseCreated, sseError, textEvents } from "./responses-sse.mjs";
import { logRequest } from "./logger.mjs";

const GEMINI_PREFIX = /^gemini-/;
const CLAUDE_PREFIX = /^claude-/;
const ALLOWED_CONTENT_TYPES = new Set(["input_text", "output_text", "input_image", "input_file"]);
const KNOWN_METADATA_TYPES = new Set([
  "session_meta", "event_msg", "task_started", "world_state", "turn_context",
  "item_completed", "token_count", "web_search_call", "task_complete",
  "thread_settings_applied", "compacted", "turn_aborted", "inter_agent_communication_metadata",
  "agent_message"
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

function json(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

async function bodyOf(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new Error("Request body must be valid JSON."); }
}

function authorized(request, settings) {
  const auth = request.headers.authorization;
  if (auth && auth === "Bearer " + settings.localToken) return true;
  if (auth && auth === "Bearer " + settings.apiKey) return true;
  if (auth && auth === "Bearer momo-local-key") return true;
  if (auth && auth !== "Bearer " + settings.localToken) return false;
  
  // When requires_openai_auth = false without env_key, Codex connects to loopback without Authorization header
  const remote = request.socket?.remoteAddress;
  const isLoopback = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
  if (settings.host === "127.0.0.1" && isLoopback) return true;
  return false;
}

function upstreamHeaders(settings, contentType = "application/json") {
  return { authorization: "Bearer " + settings.apiKey, "content-type": contentType };
}

function resolveTargetModel(model) {
  if (GEMINI_PREFIX.test(model)) return { targetModel: model, protocol: "gemini" };
  if (CLAUDE_PREFIX.test(model)) return { targetModel: model, protocol: "claude" };
  return { targetModel: model, protocol: "responses" };
}

function customInput(value) {
  if (typeof value === "string") return value;
  if (typeof value?.input === "string") return value.input;
  if (typeof value?.patch === "string") return value.patch;
  return JSON.stringify(value ?? "");
}

function parseJsonSafe(value, fallback = {}) {
  if (typeof value === "object" && value !== null) return value;
  if (typeof value === "string") {
    try { return JSON.parse(value); } catch { return { raw: value }; }
  }
  return fallback;
}

export function buildClaudeMessages(input, calls) {
  const items = asArray(input);
  const hasOnlyToolResults = items.length > 0 && items.every((i) => i && (i.type === "function_call_output" || i.type === "custom_tool_call_output"));
  const firstCallId = hasOnlyToolResults ? items[0].call_id : null;
  const knownFirst = firstCallId ? calls?.get(firstCallId) : null;

  if (hasOnlyToolResults && knownFirst?.claudeMessages) {
    const messages = structuredClone(knownFirst.claudeMessages);
    const assistantContent = [];
    if (knownFirst.toolUseBlock) {
      assistantContent.push(structuredClone(knownFirst.toolUseBlock));
    } else {
      assistantContent.push({
        type: "tool_use",
        id: firstCallId,
        name: knownFirst.name || "tool",
        input: knownFirst.arguments || {},
      });
    }
    messages.push({ role: "assistant", content: assistantContent });
    messages.push({
      role: "user",
      content: items.map((item) => ({
        type: "tool_result",
        tool_use_id: item.call_id || firstCallId,
        content: typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? ""),
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
      currentContent.push({ type: "text", text: item });
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
          currentContent.push({ type: "text", text: part });
        } else if (part.type === "input_text" || part.type === "output_text" || part.type === "text") {
          if (part.text) currentContent.push({ type: "text", text: part.text });
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
      const textOutput = typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? "");
      currentContent.push({
        type: "tool_result",
        tool_use_id: item.call_id || "call_unknown",
        content: textOutput,
      });
      continue;
    }
  }

  flush();
  return messages.length ? messages : [{ role: "user", content: "Continue." }];
}

export function buildGeminiContents(input, calls) {
  const items = asArray(input);
  const hasOnlyToolResults = items.length > 0 && items.every((i) => i && (i.type === "function_call_output" || i.type === "custom_tool_call_output"));
  const firstCallId = hasOnlyToolResults ? items[0].call_id : null;
  const knownFirst = firstCallId ? calls?.get(firstCallId) : null;

  if (hasOnlyToolResults && knownFirst?.geminiContents) {
    const contents = structuredClone(knownFirst.geminiContents);
    if (knownFirst.geminiFunctionCallPart) {
      contents.push({ role: "model", parts: [structuredClone(knownFirst.geminiFunctionCallPart)] });
    } else {
      contents.push({
        role: "model",
        parts: [{ functionCall: { name: knownFirst.name || "tool", args: knownFirst.arguments || {} } }],
      });
    }
    contents.push({
      role: "user",
      parts: items.map((item) => ({
        functionResponse: {
          name: knownFirst.name || item.name || "tool",
          response: { result: typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? "") },
        },
      })),
    });
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
      currentParts.push({ text: item });
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
          currentParts.push({ text: part });
        } else if (part.type === "input_text" || part.type === "output_text" || part.type === "text") {
          if (part.text) currentParts.push({ text: part.text });
        }
      }
      continue;
    }

    if (item.type === "function_call" || item.type === "custom_tool_call") {
      if (currentRole && currentRole !== "model") flush();
      currentRole = "model";
      const known = calls?.get(item.call_id);
      if (known?.geminiFunctionCallPart) {
        currentParts.push(structuredClone(known.geminiFunctionCallPart));
      } else {
        const name = known?.name || item.name || "tool";
        const args = known?.arguments || parseJsonSafe(item.arguments || item.input);
        currentParts.push({
          functionCall: {
            name,
            args: typeof args === "object" && args !== null ? args : { value: args },
          },
        });
      }
      continue;
    }

    if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
      if (currentRole && currentRole !== "user") flush();
      currentRole = "user";
      const known = calls?.get(item.call_id);
      const name = known?.name || item.name || "tool";
      const textOutput = typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? "");
      currentParts.push({
        functionResponse: {
          name,
          response: { result: textOutput },
        },
      });
      continue;
    }
  }

  flush();
  return contents.length ? contents : [{ role: "user", parts: [{ text: "Continue." }] }];
}

function geminiRequest(request, model, calls) {
  const functions = extractFunctions(request);
  const contents = buildGeminiContents(request.input, calls);
  const body = { contents };
  if (request.instructions) body.systemInstruction = { parts: [{ text: String(request.instructions) }] };
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

function claudeRequest(request, model, calls) {
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
      ...(request.instructions ? { system: String(request.instructions) } : {}),
      messages,
      ...(functions.length ? { tools: functions.map(({ name, description, parameters }) => ({ name, description, input_schema: parameters })) } : {}),
      ...(isThinkingModel ? { thinking: { type: "enabled", budget_tokens: budget } } : {}),
    },
    functions,
  };
}

function writeSse(response, chunks) {
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "x-accel-buffering": "no" });
  for (const chunk of chunks) response.write(chunk);
  response.end();
}

async function* streamSseLines(body) {
  if (!body) return;
  if (typeof body === "string") {
    for (const data of parseSse(body)) yield data;
    return;
  }
  let buffer = "";
  for await (const chunk of body) {
    buffer += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = blocks.pop() || "";
    for (const block of blocks) {
      const dataLine = block.split(/\r?\n/).find((l) => l.startsWith("data:"));
      if (!dataLine) continue;
      const jsonStr = dataLine.slice(5).trim();
      if (!jsonStr || jsonStr === "[DONE]") continue;
      try { yield JSON.parse(jsonStr); } catch {}
    }
  }
  if (buffer.trim()) {
    const dataLine = buffer.split(/\r?\n/).find((l) => l.startsWith("data:"));
    if (dataLine) {
      const jsonStr = dataLine.slice(5).trim();
      if (jsonStr && jsonStr !== "[DONE]") {
        try { yield JSON.parse(jsonStr); } catch {}
      }
    }
  }
}

function initSseResponse(response) {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    "connection": "keep-alive",
    "x-accel-buffering": "no"
  });
}

export function normalizeResponsesPayload(payload) {
  const normalized = { ...payload };
  const rawInput = Array.isArray(normalized.input) ? normalized.input : [];
  const cleanInput = [];

  for (const item of rawInput) {
    if (!item) continue;
    if (typeof item === "string") {
      cleanInput.push({
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: item }],
      });
      continue;
    }
    if (typeof item !== "object") continue;

    if (item.type === "additional_tools") {
      cleanInput.push({
        type: "additional_tools",
        tools: Array.isArray(item.tools) ? item.tools : [],
      });
      continue;
    }

    if (item.type === "reasoning") {
      cleanInput.push({
        type: "reasoning",
        ...(item.id ? { id: item.id } : {}),
        summary: Array.isArray(item.summary) ? item.summary : [],
        content: [],
      });
      continue;
    }

    if (item.type && KNOWN_METADATA_TYPES.has(item.type)) continue;

    if (item.type === "input_text") {
      cleanInput.push({
        type: "message",
        role: "user",
        content: [item],
      });
      continue;
    }

    if (item.type === "function_call_output") {
      cleanInput.push({
        type: "function_call_output",
        call_id: item.call_id || "call_unknown",
        output: typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? ""),
      });
      continue;
    }

    if (item.type === "custom_tool_call_output") {
      cleanInput.push({
        type: "custom_tool_call_output",
        call_id: item.call_id || "call_unknown",
        output: typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? ""),
      });
      continue;
    }

    if (item.type === "function_call") {
      cleanInput.push({
        type: "function_call",
        call_id: item.call_id || "call_unknown",
        name: item.name || "unknown",
        arguments: typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments ?? {}),
      });
      continue;
    }

    if (item.type === "custom_tool_call") {
      cleanInput.push({
        type: "custom_tool_call",
        call_id: item.call_id || "call_unknown",
        name: item.name || "unknown",
        input: typeof item.input === "string" ? item.input : JSON.stringify(item.input ?? ""),
      });
      continue;
    }

    const role = item.role || (item.type === "message" ? "user" : null);
    if (role) {
      let content = [];
      if (typeof item.content === "string") {
        const contentType = role === "assistant" ? "output_text" : "input_text";
        content = [{ type: contentType, text: item.content }];
      } else if (Array.isArray(item.content)) {
        for (const part of item.content) {
          if (!part) continue;
          if (typeof part === "string") {
            const contentType = role === "assistant" ? "output_text" : "input_text";
            content.push({ type: contentType, text: part });
          } else if (typeof part === "object") {
            if (ALLOWED_CONTENT_TYPES.has(part.type)) {
              content.push(part);
            } else if (part.text && !part.type) {
              const contentType = role === "assistant" ? "output_text" : "input_text";
              content.push({ type: contentType, text: part.text });
            }
          }
        }
      }

      if (content.length === 0 && role === "assistant") {
        content = [{ type: "output_text", text: "" }];
      }

      if (content.length > 0) {
        cleanInput.push({
          type: "message",
          role,
          content,
        });
      }
      continue;
    }
  }

  normalized.input = cleanInput;

  if (Array.isArray(payload.tools) && payload.tools.length > 0) {
    normalized.tools = payload.tools;
  } else {
    const functions = extractFunctions(payload);
    if (functions.length) {
      normalized.tools = functions.map(({ name, description, parameters }) => ({
        type: "function",
        name,
        description,
        parameters,
      }));
    }
  }

  const rawEffort = normalized.reasoning_effort || normalized.model_reasoning_effort || normalized.reasoning?.effort;
  if (rawEffort) {
    let effort = String(rawEffort).toLowerCase();
    if (effort === "ultra") effort = "xhigh";
    normalized.reasoning = { effort };
    delete normalized.reasoning_effort;
    delete normalized.model_reasoning_effort;
  }
  return normalized;
}

async function forwardResponses(request, response, settings, payload, fetchImpl, signal) {
  // 1. Lower custom tools (exec, etc.) to standard functions
  const { body: customBody, names: customNames } = rewriteRoutedCustomToolsForUpstream(payload);
  // 2. Lower namespace tools (e.g. personal:codex-canvas) to flat functions
  const { body: nsBody, aliases: nsAliases } = rewriteRoutedNamespaceToolsForUpstream(customBody);
  // 3. Normalize schema for upstream OpenAI Responses endpoint
  const cleanPayload = normalizeResponsesPayload(nsBody);
  const upstream = await fetchImpl(settings.endpoint + "/v1/responses", { method: "POST", headers: upstreamHeaders(settings), body: JSON.stringify({ ...cleanPayload, stream: true }), signal });
  if (!upstream.ok) {
    const errText = await upstream.text();
    let errMessage = errText;
    try {
      const parsed = JSON.parse(errText);
      errMessage = parsed.error?.message || parsed.message || errText;
    } catch {}
    initSseResponse(response);
    const respId = "resp_err_" + randomUUID();
    response.write(responseCreated(cleanPayload.model, respId).data);
    for (const ev of textEvents(respId, 0, "\n\n[MOMO API Error " + upstream.status + "]: " + errMessage)) {
      response.write(ev);
    }
    response.write(sseError(errMessage, "http_" + upstream.status));
   response.write(completed(respId, cleanPayload.model, []));
   response.end();
   return;
 }
 initSseResponse(response);
 if (!upstream.body) return response.end();

 const functions = extractFunctions(payload);
 let hasDsml = false;
 let fullAccumulatedText = "";
 let currentResponseId = "resp_" + randomUUID();
 let outputIndex = 0;
  let buffer = "";

  for await (const chunk of upstream.body) {
    const textChunk = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    buffer += textChunk;
    const blocks = buffer.split("\n\n");
    buffer = blocks.pop() || "";

    for (const block of blocks) {
      if (!block.trim()) continue;
      const lines = block.split("\n");
      const dataLine = lines.find((l) => l.trim().startsWith("data:"));
      let json = null;
      let rawJsonStr = null;
      if (dataLine) {
        rawJsonStr = dataLine.trim().slice(5).trim();
        const jsonStr = rawJsonStr;
        if (jsonStr && jsonStr !== "[DONE]") {
          try { json = JSON.parse(jsonStr); } catch {}
        }
      }

      if (json) {
        if (json.type === "response.created" && json.response?.id) {
          currentResponseId = json.response.id;
        }
        if (json.type === "response.output_text.delta" && typeof json.delta === "string") {
          fullAccumulatedText += json.delta;
          if (fullAccumulatedText.includes("<｜｜DSML｜｜") || fullAccumulatedText.includes("<||DSML||") || fullAccumulatedText.includes("<tool_calls>") || fullAccumulatedText.includes("<invoke ")) {
            hasDsml = true;
            continue;
          }
        }
        if (json.type === "response.completed" && hasDsml) {
          const dsmlCalls = parseDsmlCalls(fullAccumulatedText);
          const cleanText = stripDsmlMarkup(fullAccumulatedText).trim();
          const emitter = new ResponseStreamEmitter(response, cleanPayload.model, currentResponseId);
          if (cleanText) {
            emitter.writeTextDelta(cleanText);
            emitter.flushTextMessage();
          }
          for (const call of dsmlCalls) {
            const mapped = restoreToolName(call.name, functions);
            if (mapped.kind === "custom") {
              emitter.writeCustomToolCall({ name: mapped.originalName, input: customInput(call.arguments) });
            } else {
              emitter.writeFunctionCall({ name: mapped.originalName, arguments: call.arguments || {} });
            }
          }
          emitter.complete();
          return;
        }

        if (!hasDsml && rawJsonStr) {
          const restoredJsonStr = restoreAllRoutedCallsInJson(rawJsonStr, nsAliases, customNames);
          if (restoredJsonStr !== rawJsonStr) {
            const rewrittenLines = lines.map((l) => l.trim().startsWith("data:") ? "data: " + restoredJsonStr : l);
            response.write(rewrittenLines.join("\n") + "\n\n");
            continue;
          }
        }
      }

      if (!hasDsml) {
        response.write(block + "\n\n");
      }
    }
  }
  if (buffer.trim() && !hasDsml) {
    response.write(buffer);
  }
  response.end();
}

async function bridgeGemini(response, settings, payload, calls, fetchImpl, signal) {
  const { body, functions } = geminiRequest(payload, payload.model, calls);
  const endpoint = settings.endpoint + "/v1beta/models/" + encodeURIComponent(payload.model) + ":streamGenerateContent?alt=sse";
  const upstream = await fetchImpl(endpoint, { method: "POST", headers: upstreamHeaders(settings), body: JSON.stringify(body), signal });
  if (!upstream.ok) {
    const errText = await upstream.text();
    let errMessage = errText;
    try {
      const parsed = JSON.parse(errText);
      errMessage = parsed.error?.message || parsed.message || errText;
    } catch {}
    initSseResponse(response);
    const respId = "resp_err_" + randomUUID();
    response.write(responseCreated(payload.model, respId).data);
    for (const ev of textEvents(respId, 0, "\n\n[MOMO Gemini Error " + upstream.status + "]: " + errMessage)) {
      response.write(ev);
    }
    response.write(sseError(errMessage, "http_" + upstream.status));
    response.write(completed(respId, payload.model, []));
    return response.end();
  }
  initSseResponse(response);
  const emitter = new ResponseStreamEmitter(response, payload.model);
  emitter.start();

  for await (const data of streamSseLines(upstream.body || (await upstream.text()))) {
    for (const part of data?.candidates?.[0]?.content?.parts || []) {
      if (part.text) {
        emitter.writeTextDelta(part.text);
      }
      if (part.functionCall) {
        const mapped = restoreToolName(part.functionCall.name, functions);
        const tool = mapped.kind === "custom"
          ? emitter.writeCustomToolCall({ name: mapped.originalName, input: customInput(part.functionCall.args) })
          : emitter.writeFunctionCall({ name: mapped.originalName, arguments: part.functionCall.args || {} });
        calls.set(tool.callId, {
          name: mapped.name,
          originalName: mapped.originalName,
          kind: mapped.kind,
          arguments: part.functionCall.args || {},
          geminiContents: body.contents,
          geminiFunctionCallPart: structuredClone(part),
        });
      }
    }
  }
  emitter.complete();
}

async function bridgeClaude(response, settings, payload, calls, fetchImpl, signal) {
  const { body, functions } = claudeRequest(payload, payload.model, calls);
  const upstream = await fetchImpl(settings.endpoint + "/v1/messages", { method: "POST", headers: { ...upstreamHeaders(settings), "anthropic-version": "2023-06-01" }, body: JSON.stringify(body), signal });
  if (!upstream.ok) {
    const errText = await upstream.text();
    let errMessage = errText;
    try {
      const parsed = JSON.parse(errText);
      errMessage = parsed.error?.message || parsed.message || errText;
    } catch {}
    initSseResponse(response);
    const respId = "resp_err_" + randomUUID();
    response.write(responseCreated(payload.model, respId).data);
    for (const ev of textEvents(respId, 0, "\n\n[MOMO Claude Error " + upstream.status + "]: " + errMessage)) {
      response.write(ev);
    }
    response.write(sseError(errMessage, "http_" + upstream.status));
    response.write(completed(respId, payload.model, []));
    return response.end();
  }
  initSseResponse(response);
  const emitter = new ResponseStreamEmitter(response, payload.model);
  emitter.start();

  const toolBlocks = new Map();
  for await (const data of streamSseLines(upstream.body || (await upstream.text()))) {
    if (data.type === "content_block_delta" && data.delta?.type === "text_delta") {
      emitter.writeTextDelta(data.delta.text);
    }
    if (data.type === "content_block_start" && data.content_block?.type === "tool_use") {
      toolBlocks.set(data.index, { id: data.content_block.id, name: data.content_block.name, input: data.content_block.input || {}, partialJson: "" });
    }
    if (data.type === "content_block_delta" && data.delta?.type === "input_json_delta") {
      const block = toolBlocks.get(data.index);
      if (block) block.partialJson += data.delta.partial_json || "";
    }
    if (data.type === "content_block_stop" && toolBlocks.has(data.index)) {
      const block = toolBlocks.get(data.index);
      toolBlocks.delete(data.index);
      let argumentsValue = block.input;
      if (block.partialJson) {
        try { argumentsValue = JSON.parse(block.partialJson); } catch { argumentsValue = block.partialJson; }
      }
      const mapped = restoreToolName(block.name, functions);
      const tool = mapped.kind === "custom"
        ? emitter.writeCustomToolCall({ callId: block.id, name: mapped.originalName, input: customInput(argumentsValue) })
        : emitter.writeFunctionCall({ callId: block.id, name: mapped.originalName, arguments: argumentsValue });
      calls.set(tool.callId, {
        name: mapped.name,
        originalName: mapped.originalName,
        kind: mapped.kind,
        arguments: argumentsValue,
        claudeMessages: body.messages,
        toolUseBlock: { type: "tool_use", id: block.id, name: block.name, input: argumentsValue },
      });
    }
  }
  emitter.complete();
}

export function createMomoSwitch(settings, { fetchImpl = fetch } = {}) {
  const calls = new Map();
  return createServer(async (request, response) => {
    const t0 = Date.now();
    const abortController = new AbortController();
    const remoteIp = request.socket?.remoteAddress || "";
    let requestedModel = null;
    let finalStatus = 200;
    response.on("close", () => {
      if (!response.writableEnded) abortController.abort();
    });
    try {
      if (request.method === "GET" && request.url === "/healthz") {
        logRequest({ method: "GET", url: "/healthz", status: 200, elapsedMs: Date.now() - t0, ip: remoteIp });
        return json(response, 200, { ok: true, service: "momo-codex-bridge", version: "0.6.4", host: settings.host, port: settings.port });
      }
      if (!authorized(request, settings)) {
        finalStatus = 401;
        logRequest({ method: request.method, url: request.url, status: 401, elapsedMs: Date.now() - t0, error: "Unauthorized", ip: remoteIp });
        return json(response, 401, { error: { message: "Invalid local MOMO Switch token.", type: "authentication_error" } });
      }
      if (request.method === "GET" && request.url === "/v1/models") {
        const upstream = await fetchImpl(settings.endpoint + "/v1/models", { headers: upstreamHeaders(settings), signal: abortController.signal });
        finalStatus = upstream.status;
        logRequest({ method: "GET", url: "/v1/models", status: finalStatus, elapsedMs: Date.now() - t0, ip: remoteIp });
        return json(response, upstream.status, await upstream.json());
      }
      if (request.method === "POST" && request.url === "/v1/responses") {
        const payload = await bodyOf(request);
        requestedModel = payload.model;
        if (!payload.model) {
          finalStatus = 400;
          logRequest({ method: "POST", url: "/v1/responses", status: 400, elapsedMs: Date.now() - t0, error: "model is required", ip: remoteIp });
          return json(response, 400, { error: { message: "model is required", type: "invalid_request_error" } });
        }
        const { targetModel, protocol } = resolveTargetModel(payload.model);
        const routedPayload = { ...payload, model: targetModel };
        
        let handlerPromise;
        if (protocol === "responses") handlerPromise = forwardResponses(request, response, settings, routedPayload, fetchImpl, abortController.signal);
        else if (protocol === "gemini") handlerPromise = bridgeGemini(response, settings, routedPayload, calls, fetchImpl, abortController.signal);
        else handlerPromise = bridgeClaude(response, settings, routedPayload, calls, fetchImpl, abortController.signal);

        await handlerPromise;
        logRequest({ method: "POST", url: "/v1/responses", model: requestedModel, status: response.statusCode || 200, elapsedMs: Date.now() - t0, ip: remoteIp });
        return;
      }
      finalStatus = 404;
      logRequest({ method: request.method, url: request.url, status: 404, elapsedMs: Date.now() - t0, ip: remoteIp });
      return json(response, 404, { error: { message: "Not found", type: "invalid_request_error" } });
    } catch (error) {
      if (abortController.signal.aborted) return;
      logRequest({ method: request.method, url: request.url, model: requestedModel, status: 502, elapsedMs: Date.now() - t0, error: error.message, ip: remoteIp });
      if (request.url === "/v1/responses") {
        if (!response.headersSent) initSseResponse(response);
        const respId = "resp_err_" + randomUUID();
        response.write(responseCreated(requestedModel || "unknown", respId).data);
        for (const ev of textEvents(respId, 0, "\n\n[MOMO Proxy Error]: " + error.message)) {
          response.write(ev);
        }
        response.write(sseError(error.message));
        response.write(completed(respId, requestedModel || "unknown", []));
        return response.end();
      }
      return json(response, 502, { error: { message: error.message, type: "server_error" } });
    }
  });
}

export const createMomoBridge = createMomoSwitch;

export async function listen(settings, options = {}) {
  const server = createMomoSwitch(settings, options);
  await new Promise((resolve, reject) => server.once("error", reject).listen(settings.port, settings.host, resolve));
  return server;
}
