import { decodeLocalCompaction } from "./compaction.mjs";
import { responsesToolOutput, safeTextValue } from "./protocol-content.mjs";

const ALLOWED_CONTENT_TYPES = new Set(["input_text", "output_text", "input_image", "input_file"]);
const KNOWN_METADATA_TYPES = new Set([
  "session_meta", "event_msg", "task_started", "world_state", "turn_context",
  "item_completed", "token_count", "web_search_call", "task_complete",
  "thread_settings_applied", "compacted", "turn_aborted", "inter_agent_communication_metadata",
  "agent_message",
]);

export function normalizeResponsesPayload(payload) {
  const normalized = { ...payload };
  const rawInput = Array.isArray(normalized.input) ? normalized.input : [];
  const cleanInput = [];
  const loadedToolSpecs = [];

  if (Array.isArray(payload.tools)) {
    loadedToolSpecs.push(...payload.tools);
  }

  for (const item of rawInput) {
    if (!item) continue;
    if (typeof item === "string") {
      cleanInput.push({
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: safeTextValue(item) }],
      });
      continue;
    }
    if (typeof item !== "object") continue;

    if (item.type === "compaction" && typeof item.encrypted_content === "string") {
      const recovered = decodeLocalCompaction(item.encrypted_content);
      if (recovered) cleanInput.push(...recovered);
      else cleanInput.push(item);
      continue;
    }

    if (item.type === "compaction_trigger") {
      cleanInput.push(item);
      continue;
    }

    if (item.type === "additional_tools") {
      if (Array.isArray(item.tools)) loadedToolSpecs.push(...item.tools);
      cleanInput.push(item);
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
        content: [{ ...item, text: safeTextValue(item.text) }],
      });
      continue;
    }

    if (item.type === "function_call_output") {
      cleanInput.push({
        type: "function_call_output",
        call_id: item.call_id || "call_unknown",
        output: responsesToolOutput(item.output),
      });
      continue;
    }

    if (item.type === "custom_tool_call_output") {
      cleanInput.push({
        type: "custom_tool_call_output",
        call_id: item.call_id || "call_unknown",
        output: responsesToolOutput(item.output),
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
        content = [{ type: contentType, text: safeTextValue(item.content) }];
      } else if (Array.isArray(item.content)) {
        for (const part of item.content) {
          if (!part) continue;
          if (typeof part === "string") {
            const contentType = role === "assistant" ? "output_text" : "input_text";
            content.push({ type: contentType, text: safeTextValue(part) });
          } else if (typeof part === "object") {
            if (ALLOWED_CONTENT_TYPES.has(part.type)) {
              if ((part.type === "input_text" || part.type === "output_text") && typeof part.text === "string") {
                content.push({ ...part, text: safeTextValue(part.text) });
              } else {
                content.push(part);
              }
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
        cleanInput.push({ type: "message", role, content });
      }
    }
  }

  normalized.input = cleanInput;

  if (loadedToolSpecs.length > 0) {
    const builtTools = [];
    const seenNames = new Set();

    const pushFn = (tool) => {
      const name = tool.name || tool.function?.name;
      if (!name || seenNames.has(name)) return;
      seenNames.add(name);
      builtTools.push({
        type: "function",
        name,
        description: tool.description || tool.function?.description || "",
        parameters: tool.parameters || tool.function?.parameters || { type: "object", properties: {} },
        ...(tool.strict !== undefined ? { strict: tool.strict } : {}),
      });
    };

    const pushCustom = (tool) => {
      const name = tool.name;
      if (!name || seenNames.has(name)) return;
      seenNames.add(name);
      const inputDescription = name === "exec"
        ? "JavaScript source for unified exec. Use await tools.exec_command(...) for shell commands and text(...) to return textual output; do not provide a bare shell command."
        : (name === "apply_patch"
          ? "Raw tool input. For apply_patch, begin exactly with `*** Begin Patch` (no trailing `***`), then use its standard patch envelope."
          : "Raw freeform input for this tool.");
      builtTools.push({
        type: "function",
        name,
        description: tool.description || "",
        parameters: {
          type: "object",
          properties: { input: { type: "string", description: inputDescription } },
          required: ["input"],
        },
      });
    };

    for (const tool of loadedToolSpecs) {
      if (!tool || typeof tool !== "object") continue;
      if (tool.type === "namespace" && Array.isArray(tool.tools)) {
        for (const inner of tool.tools) {
          if (!inner || typeof inner !== "object") continue;
          if (inner.type === "custom") pushCustom(inner);
          else pushFn(inner);
        }
        continue;
      }
      if (tool.type === "custom") pushCustom(tool);
      else pushFn(tool);
    }
    normalized.tools = builtTools;
  } else {
    delete normalized.tools;
  }

  if (normalized.tools && normalized.tools.length > 0) {
    normalized.tool_choice = normalized.tool_choice || "auto";
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
