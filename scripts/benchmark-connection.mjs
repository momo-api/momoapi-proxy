import https from "node:https";
import { performance } from "node:perf_hooks";

const TARGET_URL = process.env.BENCHMARK_TARGET || "https://momoapi.us/api/status";

function measureDetailedRequest(url) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const timings = {
      dnsLookupMs: 0,
      tcpConnectMs: 0,
      tlsHandshakeMs: 0,
      ttfbMs: 0,
      totalMs: 0,
      reusedSocket: false,
    };

    const t0 = performance.now();
    let dnsDone = 0;
    let tcpDone = 0;
    let tlsDone = 0;

    const req = https.request({
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: parsed.pathname + parsed.search,
      method: "GET",
      headers: { "User-Agent": "MOMO-Detailed-Benchmark/1.0" },
    }, (res) => {
      res.once("data", () => {
        timings.ttfbMs = performance.now() - t0;
      });
      res.on("end", () => {
        timings.totalMs = performance.now() - t0;
        resolve(timings);
      });
    });

    req.on("socket", (socket) => {
      if (socket.connecting) {
        socket.on("lookup", () => {
          dnsDone = performance.now();
          timings.dnsLookupMs = dnsDone - t0;
        });
        socket.on("connect", () => {
          tcpDone = performance.now();
          timings.tcpConnectMs = tcpDone - (dnsDone || t0);
        });
        socket.on("secureConnect", () => {
          tlsDone = performance.now();
          timings.tlsHandshakeMs = tlsDone - (tcpDone || t0);
        });
      } else {
        timings.reusedSocket = true;
      }
    });

    req.on("error", reject);
    req.end();
  });
}

async function runBenchmark(count = 10) {
  console.log(`\n=============================================================`);
  console.log(`  MOMO Detailed Connection & Reusability Benchmark (${count} requests)`);
  console.log(`=============================================================`);

  const results = [];
  let firstRequestTime = 0;

  for (let i = 0; i < count; i++) {
    try {
      const timings = await measureDetailedRequest(TARGET_URL);
      if (i === 0) firstRequestTime = timings.totalMs;
      results.push(timings);
      console.log(`[Req #${i + 1}] Reused: ${timings.reusedSocket ? "YES" : "NO "}, DNS: ${timings.dnsLookupMs.toFixed(1)}ms, TCP: ${timings.tcpConnectMs.toFixed(1)}ms, TLS: ${timings.tlsHandshakeMs.toFixed(1)}ms, TTFB: ${timings.ttfbMs.toFixed(1)}ms, Total: ${timings.totalMs.toFixed(1)}ms`);
    } catch (err) {
      console.error(`[Req #${i + 1}] Failed:`, err.message);
    }
  }

  const reusedCount = results.filter((r) => r.reusedSocket).length;
  const totals = results.map((r) => r.totalMs).sort((a, b) => a - b);
  const p50 = totals[Math.floor(totals.length * 0.5)];
  const p95 = totals[Math.floor(totals.length * 0.95)];

  console.log("\n--- Benchmark Summary ---");
  console.log(`Total Requests: ${results.length}`);
  console.log(`Reused Sockets: ${reusedCount} / ${results.length} (${((reusedCount / results.length) * 100).toFixed(1)}%)`);
  console.log(`First Request (Uncached): ${firstRequestTime.toFixed(2)}ms`);
  console.log(`P50 Total: ${p50.toFixed(2)}ms`);
  console.log(`P95 Total: ${p95.toFixed(2)}ms`);
}

runBenchmark(10).catch(console.error);
