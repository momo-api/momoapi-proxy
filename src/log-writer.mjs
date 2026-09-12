// Formatting/redaction belongs to the caller. Never print records or raw errors.
export const LOG_WRITER_DEFAULTS = Object.freeze({
  maxQueueBytes: 1024 * 1024, maxQueueRecords: 1024,
  maxRecordBytes: 64 * 1024, maxBatchBytes: 128 * 1024,
  maxBatchRecords: 64, maxFlushWaiters: 32,
});

export function positiveLimit(value, fallback, ceiling) {
  const selected = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(selected) || selected < 1 || selected > ceiling) throw new RangeError("Invalid log writer limit");
  return selected;
}

export class BoundedLogWriter {
  constructor({ sink, ...options } = {}) {
    if (typeof sink?.append !== "function") throw new TypeError("A log sink is required");
    this.sink = sink;
    const ceilings = { maxQueueBytes: 16 * 1024 * 1024, maxQueueRecords: 16384,
      maxRecordBytes: 1024 * 1024, maxBatchBytes: 1024 * 1024, maxBatchRecords: 1024, maxFlushWaiters: 128 };
    this.limits = Object.freeze(Object.fromEntries(Object.entries(LOG_WRITER_DEFAULTS)
      .map(([key, fallback]) => [key, positiveLimit(options[key], fallback, ceilings[key])])));
    if (this.limits.maxRecordBytes > Math.min(this.limits.maxBatchBytes, this.limits.maxQueueBytes)) throw new RangeError("Record exceeds log batch/queue limit");
    this.queue = [];
    this.inFlight = null;
    this.scheduled = null;
    this.waiters = new Set();
    this.controller = new AbortController();
    this.accepting = true;
    this.closed = false;
    this.closePromise = null;
    this.settledThrough = 0;
    this.state = { accepted: 0, written: 0, writeFailed: 0, uncertain: 0,
      rejectedInvalid: 0, rejectedOversize: 0, rejectedCapacity: 0, rejectedClosed: 0,
      shutdownDropped: 0, pendingRecords: 0, pendingBytes: 0,
      peakPendingRecords: 0, peakPendingBytes: 0, batches: 0, lastError: null };
  }

  enqueue(line) {
    if (!this.accepting) { this.state.rejectedClosed++; return false; }
    if (typeof line !== "string" || !line.length) { this.state.rejectedInvalid++; return false; }
    // UTF-16 length is a cheap lower bound; allocate no Buffer before admission.
    if (line.length + 1 > this.limits.maxRecordBytes) { this.state.rejectedOversize++; return false; }
    if (/[\r\n]/.test(line) || !line.isWellFormed()) { this.state.rejectedInvalid++; return false; }
    const bytes = Buffer.byteLength(line) + 1;
    if (bytes > this.limits.maxRecordBytes) { this.state.rejectedOversize++; return false; }
    if (this.state.pendingRecords >= this.limits.maxQueueRecords || this.state.pendingBytes + bytes > this.limits.maxQueueBytes) {
      this.state.rejectedCapacity++; return false;
    }
    this.queue.push({ id: ++this.state.accepted, data: Buffer.from(line + "\n") });
    this.state.pendingRecords++;
    this.state.pendingBytes += bytes;
    this.state.peakPendingRecords = Math.max(this.state.peakPendingRecords, this.state.pendingRecords);
    this.state.peakPendingBytes = Math.max(this.state.peakPendingBytes, this.state.pendingBytes);
    if (!this.scheduled && !this.inFlight) this.scheduled = setImmediate(() => { this.scheduled = null; void this.#pump(); });
    return true;
  }

  async #pump() {
    while (this.queue.length && !this.closed) {
      const batch = [];
      let bytes = 0;
      while (this.queue.length && batch.length < this.limits.maxBatchRecords && bytes + this.queue[0].data.length <= this.limits.maxBatchBytes) {
        const item = this.queue.shift(); batch.push(item); bytes += item.data.length;
      }
      this.inFlight = batch;
      this.state.batches++;
      try {
        await this.sink.append(batch.map((item) => item.data), { signal: this.controller.signal });
        this.state.written += batch.length;
        this.state.lastError = null;
      } catch (error) {
        this.state.writeFailed += batch.length;
        // A rejected append may still have reached disk. Never replay it.
        if (error?.mayHaveWritten !== false) this.state.uncertain += batch.length;
        this.state.lastError = "log_append_failed";
      } finally {
        this.state.pendingRecords -= batch.length;
        this.state.pendingBytes -= bytes;
        this.settledThrough = batch.at(-1).id;
        this.inFlight = null;
        this.notifyWaiters();
      }
    }
  }

  snapshot() {
    return { ...this.state, accepting: this.accepting, closed: this.closed,
      inFlightRecords: this.inFlight?.length || 0, flushWaiters: this.waiters.size,
      limits: { ...this.limits } };
  }

  result(through, completed, reason) {
    return { through, completed, reason, ...this.snapshot() };
  }

  notifyWaiters() {
    for (const waiter of this.waiters) if (this.settledThrough >= waiter.through) waiter.finish(true, "settled");
  }

  flush({ timeoutMs = 1000 } = {}) {
    positiveLimit(timeoutMs, 1000, 60000);
    const through = this.state.accepted;
    if (this.settledThrough >= through) return Promise.resolve(this.result(through, true, "settled"));
    if (this.closed) return Promise.resolve(this.result(through, false, "closed"));
    if (this.waiters.size >= this.limits.maxFlushWaiters) return Promise.resolve(this.result(through, false, "waiter_limit"));
    return new Promise((resolve) => {
      const waiter = { through, finish: (completed, reason) => {
        clearTimeout(waiter.timer);
        this.waiters.delete(waiter);
        resolve(this.result(through, completed, reason));
      } };
      waiter.timer = setTimeout(() => waiter.finish(false, "timeout"), timeoutMs);
      this.waiters.add(waiter);
    });
  }

  close({ timeoutMs = 1000 } = {}) {
    positiveLimit(timeoutMs, 1000, 60000);
    if (this.closePromise) return this.closePromise;
    this.accepting = false;
    // One dedicated close waiter, independent of public flush capacity.
    this.closePromise = this.finishClose(timeoutMs);
    return this.closePromise;
  }

  async finishClose(timeoutMs) {
    const through = this.state.accepted;
    const outcome = this.settledThrough >= through ? { completed: true, reason: "settled" } : await new Promise((resolve) => {
      const waiter = { through, finish: (completed, reason) => {
        clearTimeout(waiter.timer); this.waiters.delete(waiter); resolve({ completed, reason });
      } };
      waiter.timer = setTimeout(() => waiter.finish(false, "timeout"), timeoutMs);
      this.waiters.add(waiter);
    });
    this.closed = true;
    if (this.scheduled) { clearImmediate(this.scheduled); this.scheduled = null; }
    if (!outcome.completed) {
      for (const item of this.queue) {
        this.state.shutdownDropped++; this.state.pendingRecords--; this.state.pendingBytes -= item.data.length;
      }
      this.queue = [];
      this.controller.abort();
      for (const waiter of [...this.waiters]) waiter.finish(false, "closed_timeout");
    }
    // JS cannot force-cancel in-flight fs I/O. Account it until settlement;
    // the deadline bounds waiting, not disk latency or process termination.
    return this.result(through, outcome.completed, outcome.reason);
  }
}
