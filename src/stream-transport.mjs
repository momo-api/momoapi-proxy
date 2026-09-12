// Shared framing only: protocol conversion and tool identities stay in adapters.
export const MAX_SSE_EVENT_BYTES = 32 * 1024 * 1024;

function streamError(message, code) {
  return Object.assign(new Error(message), { statusCode: 502, code });
}

export class SseFramer {
  constructor({ maxEventBytes = MAX_SSE_EVENT_BYTES } = {}) {
    if (!Number.isSafeInteger(maxEventBytes) || maxEventBytes < 1) throw new RangeError("Invalid SSE event budget");
    this.maxEventBytes = maxEventBytes;
    this.bytes = 0;
    this.parts = [];
    this.fragment = "";
    this.lines = [];
    this.skipLf = false;
  }

  append(text) {
    this.account(Buffer.byteLength(text, "utf8"));
    if (!text) return;
    // Coalesce tiny network chunks without retaining one array slot per byte,
    // or repeatedly copying the entire pending line.
    if (text.length >= 4096) {
      if (this.fragment) this.parts.push(this.fragment);
      this.fragment = "";
      this.parts.push(text);
    } else {
      this.fragment += text;
      if (this.fragment.length >= 4096) { this.parts.push(this.fragment); this.fragment = ""; }
    }
  }

  account(bytes) {
    this.bytes += bytes;
    if (this.bytes > this.maxEventBytes) throw streamError("Upstream SSE event exceeded its buffer budget.", "upstream_sse_event_too_large");
  }

  *push(text) {
    let offset = 0;
    const newline = /[\r\n]/g;
    while (offset < text.length) {
      if (this.skipLf) {
        this.skipLf = false;
        if (text[offset] === "\n") offset++;
      }
      newline.lastIndex = offset;
      const match = newline.exec(text);
      if (!match) { this.append(text.slice(offset)); break; }
      const segment = text.slice(offset, match.index);
      let line;
      if (this.parts.length || this.fragment) {
        this.append(segment);
        line = this.parts.join("") + this.fragment;
        this.parts = [];
        this.fragment = "";
      } else {
        this.account(Buffer.byteLength(segment, "utf8"));
        line = segment;
      }
      this.skipLf = match[0] === "\r";
      offset = match.index + 1;
      if (line) {
        this.lines.push(line);
        this.account(1); // Canonical line separator, not buffered twice.
      } else {
        const block = this.lines.join("\n");
        this.lines = [];
        this.bytes = 0;
        if (block) yield block;
      }
    }
  }

  *finish() {
    if (this.parts.length || this.fragment) this.lines.push(this.parts.join("") + this.fragment);
    const block = this.lines.join("\n");
    this.parts = [];
    this.fragment = "";
    this.lines = [];
    this.bytes = 0;
    if (block) yield block; // Preserve the existing unterminated-final-event compatibility.
  }
}

export function* splitSseBlocks(text, options) {
  const framer = new SseFramer(options);
  yield* framer.push(text);
  yield* framer.finish();
}

export async function* streamSseBlocks(body, options) {
  if (!body) return;
  if (typeof body === "string") body = [body];
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const framer = new SseFramer(options);
  let events = 0;
  const admit = () => {
    if (++events > (options?.maxEvents ?? Infinity)) throw streamError("Upstream output exceeded the event count budget.", "output_budget_exceeded");
  };
  function decode(chunk, stream) {
    try { return decoder.decode(chunk, { stream }); }
    catch { throw streamError("Upstream SSE contained invalid UTF-8.", "upstream_invalid_utf8"); }
  }
  for await (const chunk of body) {
    const text = typeof chunk === "string" ? decode(undefined, false) + chunk : decode(chunk, true);
    for (const block of framer.push(text)) { admit(); yield block; }
  }
  for (const block of framer.push(decode(undefined, false))) { admit(); yield block; }
  for (const block of framer.finish()) { admit(); yield block; }
}

export function sseDataPayload(block) {
  const data = [];
  for (const line of block.split(/\r\n|[\r\n]/)) {
    if (line === "data") data.push("");
    else if (line.startsWith("data:")) {
      const value = line.slice(5);
      data.push(value.startsWith(" ") ? value.slice(1) : value);
    }
  }
  return data.length ? data.join("\n") : null;
}

export function replaceSseDataPayload(block, payload) {
  const newline = block.includes("\r\n") ? "\r\n" : "\n";
  const rewritten = [];
  let replaced = false;
  for (const line of block.split(/\r\n|[\r\n]/)) {
    if (line !== "data" && !line.startsWith("data:")) rewritten.push(line);
    else if (!replaced) { rewritten.push("data: " + payload); replaced = true; }
  }
  return replaced ? rewritten.join(newline) : block;
}

export function waitForResponseDrain(response, signal) {
  const closed = () => signal?.aborted || response.destroyed || response.writableEnded;
  if (closed()) return Promise.reject(streamError("Client response is closed.", "client_stream_closed"));
  if (!response.writableNeedDrain) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      response.off("drain", onDrain);
      response.off("close", onClose);
      response.off("error", onError);
      signal?.removeEventListener("abort", onClose);
    };
    const onDrain = () => { cleanup(); resolve(); };
    const onError = (error) => { cleanup(); reject(error); };
    const onClose = () => onError(streamError("Client response closed while waiting for drain.", "client_stream_closed"));
    response.once("drain", onDrain);
    response.once("close", onClose);
    response.once("error", onError);
    signal?.addEventListener("abort", onClose, { once: true });
    if (closed()) onClose();
    else if (!response.writableNeedDrain) onDrain();
  });
}

export async function writeResponseChunk(response, chunk, signal) {
  if (signal?.aborted || response.destroyed || response.writableEnded) throw streamError("Client response is closed.", "client_stream_closed");
  if (!response.write(chunk)) await waitForResponseDrain(response, signal);
}

export async function forwardResponseBody(body, response, signal) {
  for await (const chunk of body) await writeResponseChunk(response, chunk, signal);
}
