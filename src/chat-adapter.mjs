import { outputParts, safeTextValue } from "./protocol-content.mjs";

const KNOWN_METADATA_TYPES = new Set([
  "session_meta", "event_msg", "task_started", "world_state", "turn_context",
  "item_completed", "token_count", "web_search_call", "task_complete",
  "thread_settings_applied", "compacted", "turn_aborted", "inter_agent_communication_metadata",
  "agent_message",
]);

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

export function buildOpenAIChatMessages(input, instructions) {
  const messages = [];
  if (instructions && String(instructions).trim().length > 0) {
    messages.push({ role: "system", content: safeTextValue(String(instructions).trim()) });
  }

  const items = asArray(input);
  let pendingToolCalls = [];
  let seenCallIds = new Set();
  let mintedIdSeq = 0;

  const mintId = () => {
    let id = "";
    do {
      id = `call_minted_${++mintedIdSeq}`;
    } while (seenCallIds.has(id));
    seenCallIds.add(id);
    return id;
  };

  const flushPendingToolCalls = () => {
    if (pendingToolCalls.length === 0) return;
    for (const call of pendingToolCalls) {
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: `[codex-bridge] tool execution recorded for "${call.name}".`,
      });
    }
    pendingToolCalls = [];
  };

  for (const item of items) {
    if (!item) continue;
    if (typeof item === "string") {
      flushPendingToolCalls();
      messages.push({ role: "user", content: safeTextValue(item) });
      continue;
    }
    if (typeof item !== "object") continue;

    if (item.type === "agent_message" && Array.isArray(item.content)) {
      const textParts = item.content
        .filter((c) => c && (c.type === "input_text" || c.type === "text") && typeof c.text === "string")
        .map((c) => safeTextValue(c.text));
      if (textParts.length > 0) {
        flushPendingToolCalls();
        messages.push({ role: "user", content: textParts.join("\n\n") });
      }
      continue;
    }

    if (item.type && KNOWN_METADATA_TYPES.has(item.type)) continue;

    if (item.type === "message" || item.role) {
      const role = item.role === "assistant" ? "assistant" : (item.role === "developer" || item.role === "system" ? "system" : "user");
      const output = outputParts(item.content);
      const textContent = output.text;
      if (role === "assistant") {
        flushPendingToolCalls();
        messages.push({ role: "assistant", content: textContent });
      } else if (role === "system") {
        messages.push({ role: "system", content: textContent });
      } else {
        flushPendingToolCalls();
        messages.push({
          role: "user",
          content: output.images.length > 0
            ? [
              ...(textContent ? [{ type: "text", text: textContent }] : []),
              ...output.images.map((image) => ({ type: "image_url", image_url: { url: image.url } })),
            ]
            : (textContent || "Continue."),
        });
      }
      continue;
    }

    if (item.type === "function_call" || item.type === "custom_tool_call") {
      const callId = item.call_id || mintId();
      seenCallIds.add(callId);
      const name = item.name || "tool";
      let argsStr = "{}";
      if (item.type === "custom_tool_call") {
        argsStr = JSON.stringify({ input: typeof item.input === "string" ? item.input : JSON.stringify(item.input || "") });
      } else {
        argsStr = typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments || {});
      }

      const toolCallObj = {
        id: callId,
        type: "function",
        function: { name, arguments: argsStr },
      };
      const lastMsg = messages[messages.length - 1];
      if (lastMsg && lastMsg.role === "assistant") {
        lastMsg.tool_calls = lastMsg.tool_calls || [];
        lastMsg.tool_calls.push(toolCallObj);
      } else {
        messages.push({
          role: "assistant",
          content: "",
          tool_calls: [toolCallObj],
        });
      }
      pendingToolCalls.push({ id: callId, name });
      continue;
    }

    if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
      const callId = item.call_id || "call_unknown";
      const output = outputParts(item.output);
      const textOutput = output.text;
      const matchIdx = pendingToolCalls.findIndex((c) => c.id === callId);
      if (matchIdx >= 0) {
        pendingToolCalls.splice(matchIdx, 1);
      } else {
        const hasMatchingToolCall = messages.some((m) => m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.some((tc) => tc.id === callId));
        if (!hasMatchingToolCall) {
          messages.push({
            role: "assistant",
            content: "",
            tool_calls: [{ id: callId, type: "function", function: { name: "tool", arguments: "{}" } }],
          });
        }
      }
      messages.push({
        role: "tool",
        tool_call_id: callId,
        content: textOutput,
      });
      if (output.images.length > 0) {
        messages.push({
          role: "user",
          content: [
            { type: "text", text: `[image output from tool ${callId}]` },
            ...output.images.map((image) => ({ type: "image_url", image_url: { url: image.url } })),
          ],
        });
      }
      continue;
    }
  }

  flushPendingToolCalls();
  return messages.length > 0 ? messages : [{ role: "user", content: "Continue." }];
}

// Some Qwen upstreams reject "System message must be at the beginning". Codex may
// inject developer/system items mid-history (e.g. collaboration-mode notes),
// so consolidate all system messages at the front for Qwen models only.
export function normalizeQwenSystemMessages(messages) {
  const systemParts = [];
  const remaining = [];

  for (const message of asArray(messages)) {
    if (message?.role === "system") {
      const content = String(message.content || "").trim();
      if (content) systemParts.push(content);
      continue;
    }
    remaining.push(message);
  }

  if (systemParts.length === 0) return remaining;
  return [{ role: "system", content: systemParts.join("\n\n") }, ...remaining];
}
