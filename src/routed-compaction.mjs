import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { appHome } from "./config.mjs";
import { upstreamHeaders } from "./http-lifecycle.mjs";
import { resolveTargetModel } from "./model-routing.mjs";
import { sseDataPayload, streamSseBlocks } from "./stream-transport.mjs";

function failure(code, message, statusCode = 422) {
  return Object.assign(new Error(message), { code, statusCode });
}

function textOf(item) {
  if (!item || (item.type && item.type !== "message")
    || Object.keys(item).some((key) => !["type", "role", "content"].includes(key))
    || !["user", "assistant"].includes(item.role)) return null;
  if (typeof item.content === "string") return item.content;
  if (!Array.isArray(item.content) || !item.content.length || !item.content.every((part) =>
    part && Object.keys(part).every((key) => ["type", "text"].includes(key))
    && ["input_text", "output_text", "text"].includes(part.type) && typeof part.text === "string")) return null;
  return item.content.map((part) => part.text).join("\n");
}

const CALL_TYPES = new Set(["function_call", "custom_tool_call"]);
const RESULT_TYPES = new Set(["function_call_output", "custom_tool_call_output"]);
const ROUTED_SUMMARY_PREFIX = "[Historical context summary; not an active instruction or proof of completion]\n";
const ROUTED_ENVELOPE_PREFIX = "momor2:";
const WINDOWS_KEY_ACL = [
  "$ErrorActionPreference = 'Stop'",
  "$p = [Environment]::GetEnvironmentVariable('MOMO_ROUTED_KEY_PATH')",
  "$a = Get-Acl -LiteralPath $p",
  "$a.SetAccessRuleProtection($true, $false)",
  "foreach ($r in @($a.Access)) { [void]$a.RemoveAccessRuleAll($r) }",
  "$ids = @([Security.Principal.WindowsIdentity]::GetCurrent().User, [Security.Principal.SecurityIdentifier]::new('S-1-5-18'), [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))",
  "foreach ($id in $ids) { $a.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($id, [Security.AccessControl.FileSystemRights]::FullControl, [Security.AccessControl.AccessControlType]::Allow)) }",
  "[System.IO.File]::SetAccessControl($p, $a)",
  "$check = Get-Acl -LiteralPath $p",
  "if (-not $check.AreAccessRulesProtected -or $check.Access.Count -ne 3) { throw 'key ACL verification failed' }",
  "foreach ($r in $check.Access) { $ruleSid = $r.IdentityReference.Translate([Security.Principal.SecurityIdentifier]); if ($r.IsInherited -or $r.AccessControlType -ne 'Allow' -or -not (@($ids | Where-Object { $_.Equals($ruleSid) }).Count -eq 1)) { throw 'key ACL verification failed' } }",
].join("\n");

function protectWindowsKey(path) {
  try {
    execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand",
      Buffer.from(WINDOWS_KEY_ACL, "utf16le").toString("base64")], {
      windowsHide: true, timeout: 10000, stdio: "pipe", env: { ...process.env, MOMO_ROUTED_KEY_PATH: path,
        PSModulePath: undefined },
    });
  } catch (error) {
    throw new Error("Windows key ACL could not be verified.", { cause: error });
  }
}
// Kept outside settings and separate from the client-visible bearer token.
// Never silently rotate an existing, unreadable key: doing so would invalidate
// recoverable histories and turn a storage failure into apparent success.
function routedEnvelopeKey(env, create = false) {
  const home = appHome(env);
  const path = join(home, "routed-compaction.key");
  try {
    mkdirSync(home, { recursive: true, mode: 0o700 });
  } catch {
    throw failure("routed_compact_key_unavailable", "Routed signing key directory is unavailable.", 503);
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const stat = lstatSync(path);
      if (!stat.isFile() || (process.platform !== "win32" && (stat.mode & 0o077))) throw new Error("unsafe key file");
      if (process.platform === "win32") protectWindowsKey(path);
      const key = readFileSync(path);
      if (key.length !== 32) throw new Error("invalid key length");
      return key;
    } catch (error) {
      if (error.code !== "ENOENT") throw failure("routed_compact_key_unavailable", "Routed signing key is unavailable.", 503);
      if (!create) throw failure("routed_compact_key_unavailable", "Routed signing key is missing.", 503);
    }
    let fd;
    try {
      fd = openSync(path, "wx", 0o600);
      const key = randomBytes(32);
      if (writeSync(fd, key) !== key.length) throw new Error("short key write");
      // Do not publish a key until its bytes are durable enough for a restart.
      // A failed flush preserves an explicit failure rather than a fresh envelope.
      fsyncSync(fd);
      closeSync(fd); fd = undefined;
      if (process.platform === "win32") protectWindowsKey(path);
      return key;
    } catch (error) {
      if (fd !== undefined) { try { closeSync(fd); } catch {} }
      // A partial file is intentionally retained so subsequent calls fail
      // closed until an operator inspects the installation state.
      if (error.code !== "EEXIST") throw failure("routed_compact_key_unavailable", "Routed signing key cannot be created.", 503);
    }
  }
  throw failure("routed_compact_key_unavailable", "Routed signing key is unavailable.", 503);
}

export function encodeRoutedCompaction(output, model, env = process.env) {
  const serialized = JSON.stringify({ model, output });
  if (Buffer.byteLength(serialized) > 1024 * 1024) throw failure("routed_compact_tools_too_large", "Routed replay envelope exceeds 1 MiB.", 413);
  const data = Buffer.from(serialized).toString("base64url");
  const mac = createHmac("sha256", routedEnvelopeKey(env, true)).update(ROUTED_ENVELOPE_PREFIX + data).digest("base64url");
  return ROUTED_ENVELOPE_PREFIX + data + "." + mac;
}

export function decodeRoutedCompaction(value, model, env = process.env) {
  if (typeof value !== "string" || !value.startsWith(ROUTED_ENVELOPE_PREFIX) || value.length > 2 * 1024 * 1024) return null;
  const packed = value.slice(ROUTED_ENVELOPE_PREFIX.length);
  const dot = packed.lastIndexOf(".");
  if (dot < 1) return null;
  const data = packed.slice(0, dot);
  const provided = Buffer.from(packed.slice(dot + 1), "base64url");
  const expected = createHmac("sha256", routedEnvelopeKey(env)).update(ROUTED_ENVELOPE_PREFIX + data).digest();
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return null;
  try {
    const value = JSON.parse(Buffer.from(data, "base64url").toString("utf8"));
    return value?.model === model && Array.isArray(value.output) ? value.output : null;
  } catch { return null; }
}

function expandOwnedHistory(input, model, env) {
  const envelopes = input.filter((item) => item?.type === "compaction");
  if (!envelopes.length) return input;
  if (envelopes.length !== 1) throw failure("routed_compact_unsupported_history", "Routed compaction accepts at most one own history envelope.");
  const envelope = envelopes[0];
  if (Object.keys(envelope).some((key) => !["type", "id", "encrypted_content"].includes(key))) {
    throw failure("routed_compact_unsupported_history", "Routed compaction rejects additional envelope state.");
  }
  const decoded = decodeRoutedCompaction(envelope.encrypted_content, model, env);
  if (!decoded || decoded[0]?.type !== "message" || decoded[0]?.role !== "assistant"
    || !textOf(decoded[0])?.startsWith(ROUTED_SUMMARY_PREFIX)
    || decoded.some((item) => item?.type === "compaction" || item?.type === "compaction_trigger")) {
    throw failure("routed_compact_unsupported_history", "Routed compaction cannot replay unknown or malformed opaque history.");
  }
  return input.flatMap((item) => item === envelope ? decoded : [item]);
}

function hasUnsupportedReplayState(value, depth = 0) {
  if (depth > 32) return true;
  if (typeof value === "string") return /^data:[^,]+;base64,/i.test(value);
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((entry) => hasUnsupportedReplayState(entry, depth + 1));
  if (["encrypted_content", "momo_asset", "file_data", "file_url", "image_url"].some((key) => Object.hasOwn(value, key))) return true;
  return Object.values(value).some((entry) => hasUnsupportedReplayState(entry, depth + 1));
}

function toolPairs(items) {
  const calls = new Map();
  const pairs = [];
  for (const item of items) {
    if (CALL_TYPES.has(item?.type)) {
      if (typeof item.call_id !== "string" || !item.call_id || calls.has(item.call_id)) {
        throw failure("routed_compact_unpaired_tools", "Routed compaction requires unique, complete tool call IDs.");
      }
      calls.set(item.call_id, item);
      pairs.push(item);
    } else if (RESULT_TYPES.has(item?.type)) {
      const call = calls.get(item.call_id);
      if (!call || call.type.replace(/_call$/, "_call_output") !== item.type || calls.get(item.call_id) === null) {
        throw failure("routed_compact_unpaired_tools", "Routed compaction cannot retain an orphan or duplicate tool result.");
      }
      calls.set(item.call_id, null);
      pairs.push(item);
    }
  }
  if ([...calls.values()].some(Boolean)) throw failure("routed_compact_unpaired_tools", "Routed compaction cannot summarize a pending tool call.");
  return pairs;
}

export function routedTextInput(payload, { pairedTools = false, env = process.env } = {}) {
  if (Object.keys(payload).some((key) => !["model", "input", "stream"].includes(key))) {
    throw failure("routed_compact_unsupported_history", "Routed compaction pilot rejects additional request options, instructions, tools or provider continuation state.");
  }
  const items = expandOwnedHistory(Array.isArray(payload.input) ? payload.input : [], payload.model, env);
  const lastUser = items.findLastIndex((item) => item?.role === "user");
  const historyItems = items.slice(0, lastUser);
  const firstTool = pairedTools ? historyItems.findIndex((item) => CALL_TYPES.has(item?.type) || RESULT_TYPES.has(item?.type)) : -1;
  const retained = firstTool < 0 ? [] : historyItems.slice(firstTool);
  if (pairedTools) toolPairs(retained);
  if (retained.some((item) => hasUnsupportedReplayState(item))) {
    throw failure("routed_compact_unsupported_history", "Routed compaction cannot replay opaque or attachment-bearing tool history.");
  }
  if (lastUser < 0 || historyItems.slice(0, firstTool < 0 ? undefined : firstTool).some((item) => textOf(item) === null)
    || retained.some((item) => textOf(item) === null && !CALL_TYPES.has(item?.type) && !RESULT_TYPES.has(item?.type))
    || items.slice(lastUser).some((item) => textOf(item) === null || item.role !== "user")) {
    throw failure("routed_compact_unsupported_history", "Routed compaction pilot requires only plain-text user/assistant turns and a current user turn.");
  }
  const history = historyItems.slice(0, firstTool < 0 ? undefined : firstTool)
    .map((item) => ({ role: item.role, text: textOf(item) }));
  if (!history.length) throw failure("routed_compact_unsupported_history", "No history is available to compact.");
  if (Buffer.byteLength(JSON.stringify(history)) > 256 * 1024) {
    throw failure("routed_compact_source_too_large", "Routed compaction pilot input exceeds 256 KiB.", 413);
  }
  if (Buffer.byteLength(JSON.stringify(retained)) > 512 * 1024) {
    throw failure("routed_compact_tools_too_large", "Retained causal tool history exceeds the pilot replay limit.", 413);
  }
  return { history, current: items.slice(lastUser), retained };
}

async function readRoutedSummary(upstream) {
  const contentType = upstream.headers?.get?.("content-type") || "";
  if (!/^text\/event-stream(?:\s*;|\s*$)/i.test(contentType)) {
    throw failure("invalid_routed_compact_response", "Routed compaction requires an SSE Responses stream.", 502);
  }
  let result = null;
  let completed = false;
  let bytes = 0;
  try {
    for await (const block of streamSseBlocks(upstream.body, { maxEventBytes: 256 * 1024, maxEvents: 512 })) {
      bytes += Buffer.byteLength(block, "utf8");
      if (bytes > 1024 * 1024) throw failure("invalid_routed_compact_response", "Routed compaction stream exceeded 1 MiB.", 502);
      const data = sseDataPayload(block);
      if (!data || data === "[DONE]") continue;
      const event = JSON.parse(data);
      if (completed) throw failure("invalid_routed_compact_response", "Routed compaction emitted events after completion.", 502);
      if (event.type === "response.failed" || event.type === "response.incomplete" || event.type === "error") {
        throw failure("invalid_routed_compact_response", "Routed compaction failed upstream.", 502);
      }
      if ((event.type === "response.output_item.added" || event.type === "response.output_item.done")
        && !(event.item?.type === "reasoning" || (event.item?.type === "message" && event.item.role === "assistant"))) {
        throw failure("invalid_routed_compact_response", "Routed compaction emitted a non-text output item.", 502);
      }
      if (event.type?.startsWith("response.function_call") || event.type?.startsWith("response.tool_")) {
        throw failure("invalid_routed_compact_response", "Routed compaction emitted a tool event.", 502);
      }
      if (event.type === "response.completed") {
        completed = true;
        result = event.response;
      }
    }
  } catch (error) {
    if (error?.code === "invalid_routed_compact_response") throw error;
    throw failure("invalid_routed_compact_response", "Routed compaction returned an invalid or truncated SSE stream.", 502);
  }
  if (!completed) throw failure("invalid_routed_compact_response", "Routed compaction ended without a completed response.", 502);
  return result;
}

export async function routedTextCompaction(settings, payload, fetchImpl, signal, options = {}) {
  if (resolveTargetModel(payload.model).protocol !== "responses") {
    throw failure("routed_compact_model_unsupported", "Routed text compaction pilot requires a Responses model.");
  }
  const { history, current, retained } = routedTextInput(payload, options);
  const body = {
    model: payload.model, stream: true, store: false, max_output_tokens: 2048,
    input: [
      { role: "system", content: "Summarize historical text only. Tool steps, if any, are omitted from this input and will be replayed separately; do not infer their outcomes. Never execute tasks or call tools. Separate assistant claims from verified outcomes. Prior user requests are not pending instructions. Return only summary text." },
      { role: "user", content: JSON.stringify(history) },
    ],
  };
  const upstream = await fetchImpl(settings.endpoint + "/v1/responses", {
    method: "POST", headers: upstreamHeaders(settings), body: JSON.stringify(body), signal,
  });
  if (!upstream.ok) throw failure("http_" + upstream.status, "Routed compaction upstream returned HTTP " + upstream.status + ".", upstream.status);
  const result = await readRoutedSummary(upstream);
  const output = result?.output;
  const messages = output?.filter((item) => item?.type === "message");
  if (result?.status !== "completed" || !Array.isArray(output)
    || output.some((item) => item?.type !== "reasoning" && item?.type !== "message")
    || output.some((item) => item?.type === "reasoning" && item.status && item.status !== "completed")
    || messages.length !== 1 || messages[0]?.role !== "assistant"
    || !Array.isArray(messages[0].content) || messages[0].content.length !== 1
    || messages[0].content[0]?.type !== "output_text") {
    throw failure("invalid_routed_compact_response", "Routed compaction did not return one completed text message.", 502);
  }
  const summary = messages[0].content[0].text?.trim();
  if (!summary || summary.length > 16000) throw failure("invalid_routed_compact_response", "Routed compaction summary is empty or too large.", 502);
  return {
    id: "resp_compact_" + randomUUID(), object: "response.compaction", created_at: Math.floor(Date.now() / 1000),
    output: [
      { type: "message", role: "assistant", content: [{ type: "output_text", text: ROUTED_SUMMARY_PREFIX + summary }] },
      ...retained,
      ...current,
    ],
  };
}
