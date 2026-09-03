import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setup } from "../src/setup.mjs";
import { listen } from "../src/server.mjs";
import { resolveSettings } from "../src/config.mjs";

const API_KEY = process.env.MOMO_API_KEY || "sk-momo-demo-dummy-key-placeholder";
const root = mkdtempSync(join(tmpdir(), "momo-live-smoke-"));
const env = { ...process.env, CODEX_HOME: join(root, ".codex"), MOMO_BRIDGE_HOME: root };
const workdir = join(root, "work");

await import("node:fs/promises").then(({ mkdir }) => Promise.all([mkdir(env.CODEX_HOME, { recursive: true }), mkdir(workdir, { recursive: true })]));

console.log("[1/4] Running setup in isolated environment...");
const setupRes = await setup({ apiKey: API_KEY, endpoint: "https://momoapi.us", port: 18789, autostart: false, env });
console.log("  Models synced:", setupRes.models, "Default model:", setupRes.defaultModel);

console.log("[2/4] Starting bridge server on 127.0.0.1:18789...");
const settings = resolveSettings(env);
const server = await listen(settings);

async function runCodexPrompt(model, prompt) {
  return new Promise((resolve, reject) => {
    const child = spawn("codex", ["exec", "--sandbox", "danger-full-access", "--skip-git-repo-check", "-m", model, prompt], {
      cwd: workdir,
      env: { ...env, NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve(output);
      else reject(new Error(`Codex exited with ${code}: ${output}`));
    });
  });
}

try {
  console.log("[3/6] Testing live Muse model (muse-spark-1.2-contributor-free)...");
  const out0 = await runCodexPrompt("muse-spark-1.2-contributor-free", "Reply with exactly: MOMO_MUSE_LIVE_OK");
  console.log("  Output 0 snippet:", out0.slice(0, 150).replace(/\n/g, " "));
  if (!out0.includes("MOMO_MUSE_LIVE_OK")) throw new Error("Muse response missing expected text");
  console.log("  -> Muse Spark 1.2: PASS");

  console.log("[4/6] Testing live Responses model (deepseek-v4-pro)...");
  const out1 = await runCodexPrompt("deepseek-v4-pro", "Reply with exactly: MOMO_DEEPSEEK_LIVE_OK");
  console.log("  Output 1 snippet:", out1.slice(0, 150).replace(/\n/g, " "));
  if (!out1.includes("MOMO_DEEPSEEK_LIVE_OK")) throw new Error("DeepSeek response missing expected text");
  console.log("  -> DeepSeek V4 Pro: PASS");

  console.log("[5/6] Testing live Claude thinking model (claude-opus-4-6-thinking)...");
  const out2 = await runCodexPrompt("claude-opus-4-6-thinking", "Reply with exactly: MOMO_CLAUDE_LIVE_OK");
  console.log("  Output 2 snippet:", out2.slice(0, 150).replace(/\n/g, " "));
  if (!out2.includes("MOMO_CLAUDE_LIVE_OK")) throw new Error("Claude response missing expected text");
  console.log("  -> Claude Opus 4.6 Thinking: PASS");

  console.log("[6/6] Testing live Desktop alias model (gpt-5.6-terra -> Claude)...");
  const out3 = await runCodexPrompt("gpt-5.6-terra", "Reply with exactly: MOMO_TERRA_LIVE_OK");
  console.log("  Output 3 snippet:", out3.slice(0, 150).replace(/\n/g, " "));
  if (!out3.includes("MOMO_TERRA_LIVE_OK")) throw new Error("Terra response missing expected text");
  console.log("  -> GPT-5.6 Terra: PASS");

  console.log("\n=======================================================");
  console.log("  ALL LIVE PODMAN CONTAINER SMOKE TESTS PASSED (100%)");
  console.log("=======================================================");
} finally {
  await new Promise((r) => server.close(r));
  try { rmSync(root, { recursive: true, force: true }); } catch {}
}
