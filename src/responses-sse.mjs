import { randomUUID } from "node:crypto";

function event(name, payload) {
  return `event: ${name}\ndata: ${JSON.stringify({ type: name, ...payload })}\n\n`;
}

export function responseCreated(model, responseId = `resp_${randomUUID()}`) {
  return { responseId, data: event("response.created", { response: { id: responseId, object: "response", status: "in_progress", model, output: [] } }) };
}

export class ResponseStreamEmitter {
  constructor(response, model, responseId = `resp_${randomUUID()}`) {
    this.response = response;
    this.model = model;
    this.responseId = responseId;
    this.outputIndex = 0;
    this.outputItems = [];
    this.activeTextMessage = null;
  }

  start() {
    this.response.write(event("response.created", {
      response: { id: this.responseId, object: "response", status: "in_progress", model: this.model, output: [] }
    }));
    return this.responseId;
  }

  writeTextDelta(delta) {
    if (!delta) return;
    if (!this.activeTextMessage) {
      const itemId = `msg_${randomUUID()}`;
      const outIdx = this.outputIndex++;
      this.activeTextMessage = { itemId, outputIndex: outIdx, text: "" };
      this.response.write(event("response.output_item.added", {
        response_id: this.responseId,
        output_index: outIdx,
        item: { id: itemId, type: "message", role: "assistant", status: "in_progress", content: [] }
      }));
      this.response.write(event("response.content_part.added", {
        response_id: this.responseId,
        item_id: itemId,
        output_index: outIdx,
        content_index: 0,
        part: { type: "output_text", text: "" }
      }));
    }
    this.activeTextMessage.text += delta;
    this.response.write(event("response.output_text.delta", {
      response_id: this.responseId,
      item_id: this.activeTextMessage.itemId,
      output_index: this.activeTextMessage.outputIndex,
      content_index: 0,
      delta
    }));
  }

  flushTextMessage() {
    if (!this.activeTextMessage) return;
    const { itemId, outputIndex, text } = this.activeTextMessage;
    this.response.write(event("response.output_text.done", {
      response_id: this.responseId,
      item_id: itemId,
      output_index: outputIndex,
      content_index: 0,
      text
    }));
    this.response.write(event("response.content_part.done", {
      response_id: this.responseId,
      item_id: itemId,
      output_index: outputIndex,
      content_index: 0,
      part: { type: "output_text", text }
    }));
    const item = {
      id: itemId,
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text }]
    };
    this.response.write(event("response.output_item.done", {
      response_id: this.responseId,
      output_index: outputIndex,
      item
    }));
    this.outputItems.push(item);
    this.activeTextMessage = null;
  }

  writeFunctionCall({ callId, name, arguments: args }) {
    this.flushTextMessage();
    const itemId = `fc_${randomUUID()}`;
    const cid = callId || `call_${randomUUID()}`;
    const argumentsText = typeof args === "string" ? args : JSON.stringify(args || {});
    const outIdx = this.outputIndex++;
    const item = { id: itemId, type: "function_call", status: "completed", call_id: cid, name, arguments: argumentsText };
    
    this.response.write(event("response.output_item.added", {
      response_id: this.responseId,
      output_index: outIdx,
      item: { ...item, status: "in_progress", arguments: "" }
    }));
    if (argumentsText) {
      this.response.write(event("response.function_call_arguments.delta", {
        response_id: this.responseId,
        item_id: itemId,
        output_index: outIdx,
        delta: argumentsText
      }));
    }
    this.response.write(event("response.function_call_arguments.done", {
      response_id: this.responseId,
      item_id: itemId,
      output_index: outIdx,
      arguments: argumentsText
    }));
    this.response.write(event("response.output_item.done", {
      response_id: this.responseId,
      output_index: outIdx,
      item
    }));
    this.outputItems.push(item);
    return { callId: cid, itemId };
  }

  writeCustomToolCall({ callId, name, input }) {
    this.flushTextMessage();
    const itemId = `ctc_${randomUUID()}`;
    const cid = callId || `call_${randomUUID()}`;
    const inputText = String(input || "");
    const outIdx = this.outputIndex++;
    const item = { id: itemId, type: "custom_tool_call", status: "completed", call_id: cid, name, input: inputText };

    this.response.write(event("response.output_item.added", {
      response_id: this.responseId,
      output_index: outIdx,
      item: { ...item, status: "in_progress", input: "" }
    }));
    if (inputText) {
      this.response.write(event("response.custom_tool_call_input.delta", {
        response_id: this.responseId,
        item_id: itemId,
        output_index: outIdx,
        delta: inputText
      }));
    }
    this.response.write(event("response.custom_tool_call_input.done", {
      response_id: this.responseId,
      item_id: itemId,
      output_index: outIdx,
      input: inputText
    }));
    this.response.write(event("response.output_item.done", {
      response_id: this.responseId,
      output_index: outIdx,
      item
    }));
    this.outputItems.push(item);
    return { callId: cid, itemId };
  }

  complete() {
    this.flushTextMessage();
    this.response.write(event("response.completed", {
      response: {
        id: this.responseId,
        object: "response",
        status: "completed",
        model: this.model,
        output: this.outputItems
      }
    }));
    this.response.end();
  }
}

export function textEvents(responseId, index, text) {
  const itemId = `msg_${randomUUID()}`;
  return [
    event("response.output_item.added", { response_id: responseId, output_index: index, item: { id: itemId, type: "message", role: "assistant", status: "in_progress", content: [] } }),
    event("response.content_part.added", { response_id: responseId, item_id: itemId, output_index: index, content_index: 0, part: { type: "output_text", text: "" } }),
    ...(text ? [event("response.output_text.delta", { response_id: responseId, item_id: itemId, output_index: index, content_index: 0, delta: text })] : []),
    event("response.output_text.done", { response_id: responseId, item_id: itemId, output_index: index, content_index: 0, text: text || "" }),
    event("response.content_part.done", { response_id: responseId, item_id: itemId, output_index: index, content_index: 0, part: { type: "output_text", text: text || "" } }),
    event("response.output_item.done", { response_id: responseId, output_index: index, item: { id: itemId, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: text || "" }] } }),
  ];
}

export function functionEvents(responseId, index, call) {
  const itemId = `fc_${randomUUID()}`;
  const callId = call.callId || `call_${randomUUID()}`;
  const argumentsText = typeof call.arguments === "string" ? call.arguments : JSON.stringify(call.arguments || {});
  const item = { id: itemId, type: "function_call", status: "completed", call_id: callId, name: call.name, arguments: argumentsText };
  return {
    callId,
    events: [
      event("response.output_item.added", { response_id: responseId, output_index: index, item: { ...item, status: "in_progress", arguments: "" } }),
      ...(argumentsText ? [event("response.function_call_arguments.delta", { response_id: responseId, item_id: itemId, output_index: index, delta: argumentsText })] : []),
      event("response.function_call_arguments.done", { response_id: responseId, item_id: itemId, output_index: index, arguments: argumentsText }),
      event("response.output_item.done", { response_id: responseId, output_index: index, item }),
    ],
  };
}

export function customToolEvents(responseId, index, call) {
  const itemId = `ctc_${randomUUID()}`;
  const callId = call.callId || `call_${randomUUID()}`;
  const input = String(call.input || "");
  const item = { id: itemId, type: "custom_tool_call", status: "completed", call_id: callId, name: call.name, input };
  return {
    callId,
    events: [
      event("response.output_item.added", { response_id: responseId, output_index: index, item: { ...item, status: "in_progress", input: "" } }),
      ...(input ? [event("response.custom_tool_call_input.delta", { response_id: responseId, item_id: itemId, output_index: index, delta: input })] : []),
      event("response.custom_tool_call_input.done", { response_id: responseId, item_id: itemId, output_index: index, input }),
      event("response.output_item.done", { response_id: responseId, output_index: index, item }),
    ],
  };
}

export function completed(responseId, model, output = []) {
  return event("response.completed", { response: { id: responseId, object: "response", status: "completed", model, output } });
}

export function sseError(message, code = "server_error") {
  return event("error", { error: { type: "error", code, message } });
}

export function parseSse(text) {
  return text.split(/\r?\n\r?\n/).flatMap((block) => {
    const data = block.split(/\r?\n/).find((line) => line.startsWith("data:"))?.slice(5).trim();
    if (!data || data === "[DONE]") return [];
    try { return [JSON.parse(data)]; } catch { return []; }
  });
}
