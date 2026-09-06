import { readFile, writeFile, mkdir } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { dirname, resolve } from "node:path";
import { resolveSettings } from "../src/config.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const ASSET_DIR = resolve(ROOT, "tmp", "multimodal-benchmark");
const OUTPUT_PATH = process.env.BENCHMARK_OUTPUT || resolve(ASSET_DIR, "results.json");
const settings = resolveSettings();
const endpoint = process.env.BENCHMARK_ENDPOINT || "http://127.0.0.1:" + settings.port;
const token = process.env.BENCHMARK_TOKEN || settings.localToken;
const timeoutMs = Number(process.env.BENCHMARK_TIMEOUT_MS || 180_000);
const runs = Math.max(1, Number(process.env.BENCHMARK_RUNS || 1));

const defaultModels = [
  "gpt-5.6-luna",
  "deepseek-v4-flash-vision-exp",
  "claude-opus-4-6-thinking",
  "gemini-3.8-flash",
  "muse-spark-1.3-contributor-free",
];
const models = (process.env.BENCHMARK_MODELS || defaultModels.join(","))
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const selectedCases = new Set(
  (process.env.BENCHMARK_CASES || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);

function dataUrl(mimeType, bytes) {
  return "data:" + mimeType + ";base64," + bytes.toString("base64");
}

function message(parts) {
  return [{ type: "message", role: "user", content: parts }];
}

function toolResult(callId, prompt, output) {
  return [
    { type: "message", role: "user", content: [{ type: "input_text", text: prompt }] },
    { type: "function_call", call_id: callId, name: "read_attachment", arguments: "{}" },
    { type: "function_call_output", call_id: callId, output },
  ];
}

function parseSse(raw) {
  const events = [];
  for (const block of raw.split(/\r?\n\r?\n/)) {
    const data = block.split(/\r?\n/).find((line) => line.startsWith("data:"))?.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    try { events.push(JSON.parse(data)); } catch {}
  }
  return events;
}

function outputText(events) {
  return events
    .filter((event) => event.type === "response.output_text.delta")
    .map((event) => event.delta || "")
    .join("");
}

function usageFrom(events) {
  const completed = events.findLast((event) => event.type === "response.completed");
  return completed?.response?.usage || null;
}

function errorFrom(events, raw, status) {
  const event = events.find((item) => item.type === "error");
  if (event?.error?.message) return event.error.message;
  if (status >= 400) return raw.slice(0, 500);
  const text = outputText(events);
  const marker = text.match(/\[MOMO [^\]]*Error[^\]]*\]:\s*([^\n]+)/i);
  return marker?.[1] || null;
}

function score(text, expected) {
  const normalized = text.toUpperCase().replace(/[,，]/g, "");
  const hits = expected.filter((needle) => normalized.includes(needle.toUpperCase().replace(/[,，]/g, "")));
  return { hits, expected, accuracy: expected.length ? hits.length / expected.length : 1 };
}

async function runCase(model, testCase, run) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("timeout after " + timeoutMs + "ms")), timeoutMs);
  const started = performance.now();
  let firstByteMs = null;
  let firstTextMs = null;
  let status = 0;
  let raw = "";
  try {
    const response = await fetch(endpoint + "/v1/responses", {
      method: "POST",
      headers: { authorization: "Bearer " + token, "content-type": "application/json" },
      body: JSON.stringify({ model, stream: true, reasoning: { effort: "low" }, input: testCase.input }),
      signal: controller.signal,
    });
    status = response.status;
    const reader = response.body?.getReader();
    if (reader) {
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (firstByteMs === null) firstByteMs = performance.now() - started;
        raw += decoder.decode(value, { stream: true });
        if (firstTextMs === null && raw.includes('"type":"response.output_text.delta"')) {
          firstTextMs = performance.now() - started;
        }
      }
      raw += decoder.decode();
    } else {
      raw = await response.text();
      firstByteMs = performance.now() - started;
    }
    const events = parseSse(raw);
    const text = outputText(events);
    const error = errorFrom(events, raw, status);
    const scored = score(text, testCase.expected);
    return {
      model,
      case: testCase.id,
      run,
      status,
      success: status === 200 && !error && scored.accuracy === 1,
      content_accuracy: scored.accuracy,
      matched: scored.hits,
      expected: scored.expected,
      first_byte_ms: Math.round(firstByteMs ?? (performance.now() - started)),
      first_text_ms: firstTextMs === null ? null : Math.round(firstTextMs),
      total_ms: Math.round(performance.now() - started),
      usage: usageFrom(events),
      response_excerpt: text.replace(/\s+/g, " ").trim().slice(0, 500),
      error: error ? String(error).replace(/data:[^\s]+;base64,[A-Za-z0-9+/=]+/g, "[base64 omitted]").slice(0, 800) : null,
      response_bytes: Buffer.byteLength(raw),
    };
  } catch (error) {
    return {
      model,
      case: testCase.id,
      run,
      status,
      success: false,
      content_accuracy: 0,
      matched: [],
      expected: testCase.expected,
      first_byte_ms: firstByteMs === null ? null : Math.round(firstByteMs),
      first_text_ms: firstTextMs === null ? null : Math.round(firstTextMs),
      total_ms: Math.round(performance.now() - started),
      usage: null,
      response_excerpt: "",
      error: error?.message || String(error),
      response_bytes: Buffer.byteLength(raw),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const manifest = JSON.parse(await readFile(resolve(ASSET_DIR, "manifest.json"), "utf8"));
  const textPdf = dataUrl("application/pdf", await readFile(manifest.text_pdf));
  const scannedPdf = dataUrl("application/pdf", await readFile(manifest.scanned_pdf));
  const mixedPdf = dataUrl("application/pdf", await readFile(manifest.mixed_pdf));
  const image = dataUrl("image/png", await readFile(manifest.image));
  const oversizedFake = "data:application/pdf;base64," + "A".repeat(180_000);

  const cases = [
    {
      id: "text_pdf",
      expected: ["MOMO-PDF-7429", "318.76", "2026-09-06"],
      input: message([
        { type: "input_text", text: "Read the attached PDF. Reply in one line with the code, invoice total, and date. Do not explain." },
        { type: "input_file", filename: "text-layer.pdf", file_data: textPdf },
      ]),
    },
    {
      id: "scanned_pdf",
      expected: ["MOMO-SCAN-8642", "527.41", "QUALITY ASSURANCE"],
      input: message([
        { type: "input_text", text: "Read the scanned PDF visually. Reply in one line with its code, approved amount, and department. Do not explain." },
        { type: "input_file", filename: "scanned-image-only.pdf", file_data: scannedPdf },
      ]),
    },
    {
      id: "mixed_pdf",
      expected: ["MOMO-MIX-1935", "BETA", "47"],
      input: message([
        { type: "input_text", text: "Read both the selectable text and chart image in this PDF. Reply in one line with the code, highest category, and its value. Do not explain." },
        { type: "input_file", filename: "mixed-text-chart.pdf", file_data: mixedPdf },
      ]),
    },
    {
      id: "image",
      expected: ["MOMO-IMG-5826", "4"],
      input: message([
        { type: "input_text", text: "Inspect this image. Reply in one line with IMAGE_CODE and the number of blue circles. Do not explain." },
        { type: "input_image", image_url: image, detail: "original" },
      ]),
    },
    {
      id: "oversized_inline_guard",
      expected: ["SAFE-OK"],
      input: message([
        { type: "input_text", text: "The next text part is accidental binary. Ignore it and reply exactly SAFE-OK." },
        { type: "input_text", text: oversizedFake },
      ]),
    },
    {
      id: "tool_result_pdf",
      expected: ["MOMO-PDF-7429", "318.76"],
      input: toolResult("call_pdf_benchmark", "Use the attachment returned by the tool. Reply with its code and invoice total only.", [
        { type: "input_text", text: "The requested PDF is attached." },
        { type: "input_file", filename: "text-layer.pdf", file_data: textPdf },
      ]),
    },
    {
      id: "tool_result_image",
      expected: ["MOMO-IMG-5826", "4"],
      input: toolResult("call_image_benchmark", "Use the image returned by the tool. Reply with IMAGE_CODE and the number of blue circles only.", [
        { type: "input_text", text: "The requested image is attached." },
        { type: "input_image", image_url: image, detail: "original" },
      ]),
    },
  ].filter((testCase) => selectedCases.size === 0 || selectedCases.has(testCase.id));

  const results = [];
  for (let run = 1; run <= runs; run += 1) {
    for (const model of models) {
      for (const testCase of cases) {
        process.stdout.write("run " + run + "/" + runs + " " + model + " " + testCase.id + " ... ");
        const result = await runCase(model, testCase, run);
        results.push(result);
        console.log((result.success ? "PASS " : "FAIL ") + result.total_ms + "ms" + (result.error ? " " + result.error.slice(0, 120) : ""));
      }
    }
  }

  const artifact = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    endpoint,
    timeout_ms: timeoutMs,
    runs,
    models,
    cases: cases.map(({ id, expected }) => ({ id, expected })),
    results,
  };
  await mkdir(dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, JSON.stringify(artifact, null, 2) + "\n", "utf8");
  console.log("Results: " + OUTPUT_PATH);
}

await main();
