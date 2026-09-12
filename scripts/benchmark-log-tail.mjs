// Synthetic files only. Each measured operation runs in a fresh child process;
// generation and hash verification are outside the timed section.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, openSync, closeSync, writeSync, rmSync, statSync } from "node:fs";
import { cpus, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

const script = fileURLToPath(import.meta.url);
const option = (name) => process.argv.find((arg) => arg.startsWith(name + "="))?.slice(name.length + 1);
if (process.argv.includes("--worker")) {
  const root = option("--root"), profile = option("--profile");
  const { readRecentLogs } = await import(pathToFileURL(join(root, "src/logger.mjs")));
  global.gc?.();
  const start = performance.now();
  const lines = readRecentLogs(50, { MOMO_PROXY_HOME: profile });
  const elapsedMs = performance.now() - start;
  const osMaxRssMiB = process.resourceUsage().maxRSS / 1024;
  const hash = createHash("sha256").update(JSON.stringify(lines)).digest("hex");
  process.stdout.write(JSON.stringify({ elapsedMs, osMaxRssMiB, lines: lines.length, hash }));
} else {
  const baseline = option("--baseline-root");
  if (!baseline) throw new Error("Supply a clean --baseline-root containing src/logger.mjs");
  const roots = { baseline: resolve(baseline), current: fileURLToPath(new URL("../", import.meta.url)) };
  const rounds = Number(option("--rounds") || 5);
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > 20) throw new Error("Invalid rounds");
  const scratch = mkdtempSync(join(tmpdir(), "momo-log-tail-bench-"));
  const results = [];
  try {
    for (const sizeMiB of [1, 32]) {
      const fd = openSync(join(scratch, "proxy.log"), "w");
      try {
        const record = JSON.stringify({ event: "synthetic", text: "中文😀".repeat(20) }) + "\n";
        const batch = Buffer.from(record.repeat(256));
        let total = 0;
        while (total < sizeMiB * 1048576) {
          let offset = 0;
          while (offset < batch.length) offset += writeSync(fd, batch, offset, batch.length - offset);
          total += batch.length;
        }
      } finally { closeSync(fd); }
      const fileBytes = statSync(join(scratch, "proxy.log")).size;
      let expectedHash;
      for (let round = 1; round <= rounds; round++) {
        for (const kind of round % 2 ? ["baseline", "current"] : ["current", "baseline"]) {
          const child = spawnSync(process.execPath, ["--expose-gc", script, "--worker", "--root=" + roots[kind], "--profile=" + scratch], {
            encoding: "utf8", windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024,
          });
          if (child.status !== 0) throw new Error("Synthetic log-tail worker failed");
          const result = JSON.parse(child.stdout);
          expectedHash ??= result.hash;
          if (result.lines !== 50 || result.hash !== expectedHash) throw new Error("Log lines differ");
          results.push({ sizeMiB, fileBytes, kind, round, ...result });
        }
      }
    }
  } finally { rmSync(scratch, { recursive: true, force: true }); }
  console.log(JSON.stringify({ environment: { node: process.version, platform: process.platform, cpu: cpus()[0]?.model }, rounds, results,
    note: "Fresh process, alternating sequential old/new, synthetic regular LF files, newest 50 records and hashes identical. OS maxRSS includes startup and measured read, excludes fixture generation and subsequent hash. OS file cache is not flushed. Not model/network speed, disk durability or a production latency percentile." }));
}
