import { performance } from "node:perf_hooks";

const GROUPS = ["business", "health", "control", "image", "other"];
const STAGES = ["queueWaitMs", "bodyReadMs", "bodyParseMs", "preUpstreamMs", "upstreamHeadersMs", "clientFirstWriteMs", "transportTotalMs"];
const WINDOW = 500;

// Fixed labels only: never retain a URL/query, model, token, body or tool ID.
export function requestMetricGroup(method, pathname) {
  if (method === "OPTIONS") return "other";
  if (method === "GET" && ["/health", "/healthz"].includes(pathname)) return "health";
  if (pathname === "/internal/images" || pathname.startsWith("/internal/images/")) return "image";
  if (pathname.startsWith("/internal/")) return "control";
  if ((method === "GET" && ["/models", "/v1/models"].includes(pathname))
    || (method === "POST" && ["/responses", "/v1/responses", "/responses/compact", "/v1/responses/compact", "/chat/completions", "/v1/chat/completions"].includes(pathname))) return "business";
  return "other";
}

export class MetricWindow {
  constructor() { this.values = []; this.observations = 0; }
  add(ms) {
    if (!Number.isFinite(ms) || ms < 0) return;
    this.values[this.observations % WINDOW] = ms;
    this.observations++;
  }
  snapshot() {
    const sorted = [...this.values].sort((a, b) => a - b);
    const percentile = (p) => sorted.length ? sorted[Math.ceil(sorted.length * p) - 1] : null;
    return { available: sorted.length > 0, samples: sorted.length, observations: this.observations, p50: percentile(.5), p95: percentile(.95), p99: percentile(.99) };
  }
}

export class RequestMetrics {
  constructor({ now = () => performance.now() } = {}) {
    this.now = now;
    this.startedAt = new Date().toISOString();
    this.start = now();
    this.groups = Object.fromEntries(GROUPS.map((key) => [key, {
      requests: { total: 0, success: 0, failed: 0, aborted: 0, active: 0, activeSse: 0 },
      upstream: { attempts: 0, headersReceived: 0, errors: 0 },
      stages: Object.fromEntries(STAGES.map((name) => [name, new MetricWindow()])),
    }]));
  }
  begin(method, pathname) {
    const group = this.groups[requestMetricGroup(method, pathname)];
    group.requests.total++; group.requests.active++;
    const start = this.now();
    let preparationStart = start, firstWrite = false, ended = false, sse = false, fetched = false;
    const observe = (stage, ms) => group.stages[stage]?.add(ms);
    return {
      observe,
      bodyReady: () => { preparationStart = this.now(); },
      firstWrite: () => {
        if (firstWrite || ended) return;
        firstWrite = true; observe("clientFirstWriteMs", this.now() - start);
      },
      sse: () => { if (!sse && !ended) { sse = true; group.requests.activeSse++; } },
      wrapFetch: (fetchImpl) => async (...args) => {
        const before = this.now();
        if (!fetched) { fetched = true; observe("preUpstreamMs", before - preparationStart); }
        group.upstream.attempts++;
        try {
          // Do not read, wrap or pull the response body. Preserve fetch return
          // identity, stream backpressure, cancellation and existing retries.
          const result = await fetchImpl(...args);
          observe("upstreamHeadersMs", this.now() - before);
          group.upstream.headersReceived++;
          return result;
        } catch (error) { group.upstream.errors++; throw error; }
      },
      finish: (status, aborted = false) => {
        if (ended) return;
        ended = true;
        group.requests.active--;
        if (sse) group.requests.activeSse--;
        if (aborted) group.requests.aborted++;
        if (!aborted && status < 400) group.requests.success++; else group.requests.failed++;
        observe("transportTotalMs", this.now() - start);
      },
    };
  }
  snapshot() {
    return {
      schemaVersion: 1,
      startedAt: this.startedAt,
      uptimeSeconds: Math.max(0, Math.floor((this.now() - this.start) / 1000)),
      scope: "per-server; success/failed describe HTTP transport, not model or SSE terminal success",
      windowSize: WINDOW,
      groups: Object.fromEntries(GROUPS.map((name) => {
        const value = this.groups[name];
        return [name, { requests: { ...value.requests }, upstream: { ...value.upstream }, stages: Object.fromEntries(STAGES.map((stage) => [stage, value.stages[stage].snapshot()])) }];
      })),
    };
  }
}
