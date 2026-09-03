
import { resolveSettings } from './src/config.mjs';

async function testClaude() {
  const settings = resolveSettings();
  const res = await fetch("http://127.0.0.1:" + settings.port + "/v1/responses", {
    method: "POST",
    headers: {
      "authorization": "Bearer " + settings.localToken,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: "claude-opus-4-6-thinking",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Say hello in one word." }] }]
    })
  });
  console.log("Status:", res.status);
  console.log(await res.text());
}

testClaude();

