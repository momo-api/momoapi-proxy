import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { setup } from '../src/setup.mjs';
import { listen } from '../src/server.mjs';
import { resolveSettings } from '../src/config.mjs';

const API_KEY = process.env.MOMO_API_KEY || "sk-momo-demo-dummy-key-placeholder";
const root = join(homedir(), "test-workspace");
const codexHome = join(homedir(), ".codex");

mkdirSync(root, { recursive: true });
mkdirSync(codexHome, { recursive: true });

console.log("[1] Setting up local bridge with API Key:", API_KEY.slice(0, 10) + "...");
const setupResult = await setup({
  apiKey: API_KEY,
  endpoint: "https://momoapi.us",
  port: 18789,
  autostart: false,
  env: process.env
});
console.log("[1] Setup done. Synced models:", setupResult.models, "Default model:", setupResult.defaultModel);

console.log("[2] Starting bridge server on 127.0.0.1:18789...");
const settings = resolveSettings(process.env);
console.log("Settings localToken:", settings.localToken, "auth token:", settings.apiKey?.slice(0, 10));
const server = await listen(settings);
console.log("[2] Server listening on http://127.0.0.1:18789/v1");

async function runTest(model, prompt, expected) {
  console.log(`\n--- Testing Model ${model} with prompt: '${prompt}' ---`);
  const t0 = Date.now();
  const child = spawn("codex", [
    "exec",
    "--sandbox", "danger-full-access",
    "--skip-git-repo-check",
    "-m", model,
    prompt
  ], {
    cwd: root,
    env: { ...process.env, NO_COLOR: "1", CODEX_HOME: codexHome },
    stdio: ["pipe", "pipe", "pipe"]
  });
  child.stdin.end();
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (c) => { stdout += c; process.stdout.write(c); });
  child.stderr.on("data", (c) => { stderr += c; });
  await new Promise((resolve) => child.on("exit", resolve));
  console.log(`\n[RESULT] ${model} finished in ${Date.now() - t0}ms`);
  if (stdout.includes(expected) || stderr.includes(expected)) {
    console.log(`[SUCCESS] ${model} output verified: '${expected}' found!`);
  } else {
    console.error(`[FAILURE] ${model} output missing '${expected}'. Output: ${stdout}`);
    process.exitCode = 1;
  }
}

await runTest("gpt-5.4", "Reply with EXACT: GPT54_LIVE_OK", "GPT54_LIVE_OK");
await runTest("deepseek-v4-pro", "Reply with EXACT: DEEPSEEK_LIVE_OK", "DEEPSEEK_LIVE_OK");
await runTest("claude-opus-4-6-thinking", "Reply with EXACT: CLAUDE_LIVE_OK", "CLAUDE_LIVE_OK");

await new Promise((r) => server.close(r));
