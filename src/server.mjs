import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { extractFunctions, restoreToolName } from "./tools.mjs";
import { completed, customToolEvents, functionEvents, parseSse, responseCreated, sseError, textEvents } from "./responses-sse.mjs";
import { logRequest } from "./logger.mjs";

const GEMINI_PREFIX = /^gemini-/;
const CLAUDE_PREFIX = /^claude-/;

const DESKTOP_MODEL_MAP = {
  "gpt-5.6-sol": { targetModel: "deepseek-v4-pro", protocol: "responses" },
  "gpt-5.6-terra": { targetModel: "claude-opus-4-6-thinking", protocol: "claude" },
  "gpt-5.6-luna": { targetModel: "gemini-3.7-flash", protocol: "gemini" },
};

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
  if (auth && auth === `Bearer ${settings.localToken}`) return true;
  if (auth && auth === `Bearer ${settings.apiKey}`) return true;
  if (auth && auth === "Bearer momo-local-key") return true;
  if (auth && auth !== `Bearer ${settings.localToken}`) return false;
  
  // When requires_openai_auth = false without env_key, Codex connects to loopback without Authorization header
  const remote = request.socket?.remoteAddress;
  const isLoopback = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
  if (settings.host === "127.0.0.1" && isLoopback) return true;
  return false;
}

function upstreamHeaders(settings, contentType = "application/json") {
  return { authorization: `Bearer ${settings.apiKey}`, "content-type": contentType };
}

function resolveTargetModel(model) {
  const mapped = DESKTOP_MODEL_MAP[model];
  if (mapped) return { targetModel: mapped.targetModel, protocol: mapped.protocol };
  if (GEMINI_PREFIX.test(model)) return { targetModel: model, protocol: "gemini" };
  if (CLAUDE_PREFIX.test(model)) return { targetModel: model, protocol: "claude" };
  return { targetModel: model, protocol: "responses" };
}

function responseInputText(input) {
  return (Array.isArray(input) ? input : []).flatMap((item) => {
    if (typeof item === "string") return [item];
    if (item?.type === "function_call_output" || item?.type === "custom_tool_call_output") return [];
    const content = Array.isArray(item?.content) ? item.content : [];
    return content.map((part) => part?.text || part?.input_text || "").filter(Boolean);
  }).join("\n");
}

function toolResultsFrom(input) {
  return asArray(input).filter((item) => item?.type === "function_call_output" || item?.type === "custom_tool_call_output");
}

function customInput(value) {
  if (typeof value === "string") return value;
  if (typeof value?.input === "string") return value.input;
  if (typeof value?.patch === "string") return value.patch;
  return JSON.stringify(value ?? "");
}

function geminiRequest(request, model, calls) {
  const functions = extractFunctions(request);
  const toolResults = toolResultsFrom(request.input);
  const firstKnownCall = toolResults.length ? calls.get(toolResults[0].call_id) : null;
  const content = firstKnownCall?.geminiContents ? structuredClone(firstKnownCall.geminiContents) : [];
  const prompt = responseInputText(request.input);
  if (prompt) content.push({ role: "user", parts: [{ text: prompt }] });
  if (toolResults.length) {
    const functionCalls = toolResults.map((item) => {
      const known = calls.get(item.call_id) || { name: item.name || "tool", arguments: {} };
      return known.geminiFunctionCallPart
        ? structuredClone(known.geminiFunctionCallPart)
        : { functionCall: { name: known.name, args: known.arguments || {} } };
    });
    content.push({ role: "model", parts: functionCalls });
  }
  for (const item of toolResults) {
    const known = calls.get(item.call_id) || { name: item.name || "tool" };
    content.push({ role: "user", parts: [{ functionResponse: { name: known.name, response: { result: typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? "") } } }] });
  }
  const body = { contents: content.length ? content : [{ role: "user", parts: [{ text: "Continue." }] }] };
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
  const toolResults = toolResultsFrom(request.input);
  const firstKnownCall = toolResults.length ? calls.get(toolResults[0].call_id) : null;
  const messages = firstKnownCall?.claudeMessages ? structuredClone(firstKnownCall.claudeMessages) : [];
  const prompt = responseInputText(request.input);
  if (prompt) messages.push({ role: "user", content: prompt });
  if (toolResults.length) {
    messages.push({
      role: "assistant",
      content: toolResults.map((item) => {
        const known = calls.get(item.call_id) || { name: item.name || "tool", arguments: {} };
        return { type: "tool_use", id: item.call_id, name: known.name, input: known.arguments || {} };
      }),
    });
    messages.push({
      role: "user",
      content: toolResults.map((item) => ({ type: "tool_result", tool_use_id: item.call_id, content: typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? "") })),
    });
  }
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
      messages: messages.length ? messages : [{ role: "user", content: "Continue." }],
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

function normalizeResponsesInput(input) {
  if (!Array.isArray(input)) return [];
  return input.map((item) => {
    if (typeof item === "string") {
      return {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: item }],
      };
    }
    if (item && typeof item === "object") {
      if (item.type === "input_text") {
        return {
          type: "message",
          role: "user",
          content: [item],
        };
      }
      if (item.role && item.content && !item.type) {
        return {
          type: "message",
          role: item.role,
          content: typeof item.content === "string"
            ? [{ type: "input_text", text: item.content }]
            : item.content,
        };
      }
      if (item.type === "message" && typeof item.content === "string") {
        return {
          ...item,
          content: [{ type: "input_text", text: item.content }],
        };
      }
    }
    return item;
  });
}

function normalizeResponsesPayload(payload) {
  const normalized = { ...payload };
  if (normalized.input) {
    normalized.input = normalizeResponsesInput(normalized.input);
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
  const cleanPayload = normalizeResponsesPayload(payload);
  const upstream = await fetchImpl(settings.endpoint + "/v1/responses", { method: "POST", headers: upstreamHeaders(settings), body: JSON.stringify({ ...cleanPayload, stream: true }), signal });
  if (!upstream.ok) {
    const errText = await upstream.text();
    response.writeHead(upstream.status, { "content-type": "application/json" });
    response.end(errText);
    return;
  }
  initSseResponse(response);
  if (!upstream.body) return response.end();
  for await (const chunk of upstream.body) response.write(chunk);
  response.end();
}

async function bridgeGemini(response, settings, payload, calls, fetchImpl, signal) {
  const { body, functions } = geminiRequest(payload, payload.model, calls);
  const endpoint = settings.endpoint + "/v1beta/models/" + encodeURIComponent(payload.model) + ":streamGenerateContent?alt=sse";
  const upstream = await fetchImpl(endpoint, { method: "POST", headers: upstreamHeaders(settings), body: JSON.stringify(body), signal });
  if (!upstream.ok) throw new Error(`Gemini upstream returned ${upstream.status}: ${(await upstream.text()).slice(0, 500)}`);
  initSseResponse(response);
  const created = responseCreated(payload.model);
  response.write(created.data);
  const output = [];
  let index = 0;
  for await (const data of streamSseLines(upstream.body || (await upstream.text()))) {
    for (const part of data?.candidates?.[0]?.content?.parts || []) {
      if (part.text) {
        for (const ev of textEvents(created.responseId, index++, part.text)) response.write(ev);
      }
      if (part.functionCall) {
        const mapped = restoreToolName(part.functionCall.name, functions);
        const tool = mapped.kind === "custom"
          ? customToolEvents(created.responseId, index++, { name: mapped.originalName, input: customInput(part.functionCall.args) })
          : functionEvents(created.responseId, index++, { name: mapped.originalName, arguments: part.functionCall.args || {} });
        calls.set(tool.callId, {
          name: mapped.name,
          originalName: mapped.originalName,
          kind: mapped.kind,
          arguments: part.functionCall.args || {},
          geminiContents: body.contents,
          geminiFunctionCallPart: structuredClone(part),
        });
        for (const ev of tool.events) response.write(ev);
        output.push(mapped.kind === "custom"
          ? { type: "custom_tool_call", call_id: tool.callId, name: mapped.originalName, input: customInput(part.functionCall.args) }
          : { type: "function_call", call_id: tool.callId, name: mapped.originalName });
      }
    }
  }
  response.write(completed(created.responseId, payload.model, output));
  response.end();
}

async function bridgeClaude(response, settings, payload, calls, fetchImpl, signal) {
  const { body, functions } = claudeRequest(payload, payload.model, calls);
  const upstream = await fetchImpl(settings.endpoint + "/v1/messages", { method: "POST", headers: { ...upstreamHeaders(settings), "anthropic-version": "2023-06-01" }, body: JSON.stringify(body), signal });
  if (!upstream.ok) throw new Error(`Claude upstream returned ${upstream.status}: ${(await upstream.text()).slice(0, 500)}`);
  initSseResponse(response);
  const created = responseCreated(payload.model);
  response.write(created.data);
  const output = [];
  const toolBlocks = new Map();
  let index = 0;
  for await (const data of streamSseLines(upstream.body || (await upstream.text()))) {
    if (data.type === "content_block_delta" && data.delta?.type === "text_delta") {
      for (const ev of textEvents(created.responseId, index++, data.delta.text)) response.write(ev);
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
        ? customToolEvents(created.responseId, index++, { callId: block.id, name: mapped.originalName, input: customInput(argumentsValue) })
        : functionEvents(created.responseId, index++, { callId: block.id, name: mapped.originalName, arguments: argumentsValue });
      calls.set(tool.callId, { name: mapped.name, originalName: mapped.originalName, kind: mapped.kind, arguments: argumentsValue, claudeMessages: body.messages });
      for (const ev of tool.events) response.write(ev);
      output.push(mapped.kind === "custom"
        ? { type: "custom_tool_call", call_id: tool.callId, name: mapped.originalName, input: customInput(argumentsValue) }
        : { type: "function_call", call_id: tool.callId, name: mapped.originalName });
    }
  }
  response.write(completed(created.responseId, payload.model, output));
  response.end();
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
        return json(response, 200, { ok: true, service: "momo-codex-bridge", version: "0.5.8", host: settings.host, port: settings.port });
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
      if (request.url === "/v1/responses") return response.writeHead(200, { "content-type": "text/event-stream" }).end(sseError(error.message));
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
