
import { resolveSettings } from './src/config.mjs';
import { normalizeResponsesPayload } from './src/server.mjs';

async function testMultiTurn() {
  const settings = resolveSettings();
  
  // Test 1: reasoning item with empty content
  const payload1 = {
    model: "gpt-5.6-sol",
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
      { type: "reasoning", id: "rs_123", summary: [], content: [] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "Hello!" }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "how are you?" }] }
    ]
  };

  const res1 = await fetch("https://momoapi.us/v1/responses", {
    method: "POST",
    headers: { "authorization": "Bearer " + settings.apiKey, "content-type": "application/json" },
    body: JSON.stringify({ ...normalizeResponsesPayload(payload1), stream: true })
  });
  console.log("Test 1 (reasoning item) -> HTTP " + res1.status + " " + (await res1.text()).slice(0, 150).replace(/\r?\n/g, ' '));

  // Test 2: function call + function call output
  const payload2 = {
    model: "gpt-5.6-sol",
    tools: [
      { type: "function", name: "exec", description: "exec tool", parameters: { type: "object", properties: { input: { type: "string" } } } }
    ],
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "run ls" }] },
      { type: "function_call", call_id: "call_abc", name: "exec", arguments: '{"input":"ls"}' },
      { type: "function_call_output", call_id: "call_abc", output: "file1.txt\nfile2.txt" }
    ]
  };

  const res2 = await fetch("https://momoapi.us/v1/responses", {
    method: "POST",
    headers: { "authorization": "Bearer " + settings.apiKey, "content-type": "application/json" },
    body: JSON.stringify({ ...normalizeResponsesPayload(payload2), stream: true })
  });
  console.log("Test 2 (tool call + output) -> HTTP " + res2.status + " " + (await res2.text()).slice(0, 150).replace(/\r?\n/g, ' '));
}

testMultiTurn();

