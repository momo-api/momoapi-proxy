import assert from "node:assert/strict";
import test from "node:test";
import { getEventListeners } from "node:events";
import { PassThrough } from "node:stream";
import { RequestAdmission, resolveAdmissionPolicy } from "../src/request-admission.mjs";
import { bodyOf, declaredBodyBytes, requestReservationBytes } from "../src/request-body.mjs";
const MIB = 1024 * 1024;

test("admission policy keeps safe defaults for invalid settings and permits zero queue", () => {
  const defaults = resolveAdmissionPolicy();
  assert.equal(defaults.maxConcurrent, 4);
  assert.equal(defaults.maxBodyBudgetMb, 128);
  assert.deepEqual(resolveAdmissionPolicy({ requestAdmission: { maxConcurrent: 0, maxBodyBudgetMb: Infinity, maxQueued: -1 } }), defaults);
  assert.equal(resolveAdmissionPolicy({ requestAdmission: { maxQueued: 0 } }).maxQueued, 0);
});

test("aggregate bytes and concurrency are enforced, FIFO blocks bypass, release is idempotent", async () => {
  const gate = new RequestAdmission({ requestAdmission: { maxConcurrent: 3, maxBodyBudgetMb: 2 } });
  const first = await gate.acquire(1.5 * MIB);
  const order = [];
  const second = gate.acquire(MIB).then((lease) => { order.push(2); return lease; });
  const third = gate.acquire(1).then((lease) => { order.push(3); return lease; });
  assert.equal(gate.snapshot().queued, 2);
  assert.equal(gate.snapshot().active, 1);
  first.release(); first.release();
  const leases = await Promise.all([second, third]);
  assert.deepEqual(order, [2, 3]);
  assert.equal(gate.snapshot().reservedBytes, MIB + 1);
  leases.forEach((lease) => lease.release());
  assert.equal(gate.snapshot().reservedBytes, 0);
  assert.equal(gate.snapshot().active, 0);
});

test("queue full, oversize and wait deadline fail before receiving work", async () => {
  const gate = new RequestAdmission({ requestAdmission: { maxConcurrent: 1, maxQueued: 1, maxBodyBudgetMb: 1, queueTimeoutMs: 20 } });
  const first = await gate.acquire(1);
  const timeout = assert.rejects(gate.acquire(1), { code: "request_queue_timeout", statusCode: 503 });
  await assert.rejects(gate.acquire(1), { code: "request_queue_full" });
  await assert.rejects(gate.acquire(MIB + 1), { code: "admission_request_too_large", statusCode: 413 });
  await timeout;
  assert.equal(gate.snapshot().queued, 0);
  first.release();
  const next = await gate.acquire(1);
  next.release();
  assert.equal(gate.snapshot().queueTimeouts, 1);
});

test("queued cancellation removes listeners, shutdown rejects queued but keeps active leases", async () => {
  const gate = new RequestAdmission({ requestAdmission: { maxConcurrent: 1 } });
  const first = await gate.acquire(1);
  const abort = new AbortController();
  const cancelled = assert.rejects(gate.acquire(1, abort.signal), { code: "request_cancelled" });
  abort.abort();
  await cancelled;
  assert.equal(getEventListeners(abort.signal, "abort").length, 0);
  const waiting = assert.rejects(gate.acquire(1), { code: "server_draining" });
  gate.close();
  await waiting;
  assert.equal(gate.snapshot().active, 1);
  first.release();
  assert.equal(gate.snapshot().active, 0);
  await assert.rejects(gate.acquire(1), { code: "server_draining" });
});

test("known lengths reserve exact bytes with a floor; chunked reserves the single-body ceiling", () => {
  assert.equal(requestReservationBytes({ headers: { "content-length": "10" } }), 65536);
  assert.equal(requestReservationBytes({ headers: { "content-length": String(MIB) } }), MIB);
  assert.equal(requestReservationBytes({ headers: {} }, { maxRequestBodyMb: 2 }), 2 * MIB);
  assert.throws(() => declaredBodyBytes({ headers: { "content-length": "2097153" } }, { maxRequestBodyMb: 2 }), { code: "payload_too_large" });
  for (const value of ["-1", "1e3", "1.2", "9007199254740992"]) assert.throws(() => declaredBodyBytes({ headers: { "content-length": value } }), { code: "invalid_content_length" });
});

function upload(length) {
  const stream = new PassThrough();
  stream.headers = length === undefined ? {} : { "content-length": String(length) };
  return stream;
}

test("known and chunked JSON preserve multibyte text across tiny chunks", async () => {
  const object = { text: "中文😀" };
  const bytes = Buffer.from(JSON.stringify(object));
  for (const length of [undefined, bytes.length]) {
    const source = upload(length);
    const result = bodyOf(source);
    for (const byte of bytes) source.write(Buffer.from([byte]));
    source.end();
    assert.deepEqual(await result, object);
    assert.equal(source.momoRequestBodyBytes, bytes.length);
    assert.equal(source.listenerCount("data"), 0);
  }
});

test("body timeout, abort, wrong length and chunked oversize release collectors", async () => {
  const slow = upload(10);
  await assert.rejects(bodyOf(slow, {}, { timeoutMs: 10 }), { statusCode: 408, code: "request_body_timeout" });
  assert.equal(slow.listenerCount("data"), 0);
  slow.destroy();
  const source = upload();
  const abort = new AbortController();
  const reading = assert.rejects(bodyOf(source, {}, { signal: abort.signal }), { code: "request_cancelled" });
  abort.abort(); await reading;
  assert.equal(source.listenerCount("data"), 0);
  assert.equal(getEventListeners(abort.signal, "abort").length, 0);
  source.destroy();
  for (const length of [1, 100]) {
    const wrong = upload(length);
    const failed = assert.rejects(bodyOf(wrong), { code: "content_length_mismatch" });
    wrong.end("{}"); await failed; wrong.destroy();
  }
  const large = upload();
  const tooLarge = assert.rejects(bodyOf(large, { maxRequestBodyMb: 1 }), { code: "payload_too_large" });
  large.end(Buffer.alloc(MIB + 1)); await tooLarge; large.destroy();
});

test("unknown-length collectors span slabs without retaining an entry for every tiny chunk", async () => {
  const data = { text: "中😀".repeat(40000) };
  const bytes = Buffer.from(JSON.stringify(data));
  const source = upload();
  const reading = bodyOf(source);
  for (let offset = 0; offset < bytes.length; offset += 7) source.write(bytes.subarray(offset, offset + 7));
  source.end();
  assert.deepEqual(await reading, data);
  assert.equal(source.listenerCount("data"), 0);
});

test("already cancelled collectors refuse work without adding upload listeners", async () => {
  const source = upload(2);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(bodyOf(source, {}, { signal: controller.signal }), { code: "request_cancelled" });
  assert.equal(source.listenerCount("data"), 0); source.destroy();
});
