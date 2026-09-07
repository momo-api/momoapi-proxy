import http from "node:http";
import https from "node:https";
import { performance } from "node:perf_hooks";

const TARGET_URL = process.env.BENCHMARK_TARGET || "https://momoapi.us/api/status";

async function testFetchPerformance(iterations = 10) {
  console.log(`\n--- Testing Node.js native fetch() connection reuse (${iterations} requests) ---`);
  const latencies = [];
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    try {
      const res = await fetch(TARGET_URL, { headers: { "User-Agent": "MOMO-Benchmark/1.0" } });
      await res.text();
      const end = performance.now();
      const duration = end - start;
      latencies.push(duration);
      console.log(`[fetch #${i + 1}] Status: ${res.status}, Time: ${duration.toFixed(2)}ms`);
    } catch (err) {
      console.error(`[fetch #${i + 1}] Failed:`, err.message);
    }
  }

  if (latencies.length > 0) {
    latencies.sort((a, b) => a - b);
    const p50 = latencies[Math.floor(latencies.length * 0.5)];
    const p95 = latencies[Math.floor(latencies.length * 0.95)];
    const avg = latencies.reduce((a, b) => a + b, 0) / latencies.length;
    console.log(`--> Fetch Summary: P50=${p50.toFixed(2)}ms, P95=${p95.toFixed(2)}ms, Avg=${avg.toFixed(2)}ms, FirstReq=${latencies[0].toFixed(2)}ms`);
  }
}

testFetchPerformance(10).catch(console.error);
