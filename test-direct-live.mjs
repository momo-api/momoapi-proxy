
import { resolveSettings } from './src/config.mjs';

async function testDirect() {
  const settings = resolveSettings();
  const models = [
    "gpt-5.6-sol",
    "gpt-5.5",
    "gpt-5.4",
    "deepseek-v4-pro",
    "deepseek-v4-flash-vision-exp",
    "muse-spark-1.3-contributor-free",
    "codex-auto-review"
  ];
  for (const m of models) {
    const res = await fetch("https://momoapi.us/v1/responses", {
      method: "POST",
      headers: {
        "authorization": "Bearer " + settings.apiKey,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: m,
        stream: false,
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }]
      })
    });
    const text = await res.text();
    console.log(m + " (responses) -> HTTP " + res.status + " " + text.slice(0, 150));
  }
}

testDirect();

