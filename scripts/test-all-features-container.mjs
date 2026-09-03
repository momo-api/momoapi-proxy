import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = dirname(__dirname);
const BIN_PATH = join(ROOT_DIR, "bin", "momo-codex-bridge.mjs");
const API_KEY = process.env.MOMO_API_KEY || "sk-momo-demo-dummy-key-placeholder";

const root = mkdtempSync(join(tmpdir(), "momo-full-feature-test-"));
const env = {
  ...process.env,
  CODEX_HOME: join(root, ".codex"),
  MOMO_BRIDGE_HOME: root,
  NO_COLOR: "1"
};
const workdir = join(root, "work");

await import("node:fs/promises").then(({ mkdir }) => Promise.all([mkdir(env.CODEX_HOME, { recursive: true }), mkdir(workdir, { recursive: true })]));

function runCli(...args) {
  return execFileSync("node", [BIN_PATH, ...args], { env, encoding: "utf8" });
}

console.log("=== [1/8] Testing 'momo-codex-bridge install' ===");
const installOut = runCli("install", "--api-key", API_KEY, "--endpoint", "https://momoapi.us", "--port", "18795", "--no-autostart");
console.log(installOut);

console.log("=== [2/8] Testing 'momo-codex-bridge status' ===");
const statusJson = JSON.parse(runCli("status"));
console.log("Status:", JSON.stringify(statusJson, null, 2));
if (!statusJson.keyConfigured || statusJson.catalogModelsCount < 10) {
  throw new Error("Status check failed: key or models missing");
}

console.log("=== [3/8] Testing 'momo-codex-bridge models' ===");
const modelsOut = runCli("models");
console.log(modelsOut.slice(0, 300) + "...");
if (!modelsOut.includes("claude-opus-4-6-thinking") || !modelsOut.includes("muse-spark")) {
  throw new Error("Models listing missing expected models");
}

console.log("=== [4/8] Testing 'momo-codex-bridge sync' (Model Catalog Auto/Manual Sync) ===");
const syncOut = runCli("sync");
console.log(syncOut);
if (!syncOut.includes("Sync completed")) throw new Error("Sync failed");

console.log("=== [5/8] Testing 'momo-codex-bridge doctor' ===");
const doctorJson = JSON.parse(runCli("doctor"));
console.log("Doctor summary ok:", doctorJson.ok);
if (!doctorJson.ok) throw new Error("Doctor check reported failure: " + JSON.stringify(doctorJson));

console.log("=== [6/8] Starting Daemon & Testing Background Auto-Sync / Server ===");
const serverProcess = spawn("node", [BIN_PATH, "serve"], { env, stdio: ["ignore", "pipe", "pipe"] });
let serverLogs = "";
serverProcess.stdout.on("data", (d) => { serverLogs += d; });
serverProcess.stderr.on("data", (d) => { serverLogs += d; });

await new Promise((r) => setTimeout(r, 1200));

async function runCodexPrompt(model, prompt) {
  return new Promise((resolve, reject) => {
    const child = spawn("codex", ["exec", "--sandbox", "danger-full-access", "--skip-git-repo-check", "-m", model, prompt], {
      cwd: workdir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve(output);
      else reject(new Error("Codex exited with " + code + ": " + output));
    });
  });
}

try {
  console.log("=== [7/8] Running Real Codex CLI Prompts in Clean Container ===");
  
  console.log("  -> Testing Muse (muse-spark-1.2-contributor-free)...");
  const outMuse = await runCodexPrompt("muse-spark-1.2-contributor-free", "Reply with EXACT: MOMO_MUSE_OK");
  if (!outMuse.includes("MOMO_MUSE_OK")) throw new Error("Muse failed: " + outMuse);
  console.log("     Muse: PASS");

  console.log("  -> Testing DeepSeek (deepseek-v4-pro)...");
  const outDs = await runCodexPrompt("deepseek-v4-pro", "Reply with EXACT: MOMO_DEEPSEEK_OK");
  if (!outDs.includes("MOMO_DEEPSEEK_OK")) throw new Error("DeepSeek failed: " + outDs);
  console.log("     DeepSeek: PASS");

  console.log("  -> Testing Claude Thinking (claude-opus-4-6-thinking)...");
  const outCl = await runCodexPrompt("claude-opus-4-6-thinking", "Reply with EXACT: MOMO_CLAUDE_OK");
  if (!outCl.includes("MOMO_CLAUDE_OK")) throw new Error("Claude failed: " + outCl);
  console.log("     Claude Thinking: PASS");

  console.log("  -> Testing Desktop Compatibility Alias (gpt-5.6-terra -> Claude)...");
  const outTe = await runCodexPrompt("gpt-5.6-terra", "Reply with EXACT: MOMO_TERRA_OK");
  if (!outTe.includes("MOMO_TERRA_OK")) throw new Error("Terra alias: " + outTe);
  console.log("     GPT-5.6 Terra: PASS");

} finally {
  serverProcess.kill("SIGTERM");
}

console.log("=== [8/8] Testing 'momo-codex-bridge rollback' ===");
const rollbackOut = runCli("rollback");
console.log(rollbackOut);

try { rmSync(root, { recursive: true, force: true }); } catch {}

console.log("=======================================================");
console.log("  ALL CAPABILITIES & CONTAINER TESTS PASSED (100%)");
console.log("=======================================================");
