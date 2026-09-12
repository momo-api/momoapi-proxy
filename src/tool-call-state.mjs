import { randomUUID } from "node:crypto";

const MAX_CACHED_CALLS = 512;

function normalizeSingleExecCommand(raw) {
  const call = /^(?:await\s+)?tools\.exec_command\(\s*([\s\S]*?)\s*\)\s*;?$/.exec(raw);
  if (!call) return null;
  const argument = call[1].trim();
  const quoted = /^("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)$/.exec(argument);
  if (quoted && !quoted[1].includes("${")) {
    return `await tools.exec_command({ cmd: ${quoted[1]} });`;
  }

  try {
    const parsed = JSON.parse(argument);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const keys = Object.keys(parsed);
      if (keys.length === 1 && typeof parsed.command === "string") {
        return `await tools.exec_command({ cmd: ${JSON.stringify(parsed.command)} });`;
      }
      if (keys.length === 1 && typeof parsed.cmd === "string") {
        return `await tools.exec_command({ cmd: ${JSON.stringify(parsed.cmd)} });`;
      }
    }
  } catch {}

  const object = /^\{\s*(?:["']?(command|cmd)["']?)\s*:\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)\s*,?\s*\}$/.exec(argument);
  if (object && !object[2].includes("${")) {
    return `await tools.exec_command({ cmd: ${object[2]} });`;
  }
  return null;
}

export function customInput(value) {
  let raw = "";
  if (typeof value === "string") {
    raw = value;
  } else if (value && typeof value === "object") {
    if (typeof value.patch === "string") return value.patch;
    if (typeof value.input === "string") raw = value.input;
    else if (typeof value.raw === "string") raw = value.raw;
    else if (typeof value.command === "string") raw = value.command;
    else if (typeof value.cmd === "string") raw = value.cmd;
    else if (value.input !== undefined) raw = typeof value.input === "object" ? JSON.stringify(value.input) : String(value.input);
    else if (value.raw !== undefined) raw = typeof value.raw === "object" ? JSON.stringify(value.raw) : String(value.raw);
    else if (value.command !== undefined) raw = typeof value.command === "object" ? JSON.stringify(value.command) : String(value.command);
    else if (value.cmd !== undefined) raw = typeof value.cmd === "object" ? JSON.stringify(value.cmd) : String(value.cmd);
    else raw = JSON.stringify(value);
  } else {
    raw = String(value ?? "");
  }

  raw = raw.trim();
  if (raw.startsWith("*** Begin Patch")) return raw;
  if (!raw) return "";
  const normalizedExec = normalizeSingleExecCommand(raw);
  if (normalizedExec) return normalizedExec;

  // Auto-wrap bare shell commands / scripts into valid Codex V8 isolate JavaScript
  // Unified exec exposes these JavaScript helpers directly, not as shell commands.
  // Match a complete helper call (including whitespace/comments), not a prefix.
  const hostHelperCall = /^(?:text|image|audio|generatedImage|store|load|notify|exit|setTimeout|clearTimeout|yield_control)(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*(?:\r?\n|$))*\(/.test(raw);
  const isJs = hostHelperCall || raw.startsWith("await ") || raw.startsWith("tools.") || raw.startsWith("const ") || raw.startsWith("let ") || raw.startsWith("var ") || raw.startsWith("function ") || raw.startsWith("return ") || raw.startsWith("/*") || raw.startsWith("//") || raw.startsWith("try {");
  if (!isJs) {
    return `await tools.exec_command({ cmd: ${JSON.stringify(raw)} });`;
  }
  return raw;
}

function rememberCall(calls, callId, value) {
  calls.set(callId, { createdAt: Date.now(), ...value });
  while (calls.size > MAX_CACHED_CALLS) {
    const oldest = calls.keys().next().value;
    if (oldest === undefined) break;
    calls.delete(oldest);
  }
}

export function emitRememberedCall(emitter, calls, mapped, args, callId, context = {}) {
  const id = callId || "call_" + randomUUID();
  rememberCall(calls, id, { name: mapped.name, originalName: mapped.originalName, kind: mapped.kind, arguments: args, ...context });
  try {
    return mapped.kind === "custom"
      ? emitter.writeCustomToolCall({ callId: id, name: mapped.originalName, input: customInput(args) })
      : emitter.writeFunctionCall({ callId: id, name: mapped.originalName, arguments: args });
  } catch (error) { calls.delete(id); throw error; }
}
