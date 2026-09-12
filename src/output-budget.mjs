const MIB = 1024 * 1024;
export function outputBudgetError() {
  return Object.assign(new Error("Upstream output exceeded the local safety budget; the response is incomplete. Start a new request with an explicit handoff."), { statusCode: 502, code: "output_budget_exceeded" });
}
export function resolveOutputPolicy(settings = {}) {
  const supplied = settings.outputPolicy || {};
  const specs = { maxStreamMb: [64, 1, 256], maxRetainedMb: [16, 1, 64], maxEvents: [65536, 1, 262144], maxItems: [16384, 1, 65536], maxCallCacheMb: [64, 1, 256] };
  return Object.fromEntries(Object.entries(specs).map(([key, [fallback, min, max]]) => {
    const value = supplied[key];
    return [key, Number.isSafeInteger(value) && value >= min && value <= max ? value : fallback];
  }));
}

// Logical UTF-8 bytes + structural nodes, not V8 heap/RSS. Monotonic per response:
// reassigning a snapshot does not refund its budget. This also bounds churn.
export class RetainedOutputBudget {
  constructor(settings = {}) {
    const policy = resolveOutputPolicy(settings);
    this.maxBytes = policy.maxRetainedMb * MIB;
    this.maxItems = policy.maxItems;
    this.bytes = 0;
    this.items = 0;
  }
  charge(bytes, items = 0) {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || !Number.isSafeInteger(items) || items < 0
      || this.bytes + bytes > this.maxBytes || this.items + items > this.maxItems) throw outputBudgetError();
    this.bytes += bytes;
    this.items += items;
  }
  text(value, items = 0) { this.charge(Buffer.byteLength(value, "utf8"), items); }
  value(value) {
    const visit = (node, depth) => {
      if (depth > 64) throw outputBudgetError();
      this.charge(8, 1);
      if (typeof node === "string") this.text(node);
      else if (Array.isArray(node)) { for (const item of node) visit(item, depth + 1); }
      else if (node && typeof node === "object") {
        for (const key in node) if (Object.hasOwn(node, key)) { this.text(key); visit(node[key], depth + 1); }
      }
    };
    visit(value, 0);
  }
}

export async function* budgetedOutputBody(body, settings = {}) {
  const maxBytes = resolveOutputPolicy(settings).maxStreamMb * MIB;
  let bytes = 0;
  const source = typeof body === "string" ? [body] : body;
  if (!source) return;
  for await (const chunk of source) {
    bytes += typeof chunk === "string" ? Buffer.byteLength(chunk, "utf8") : chunk.byteLength;
    if (bytes > maxBytes) throw outputBudgetError();
    yield chunk;
  }
}

// Bounded diagnostic/error/non-stream body. Production fetch always has a body;
// text-only mocks are supported but cannot avoid that mock's own allocation.
export async function readBoundedOutputText(upstream, maxBytes = MIB) {
  if (!upstream.body) {
    const text = await upstream.text();
    if (Buffer.byteLength(text, "utf8") > maxBytes) throw outputBudgetError();
    return text;
  }
  let bytes = 0, text = "";
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for await (const chunk of upstream.body) {
    bytes += typeof chunk === "string" ? Buffer.byteLength(chunk, "utf8") : chunk.byteLength;
    if (bytes > maxBytes) throw outputBudgetError();
    text += typeof chunk === "string" ? decoder.decode() + chunk : decoder.decode(chunk, { stream: true });
  }
  return text + decoder.decode();
}

export class BoundedCallCache extends Map {
  constructor(settings = {}) {
    super();
    this.settings = settings;
    this.maxBytes = resolveOutputPolicy(settings).maxCallCacheMb * MIB;
    this.bytes = 0;
    this.weights = new Map();
    this.evicted = 0;
  }
  set(id, value) {
    const measured = new RetainedOutputBudget(this.settings);
    measured.maxBytes = this.maxBytes;
    measured.value(value); measured.value(id);
    // Admit a whole entry or fail before the corresponding tool is emitted.
    this.delete(id);
    while (this.size >= 512 || this.bytes + measured.bytes > this.maxBytes) {
      this.delete(this.keys().next().value); this.evicted++;
    }
    super.set(id, value); this.weights.set(id, measured.bytes); this.bytes += measured.bytes;
    return this;
  }
  delete(id) {
    if (!super.has(id)) return false;
    this.bytes -= this.weights.get(id) || 0; this.weights.delete(id);
    return super.delete(id);
  }
  clear() { super.clear(); this.weights.clear(); this.bytes = 0; }
  requireContinuation(items, field) {
    if (!items.length || !items.every((item) => item && ["function_call_output", "custom_tool_call_output"].includes(item.type))) return;
    if (items.every((item) => this.get(item.call_id)?.[field])) return;
    throw Object.assign(new Error("Tool continuation state is unavailable or was evicted. Resend the complete call/result history with its required provider metadata, or start a new task with an explicit handoff."), { statusCode: 409, code: "tool_continuation_unavailable" });
  }
  snapshot() { return { entries: this.size, bytes: this.bytes, maxBytes: this.maxBytes, evicted: this.evicted }; }
}
