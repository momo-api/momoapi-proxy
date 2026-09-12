import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { BoundedLogWriter } from "../src/log-writer.mjs";

function gate() { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; }
const tiny = { maxQueueBytes: 32, maxQueueRecords: 4, maxRecordBytes: 16, maxBatchBytes: 16, maxBatchRecords: 2 };
function checkAccounting(state) {
  assert.equal(state.accepted, state.written + state.writeFailed + state.shutdownDropped + state.pendingRecords);
  assert.ok(state.pendingBytes >= 0 && state.pendingBytes <= state.limits.maxQueueBytes);
  assert.ok(state.pendingRecords >= 0 && state.pendingRecords <= state.limits.maxQueueRecords);
}

test("admission performs no disk calls inline; Unicode records preserve order in bounded batches", async () => {
  const writes = [];
  const writer = new BoundedLogWriter({ ...tiny, sink: { append: async (records) => { writes.push(records.map(String)); } } });
  assert.equal(writer.enqueue("中文😀"), true);
  assert.equal(writer.enqueue("second"), true);
  assert.equal(writer.enqueue("third"), true);
  assert.equal(writes.length, 0);
  const result = await writer.close();
  assert.equal(result.completed, true);
  assert.equal(result.written, 3);
  assert.deepEqual(writes.flat(), ["中文😀\n", "second\n", "third\n"]);
  assert.ok(writes.every((batch) => batch.length <= 2 && Buffer.byteLength(batch.join("")) <= 16));
  checkAccounting(result);
});

test("invalid/multiline/oversize records are rejected whole before admission", async () => {
  const writer = new BoundedLogWriter({ ...tiny, sink: { append: async () => {} } });
  for (const value of [null, {}, "", "line\nnext", "line\rnext", "\ud800", "\udfff"]) assert.equal(writer.enqueue(value), false);
  for (const value of ["x".repeat(16), "😀".repeat(4), "x".repeat(1_000_000)]) assert.equal(writer.enqueue(value), false);
  assert.equal(writer.enqueue("x".repeat(15)), true);
  const result = await writer.close();
  assert.equal(result.rejectedInvalid, 7);
  assert.equal(result.rejectedOversize, 3);
  assert.equal(result.written, 1);
  checkAccounting(result);
});

test("queue bytes include held in-flight data; saturation drops new records and recovers", async () => {
  const entered = gate(), release = gate();
  const writer = new BoundedLogWriter({ ...tiny, sink: { append: async () => { entered.resolve(); await release.promise; } } });
  writer.enqueue("x".repeat(15));
  await entered.promise;
  assert.equal(writer.enqueue("y".repeat(15)), true);
  for (let i = 0; i < 10000; i++) assert.equal(writer.enqueue("z"), false);
  const pending = writer.snapshot();
  assert.equal(pending.pendingBytes, 32);
  assert.equal(pending.pendingRecords, 2);
  assert.equal(pending.inFlightRecords, 1);
  assert.equal(pending.rejectedCapacity, 10000);
  checkAccounting(pending);
  release.resolve();
  await writer.flush();
  assert.equal(writer.enqueue("recovered"), true);
  checkAccounting(await writer.close());
});

test("record-count saturation is independent of byte capacity", async () => {
  const writer = new BoundedLogWriter({ ...tiny, sink: { append: async () => {} } });
  for (let i = 0; i < 4; i++) assert.equal(writer.enqueue("a"), true);
  assert.equal(writer.enqueue("b"), false);
  assert.equal(writer.snapshot().pendingBytes, 8);
  checkAccounting(await writer.close());
});

test("failed/possibly partial appends never replay and do not block subsequent batches", async () => {
  let attempts = 0;
  const writer = new BoundedLogWriter({ ...tiny, maxBatchRecords: 1, sink: { append: async () => {
    attempts++;
    if (attempts === 1) throw new Error("PRIVATE_PATH_AND_CONTENT");
    if (attempts === 2) throw Object.assign(new Error("PRIVATE"), { mayHaveWritten: false });
  } } });
  writer.enqueue("first"); writer.enqueue("second"); writer.enqueue("third");
  const result = await writer.close();
  assert.equal(attempts, 3);
  assert.equal(result.completed, true); // settled, not synonymous with saved
  assert.equal(result.written, 1);
  assert.equal(result.writeFailed, 2);
  assert.equal(result.uncertain, 1);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|first|second|third/);
  checkAccounting(result);
});

test("flush is a prefix barrier: later writes do not prolong it", async () => {
  const first = gate(), second = gate();
  let attempt = 0;
  const writer = new BoundedLogWriter({ ...tiny, maxBatchRecords: 1, sink: { append: async () => { await (++attempt === 1 ? first.promise : second.promise); } } });
  writer.enqueue("first");
  const flush = writer.flush();
  writer.enqueue("second");
  first.resolve();
  const result = await flush;
  assert.equal(result.through, 1);
  assert.equal(result.completed, true);
  assert.equal(result.pendingRecords, 1);
  second.resolve();
  await writer.close();
});

test("flush timeouts leave data queued and callers cannot create unbounded waiters", async () => {
  const release = gate();
  const writer = new BoundedLogWriter({ ...tiny, maxFlushWaiters: 2, sink: { append: async () => release.promise } });
  writer.enqueue("record");
  const first = writer.flush({ timeoutMs: 10 }), second = writer.flush({ timeoutMs: 10 });
  assert.equal((await writer.flush()).reason, "waiter_limit");
  assert.equal(writer.snapshot().flushWaiters, 2);
  for (const result of await Promise.all([first, second])) assert.equal(result.reason, "timeout");
  assert.equal(writer.snapshot().pendingRecords, 1);
  release.resolve();
  assert.equal((await writer.close()).written, 1);
});

test("close timeout is idempotent, rejects new input, drops queued records and accounts late I/O", async () => {
  const entered = gate(), release = gate();
  let signal;
  const writer = new BoundedLogWriter({ ...tiny, maxBatchRecords: 1, sink: { append: async (_records, options) => {
    signal = options.signal; entered.resolve(); await release.promise;
  } } });
  writer.enqueue("first"); writer.enqueue("second");
  await entered.promise;
  const closing = writer.close({ timeoutMs: 10 });
  assert.equal(writer.close(), closing);
  assert.equal(writer.enqueue("third"), false);
  const result = await closing;
  assert.equal(result.completed, false);
  assert.equal(result.shutdownDropped, 1);
  assert.equal(result.pendingRecords, 1);
  assert.equal(result.inFlightRecords, 1);
  assert.equal(signal.aborted, true);
  checkAccounting(result);
  release.resolve(); await nextTurn();
  const settled = writer.snapshot();
  assert.equal(settled.written, 1);
  assert.equal(settled.pendingRecords, 0);
  assert.equal((await writer.flush()).completed, false); // the dropped prefix is not saved
  checkAccounting(settled);
});

test("close has a reserved waiter even when public flush callers saturate capacity", async () => {
  const release = gate();
  const writer = new BoundedLogWriter({ ...tiny, maxFlushWaiters: 1, sink: { append: async () => release.promise } });
  writer.enqueue("one");
  const flushing = writer.flush();
  const closing = writer.close({ timeoutMs: 1000 });
  assert.equal(writer.snapshot().flushWaiters, 2);
  release.resolve();
  assert.equal((await closing).completed, true);
  assert.equal((await flushing).completed, true);
  assert.equal(writer.snapshot().flushWaiters, 0);
});

test("configuration fails explicitly and returned snapshots cannot mutate limits or counters", async () => {
  for (const value of [0, -1, NaN, Infinity, 1.5, 1e12]) assert.throws(() => new BoundedLogWriter({ sink: { append() {} }, maxQueueBytes: value }), RangeError);
  assert.throws(() => new BoundedLogWriter(), TypeError);
  assert.throws(() => new BoundedLogWriter({ sink: { append() {} }, maxRecordBytes: 100, maxBatchBytes: 50 }), RangeError);
  const writer = new BoundedLogWriter({ sink: { append() {} } });
  assert.throws(() => writer.flush({ timeoutMs: 0 }), RangeError);
  assert.throws(() => writer.close({ timeoutMs: Infinity }), RangeError);
  const snapshot = writer.snapshot(); snapshot.limits.maxQueueBytes = 1; snapshot.accepted = 100;
  assert.equal(writer.snapshot().accepted, 0);
  assert.equal(writer.snapshot().limits.maxQueueBytes, 1048576);
  assert.equal((await writer.close()).completed, true);
});
