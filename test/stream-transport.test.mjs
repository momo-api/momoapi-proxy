import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter, getEventListeners } from "node:events";
import { SseFramer, streamSseBlocks, splitSseBlocks, sseDataPayload, replaceSseDataPayload, writeResponseChunk, forwardResponseBody } from "../src/stream-transport.mjs";
import { parseSse } from "../src/responses-sse.mjs";

async function blocks(chunks, options) { return Array.fromAsync(streamSseBlocks(chunks, options)); }

test("UTF-8 and every split position preserve SSE payloads for LF/CRLF/CR", async () => {
  for (const nl of ["\n", "\r\n", "\r"]) {
    const text = ': comment' + nl + 'event: value' + nl + 'data: {"text":"中文😀"}' + nl + nl + 'data: [DONE]' + nl + nl;
    const expected = [...splitSseBlocks(text)];
    const bytes = Buffer.from(text);
    for (let index = 0; index <= bytes.length; index++) {
      assert.deepEqual(await blocks([bytes.subarray(0, index), bytes.subarray(index)]), expected, "split " + index + " newline " + JSON.stringify(nl));
    }
    assert.deepEqual(await blocks([...bytes].map((byte) => Uint8Array.of(byte))), expected);
    assert.deepEqual(parseSse(text), [{ text: "中文😀" }]);
  }
});

test("multiline data, comments, empty fields, mixed line endings and EOF stay consistent", async () => {
  const text = ':comment\r\ndata: {\ndata: "value": "中文"\rdata: }\r\n\r\n: ping\n\ndata\n\ndata: [DONE]\n\ndata: {"last":true}';
  const parsed = parseSse(text);
  assert.deepEqual(parsed, [{ value: "中文" }, { last: true }]);
  const framed = await blocks([text]);
  assert.equal(sseDataPayload(framed[0]), '{\n"value": "中文"\n}');
  assert.equal(sseDataPayload(framed[1]), null);
  assert.equal(sseDataPayload(framed[2]), "");
  const replaced = replaceSseDataPayload(framed[0], '{"replaced":true}');
  assert.equal(sseDataPayload(replaced), '{"replaced":true}');
  assert.equal(replaced.split("\n").filter((line) => line.startsWith("data:")).length, 1);
  assert.ok(replaced.startsWith(":comment"));
});

test("complete frames are yielded before another upstream read, and return closes the iterator", async () => {
  let reads = 0;
  let returned = false;
  async function* source() { try { reads++; yield Buffer.from('data: 1\r\n\r\ndata: 2\r\n\r\n'); reads++; yield Buffer.from('data: 3'); } finally { returned = true; } }
  const iterator = streamSseBlocks(source());
  assert.equal((await iterator.next()).value, "data: 1");
  assert.equal((await iterator.next()).value, "data: 2");
  assert.equal(reads, 1);
  await iterator.return();
  assert.equal(returned, true);
});

test("event budget is incremental, includes comments, resets per event and never logs payload", async () => {
  assert.deepEqual(await blocks([Buffer.from('data: 1\n\ndata: 2\n\n')], { maxEventBytes: 8 }), ["data: 1", "data: 2"]);
  await assert.rejects(blocks([Buffer.from(': private_marker_long')], { maxEventBytes: 8 }), (error) => error.code === "upstream_sse_event_too_large" && !error.message.includes("private_marker"));
  const framer = new SseFramer({ maxEventBytes: 8 });
  assert.deepEqual([...framer.push("data:")], []);
  assert.throws(() => [...framer.push("abcd")], { code: "upstream_sse_event_too_large" });
});

test("invalid and truncated UTF-8 fail explicitly instead of corrupting a tool argument", async () => {
  for (const invalid of [Uint8Array.of(0xff), Buffer.from([0xe4, 0xb8])]) {
    await assert.rejects(blocks([invalid]), { code: "upstream_invalid_utf8" });
  }
});

class SlowResponse extends EventEmitter {
  writableNeedDrain = false;
  destroyed = false;
  writableEnded = false;
  writes = [];
  write(chunk) { this.writes.push(chunk); this.writableNeedDrain = true; return false; }
  drain() { this.writableNeedDrain = false; this.emit("drain"); }
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

test("slow client pauses upstream iteration until drain without losing bytes", async () => {
  const response = new SlowResponse();
  let reads = 0;
  async function* source() { reads++; yield Buffer.from("one"); reads++; yield Buffer.from("two"); }
  const forwarded = forwardResponseBody(source(), response);
  await tick();
  assert.equal(reads, 1);
  assert.equal(response.writes.length, 1);
  response.drain();
  await tick();
  assert.equal(reads, 2);
  response.drain();
  await forwarded;
  assert.equal(Buffer.concat(response.writes).toString(), "onetwo");
  assert.equal(response.listenerCount("close"), 0);
  assert.equal(response.listenerCount("drain"), 0);
});

test("close, abort and write error release a pending drain and remove listeners", async () => {
  for (const event of ["close", "abort", "error"]) {
    const response = new SlowResponse();
    const controller = new AbortController();
    let finalized = false;
    async function* source() { try { yield "one"; assert.fail("must not read after cancellation"); } finally { finalized = true; } }
    const forwarded = forwardResponseBody(source(), response, controller.signal);
    const rejected = assert.rejects(forwarded, event === "error" ? /synthetic write error/ : { code: "client_stream_closed" });
    await tick();
    if (event === "abort") controller.abort();
    else if (event === "error") response.emit("error", new Error("synthetic write error"));
    else { response.destroyed = true; response.emit("close"); }
    await rejected;
    assert.equal(finalized, true);
    for (const name of ["close", "error", "drain"]) assert.equal(response.listenerCount(name), 0);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  }
});

test("fast writes do not register drain listeners and closed writes are refused", async () => {
  const response = new SlowResponse();
  response.write = (chunk) => { response.writes.push(chunk); return true; };
  await writeResponseChunk(response, "one");
  assert.equal(response.listenerCount("drain"), 0);
  response.writableEnded = true;
  await assert.rejects(writeResponseChunk(response, "two"), { code: "client_stream_closed" });
  assert.deepEqual(response.writes, ["one"]);
});
