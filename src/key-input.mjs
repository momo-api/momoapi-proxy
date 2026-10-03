import readline from "node:readline/promises";
import { Writable } from "node:stream";

export async function promptApiKey({ input = process.stdin, output = process.stderr } = {}) {
  if (!input.isTTY) throw new Error("No terminal available. Use --api-key-stdin or explicitly --api-key-env for unattended installation.");
  output.write("Enter a new MOMO API Key (hidden; blank cancels): ");
  const muted = new Writable({ write(_chunk, _encoding, done) { done(); } });
  const rl = readline.createInterface({ input, output: muted, terminal: true });
  const controller = new AbortController();
  const cancel = () => controller.abort();
  rl.once("SIGINT", cancel);
  rl.once("close", cancel);
  try { return (await rl.question("", { signal: controller.signal })).trim(); }
  catch (error) { if (error.name === "AbortError") return ""; throw error; }
  finally { rl.off("SIGINT", cancel); rl.off("close", cancel); rl.close(); output.write("\n"); }
}

export async function readApiKeyStdin(input = process.stdin) {
  let text = "";
  for await (const chunk of input) {
    text += chunk.toString("utf8");
    if (Buffer.byteLength(text) > 4096) throw new Error("API Key input exceeds the allowed length.");
  }
  return text.trim();
}
