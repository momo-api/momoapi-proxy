import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = dirname(__dirname);
const BIN_PATH = join(ROOT_DIR, "bin", "momo-codex-bridge.mjs");
const API_KEY = process.env.MOMO_API_KEY;
if (!API_KEY) throw new Error("MOMO_API_KEY is required for the Canvas container test.");

const root = mkdtempSync(join(tmpdir(), "momo-canvas-test-"));
const env = {
  ...process.env,
  CODEX_HOME: join(root, ".codex"),
  MOMO_BRIDGE_HOME: root,
  NO_COLOR: "1",
};
const workdir = join(root, "work");

await import("node:fs/promises").then(({ mkdir }) => Promise.all([
  mkdir(env.CODEX_HOME, { recursive: true }),
  mkdir(workdir, { recursive: true }),
]));

function runCli(...args) {
  return execFileSync("node", [BIN_PATH, ...args], { env, encoding: "utf8" });
}

console.log("=== Setting up MOMO Codex Bridge for Canvas Install Test ===");
runCli("install", "--api-key", API_KEY, "--endpoint", "https://momoapi.us", "--port", "18797", "--no-autostart");

const serverProcess = spawn("node", [BIN_PATH, "serve"], { env, stdio: ["ignore", "pipe", "pipe"] });
serverProcess.stdout.on("data", (d) => process.stdout.write("[BRIDGE] " + d));
serverProcess.stderr.on("data", (d) => process.stderr.write("[BRIDGE ERR] " + d));

await new Promise((r) => setTimeout(r, 1500));

const PROMPT = "Please install Codex-Canvas according to https://github.com/Xiangyu-CAS/codex-canvas.git and its INSTALL.md. After installation, tell the user to start a new Codex task and type `@Codex-Canvas open the codex canvas`.";

async function runTest(model) {
  console.log(`\n======================================================`);
  console.log(`[TESTING] Model: ${model}`);
  console.log(`[PROMPT]: ${PROMPT}`);
  console.log(`======================================================\n`);

  const t0 = Date.now();
  let firstTokenTime = null;

  return new Promise((resolve) => {
    const child = spawn("codex", ["exec", "--sandbox", "danger-full-access", "--skip-git-repo-check", "-m", model, PROMPT], {
      cwd: workdir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let fullOutput = "";

    child.stdout.on("data", (chunk) => {
      if (!firstTokenTime) {
        firstTokenTime = Date.now() - t0;
        console.log(`\n[METRIC] TTFT (First Token Latency): ${firstTokenTime}ms\n`);
      }
      const text = chunk.toString();
      fullOutput += text;
      process.stdout.write(text);
    });

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      process.stderr.write(text);
    });

    child.once("exit", (code) => {
      const totalDuration = Date.now() - t0;
      console.log(`\n------------------------------------------------------`);
      console.log(`[RESULT] Model: ${model}`);
      console.log(`[STATUS]: Exit code ${code} (${code === 0 ? "SUCCESS" : "FAILED"})`);
      console.log(`[METRICS]: TTFT: ${firstTokenTime || 0}ms | Total Duration: ${totalDuration}ms`);
      console.log(`------------------------------------------------------\n`);
      resolve({ model, code, totalDuration, firstTokenTime, output: fullOutput });
    });
  });
}

try {
  // Test with deepseek-v4-pro
  await runTest("deepseek-v4-pro");
} finally {
  serverProcess.kill("SIGTERM");
  try { rmSync(root, { recursive: true, force: true }); } catch {}
}
