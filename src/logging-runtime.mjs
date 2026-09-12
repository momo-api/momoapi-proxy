import { join, resolve } from "node:path";
import { appHome } from "./config.mjs";
import { BoundedLogWriter } from "./log-writer.mjs";
import { RotatingLogFile } from "./log-file-sink.mjs";

export const REQUEST_LOG_FILE = "request-events.jsonl";
export const DIAGNOSTIC_LOG_FILE = "diagnostic-events-v2.jsonl";

const EMPTY_CHANNEL = Object.freeze({
  initialized: false,
  accepted: 0,
  written: 0,
  writeFailed: 0,
  uncertain: 0,
  rejectedInvalid: 0,
  rejectedOversize: 0,
  rejectedCapacity: 0,
  rejectedClosed: 0,
  shutdownDropped: 0,
  pendingRecords: 0,
  pendingBytes: 0,
  rotations: 0,
  lockConflicts: 0,
  sinkFailures: 0,
  lastError: null,
});

function publicSnapshot(writer, sink) {
  if (!writer) return { ...EMPTY_CHANNEL };
  const queued = writer.snapshot();
  const file = sink?.snapshot?.() || {};
  return {
    initialized: true,
    accepted: queued.accepted,
    written: queued.written,
    writeFailed: queued.writeFailed,
    uncertain: queued.uncertain,
    rejectedInvalid: queued.rejectedInvalid,
    rejectedOversize: queued.rejectedOversize,
    rejectedCapacity: queued.rejectedCapacity,
    rejectedClosed: queued.rejectedClosed,
    shutdownDropped: queued.shutdownDropped,
    pendingRecords: queued.pendingRecords,
    pendingBytes: queued.pendingBytes,
    rotations: file.rotations || 0,
    lockConflicts: file.lockConflicts || 0,
    sinkFailures: file.failures || 0,
    lastError: file.lastError || queued.lastError || null,
  };
}

export function requestEventPath(env = process.env) {
  return join(appHome(env), REQUEST_LOG_FILE);
}

export function diagnosticEventPath(env = process.env) {
  return join(appHome(env), DIAGNOSTIC_LOG_FILE);
}

export function consoleMirrorEnabled(env = process.env) {
  return !["0", "false", "off", "no"].includes(String(env.MOMO_PROXY_CONSOLE_MIRROR || "").toLowerCase());
}

export class LoggingRuntime {
  constructor({ env = process.env, diagnosticsEnabled = true, consoleMirror = consoleMirrorEnabled(env),
    writerFactory, sinkFactory } = {}) {
    this.env = env;
    this.diagnosticsEnabled = diagnosticsEnabled !== false;
    this.consoleMirror = Boolean(consoleMirror);
    this.writerFactory = writerFactory || ((options) => new BoundedLogWriter(options));
    this.sinkFactory = sinkFactory || ((target) => new RotatingLogFile(target));
    this.channels = {
      request: { target: resolve(requestEventPath(env)), writer: null, sink: null },
      diagnostic: { target: resolve(diagnosticEventPath(env)), writer: null, sink: null },
    };
    this.closePromise = null;
  }

  writer(kind) {
    const channel = this.channels[kind];
    if (!channel) throw new TypeError("Unknown logging channel");
    if (!channel.writer) {
      channel.sink = this.sinkFactory(channel.target, kind);
      channel.writer = this.writerFactory({ sink: channel.sink, kind });
    }
    return channel.writer;
  }

  enqueueRequest(line) {
    let accepted = false;
    try { accepted = this.writer("request").enqueue(line); } catch {}
    if (this.consoleMirror) {
      try { console.log(line); } catch {}
    }
    return accepted;
  }

  enqueueDiagnostic(line) {
    if (!this.diagnosticsEnabled) return false;
    try { return this.writer("diagnostic").enqueue(line); } catch { return false; }
  }

  snapshot() {
    return {
      request: publicSnapshot(this.channels.request.writer, this.channels.request.sink),
      diagnostic: publicSnapshot(this.channels.diagnostic.writer, this.channels.diagnostic.sink),
    };
  }

  async flush({ timeoutMs = 1000 } = {}) {
    const entries = Object.values(this.channels).filter((channel) => channel.writer);
    const settled = await Promise.all(entries.map((channel) => channel.writer.flush({ timeoutMs })));
    return { completed: settled.every((item) => item.completed), channels: this.snapshot() };
  }

  close({ timeoutMs = 1000 } = {}) {
    if (this.closePromise) return this.closePromise;
    const entries = Object.values(this.channels).filter((channel) => channel.writer);
    this.closePromise = Promise.all(entries.map((channel) => channel.writer.close({ timeoutMs })))
      .then((settled) => ({ completed: settled.every((item) => item.completed), channels: this.snapshot() }));
    return this.closePromise;
  }
}

export function createLoggingRuntime(options = {}) {
  return new LoggingRuntime(options);
}

let configuredRuntime = null;
const defaultRuntimes = new Map();

export function configureLoggingRuntime(runtime) {
  configuredRuntime = runtime || null;
}

export function activeLoggingRuntime() {
  return configuredRuntime;
}

export function defaultLoggingRuntime(env = process.env) {
  if (configuredRuntime && configuredRuntime.env === env) return configuredRuntime;
  const key = resolve(appHome(env));
  let runtime = defaultRuntimes.get(key);
  if (!runtime) {
    runtime = createLoggingRuntime({ env });
    defaultRuntimes.set(key, runtime);
  }
  return runtime;
}

export async function flushLogging({ env = process.env, timeoutMs = 1000, runtime } = {}) {
  const selected = runtime || (configuredRuntime?.env === env ? configuredRuntime : defaultRuntimes.get(resolve(appHome(env))));
  return selected ? selected.flush({ timeoutMs }) : { completed: true, channels: { request: { ...EMPTY_CHANNEL }, diagnostic: { ...EMPTY_CHANNEL } } };
}

export async function closeLogging({ env = process.env, timeoutMs = 1000, runtime } = {}) {
  const selected = runtime || (configuredRuntime?.env === env ? configuredRuntime : defaultRuntimes.get(resolve(appHome(env))));
  return selected ? selected.close({ timeoutMs }) : { completed: true, channels: { request: { ...EMPTY_CHANNEL }, diagnostic: { ...EMPTY_CHANNEL } } };
}

export function getLoggingMetrics({ env = process.env, runtime } = {}) {
  const selected = runtime || (configuredRuntime?.env === env ? configuredRuntime : defaultRuntimes.get(resolve(appHome(env))));
  return selected?.snapshot() || { request: { ...EMPTY_CHANNEL }, diagnostic: { ...EMPTY_CHANNEL } };
}
