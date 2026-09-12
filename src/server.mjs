import { createServer } from "node:http";
import { performance } from "node:perf_hooks";
import { RequestMetrics } from "./request-metrics.mjs";
import { RequestAdmission } from "./request-admission.mjs";
import { DsmlMarkerDetector } from "./incremental-stream-state.mjs";
import { BoundedCallCache, RetainedOutputBudget, budgetedOutputBody, resolveOutputPolicy, readBoundedOutputText } from "./output-budget.mjs";
import { bodyOf, requestReservationBytes } from "./request-body.mjs";
export { bodyOf, getMaxRequestBodyBytes } from "./request-body.mjs";
import { streamSseBlocks, sseDataPayload, replaceSseDataPayload, writeResponseChunk, forwardResponseBody } from "./stream-transport.mjs";
import { randomUUID } from "node:crypto";
import { extractFunctions, parseDsmlCalls, restoreToolName, stripDsmlMarkup } from "./tools.mjs";
import {
  rewriteRoutedNamespaceToolsForUpstream,
  rewriteRoutedCustomToolsForUpstream,
  rewriteRoutedToolSearchForUpstream,
  restoreAllRoutedCallsInJson,
  createRoutedCustomToolRestoreBlockRewrite,
} from "./responses-compat.mjs";
import { ResponseStreamEmitter, customToolEvents, functionEvents } from "./responses-sse.mjs";
import { logRequest as writeRequestLog } from "./logger.mjs";
import { summarizeToolRequest, createToolEventAudit, observeToolEvent, observeToolBlock, summarizeToolEvents } from "./tool-audit.mjs";
import { getCurrentVersion } from "./updater.mjs";
import { prepareMediaPayload, serializeOutboundBody, shouldFallbackResponses } from "./context-policy.mjs";
import { buildLocalCompactResponse, compactLockKey, decodeLocalCompaction, prefersLocalCompaction, prepareCompactPayload, prepareContextManagedPayload, prepareOversizedHistoryReplay } from "./compaction.mjs";
import { encodeRecoverableCompaction, parseCompactResponseText, readCompactResponseText, shouldUseLocalCompact } from "./compact-endpoint.mjs";
import { collectResponsesState, finalizeResponsesState, observeResponsesBlock, preparePreviousResponseReplay } from "./responses-state.mjs";
import { generateImage, getImageTask, resolveImageCapabilities } from "./image-service.mjs";
import { createImageAssetStore, persistImageResult } from "./image-assets.mjs";
import { getDiagnosticsMetrics } from "./diagnostics.mjs";
import { createLoggingRuntime } from "./logging-runtime.mjs";
import { closeLoggingWithinDeadline } from "./process-shutdown.mjs";
import { safePartJson } from "./protocol-content.mjs";
import { normalizeResponsesPayload } from "./responses-payload.mjs";
export { normalizeResponsesPayload } from "./responses-payload.mjs";
import { geminiRequest, geminiUsage } from "./gemini-adapter.mjs";
export { buildGeminiContents, sanitizeGeminiFunctionHistory } from "./gemini-adapter.mjs";
import { claudeRequest } from "./claude-adapter.mjs";
export { buildClaudeMessages } from "./claude-adapter.mjs";
import { buildOpenAIChatMessages, normalizeQwenSystemMessages } from "./chat-adapter.mjs";
export { buildOpenAIChatMessages, normalizeQwenSystemMessages } from "./chat-adapter.mjs";
import { customInput, emitRememberedCall } from "./tool-call-state.mjs";
import { resolveOpenCodeSession } from "./opencode-session.mjs";
import { initSseResponse, streamSseLines, upstreamErrorMessage, writeResponsesFailure } from "./responses-transport.mjs";
import { expandCurrentImageVisionReferences, withImageVisionReferences } from "./image-vision.mjs";
import { asArray, authorized, json, openCodeUpstreamHeaders, upstreamHeaders, writeSse } from "./http-lifecycle.mjs";
import { isChatCompletionsRoute, isCompactRoute, isModelsRoute, isResponsesRoute } from "./route-dispatch.mjs";

const GEMINI_PREFIX = /^gemini-/;
const CLAUDE_PREFIX = /^claude-/;
const MUSE_PREFIX = /^muse-/;
export const metricsState = {
  startedAt: Date.now(),
  resetTime: new Date().toISOString(),
  requestsTotal: 0,
  requestsSuccess: 0,
  requestsFailed: 0,
  activeRequests: 0,
  activeSse: 0,
  maxRssBytes: 0,
  isDraining: false,
  contextRequestsAdmitted: 0,
  contextRequestsRejected: 0,
  inboundBodyRejects: 0,
  outboundBodySoftLimitHits: 0,
  outboundBodyHardLimitRejects: 0,
  imageBytesRemoved: 0,
  imageBytesForwarded: 0,
  imageDedupHits: 0,
  historicalImagesRemoved: 0,
  maxSerializedBodyBytes: 0,
  compactRequests: 0,
  compactFailures: 0,
  activeCompactions: 0,
  replayDedupHits: 0,
  replayBytesSkipped: 0,
};

export function resetMetrics() {
  metricsState.startedAt = Date.now();
  metricsState.resetTime = new Date().toISOString();
  metricsState.requestsTotal = 0;
  metricsState.requestsSuccess = 0;
  metricsState.requestsFailed = 0;
  metricsState.activeRequests = 0;
  metricsState.activeSse = 0;
  metricsState.maxRssBytes = 0;
  metricsState.isDraining = false;
  metricsState.contextRequestsAdmitted = 0;
  metricsState.contextRequestsRejected = 0;
  metricsState.inboundBodyRejects = 0;
  metricsState.outboundBodySoftLimitHits = 0;
  metricsState.outboundBodyHardLimitRejects = 0;
  metricsState.imageBytesRemoved = 0;
  metricsState.imageBytesForwarded = 0;
  metricsState.imageDedupHits = 0;
  metricsState.historicalImagesRemoved = 0;
  metricsState.maxSerializedBodyBytes = 0;
  metricsState.compactRequests = 0;
  metricsState.compactFailures = 0;
  metricsState.activeCompactions = 0;
  metricsState.replayDedupHits = 0;
  metricsState.replayBytesSkipped = 0;
}

export function resolveTargetModel(model) {
  if (GEMINI_PREFIX.test(model)) return { targetModel: model, protocol: "gemini" };
  if (CLAUDE_PREFIX.test(model)) return { targetModel: model, protocol: "claude" };
  if (MUSE_PREFIX.test(model) || model === "gpt-5.6-sol" || model === "gpt-5.6-luna" || model.endsWith("-sol") || model.endsWith("-luna") || model.endsWith("-responses")) {
    return { targetModel: model, protocol: "responses" };
  }
  return { targetModel: model, protocol: "chat" };
}

function recordContextTrace(response, trace, admitted = true) {
  if (!trace) return;
  response.momoContextTrace = trace;
  if (trace.metricsRecorded) return;
  trace.metricsRecorded = true;
  if (admitted) metricsState.contextRequestsAdmitted++;
  else metricsState.contextRequestsRejected++;
  if (trace.softLimitHit) metricsState.outboundBodySoftLimitHits++;
  if (trace.hardLimitRejected) metricsState.outboundBodyHardLimitRejects++;
  metricsState.imageBytesRemoved += trace.imageBytesRemoved || 0;
  metricsState.imageBytesForwarded += trace.imageBytesForwarded || 0;
  metricsState.imageDedupHits += trace.imageDedupHits || 0;
  metricsState.historicalImagesRemoved += trace.historicalImagesRemoved || 0;
  metricsState.maxSerializedBodyBytes = Math.max(metricsState.maxSerializedBodyBytes, trace.maxOutboundBytes || trace.outboundBytes || 0);
}

function contextLogFields(response, request) {
  const trace = response.momoContextTrace;
  return {
    toolAudit: response.momoToolAudit ? { ...response.momoToolAudit, events: summarizeToolEvents(response.momoToolEvents) } : undefined,
    requestBytes: trace?.requestBytes || request.momoRequestBodyBytes,
    outboundBytes: trace?.outboundBytes,
    imageCount: trace?.imageCount,
    imageBytes: trace?.imageBytes,
    policyAction: trace?.policyActions?.join(",") || (trace?.hardLimitRejected ? "hard_limit_rejected" : undefined),
  };
}

function compactJson(response, status, body, headers = {}) {
  return json(response, status, body, headers);
}

async function forwardCompact(request, response, settings, payload, fetchImpl, signal, compactLocks) {
  const key = compactLockKey(request, payload);
  if (key && compactLocks.has(key)) {
    return compactJson(response, 409, { error: { message: "A compaction is already active for this session.", type: "conflict_error", code: "compaction_in_progress" } }, { "retry-after": "1" });
  }

  if (key) compactLocks.add(key);
  metricsState.compactRequests += 1;
  metricsState.activeCompactions += 1;
  try {
    if (prefersLocalCompaction(settings)) {
      const checkpoint = buildLocalCompactResponse(payload.model, payload.input);
      response.momoCompactTrace = { compactBytes: 0, markerizedItems: 0, policyAction: "local_compact_checkpoint" };
      return compactJson(response, 200, checkpoint);
    }
    const prepared = prepareCompactPayload(payload, settings);
    response.momoCompactTrace = prepared.trace;
    const upstream = await fetchImpl(settings.endpoint + "/v1/responses/compact", {
      method: "POST",
      headers: upstreamHeaders(settings),
      body: JSON.stringify(prepared.payload),
      signal,
    });

    if (upstream.ok) {
      const text = await readCompactResponseText(upstream);
      return compactJson(response, upstream.status, parseCompactResponseText(text));
    }

    const message = await upstreamErrorMessage(upstream);
    if (shouldUseLocalCompact(upstream.status, message)) {
      const checkpoint = buildLocalCompactResponse(payload.model, prepared.payload.input);
      response.momoCompactTrace = { ...prepared.trace, policyAction: "local_compact_checkpoint" };
      return compactJson(response, 200, checkpoint);
    }

    metricsState.compactFailures += 1;
    return compactJson(response, upstream.status, { error: { message, type: "compact_error", code: `http_${upstream.status}` } });
  } catch (error) {
    if (error?.code === "compact_budget_exceeded") {
      const checkpoint = buildLocalCompactResponse(payload.model, error.localCheckpointInput || payload.input);
      response.momoCompactTrace = { compactBytes: 0, markerizedItems: 0, policyAction: "local_compact_checkpoint" };
      return compactJson(response, 200, checkpoint);
    }
    metricsState.compactFailures += 1;
    throw error;
  } finally {
    metricsState.activeCompactions = Math.max(0, metricsState.activeCompactions - 1);
    if (key) compactLocks.delete(key);
  }
}

async function forwardCompactionTrigger(request, response, settings, payload, fetchImpl, signal, compactLocks) {
  const compactPayload = { ...payload, input: asArray(payload.input).filter((item) => item?.type !== "compaction_trigger") };
  const key = compactLockKey(request, compactPayload);
  if (key && compactLocks.has(key)) {
    return writeResponsesFailure(response, payload.model, 409, "A compaction is already active for this session.", "compaction_in_progress");
  }
  if (key) compactLocks.add(key);
  metricsState.compactRequests += 1;
  metricsState.activeCompactions += 1;
  try {
    if (prefersLocalCompaction(settings)) {
      const compacted = buildLocalCompactResponse(payload.model, compactPayload.input);
      const encryptedContent = encodeRecoverableCompaction(payload.model, compactPayload.input, compacted.output);
      const item = { type: "compaction", id: `cmp_${randomUUID()}`, encrypted_content: encryptedContent };
      response.momoCompactTrace = { compactBytes: 0, markerizedItems: 0, policyAction: "local_compact_checkpoint" };
      initSseResponse(response);
      const emitter = new ResponseStreamEmitter(response, payload.model, undefined, settings);
      emitter.start();
      const index = emitter.outputIndex++;
      emitter.outputItems.push(item);
      response.write(`event: response.output_item.done\ndata: ${JSON.stringify({ type: "response.output_item.done", response_id: emitter.responseId, output_index: index, item })}\n\n`);
      emitter.complete();
      return;
    }
    const prepared = prepareCompactPayload(compactPayload, settings);
    const upstream = await fetchImpl(settings.endpoint + "/v1/responses/compact", {
      method: "POST", headers: upstreamHeaders(settings), body: JSON.stringify(prepared.payload), signal,
    });
    let compacted;
    if (upstream.ok) {
      const compactText = await readCompactResponseText(upstream);
      compacted = parseCompactResponseText(compactText);
    } else {
      const message = await upstreamErrorMessage(upstream);
      if (!shouldUseLocalCompact(upstream.status, message)) {
        metricsState.compactFailures += 1;
        return writeResponsesFailure(response, payload.model, upstream.status, message);
      }
      compacted = buildLocalCompactResponse(payload.model, prepared.payload.input);
    }
    const output = Array.isArray(compacted?.output) ? compacted.output : [];
    const encryptedContent = encodeRecoverableCompaction(payload.model, prepared.payload.input, output);
    initSseResponse(response);
    const emitter = new ResponseStreamEmitter(response, payload.model, undefined, settings);
    emitter.start();
    const item = { type: "compaction", id: `cmp_${randomUUID()}`, encrypted_content: encryptedContent };
    const index = emitter.outputIndex++;
    emitter.outputItems.push(item);
    response.write(`event: response.output_item.done\ndata: ${JSON.stringify({ type: "response.output_item.done", response_id: emitter.responseId, output_index: index, item })}\n\n`);
    emitter.complete();
  } catch (error) {
    if (error?.code === "compact_budget_exceeded") {
      const checkpoint = buildLocalCompactResponse(payload.model, error.localCheckpointInput || compactPayload.input);
      const output = Array.isArray(checkpoint.output) ? checkpoint.output : [];
      const encryptedContent = encodeRecoverableCompaction(payload.model, compactPayload.input, output);
      initSseResponse(response);
      const emitter = new ResponseStreamEmitter(response, payload.model, undefined, settings);
      emitter.start();
      const item = { type: "compaction", id: `cmp_${randomUUID()}`, encrypted_content: encryptedContent };
      const index = emitter.outputIndex++;
      emitter.outputItems.push(item);
      response.write(`event: response.output_item.done\ndata: ${JSON.stringify({ type: "response.output_item.done", response_id: emitter.responseId, output_index: index, item })}\n\n`);
      emitter.complete();
      return;
    }
    metricsState.compactFailures += 1;
    throw error;
  } finally {
    metricsState.activeCompactions = Math.max(0, metricsState.activeCompactions - 1);
    if (key) compactLocks.delete(key);
  }
}

export async function bridgeChatCompletionsToResponses(request, response, settings, payload, calls, fetchImpl, signal, existingAdmission = null) {
  const historyReplay = existingAdmission ? { payload, rewritten: false } : prepareOversizedHistoryReplay(payload, settings);
  const prepared = existingAdmission || prepareMediaPayload(historyReplay.payload, settings, { kind: "responses", requestBytes: request.momoRequestBodyBytes || 0 });
  if (historyReplay.rewritten && !prepared.trace.policyActions.includes("local_history_checkpoint")) {
    prepared.trace.policyActions.push("local_history_checkpoint");
  }
  const safePayload = prepared.payload;
  const functions = extractFunctions(safePayload);
  const builtMessages = buildOpenAIChatMessages(safePayload.input || [], safePayload.instructions);
  const messages = String(payload.model || "").toLowerCase().includes("qwen")
    ? normalizeQwenSystemMessages(builtMessages)
    : builtMessages;

  const chatBody = {
    model: safePayload.model,
    messages,
    stream: true,
  };

  if (functions.length > 0) {
    chatBody.tools = functions.map((f) => ({
      type: "function",
      function: {
        name: f.name,
        description: f.description,
        parameters: f.parameters,
      },
    }));
    chatBody.tool_choice = safePayload.tool_choice || "auto";
  }

  const rawEffort = safePayload.reasoning_effort || safePayload.model_reasoning_effort || safePayload.reasoning?.effort;
  if (rawEffort) {
    chatBody.reasoning_effort = String(rawEffort).toLowerCase();
  }

  const serializedBody = serializeOutboundBody(chatBody, settings, prepared.trace);
  recordContextTrace(response, prepared.trace, true);
  const upstream = await fetchImpl(settings.endpoint + "/v1/chat/completions", {
    method: "POST",
    headers: openCodeUpstreamHeaders(settings, request, payload, calls),
    body: serializedBody,
    signal,
  });

  if (!upstream.ok) {
    const errMessage = await upstreamErrorMessage(upstream);
    return writeResponsesFailure(response, safePayload.model, upstream.status, errMessage);
  }

  initSseResponse(response);
  const emitter = new ResponseStreamEmitter(response, payload.model, undefined, settings);
  emitter.start();

  let fullAccumulatedText = "";
  const toolCallsByIndex = new Map();
  const dsmlDetector = new DsmlMarkerDetector();
  const accumulatedBudget = new RetainedOutputBudget(settings);

  for await (const data of streamSseLines(upstream.body || (await readBoundedOutputText(upstream)), response, signal, settings)) {
    const choice = data.choices?.[0];
    if (!choice) continue;

    const deltaContent = choice.delta?.content;
    if (deltaContent) {
      accumulatedBudget.text(deltaContent);
      fullAccumulatedText += deltaContent;
      if (!dsmlDetector.push(deltaContent)) {
        emitter.writeTextDelta(deltaContent);
      }
    }

    if (Array.isArray(choice.delta?.tool_calls)) {
      for (const tc of choice.delta.tool_calls) {
        accumulatedBudget.value(tc);
        const idx = tc.index ?? 0;
        let existing = toolCallsByIndex.get(idx);
        if (!existing) {
          existing = { id: tc.id || ("call_" + randomUUID()), name: "", arguments: "" };
          toolCallsByIndex.set(idx, existing);
        }
        if (tc.id) existing.id = tc.id;
        if (tc.function?.name) existing.name += tc.function.name;
        if (tc.function?.arguments) existing.arguments += tc.function.arguments;
      }
    }
  }

  const hasDsml = dsmlDetector.found;
  if (hasDsml) {
    const dsmlCalls = parseDsmlCalls(fullAccumulatedText);
    const cleanText = stripDsmlMarkup(fullAccumulatedText).trim();
    if (cleanText) {
      emitter.writeTextDelta(cleanText);
    }
    for (const call of dsmlCalls) {
      const mapped = restoreToolName(call.name, functions);
      emitRememberedCall(emitter, calls, mapped, call.arguments || {}, undefined, { openCodeSessionId: resolveOpenCodeSession(request, payload, calls) });
    }
  }

  if (toolCallsByIndex.size > 0) {
    for (const [, call] of toolCallsByIndex.entries()) {
      const mapped = restoreToolName(call.name, functions);
      let parsedArgs = {};
      try {
        parsedArgs = JSON.parse(call.arguments);
      } catch {
        parsedArgs = call.arguments;
      }

      emitRememberedCall(emitter, calls, mapped, parsedArgs, call.id, { openCodeSessionId: resolveOpenCodeSession(request, payload, calls) });
    }
  }

  emitter.complete();
}

async function forwardResponses(request, response, settings, payload, calls, fetchImpl, signal, replay = null, imageAssetStore = null) {
  response.momoToolAudit = { entry: summarizeToolRequest(payload) };
  response.momoToolEvents = createToolEventAudit();
  // Restore local envelopes before lowering: recovered calls need the same
  // custom/namespace conversion as ordinary client history.
  payload = { ...payload, input: asArray(payload.input).flatMap((item) =>
    item?.type === "compaction" ? (decodeLocalCompaction(item.encrypted_content) || [item]) : [item]) };
  // 1. Lower tool_search to standard function
  const { body: searchBody, names: searchNames } = rewriteRoutedToolSearchForUpstream(payload);
  // 2. Lower custom tools (exec, etc.) to standard functions
  const { body: customBody, names: customNames } = rewriteRoutedCustomToolsForUpstream(searchBody);
  // 3. Lower namespace tools (e.g. personal:codex-canvas) to flat functions
  const { body: nsBody, aliases: nsAliases } = rewriteRoutedNamespaceToolsForUpstream(customBody);
  // 4. Normalize schema for upstream OpenAI Responses endpoint
  const visionPayload = imageAssetStore
    ? await expandCurrentImageVisionReferences(nsBody, imageAssetStore, settings.localToken)
    : nsBody;
  const cleanPayload = normalizeResponsesPayload(visionPayload);
  response.momoToolAudit.normalized = summarizeToolRequest(cleanPayload);
  const historyReplay = prepareOversizedHistoryReplay(cleanPayload, settings);
  const managedPayload = Array.isArray(cleanPayload.context_management)
    && cleanPayload.context_management.some((item) => item?.type === "compaction")
    ? prepareContextManagedPayload(cleanPayload)
    : cleanPayload;
  const prepared = prepareMediaPayload({ ...managedPayload, stream: true }, settings, { kind: "responses", requestBytes: request.momoRequestBodyBytes || 0 });
  if (historyReplay.rewritten && !prepared.trace.policyActions.includes("local_history_checkpoint")) {
    prepared.trace.policyActions.push("local_history_checkpoint");
  }
  const outboundBody = serializeOutboundBody(prepared.payload, settings, prepared.trace);
  response.momoToolAudit.upstream = summarizeToolRequest(prepared.payload);
  // Attach trace for network-error logging, but defer metric finalization until
  // a possible Responses -> Chat fallback has passed its own final admission.
  response.momoContextTrace = prepared.trace;
  const upstream = await fetchImpl(settings.endpoint + "/v1/responses", { method: "POST", headers: upstreamHeaders(settings), body: outboundBody, signal });
  if (!upstream.ok) {
    const errMessage = await upstreamErrorMessage(upstream);
    // Only an explicit endpoint/protocol capability mismatch may be replayed once.
    // Payload, auth, throttling and server failures must preserve their status and never double-send.
    if (shouldFallbackResponses(upstream.status, errMessage)) {
      prepared.trace.fallbackProtocol = "chat";
      if (!prepared.trace.policyActions.includes("responses_to_chat_fallback")) prepared.trace.policyActions.push("responses_to_chat_fallback");
      return bridgeChatCompletionsToResponses(request, response, settings, prepared.payload, calls, fetchImpl, signal, prepared);
    }
    recordContextTrace(response, prepared.trace, true);
    return writeResponsesFailure(response, prepared.payload.model, upstream.status, errMessage);
  }
  recordContextTrace(response, prepared.trace, true);
  initSseResponse(response);
  if (!upstream.body) return response.end();
  const responseState = collectResponsesState(response, replay, settings);

  const allCustomNames = new Set(["exec", "apply_patch", ...customNames, ...searchNames]);
  const customToolBlockRewrite = createRoutedCustomToolRestoreBlockRewrite(allCustomNames, settings);
  const functions = extractFunctions(payload);
  let hasDsml = false;
  const dsmlDetector = new DsmlMarkerDetector();
  let fullAccumulatedText = "";
  let currentResponseId = "resp_" + randomUUID();
  const accumulatedBudget = new RetainedOutputBudget(settings);

  for await (const block of streamSseBlocks(budgetedOutputBody(upstream.body, settings), resolveOutputPolicy(settings))) {
    if (!block.trim()) continue;
    let json = null;
    const rawJsonStr = sseDataPayload(block)?.trim();
    if (rawJsonStr && rawJsonStr !== "[DONE]") {
      try { json = JSON.parse(rawJsonStr); } catch {}
    }

    if (json) {
      observeToolEvent(response.momoToolEvents, "upstream", json);
      if (json.type === "response.created" && json.response?.id) {
        currentResponseId = json.response.id;
        response.momoResponseId = currentResponseId;
      }
      if (json.type === "response.output_text.delta" && typeof json.delta === "string") {
        accumulatedBudget.text(json.delta);
        fullAccumulatedText += json.delta;
        if (dsmlDetector.push(json.delta)) {
          hasDsml = true;
          continue;
        }
      }
      if (json.type === "response.completed" && hasDsml) {
        const dsmlCalls = parseDsmlCalls(fullAccumulatedText);
        const cleanText = stripDsmlMarkup(fullAccumulatedText).trim();
        const emitter = new ResponseStreamEmitter(response, cleanPayload.model, currentResponseId, settings);
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

      if (!hasDsml) {
        let transformedBlock = block;
        if (nsAliases && nsAliases.size > 0 && rawJsonStr) {
          const restoredJsonStr = restoreAllRoutedCallsInJson(rawJsonStr, nsAliases, null);
          if (restoredJsonStr !== rawJsonStr) {
            transformedBlock = replaceSseDataPayload(block, restoredJsonStr);
          }
        }
        const outputBlocks = customToolBlockRewrite(transformedBlock);
        for (const outBlock of outputBlocks) {
          observeToolBlock(response.momoToolEvents, "client", outBlock);
          observeResponsesBlock(responseState, outBlock);
          await writeResponseChunk(response, outBlock + "\n\n", signal);
        }
        continue;
      }
    }

    if (!hasDsml) {
      const outputBlocks = customToolBlockRewrite(block);
      for (const outBlock of outputBlocks) {
        observeToolBlock(response.momoToolEvents, "client", outBlock);
        observeResponsesBlock(responseState, outBlock);
        await writeResponseChunk(response, outBlock + "\n\n", signal);
      }
    }
  }
  customToolBlockRewrite.finish?.();
  finalizeResponsesState(responseState, replay);
  response.end();
}

async function bridgeGemini(response, settings, payload, calls, fetchImpl, signal) {
  const historyReplay = prepareOversizedHistoryReplay(payload, settings);
  const prepared = prepareMediaPayload(historyReplay.payload, settings, { kind: "responses" });
  if (historyReplay.rewritten && !prepared.trace.policyActions.includes("local_history_checkpoint")) {
    prepared.trace.policyActions.push("local_history_checkpoint");
  }
  const { body, functions } = geminiRequest(prepared.payload, prepared.payload.model, calls);
  const endpoint = settings.endpoint + "/v1beta/models/" + encodeURIComponent(payload.model) + ":streamGenerateContent?alt=sse";
  const outboundBody = serializeOutboundBody(body, settings, prepared.trace);
  recordContextTrace(response, prepared.trace, true);
  const upstream = await fetchImpl(endpoint, { method: "POST", headers: upstreamHeaders(settings), body: outboundBody, signal });
  if (!upstream.ok) {
    const errMessage = await upstreamErrorMessage(upstream);
    return writeResponsesFailure(response, prepared.payload.model, upstream.status, errMessage);
  }
  initSseResponse(response);
  const emitter = new ResponseStreamEmitter(response, payload.model, undefined, settings);
  emitter.start();
  let usage;

  for await (const data of streamSseLines(upstream.body || (await readBoundedOutputText(upstream)), response, signal, settings)) {
    const root = data?.response && typeof data.response === "object" ? data.response : data;
    if (root?.usageMetadata) usage = geminiUsage(root.usageMetadata);
    for (const part of root?.candidates?.[0]?.content?.parts || []) {
      if (part.text) {
        emitter.writeTextDelta(part.text);
      }
      if (part.functionCall) {
        const mapped = restoreToolName(part.functionCall.name, functions);
        const upstreamCallId = typeof part.functionCall.id === "string" && part.functionCall.id
          ? part.functionCall.id
          : undefined;
        const callId = upstreamCallId && !calls.has(upstreamCallId) ? upstreamCallId : undefined;
        emitRememberedCall(emitter, calls, mapped, part.functionCall.args || {}, callId, {
          geminiContents: body.contents,
          geminiFunctionCallPart: structuredClone(part),
        });
      }
    }
  }
  emitter.complete(usage);
}

async function bridgeClaude(response, settings, payload, calls, fetchImpl, signal) {
  const historyReplay = prepareOversizedHistoryReplay(payload, settings);
  const prepared = prepareMediaPayload(historyReplay.payload, settings, { kind: "responses" });
  if (historyReplay.rewritten && !prepared.trace.policyActions.includes("local_history_checkpoint")) {
    prepared.trace.policyActions.push("local_history_checkpoint");
  }
  const { body, functions } = claudeRequest(prepared.payload, prepared.payload.model, calls);
  const outboundBody = serializeOutboundBody(body, settings, prepared.trace);
  recordContextTrace(response, prepared.trace, true);
  const upstream = await fetchImpl(settings.endpoint + "/v1/messages", { method: "POST", headers: { ...upstreamHeaders(settings), "anthropic-version": "2023-06-01" }, body: outboundBody, signal });
  if (!upstream.ok) {
    const errMessage = await upstreamErrorMessage(upstream);
    return writeResponsesFailure(response, prepared.payload.model, upstream.status, errMessage);
  }
  initSseResponse(response);
  const emitter = new ResponseStreamEmitter(response, payload.model, undefined, settings);
  emitter.start();

  const toolBlocks = new Map();
  const accumulatedBudget = new RetainedOutputBudget(settings);
  for await (const data of streamSseLines(upstream.body || (await readBoundedOutputText(upstream)), response, signal, settings)) {
    if (data.type === "content_block_delta" && data.delta?.type === "text_delta") {
      emitter.writeTextDelta(data.delta.text);
    }
    if (data.type === "content_block_start" && data.content_block?.type === "tool_use") {
      accumulatedBudget.value(data.content_block);
      toolBlocks.set(data.index, { id: data.content_block.id, name: data.content_block.name, input: data.content_block.input || {}, partialJson: "" });
    }
    if (data.type === "content_block_delta" && data.delta?.type === "input_json_delta") {
      const block = toolBlocks.get(data.index);
      if (block) { accumulatedBudget.text(data.delta.partial_json || ""); block.partialJson += data.delta.partial_json || ""; }
    }
    if (data.type === "content_block_stop" && toolBlocks.has(data.index)) {
      const block = toolBlocks.get(data.index);
      toolBlocks.delete(data.index);
      let argumentsValue = block.input;
      if (block.partialJson) {
        try { argumentsValue = JSON.parse(block.partialJson); } catch { argumentsValue = block.partialJson; }
      }
      const mapped = restoreToolName(block.name, functions);
      emitRememberedCall(emitter, calls, mapped, argumentsValue, block.id, {
        claudeMessages: body.messages,
        toolUseBlock: { type: "tool_use", id: block.id, name: block.name, input: argumentsValue },
      });
    }
  }
  emitter.complete();
}

async function forwardChatCompletions(request, response, settings, payload, fetchImpl, signal) {
  const prepared = prepareMediaPayload(payload, settings, { kind: "chat", requestBytes: request.momoRequestBodyBytes || 0 });
  const outboundBody = serializeOutboundBody(prepared.payload, settings, prepared.trace);
  recordContextTrace(response, prepared.trace, true);
  const upstream = await fetchImpl(settings.endpoint + "/v1/chat/completions", {
    method: "POST",
    headers: openCodeUpstreamHeaders(settings, request, payload, null),
    body: outboundBody,
    signal,
  });

  response.statusCode = upstream.status;
  for (const [key, val] of upstream.headers.entries()) {
    const lower = key.toLowerCase();
    if (lower !== "content-length" && lower !== "content-encoding" && lower !== "transfer-encoding" && lower !== "connection") {
      response.setHeader(key, val);
    }
  }

  if (upstream.body) {
    await forwardResponseBody(budgetedOutputBody(upstream.body, settings), response, signal);
  } else {
    const text = await readBoundedOutputText(upstream, resolveOutputPolicy(settings).maxStreamMb * 1024 * 1024);
    await writeResponseChunk(response, text, signal);
  }
  response.end();
}

export function createMomoSwitch(settings, options = {}) {
  const { fetchImpl = fetch, exitImpl = process.exit, assetStore } = options;
  const ownsLoggingRuntime = !options.loggingRuntime;
  const loggingRuntime = options.loggingRuntime || (options.loggingRuntimeFactory || createLoggingRuntime)({
    diagnosticsEnabled: settings.diagnosticsEnabled, consoleMirror: false,
  });
  const requestMetrics = new RequestMetrics();
  const originalFetch = fetchImpl;
  metricsState.isDraining = false;
  const calls = new BoundedCallCache(settings);
  const activeSockets = new Set();
  const activeSseEmitters = new Set();
  const activeAbortControllers = new Set();
  const compactLocks = new Set();
  const admission = new RequestAdmission(settings);
  const imageAssetStore = assetStore || createImageAssetStore(settings);
  const logRequest = (fields) => writeRequestLog(fields, loggingRuntime.env, { runtime: loggingRuntime, settings });
  let serverInstance = null;
  let shutdownLifecycle = null;

  const server = createServer(async (request, response) => {
    const t0 = Date.now();
    const metricPath = (request.url || "/").split("?")[0].replace(/\/+$/, "") || "/";
    const timing = requestMetrics.begin(request.method, metricPath);
    const fetchImpl = timing.wrapFetch(originalFetch);
    // This is a local body-write milestone, not socket delivery or first token.
    let measuredFirstWrite = false;
    const measureFirstWrite = (chunk) => {
      if (measuredFirstWrite || !(chunk?.length || chunk?.byteLength)) return;
      measuredFirstWrite = true;
      if (String(response.getHeader("content-type") || "").includes("text/event-stream")) timing.sse();
      timing.firstWrite();
    };
    const originalWrite = response.write.bind(response);
    const originalEnd = response.end.bind(response);

    response.write = function (...args) {
      measureFirstWrite(args[0]);
      return originalWrite(...args);
    };

    response.end = function (...args) {
      measureFirstWrite(args[0]);
      return originalEnd(...args);
    };

    const abortController = new AbortController();
    request.once("aborted", () => abortController.abort());
    request.on("error", () => abortController.abort());
    let admissionLease;
    const receiveBody = async () => {
      const queueStart = performance.now();
      try { admissionLease = await admission.acquire(requestReservationBytes(request, settings), abortController.signal); }
      finally { timing.observe("queueWaitMs", performance.now() - queueStart); }
      try { return await bodyOf(request, settings, { signal: abortController.signal, timeoutMs: admission.policy.bodyReadTimeoutMs }); }
      finally {
        timing.observe("bodyReadMs", request.momoBodyReadMs);
        timing.observe("bodyParseMs", request.momoBodyParseMs);
        timing.bodyReady();
      }
    };
    activeAbortControllers.add(abortController);
    response.on("finish", () => activeAbortControllers.delete(abortController));
    response.on("close", () => activeAbortControllers.delete(abortController));
    const remoteIp = request.socket?.remoteAddress || "";
    let requestedModel = null;
    let finalStatus = 200;
    let isSse = false;

    // 统计活跃请求
    metricsState.requestsTotal++;
    metricsState.activeRequests++;

    const mem = process.memoryUsage();
    if (mem.rss > metricsState.maxRssBytes) metricsState.maxRssBytes = mem.rss;

    const cleanupActive = () => {
      metricsState.activeRequests = Math.max(0, metricsState.activeRequests - 1);
      if (isSse) {
        metricsState.activeSse = Math.max(0, metricsState.activeSse - 1);
      }
    };

    let cleanupDone = false;
    const finishCleanup = (success) => {
      if (!cleanupDone) {
        cleanupDone = true;
        cleanupActive();
        if (success) metricsState.requestsSuccess++;
        else metricsState.requestsFailed++;
      }
    };

    response.on("finish", () => {
      timing.finish(response.statusCode);
      finishCleanup(response.statusCode < 400);
    });
    response.on("close", () => {
      timing.finish(response.statusCode, !response.writableFinished);
      if (!response.writableEnded) {
        abortController.abort();
        finishCleanup(false);
      }
    });

    const rawUrl = request.url || "/";
    const pathname = rawUrl.split("?")[0].replace(/\/+$/, "") || "/";
    const isInternal = pathname.startsWith("/internal/");

    // 严禁对内部端点暴露公共 CORS headers
    if (!isInternal) {
      response.setHeader("Access-Control-Allow-Origin", "*");
      response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS, PUT, DELETE");
      response.setHeader("Access-Control-Allow-Headers", "*");

      if (request.method === "OPTIONS") {
        response.writeHead(204);
        return response.end();
      }
    } else if (request.method === "OPTIONS") {
      // 内部端点直接拒绝 OPTIONS 探测
      response.writeHead(403);
      return response.end();
    }

    try {
      const rawUrl = request.url || "/";
      const pathname = rawUrl.split("?")[0].replace(/\/+$/, "") || "/";

      // 1. healthz
      if (request.method === "GET" && (pathname === "/healthz" || pathname === "/health")) {
        if (metricsState.isDraining) {
          logRequest({ method: "GET", url: pathname, status: 503, elapsedMs: Date.now() - t0, ip: remoteIp });
          return json(response, 503, { ok: false, status: "draining", service: "momo-codex-bridge", version: getCurrentVersion() });
        }
        logRequest({ method: "GET", url: pathname, status: 200, elapsedMs: Date.now() - t0, ip: remoteIp });
        return json(response, 200, { ok: true, service: "momo-codex-bridge", version: getCurrentVersion(), host: settings.host, port: settings.port });
      }

      // 2. internal shutdown
      if (request.method === "POST" && pathname === "/internal/shutdown") {
        const isLocal = remoteIp === "127.0.0.1" || remoteIp === "::1" || remoteIp === "::ffff:127.0.0.1";
        const headerToken = request.headers["x-local-token"] || request.headers.authorization?.replace(/^Bearer\s+/i, "");
        if (!isLocal || (settings.localToken && headerToken !== settings.localToken)) {
          return json(response, 403, { error: "Forbidden: shutdown is restricted to authenticated loopback clients." });
        }

        if (metricsState.isDraining) {
          return json(response, 200, { ok: true, message: "Server already in draining state." });
        }

        metricsState.isDraining = true;
        admission.close();
        const configuredDrainTimeoutMs = Number(settings.drainTimeoutMs);
        const drainTimeoutMs = Number.isFinite(configuredDrainTimeoutMs) && configuredDrainTimeoutMs > 0
          ? configuredDrainTimeoutMs
          : 5000;
        const shutdownStartedAt = Date.now();
        let shutdownFinished = false;
        let deadlineTimer = null;

        let exitStarted = false;
        const exitProcess = () => {
          if (exitStarted) return;
          exitStarted = true;
          const elapsedMs = Date.now() - shutdownStartedAt;
          const remainingMs = Math.max(1, Math.min(1000, drainTimeoutMs - elapsedMs - 50));
          void closeLoggingWithinDeadline({ loggingRuntime, timeoutMs: remainingMs }).finally(() => {
            const exitDelayMs = Math.max(0, Math.min(50, drainTimeoutMs - (Date.now() - shutdownStartedAt)));
            setTimeout(() => {
              try { exitImpl(0); } catch {}
            }, exitDelayMs);
          });
        };

        const finishNaturally = () => {
          if (shutdownFinished) return;
          shutdownFinished = true;
          if (deadlineTimer) clearTimeout(deadlineTimer);
          shutdownLifecycle = null;
          exitProcess();
        };

        const forceShutdown = () => {
          if (shutdownFinished) return;
          shutdownFinished = true;
          shutdownLifecycle = null;

          for (const ac of activeAbortControllers) {
            try { ac.abort(); } catch {}
          }
          activeAbortControllers.clear();

          for (const emitter of activeSseEmitters) {
            try {
              emitter.response.write("event: response.incomplete\ndata: " + JSON.stringify({
                type: "response.incomplete",
                response: {
                  id: "resp_incomplete_" + Date.now(),
                  object: "response",
                  status: "incomplete",
                  incomplete_details: { reason: "server_shutdown" },
                  error: { message: "Server shutting down gracefully", type: "server_shutdown" },
                  output: []
                }
              }) + "\n\n");
              emitter.response.end();
            } catch {}
          }
          activeSseEmitters.clear();

          for (const sock of activeSockets) {
            try { sock.destroy(); } catch {}
          }
          activeSockets.clear();
          exitProcess();
        };

        shutdownLifecycle = { forceShutdown };
        deadlineTimer = setTimeout(forceShutdown, drainTimeoutMs);
        if (deadlineTimer.unref) deadlineTimer.unref();

        response.once("finish", () => {
          if (!serverInstance) return finishNaturally();
          try { serverInstance.close(finishNaturally); } catch { finishNaturally(); }
        });

        json(response, 200, {
          ok: true,
          message: `Server draining initiated; no new connections accepted, terminating in up to ${drainTimeoutMs}ms.`
        });

        return;
      }

      // 3. internal metrics
      if (request.method === "GET" && pathname === "/internal/metrics") {
        const isLocal = remoteIp === "127.0.0.1" || remoteIp === "::1" || remoteIp === "::ffff:127.0.0.1";
        const headerToken = request.headers["x-local-token"] || request.headers.authorization?.replace(/^Bearer\s+/i, "");
        if (!isLocal || (settings.localToken && headerToken !== settings.localToken)) {
          return json(response, 403, { error: "Forbidden: metrics are restricted to authenticated loopback clients." });
        }

        const curMem = process.memoryUsage();
        if (curMem.rss > metricsState.maxRssBytes) metricsState.maxRssBytes = curMem.rss;
        const measured = requestMetrics.snapshot();

        return json(response, 200, {
          ok: true,
          uptimeSeconds: Math.floor((Date.now() - metricsState.startedAt) / 1000),
          resetTime: metricsState.resetTime,
          isDraining: metricsState.isDraining,
          admission: admission.snapshot(),
          callCache: calls.snapshot(),
          outputPolicy: resolveOutputPolicy(settings),
          requests: measured.groups.business.requests,
          requestMetrics: measured,
          legacyAllHttpRequests: {
            total: metricsState.requestsTotal,
            success: metricsState.requestsSuccess,
            failed: metricsState.requestsFailed,
            active: metricsState.activeRequests,
            activeSse: metricsState.activeSse,
          },
          context: {
            requestsAdmitted: metricsState.contextRequestsAdmitted,
            requestsRejected: metricsState.contextRequestsRejected,
            inboundBodyRejects: metricsState.inboundBodyRejects,
            softLimitRewrites: metricsState.outboundBodySoftLimitHits,
            hardLimitRejections: metricsState.outboundBodyHardLimitRejects,
            imageBytesRemoved: metricsState.imageBytesRemoved,
            imageBytesForwarded: metricsState.imageBytesForwarded,
            imageDedupHits: metricsState.imageDedupHits,
            historicalImagesRemoved: metricsState.historicalImagesRemoved,
            maxSerializedBodyBytes: metricsState.maxSerializedBodyBytes,
            compactRequests: metricsState.compactRequests,
            compactFailures: metricsState.compactFailures,
            activeCompactions: metricsState.activeCompactions,
            replayDedupHits: metricsState.replayDedupHits,
            replayBytesSkipped: metricsState.replayBytesSkipped,
          },
          ttfbMs: measured.groups.business.stages.clientFirstWriteMs,
          memory: {
            rssBytes: curMem.rss,
            heapUsedBytes: curMem.heapUsed,
            heapTotalBytes: curMem.heapTotal,
            externalBytes: curMem.external,
            arrayBuffersBytes: curMem.arrayBuffers,
            maxRssBytes: metricsState.maxRssBytes,
            maxRssScope: "request-boundary sampled process RSS; not a true peak or per-server measurement",
          },
          features: {
            dnsCache: { supported: false },
            connectionPooling: { supported: true, backend: "node-native-fetch" },
          },
          diagnostics: getDiagnosticsMetrics(loggingRuntime.env, { runtime: loggingRuntime }),
          logging: loggingRuntime.snapshot(),
          version: getCurrentVersion(),
        });
      }

      // Image plugin endpoints are loopback-only and require the proxy local token.
      if (pathname.startsWith("/internal/images")) {
        const isLocal = remoteIp === "127.0.0.1" || remoteIp === "::1" || remoteIp === "::ffff:127.0.0.1";
        const headerToken = request.headers["x-local-token"] || request.headers.authorization?.replace(/^Bearer\s+/i, "");
        if (!isLocal || headerToken !== settings.localToken) {
          return json(response, 403, { error: { message: "Forbidden: image endpoints require an authenticated loopback client.", type: "authentication_error" } });
        }
        if (request.method === "GET" && pathname === "/internal/images/capabilities") {
          const capabilities = await resolveImageCapabilities({ settings, fetchImpl, signal: abortController.signal });
          return json(response, 200, capabilities);
        }
        if (request.method === "POST" && (pathname === "/internal/images/generate" || pathname === "/internal/images/edit")) {
          const payload = await receiveBody();
          const operation = pathname.endsWith("/edit") ? "edit" : "generate";
          const result = await generateImage({
            settings,
            request: payload,
            fetchImpl,
            signal: abortController.signal,
            operation,
            assetResolver: (reference) => imageAssetStore.dataUrl(reference),
          });
          const persisted = await persistImageResult(imageAssetStore, result);
          return json(response, 200, withImageVisionReferences(persisted, settings.localToken));
        }
        const taskMatch = /^\/internal\/images\/tasks\/([^/]+)$/.exec(pathname);
        if (request.method === "GET" && taskMatch) {
          const result = await getImageTask({ settings, taskId: decodeURIComponent(taskMatch[1]), fetchImpl, signal: abortController.signal });
          const persisted = result.images?.length ? await persistImageResult(imageAssetStore, result) : result;
          return json(response, 200, withImageVisionReferences(persisted, settings.localToken));
        }
        if (request.method === "GET" && pathname === "/internal/images/assets") {
          const limit = new URL(rawUrl, "http://127.0.0.1").searchParams.get("limit");
          return json(response, 200, { images: await imageAssetStore.list({ limit }) });
        }
        const assetMatch = /^\/internal\/images\/assets\/(img_[a-f0-9]{64})$/.exec(pathname);
        if (request.method === "GET" && assetMatch) {
          return json(response, 200, withImageVisionReferences({ images: [await imageAssetStore.get(assetMatch[1])] }, settings.localToken));
        }
        return json(response, 404, { error: { message: "Image endpoint not found.", type: "invalid_request_error" } });
      }

      // 4. draining 期间拒绝任何新业务请求
      if (metricsState.isDraining) {
        finalStatus = 503;
        logRequest({ method: request.method, url: pathname, status: 503, elapsedMs: Date.now() - t0, error: "Server is draining", ip: remoteIp });
        return json(response, 503, { error: { message: "Server is draining for shutdown, please retry later.", type: "server_draining" } }, { "Retry-After": "5" });
      }

      // 5. 鉴权校验
      if (!authorized(request, settings)) {
        finalStatus = 401;
        logRequest({ method: request.method, url: pathname, status: 401, elapsedMs: Date.now() - t0, error: "Unauthorized", ip: remoteIp });
        return json(response, 401, { error: { message: "Invalid local MOMO Switch token.", type: "authentication_error" } });
      }

      // 6. models
      if (isModelsRoute(request.method, pathname)) {
        const upstream = await fetchImpl(settings.endpoint + "/v1/models", { headers: upstreamHeaders(settings), signal: abortController.signal });
        finalStatus = upstream.status;
        logRequest({ method: "GET", url: pathname, status: finalStatus, elapsedMs: Date.now() - t0, ip: remoteIp });
        return json(response, upstream.status, await upstream.json());
      }

      // 7. chat completions
      if (isChatCompletionsRoute(request.method, pathname)) {
        const payload = await receiveBody();
        requestedModel = payload.model;
        await forwardChatCompletions(request, response, settings, payload, fetchImpl, abortController.signal);
        logRequest({ method: "POST", url: pathname, model: requestedModel, status: response.statusCode || 200, elapsedMs: Date.now() - t0, ip: remoteIp, ...contextLogFields(response, request) });
        return;
      }

      // 8. responses
      if (isCompactRoute(request.method, pathname)) {
        const payload = await receiveBody();
        requestedModel = payload.model;
        if (!payload.model) {
          return json(response, 400, { error: { message: "model is required", type: "invalid_request_error" } });
        }
        await forwardCompact(request, response, settings, payload, fetchImpl, abortController.signal, compactLocks);
        const compactTrace = response.momoCompactTrace;
        logRequest({ method: "POST", url: pathname, model: requestedModel, status: response.statusCode || 200, elapsedMs: Date.now() - t0, ip: remoteIp, requestBytes: request.momoRequestBodyBytes, outboundBytes: compactTrace?.compactBytes, policyAction: compactTrace?.policyAction });
        return;
      }

      if (isResponsesRoute(request.method, pathname)) {
        const payload = await receiveBody();
        requestedModel = payload.model;
        if (!payload.model) {
          finalStatus = 400;
          logRequest({ method: "POST", url: pathname, status: 400, elapsedMs: Date.now() - t0, error: "model is required", ip: remoteIp });
          return json(response, 400, { error: { message: "model is required", type: "invalid_request_error" } });
        }
        const { targetModel, protocol } = resolveTargetModel(payload.model);
        const replay = protocol === "responses"
          ? preparePreviousResponseReplay({ ...payload, model: targetModel })
          : { payload: { ...payload, model: targetModel }, seed: null, deduplicated: false, skippedBytes: 0 };
        if (replay.deduplicated) {
          metricsState.replayDedupHits += 1;
          metricsState.replayBytesSkipped += replay.skippedBytes;
        }
        const routedPayload = replay.payload;

        isSse = true;
        metricsState.activeSse++;
        const sseHandle = { response };
        activeSseEmitters.add(sseHandle);
        response.on("finish", () => activeSseEmitters.delete(sseHandle));
        response.on("close", () => activeSseEmitters.delete(sseHandle));

        let handlerPromise;
        if (asArray(routedPayload.input).some((item) => item?.type === "compaction_trigger")) {
          handlerPromise = forwardCompactionTrigger(request, response, settings, routedPayload, fetchImpl, abortController.signal, compactLocks);
        } else if (protocol === "responses") handlerPromise = forwardResponses(request, response, settings, routedPayload, calls, fetchImpl, abortController.signal, replay, imageAssetStore);
        else if (protocol === "chat") handlerPromise = bridgeChatCompletionsToResponses(request, response, settings, routedPayload, calls, fetchImpl, abortController.signal);
        else if (protocol === "gemini") handlerPromise = bridgeGemini(response, settings, routedPayload, calls, fetchImpl, abortController.signal);
        else handlerPromise = bridgeClaude(response, settings, routedPayload, calls, fetchImpl, abortController.signal);

        await handlerPromise;
        logRequest({ method: "POST", url: pathname, model: requestedModel, status: response.statusCode || 200, elapsedMs: Date.now() - t0, ip: remoteIp, ...contextLogFields(response, request) });
        return;
      }

      finalStatus = 404;
      logRequest({ method: request.method, url: pathname, status: 404, elapsedMs: Date.now() - t0, ip: remoteIp });
      return json(response, 404, { error: { message: "Not found", type: "invalid_request_error" } });
    } catch (error) {
      if (abortController.signal.aborted) return;
      const rawUrl = request.url || "/";
      const pathname = rawUrl.split("?")[0].replace(/\/+$/, "") || "/";

      if (error.admission) {
        const status = error.statusCode;
        if (status === 413) {
          metricsState.inboundBodyRejects++;
          metricsState.contextRequestsRejected++;
        }
        // Do not drain an arbitrarily large/slow rejected upload into memory.
        // Send the structured error, then close only this request's connection.
        const headers = status === 503 ? { "Retry-After": "1" } : {};
        if (!request.readableEnded) {
          request.pause();
          headers.Connection = "close";
          response.once("finish", () => request.destroy());
        }
        logRequest({ method: request.method, url: pathname, status, elapsedMs: Date.now() - t0, error: error.message, errorCode: error.code, ip: remoteIp });
        return json(response, status, { error: { message: error.message, type: "request_admission_error", code: error.code } }, headers);
      }

      if (pathname.startsWith("/internal/images") && Number.isInteger(error.statusCode)) {
        const status = error.statusCode;
        logRequest({ method: request.method, url: pathname, status, elapsedMs: Date.now() - t0, error: error.message, ip: remoteIp });
        return json(response, status, { error: { message: error.message, type: error.code || "image_error", code: error.code || "image_error" } });
      }

      if (error.statusCode === 413) {
        const trace = error.contextTrace;
        if (trace) {
          recordContextTrace(response, trace, false);
        } else {
          metricsState.inboundBodyRejects++;
          metricsState.contextRequestsRejected++;
        }
        const code = error.code || "payload_too_large";
        logRequest({ method: request.method, url: pathname, model: requestedModel, status: 413, elapsedMs: Date.now() - t0, error: error.message, errorCode: code, ip: remoteIp, ...contextLogFields(response, request) });
        const body = { error: { message: error.message, type: "payload_too_large", code, ...(error.details ? { details: error.details } : {}) } };
        if ((pathname === "/v1/responses" || pathname === "/responses") && request.momoRequestBodyBytes) {
          return writeResponsesFailure(response, requestedModel || "unknown", 413, error.message, code);
        }
        return json(response, 413, body);
      }

      if (error.code === "tool_continuation_unavailable") {
        return json(response, 409, { error: { message: error.message, type: "invalid_request_error", code: error.code } });
      }

      if (error.statusCode === 400) {
        logRequest({ method: request.method, url: pathname, status: 400, elapsedMs: Date.now() - t0, error: error.message, ip: remoteIp });
        return json(response, 400, { error: { message: error.message, type: "invalid_request_error", code: "invalid_json" } });
      }

      if (Number.isInteger(error.statusCode) && (pathname === "/v1/responses/compact" || pathname === "/responses/compact")) {
        const status = error.statusCode;
        logRequest({ method: request.method, url: pathname, model: requestedModel, status, elapsedMs: Date.now() - t0, error: error.message, errorCode: error.code || `http_${status}`, ip: remoteIp });
        return json(response, status, { error: { message: error.message, type: "compact_error", code: error.code || `http_${status}` } });
      }

      logRequest({ method: request.method, url: pathname, model: requestedModel, status: 502, elapsedMs: Date.now() - t0, error: error.message, errorCode: error.code || "upstream_request_failed", ip: remoteIp, ...contextLogFields(response, request) });
      if (pathname === "/v1/responses" || pathname === "/responses") {
        abortController.abort();
        return writeResponsesFailure(response, requestedModel || "unknown", 502, error.message, error.code || "upstream_request_failed");
      }
      abortController.abort();
      // Raw Chat may already be streaming non-Responses bytes: close it as a
      // truncated transport, never append incompatible JSON or a fake DONE.
      if (response.headersSent) return response.destroy();
      return json(response, 502, { error: { message: error.message, type: "server_error" } });
    } finally {
      // Hold through parsing, normalization and upstream completion/cancellation.
      // Response finish alone does not prove the handler released its body.
      admissionLease?.release();
    }
  });

  serverInstance = server;

  server.on("connection", (socket) => {
    activeSockets.add(socket);
    socket.on("close", () => activeSockets.delete(socket));
  });

  server.on("error", () => {
    if (shutdownLifecycle) shutdownLifecycle.forceShutdown();
  });

  // Library/test callers commonly await server.close(callback) and then remove
  // their temporary profile. When this server created the async logger, make
  // that callback a lifecycle barrier so pending appends cannot race cleanup.
  // Explicitly injected runtimes remain owned by their caller (the CLI does
  // its own signal/HTTP deadline handling).
  if (ownsLoggingRuntime) {
    const closeServer = server.close.bind(server);
    let closeOwnedLogging = null;
    server.close = (callback) => closeServer((...args) => {
      closeOwnedLogging ||= closeLoggingWithinDeadline({ loggingRuntime, timeoutMs: 1000 });
      if (typeof callback === "function") void closeOwnedLogging.finally(() => callback(...args));
    });
  }

  return server;
}

export const createMomoBridge = createMomoSwitch;

export async function listen(settings, options = {}) {
  const server = createMomoSwitch(settings, options);
  await new Promise((resolve, reject) => server.once("error", reject).listen(settings.port, settings.host, resolve));
  return server;
}
