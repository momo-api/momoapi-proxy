
import { resolveSettings } from './src/config.mjs';

async function testReasoning() {
  const settings = resolveSettings();

  // Multi-turn without reasoning item
  const payloadNoReasoning = {
    model: "gpt-5.6-sol",
    stream: true,
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "Hello! How can I assist you today?" }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "What is 2+2?" }] }
    ]
  };

  const res1 = await fetch("https://momoapi.us/v1/responses", {
    method: "POST",
    headers: { "authorization": "Bearer " + settings.apiKey, "content-type": "application/json" },
    body: JSON.stringify(payloadNoReasoning)
  });
  console.log("No reasoning in history -> HTTP " + res1.status + " " + (await res1.text()).slice(0, 150).replace(/\r?\n/g, ' '));
}

testReasoning();

