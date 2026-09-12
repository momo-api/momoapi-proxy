const MIB = 1024 * 1024;
const DEFAULTS = { maxConcurrent: 4, maxQueued: 8, maxBodyBudgetMb: 128, queueTimeoutMs: 30000, bodyReadTimeoutMs: 120000 };

export function admissionError(statusCode, code, message) {
  return Object.assign(new Error(message), { statusCode, code, admission: true });
}

export function resolveAdmissionPolicy(settings = {}) {
  const supplied = settings.requestAdmission || {};
  const ranges = { maxConcurrent: [1, 32], maxQueued: [0, 64], maxBodyBudgetMb: [1, 1024], queueTimeoutMs: [1, 120000], bodyReadTimeoutMs: [1, 600000] };
  return Object.fromEntries(Object.entries(DEFAULTS).map(([key, fallback]) => {
    const value = supplied[key];
    const [min, max] = ranges[key];
    return [key, Number.isSafeInteger(value) && value >= min && value <= max ? value : fallback];
  }));
}

// Per-server leases: raw ingress accounting, NOT a process RSS guarantee.
// Unknown/chunked bodies reserve the entire single-body limit before reading;
// partial uploads cannot deadlock while requesting incremental budget growth.
export class RequestAdmission {
  constructor(settings = {}) {
    this.policy = resolveAdmissionPolicy(settings);
    this.active = 0;
    this.reservedBytes = 0;
    this.queue = [];
    this.closed = false;
    this.counters = { admitted: 0, queuedTotal: 0, queueFull: 0, queueTimeouts: 0, oversized: 0, cancelled: 0, peakActive: 0, peakReservedBytes: 0 };
  }
  snapshot() {
    return { ...this.counters, active: this.active, queued: this.queue.length, reservedBytes: this.reservedBytes, closed: this.closed, policy: { ...this.policy } };
  }
  fits(bytes) {
    return this.active < this.policy.maxConcurrent && this.reservedBytes + bytes <= this.policy.maxBodyBudgetMb * MIB;
  }
  lease(bytes) {
    this.active++;
    this.reservedBytes += bytes;
    this.counters.admitted++;
    this.counters.peakActive = Math.max(this.counters.peakActive, this.active);
    this.counters.peakReservedBytes = Math.max(this.counters.peakReservedBytes, this.reservedBytes);
    let released = false;
    return { release: () => {
      if (released) return;
      released = true;
      this.active--;
      this.reservedBytes -= bytes;
      this.pump();
    } };
  }
  acquire(bytes, signal) {
    if (this.closed) return Promise.reject(admissionError(503, "server_draining", "Server is draining; no new request work is admitted."));
    if (signal?.aborted) return Promise.reject(admissionError(499, "request_cancelled", "Client cancelled the request."));
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > this.policy.maxBodyBudgetMb * MIB) {
      this.counters.oversized++;
      return Promise.reject(admissionError(413, "admission_request_too_large", "Request reservation exceeds the total ingress budget."));
    }
    if (!this.queue.length && this.fits(bytes)) return Promise.resolve(this.lease(bytes));
    if (this.queue.length >= this.policy.maxQueued) {
      this.counters.queueFull++;
      return Promise.reject(admissionError(503, "request_queue_full", "Local request queue is full; retry later."));
    }
    this.counters.queuedTotal++;
    return new Promise((resolve, reject) => {
      let timer;
      const entry = { bytes, resolve, reject, cleanup: () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      } };
      const fail = (error) => {
        const index = this.queue.indexOf(entry);
        if (index < 0) return;
        this.queue.splice(index, 1);
        entry.cleanup();
        reject(error);
        this.pump();
      };
      const onAbort = () => {
        this.counters.cancelled++;
        fail(admissionError(499, "request_cancelled", "Client cancelled while queued."));
      };
      this.queue.push(entry);
      timer = setTimeout(() => {
        this.counters.queueTimeouts++;
        fail(admissionError(503, "request_queue_timeout", "Local request queue wait timed out; retry later."));
      }, this.policy.queueTimeoutMs);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
  }
  pump() {
    // FIFO is intentional: a stream of small requests cannot starve a large one.
    while (!this.closed && this.queue.length && this.fits(this.queue[0].bytes)) {
      const entry = this.queue.shift();
      entry.cleanup();
      entry.resolve(this.lease(entry.bytes));
    }
  }
  close() {
    this.closed = true;
    for (const entry of this.queue.splice(0)) {
      entry.cleanup();
      entry.reject(admissionError(503, "server_draining", "Server is draining; queued request was not sent upstream."));
    }
  }
}
