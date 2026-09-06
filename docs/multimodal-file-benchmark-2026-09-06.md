# Multimodal and file-input benchmark (2026-09-06)

This report measures the behavior users actually receive through momoapi-proxy, not only the capability advertised by the underlying model. It was created after PDF and image attachments were accidentally serialized into text and produced requests near or above one million tokens.

## Executive conclusion

- Use gpt-5.6-luna when PDF reliability matters. It passed selectable-text PDFs, scanned PDFs, PDFs containing raster charts, direct images, tool-returned files, and the oversized-inline safety check.
- gemini-3.8-flash also has complete PDF/image coverage in this test. It was usually fast after warm-up, but one safety prompt was not followed in one of three runs. The payload itself stayed bounded at 27 input tokens.
- muse-spark-1.3-contributor-free demonstrated complete native PDF/image capability while available, but the free contributor channel became unavailable during the run. Do not use it as the only production document route without retries and fallback.
- deepseek-v4-flash-vision-exp reads images but does not read PDF input on the current upstream Responses route. A direct request to momoapi.us failed in the same way, so this is not caused by the local proxy's Chat fallback. Convert PDF pages to images or extract text before selecting this model.
- claude-opus-4-6-thinking reads selectable PDF text and direct images, but the current CPA/Antigravity route did not expose scanned pages or images embedded in PDFs. It needs local extraction plus page rendering/OCR for full PDF support.
- The million-token regression is closed in the local proxy. An accidental 180,000-character Base64 data URL sent as input_text was reduced to a short marker. Luna reported 326 input tokens, Gemini 27, and Muse 31, rather than tens of thousands. DeepSeek's direct-upstream control consumed 22,531 input tokens, proving why the local guard is necessary.

## Test scope

Production model IDs were read from GET https://momoapi.us/v1/models immediately before the run.

| Family | Tested model | Local route |
| --- | --- | --- |
| GPT | gpt-5.6-luna | native Responses |
| DeepSeek | deepseek-v4-flash-vision-exp | Chat compatibility route; direct Responses control also tested |
| Claude | claude-opus-4-6-thinking | Claude Messages through CPA/Antigravity |
| Gemini | gemini-3.8-flash | native Gemini streaming protocol |
| Muse | muse-spark-1.3-contributor-free | native Responses |

The deterministic fixtures contain unique values that are not present in the prompts:

| Case | What it proves | Expected values |
| --- | --- | --- |
| Selectable-text PDF | PDF text-layer access | MOMO-PDF-7429, 318.76, 2026-09-06 |
| Scanned PDF | page-image/OCR access; PDF has zero extractable characters | MOMO-SCAN-8642, 527.41, Quality Assurance |
| Mixed PDF | selectable text plus understanding an embedded raster chart | MOMO-MIX-1935, BETA, 47 |
| PNG image | native vision | MOMO-IMG-5826, four blue circles |
| Oversized inline guard | accidental Base64 is not inserted into model text | exact SAFE-OK |
| Tool-result PDF/image | native media survives function-call history | the same unique PDF/image values |

## Capability results

Results below combine the initial run, the two-run timed series, and a separate Muse availability retry. The two tool-result cases were run once. 503 is reported as channel availability, not as a false claim that the model lacks the capability.

| Model | Text PDF | Scanned PDF | Mixed PDF | Image | Tool PDF | Tool image | Base64 guard |
| --- | --- | --- | --- | --- | --- | --- | --- |
| gpt-5.6-luna | PASS 3/3 | PASS 3/3 | PASS 3/3 | PASS 3/3 | PASS | PASS | PASS 3/3 |
| deepseek-v4-flash-vision-exp | FAIL 0/3 | FAIL 0/3 | FAIL 0/3 | PASS 3/3 | FAIL | PASS | PASS 3/3 |
| claude-opus-4-6-thinking | PASS 3/3 | FAIL 0/3 | FAIL 0/3 | PASS 3/3 | PASS | PASS | PASS 3/3 |
| gemini-3.8-flash | PASS 3/3 | PASS 3/3 | PASS 3/3 | PASS 3/3 | PASS | PASS | PASS 2/3 response compliance; payload bounded 3/3 |
| muse-spark-1.3-contributor-free | PASS 3/4 attempts | PASS 2/4 attempts | PASS 1/4 attempts | PASS 1/4 attempts | unavailable | unavailable | PASS 1/4 attempts |

Important interpretation:

- DeepSeek sometimes invented plausible invoice/chart values when it received only a file marker. This is a dangerous failure mode: it is not merely unsupported; it may hallucinate that it read the file.
- Claude consistently recovered selectable PDF text but consistently failed scanned pages and the embedded chart. This matches a route that extracts text but does not expose PDF page images.
- Muse's successful runs prove capability, while repeated Service temporarily unavailable responses prove that the tested free channel is not presently production-stable.

## Latency and token observations

Latency is end-to-end from the local client to the first output-text event. It includes NewAPI/provider queue time. The median uses successful requests from the two-run timed series; it is a small operational sample, not a vendor benchmark.

| Model | Successful requests in timed series | Median time to first text | Availability/errors |
| --- | ---: | ---: | --- |
| gemini-3.8-flash | 9/10 | 1.68 s | no HTTP/provider errors; one instruction-compliance miss |
| gpt-5.6-luna | 10/10 | 2.10 s | no errors |
| deepseek-v4-flash-vision-exp | 4/10 | 2.47 s | no transport errors; all PDF answers incorrect |
| claude-opus-4-6-thinking | 6/10 | 3.40 s | no transport errors; scanned/mixed PDF incorrect |
| muse-spark-1.3-contributor-free | 3/10 | 4.92 s | 7/10 returned provider 503 |

Representative input-token counts show that document strategy changes cost materially:

| Model/case | Input tokens |
| --- | ---: |
| Luna selectable-text PDF | 396 |
| Luna scanned PDF | 3,340 |
| Luna mixed PDF | 2,543 |
| Luna PNG | 1,525 |
| Gemini selectable/scanned/mixed PDF | 556 / 557 / 564 |
| Gemini PNG | 1,116 |
| Muse selectable/scanned/mixed PDF | 2,707 / 2,661 / 2,712 |
| Local guarded accidental Base64: Luna / Gemini / Muse | 326 / 27 / 31 |
| Direct upstream accidental Base64 on DeepSeek control | 22,531 |

DeepSeek and Claude compatibility responses did not expose usage in the returned normalized SSE, so their token counts cannot be reported honestly from this client-side test.

## Root-cause isolation

### DeepSeek PDF

The local route converts an unsupported file to a short marker before calling Chat Completions. A direct POST /v1/responses control to momoapi.us was therefore run with the original PDF bytes:

- selectable PDF: 32 input tokens, returned N/A values;
- scanned PDF: 33 input tokens, explicitly said the format was unsupported;
- mixed PDF: 41 input tokens, explicitly said the document was unsupported;
- PNG image: passed with 367 input tokens.

This establishes that PDF content is discarded or unsupported upstream for this model route. Changing only resolveTargetModel() in the local proxy would not restore PDF reading.

### Claude PDF

The local proxy emits a native Claude document block. Selectable PDF text passed in all attempts, including a PDF returned by a tool. Scanned content and embedded raster charts failed consistently. The current production route therefore behaves like text extraction, not full page-vision PDF processing.

### Base64/token incident

The production-safe behavior is:

1. Keep media bytes in native input_file, input_image, Claude document, or Gemini inline_data fields when that route supports them.
2. Replace media accidentally mislabeled as ordinary text with a bounded marker.
3. Never JSON-stringify a media part into prompt text.
4. For text-only PDF routes, use bounded text extraction; for scanned/mixed PDFs, render pages and run OCR/vision with strict page, byte, pixel, and character limits.

The tested local proxy follows rules 1-3. Rule 4 should be implemented in NewAPI as a provider-capability fallback, because that layer knows the selected channel and can avoid double-processing native-capable routes.

## Production routing recommendation

1. Default PDF route: gpt-5.6-luna.
2. Cost/latency alternative after monitoring: gemini-3.8-flash.
3. muse-spark-1.3-contributor-free: optional fallback only; retry with exponential backoff and immediately fail over on 503.
4. deepseek-v4-flash-vision-exp: direct images only. For PDF, first extract text and render/OCR only the pages without useful text.
5. CPA Claude: direct images and text-layer PDFs are acceptable; add page rendering/OCR before using it for arbitrary user PDFs.

Recommended bounded preprocessing:

- maximum upload: 20 MiB;
- maximum pages: 200;
- maximum extracted text: 24,000 Unicode characters for the current fallback;
- process text layer first;
- render only pages needing vision, at a bounded resolution;
- reject encrypted/corrupt PDFs with a clear client error;
- preserve native files for routes that passed this benchmark;
- record extraction mode (native, text, page_vision, or ocr) in internal request metadata without logging document contents.

## Reproduction

Requirements: Node.js 22+, Python 3, reportlab, Pillow, and a configured local MOMO proxy.

~~~powershell
npm run benchmark:multimodal:fixtures
$env:BENCHMARK_RUNS='2'
npm run benchmark:multimodal
~~~

Optional controls:

~~~powershell
$env:BENCHMARK_MODELS='gpt-5.6-luna,gemini-3.8-flash'
$env:BENCHMARK_CASES='text_pdf,scanned_pdf,mixed_pdf,image'
$env:BENCHMARK_ENDPOINT='https://momoapi.us'
$env:BENCHMARK_TOKEN=$env:MOMO_API_KEY
npm run benchmark:multimodal
~~~

Generated fixtures and raw responses stay under the ignored tmp directory. The runner stores only short response excerpts and sanitized errors; it never writes API keys or Base64 request bodies into result JSON.

## Limitations

- The test uses small, deterministic one-page files. Large-document throughput, encrypted PDFs, malformed PDFs, multilingual OCR, tables spanning pages, and concurrent load need separate soak/load tests.
- Latency varies with provider queues and cache warmth. Use repeated scheduled runs before defining an SLA.
- A content pass proves the tested route at the tested time; third-party OAuth/channel behavior can change independently of model capability.
- This benchmark intentionally uses Luna instead of a more expensive GPT route, as requested.
