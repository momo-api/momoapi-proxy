// Synthetic JSON-only fixtures shared by differential tests and benchmarks.
export const compactSettings = { contextPolicy: { compactBodyLimitMb: 18 } };
const MIB = 1048576;
const byteLength = (value) => Buffer.byteLength(JSON.stringify(value));
const message = (content, role = "assistant") => ({ role, content });
function padTo(body, bytes) {
  body.padding = "";
  body.padding = "p".repeat(Math.max(0, bytes - byteLength(body)));
  return body;
}
export const compactCaseNames = ["small", "marker-420", "current-64", "boundary-minus", "boundary-exact", "boundary-plus", "marker-growth", "opaque", "unshrinkable", "filtered-trigger", "unicode", "mixed", "replay", "required-overflow"];
export function compactFixture(name) {
  const body = { model: "synthetic", input: [] };
  let operation = "compact";
  if (name === "small") body.input = [message("small history"), message("latest", "user")];
  else if (name === "marker-420") body.input = [...Array.from({ length: 420 }, () => message("x".repeat(65536))), message("current 中文😀", "user")];
  else if (name === "current-64") body.input = [message("current", "user"), ...Array.from({ length: 64 }, (_, i) => ({ type: "function_call_output", call_id: String(i), output: "中".repeat(131072) }))];
  else if (name.startsWith("boundary-")) {
    body.input = [...Array.from({ length: 10 }, () => message("historic".repeat(256))), message("current", "user")];
    padTo(body, 18 * MIB + ({ "boundary-minus": -1, "boundary-exact": 0, "boundary-plus": 1 })[name]);
  } else if (name === "marker-growth") {
    body.input = [message(""), message(""), message("current", "user")];
    padTo(body, 18 * MIB + 1);
  } else if (name === "opaque") {
    body.input = [{ type: "reasoning", encrypted_content: "opaque." + "Q".repeat(18 * MIB), summary: [] }, message("current", "user")];
  } else if (name === "unshrinkable") {
    body.input = [message("current", "user")]; body.tools = [{ type: "function", name: "synthetic", description: "x".repeat(18 * MIB) }];
  } else if (name === "filtered-trigger") {
    // Preserve even the pre-existing index/boundary handling after filtering.
    body.input = [{ type: "compaction_trigger" }, { type: "compaction_trigger" }, message("hist"), message("current", "user")];
    padTo(body, 18 * MIB + 4096);
  } else if (name === "unicode") {
    body.input = [...Array.from({ length: 120 }, (_, i) => ({ type: "function_call_output", call_id: String(i), output: ('中😀"\\\n\u0000\ud800').repeat(8192) })), message("current\ud800😀", "user")];
  } else if (name === "mixed") {
    let seed = 7;
    const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
    const kinds = [message("a"), null, "raw", 1, false, { type: "function_call", name: "run", call_id: "f", arguments: "{}" }, { type: "custom_tool_call", name: "exec", call_id: "c", input: "text(1)" }, { type: "function_call_output", call_id: "f", output: "ok" }, { type: "custom_tool_call_output", call_id: "c", output: "ok" }, { type: "reasoning", summary: [] }, { type: "additional_tools", tools: [] }];
    body.input = Array.from({ length: 96 }, () => structuredClone(kinds[next() % kinds.length]));
    body.input.push(message("current", "user")); padTo(body, 18 * MIB + 2048);
  } else if (name === "replay") {
    operation = "replay";
    body.tool_choice = "required";
    body.input = [message("system constraint", "system"), message("developer constraint", "developer"), message("original task", "user"), { type: "additional_tools", tools: [{ type: "custom", name: "dynamic" }] }, ...Array.from({ length: 128 }, () => message("x".repeat(65536))), { type: "custom_tool_call", name: "exec", call_id: "done", input: "text(1)" }, { type: "custom_tool_call_output", call_id: "done", output: "verified 中文😀" }, { type: "custom_tool_call", name: "exec", call_id: "pending", input: "text(2)" }, message("latest task", "user"), { type: "custom_tool_call_output", call_id: "pending", output: "latest evidence" }];
  } else if (name === "required-overflow") {
    operation = "replay";
    body.input = [message("original", "user"), { type: "custom_tool_call", name: "exec", call_id: "pending", input: "x".repeat(900001) }, message("latest", "user")];
  } else throw new Error("Unknown synthetic fixture");
  body.stream = true; body.previous_response_id = "resp_synthetic";
  return { body, operation };
}

export function compactOutcome(api, body, operation) {
  try {
    const result = operation === "replay" ? api.prepareOversizedHistoryReplay(body) : api.prepareCompactPayload(body, compactSettings);
    return { result };
  } catch (error) {
    return { error: { code: error.code, statusCode: error.statusCode, message: error.message, ...(error.details ? { details: error.details } : {}), ...(error.localCheckpointInput ? { localCheckpointInput: error.localCheckpointInput } : {}) }, payload: body };
  }
}
