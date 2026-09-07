import { readFileSync } from "node:fs";
import { createMomoSwitch } from "../src/server.mjs";

const settings = JSON.parse(readFileSync("C:/Users/lumao/.momoapi-proxy/settings.json", "utf8"));
const selfHost = process.argv.includes("--self-host");
let smokeServer = null;
let endpoint = "http://127.0.0.1:18789/v1/responses";
if (selfHost) {
  smokeServer = createMomoSwitch({ ...settings, host: "127.0.0.1", port: 0 });
  await new Promise((resolve) => smokeServer.listen(0, "127.0.0.1", resolve));
  endpoint = `http://127.0.0.1:${smokeServer.address().port}/v1/responses`;
}
const headers = {
  authorization: `Bearer ${settings.localToken}`,
  "content-type": "application/json",
};

function parseEvents(text) {
  const events = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    try { events.push(JSON.parse(line.slice(6))); } catch {}
  }
  return events;
}

async function testModel(model) {
  const marker = `momo-${model.replace(/[^a-z0-9]+/gi, "-")}-tool-ok`;
  const prompt = `You must call the exec tool once to run exactly: echo ${marker}. After receiving the tool result, reply exactly TOOL_ROUNDTRIP_OK.`;
  const tools = [{
    type: "namespace",
    name: "functions",
    tools: [{ type: "custom", name: "exec", description: "Run JavaScript through the Codex unified exec tool" }],
  }];
  const input = [{ role: "user", content: [{ type: "input_text", text: prompt }] }];
  const firstStarted = Date.now();
  const first = await fetch(endpoint, {
    method: "POST",
    headers,
    signal: AbortSignal.timeout(90_000),
    body: JSON.stringify({ model, stream: true, reasoning: { effort: "low" }, input, tools }),
  });
  const firstText = await first.text();
  const firstEvents = parseEvents(firstText);
  const item = firstEvents.find((event) => event.type === "response.output_item.done" && event.item?.type === "custom_tool_call")?.item;
  const outputItems = firstEvents
    .filter((event) => event.type === "response.output_item.done")
    .map((event) => ({
      type: event.item?.type,
      name: event.item?.name,
      inputPreview: typeof event.item?.input === "string" ? event.item.input.slice(0, 240) : undefined,
      argumentsPreview: typeof event.item?.arguments === "string" ? event.item.arguments.slice(0, 240) : undefined,
      textPreview: Array.isArray(event.item?.content)
        ? event.item.content.map((part) => part.text || "").join("").slice(0, 240)
        : undefined,
    }));
  const safeInput = typeof item?.input === "string" ? item.input : "";
  const referencesMarker = safeInput.includes(marker);
  const usesCmd = /exec_command\(\{\s*cmd:/.test(safeInput);
  const usesCommand = /exec_command\(\{\s*command:/.test(safeInput);

  if (!item || !referencesMarker) {
    return {
      model,
      firstHttp: first.status,
      firstMs: Date.now() - firstStarted,
      toolCall: false,
      usesCmd,
      usesCommand,
      outputItems,
      error: "model did not emit the requested safe exec tool call",
    };
  }

  let invokedArgs = null;
  try {
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    await new AsyncFunction("tools", "text", safeInput)(
      { exec_command: async (args) => { invokedArgs = args; return { output: marker, exit_code: 0 }; } },
      () => {}
    );
  } catch (error) {
    return {
      model,
      firstHttp: first.status,
      firstMs: Date.now() - firstStarted,
      toolCall: true,
      usesCmd,
      usesCommand,
      executable: false,
      inputPreview: safeInput.slice(0, 240),
      outputItems,
      error: error.message,
    };
  }

  const secondStarted = Date.now();
  const second = await fetch(endpoint, {
    method: "POST",
    headers,
    signal: AbortSignal.timeout(90_000),
    body: JSON.stringify({
      model,
      stream: true,
      reasoning: { effort: "low" },
      input: [...input, item, { type: "custom_tool_call_output", call_id: item.call_id, output: marker }],
      tools,
    }),
  });
  const secondText = await second.text();
  const secondEvents = parseEvents(secondText);
  const responseText = secondEvents
    .filter((event) => event.type === "response.output_text.delta")
    .map((event) => event.delta || "")
    .join("");

  return {
    model,
    firstHttp: first.status,
    firstMs: Date.now() - firstStarted,
    toolCall: item.type === "custom_tool_call",
    toolName: item.name,
    usesCmd,
    usesCommand,
    executable: invokedArgs && typeof invokedArgs === "object" && invokedArgs.cmd?.includes(marker),
    invokedKeys: invokedArgs && typeof invokedArgs === "object" ? Object.keys(invokedArgs) : [],
    inputPreview: safeInput.slice(0, 240),
    secondHttp: second.status,
    secondMs: Date.now() - secondStarted,
    completed: secondEvents.some((event) => event.type === "response.completed"),
    roundtripOk: /TOOL_ROUNDTRIP_OK/i.test(responseText),
    responsePreview: responseText.slice(0, 120),
  };
}

const models = process.argv.slice(2).filter((arg) => arg !== "--self-host");
try {
  for (const model of models) {
    try {
      console.log(JSON.stringify(await testModel(model)));
    } catch (error) {
      console.log(JSON.stringify({ model, error: error.message }));
    }
  }
} finally {
  if (smokeServer) await new Promise((resolve) => smokeServer.close(resolve));
}
