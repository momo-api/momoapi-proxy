import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMomoSwitch } from "../src/server.mjs";

const root = mkdtempSync(join(tmpdir(), "momo-switch-codex-"));
const codexHome = join(root, ".codex");
const workdir = join(root, "work");
const localToken = "codex-smoke-local-token";
const provider = process.argv.includes("--claude") ? "claude" : "gemini";
const credentialCommand = process.argv.includes("--credential-command");
const port = Number(process.env.MOMO_CODEX_SMOKE_PORT || 18789);
const model = provider === "claude" ? "claude-sonnet-4-6" : "gemini-3.7-flash";
const successText = provider === "claude" ? "MOMO_CLAUDE_CODEX_TOOL_OK" : "MOMO_GEMINI_CODEX_TOOL_OK";

const bundled = JSON.parse(execFileSync("codex", ["debug", "models", "--bundled"], { encoding: "utf8" }));
const template = structuredClone(bundled.models.find((model) => model.slug === "gpt-5.5") || bundled.models[0]);
template.slug = model;
template.display_name = `MOMO ${provider}`;
template.visibility = "list";
writeFileSync(join(root, "catalog.json"), `${JSON.stringify({ models: [template] })}\n`);
await import("node:fs/promises").then(({ mkdir }) => Promise.all([mkdir(codexHome, { recursive: true }), mkdir(workdir, { recursive: true })]));
let authConfig = "";
if (credentialCommand) {
  const helperPath = join(root, "credential.mjs");
  writeFileSync(helperPath, `process.stdout.write(${JSON.stringify(localToken)});\n`);
  authConfig = `\n[model_providers.momo.auth]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(helperPath.replace(/\\/g, "/"))}]\ntimeout_ms = 5000\nrefresh_interval_ms = 0\n`;
} else {
  writeFileSync(join(codexHome, "auth.json"), `${JSON.stringify({ OPENAI_API_KEY: localToken })}\n`);
}
writeFileSync(join(codexHome, "config.toml"), `model_provider = "momo"\nmodel = "${model}"\nmodel_catalog_json = "${join(root, "catalog.json").replace(/\\/g, "/")}"\n\n[model_providers.momo]\nname = "MOMO smoke"\nbase_url = "http://127.0.0.1:${port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n${authConfig}`);

let sawFunctionResponse = false;
const fakeFetch = async (_url, init) => {
  const body = JSON.parse(init.body);
  if (provider === "claude") {
    sawFunctionResponse ||= Boolean(body.messages?.some((message) => Array.isArray(message.content) && message.content.some((part) => part.type === "tool_result")));
    const claudeEvents = sawFunctionResponse
      ? [{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: successText } }]
      : [
          { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_smoke", name: "shell_command", input: {} } },
          { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"command\":\"Get-Location\"}" } },
          { type: "content_block_stop", index: 0 },
        ];
    return new Response(claudeEvents.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
  }
  sawFunctionResponse ||= Boolean(body.contents?.some((content) => content.parts?.some((part) => part.functionResponse)));
  const part = sawFunctionResponse ? { text: successText } : { functionCall: { name: "shell_command", args: { command: "Get-Location" } } };
  return new Response(`data: ${JSON.stringify({ candidates: [{ content: { parts: [part] } }] })}\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
};
const server = createMomoSwitch({ endpoint: "https://mock.momo", apiKey: "momo-upstream-token", localToken, host: "127.0.0.1", port }, { fetchImpl: fakeFetch });
await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));

try {
  const output = await new Promise((resolve, reject) => {
    const child = spawn("codex", ["exec", "--sandbox", "workspace-write", "--skip-git-repo-check", "-m", model, "Run Get-Location using a shell command, then report the result."], {
      cwd: workdir,
      env: { ...process.env, CODEX_HOME: codexHome, NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let text = "";
    child.stdout.on("data", (chunk) => { text += chunk; });
    child.stderr.on("data", (chunk) => { text += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve(text) : reject(new Error(`codex exited ${code}: ${text}`)));
  });
  if (!sawFunctionResponse || !String(output).includes(successText)) {
    throw new Error(`Codex tool-loop verification failed. tool_result=${sawFunctionResponse}`);
  }
  console.log(`MOMO_${provider.toUpperCase()}_CODEX_CLI_SMOKE_OK`);
} finally {
  await new Promise((resolve) => server.close(resolve));
  try { rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { console.warn(`Temporary Codex state retained at ${root}`); }
}
