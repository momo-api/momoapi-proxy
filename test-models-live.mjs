
import { resolveSettings } from './src/config.mjs';

async function testModel(model) {
  const settings = resolveSettings();
  try {
    const res = await fetch("http://127.0.0.1:" + settings.port + "/v1/responses", {
      method: "POST",
      headers: {
        "authorization": "Bearer " + settings.localToken,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: model,
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Say hello in one word." }] }]
      })
    });
    const text = await res.text();
    const hasError = text.includes("MOMO") || text.includes("Error") || res.status !== 200;
    console.log(model + " -> HTTP " + res.status + " (hasError: " + hasError + ")");
    if (hasError) {
      console.log("  Output snippet:", text.slice(0, 300));
    }
  } catch (e) {
    console.log(model + " -> EXCEPTION: " + e.message);
  }
}

async function run() {
  const models = [
    "gpt-5.6-sol",
    "gpt-5.5",
    "gpt-5.4",
    "claude-opus-4-6-thinking",
    "gemini-3.7-flash",
    "deepseek-v4-pro",
    "deepseek-v4-flash-vision-exp",
    "muse-spark-1.3-contributor-free",
    "codex-auto-review"
  ];
  for (const m of models) {
    await testModel(m);
  }
}

run();

