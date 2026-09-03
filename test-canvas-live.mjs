
import { resolveSettings } from './src/config.mjs';

async function testCanvasPrompt() {
  const settings = resolveSettings();
  console.log('Sending @Codex-Canvas prompt to http://127.0.0.1:' + settings.port + '/v1/responses ...');
  
  const payload = {
    model: "gpt-5.6-sol",
    instructions: "You are Codex. When the user asks to open canvas, you use the skill codex-canvas:canvas. Tools available: exec (custom tool).",
    tools: [
      {
        type: "custom",
        name: "exec",
        description: "Run JavaScript code to orchestrate/compose tool calls. Nested tools: await tools.exec_command(...)",
        format: {
          type: "grammar",
          syntax: "javascript",
          definition: "..."
        }
      }
    ],
    input: [
      {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: "@Codex-Canvas 打开画布"
          }
        ]
      }
    ]
  };

  const res = await fetch("http://127.0.0.1:" + settings.port + "/v1/responses", {
    method: "POST",
    headers: {
      "authorization": "Bearer " + settings.localToken,
      "content-type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  console.log("Status:", res.status);
  const text = await res.text();
  console.log("=== RAW SSE RESPONSE ===");
  console.log(text);
}

testCanvasPrompt().catch(console.error);
