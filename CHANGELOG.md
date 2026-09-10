# Changelog

## Unreleased

- Added periodic update checks, tray update notifications, trusted versioned package selection, SHA-256 verification, archive traversal/link/size admission, and automatic rollback when a manually or explicitly enabled update fails health/version verification. Update checks are enabled by default; unattended installation is opt-in.
- Added bounded local-only diagnostics for 413, 429, 5xx, startup, crash, sync, and update errors. No diagnostic events, credentials, prompts, responses, file paths, Base64, or media contents are sent to MOMO or another remote service.
- Added final outbound context admission with a 16 MiB soft limit and 18 MiB hard limit below the production edge ceiling.
- Added SHA-256 deduplication and budget-based expiry for historical inline images while preserving current-turn media.
- Stopped Responses fallback replay for 413, 429, authentication, and 5xx failures; only explicit endpoint capability mismatches may fall back once.
- Preserved real upstream failure status and emitted `response.failed` instead of a false `response.completed` success.
- Added redacted request/body/media metrics and incident-scale regression coverage for 72-image histories.
- Added standard `/v1/responses/compact`, `context_management` compaction admission, and Codex `compaction_trigger` support with recoverable local checkpoints when the compact endpoint is explicitly unavailable or returns 413.
- Added per-session compaction mutual exclusion plus bounded, memory-only `previous_response_id` replay deduplication that fails open unless a complete prefix crosses provider-issued output.

## 0.11.0 - 2026-09-09

- Added the MOMO Image Codex plugin with authenticated loopback tools for image generation, editing, and asynchronous task status.
- Added verified routing for `gpt-image-2`, `gpt-image-2-momoapi`, and `gemini-3.1-flash-image`.
- Added catalog-gated GPT Image 2.5 Sunburst and Flare protocol adapters for generation, multipart edits, up to 16 references, masks, native size and quality controls, output formatting, and partial-image streaming.
- Kept unavailable GPT Image 2.5 models out of the MCP enum and return `model_unavailable` until MOMO exposes a usable channel.
- Added a Git marketplace manifest so Codex can install `momo-image` from `momo-api/momoapi-proxy`.

## 0.10.5 - 2026-09-08

- Normalized Qwen requests to a single leading system message before forwarding them upstream.
- Merged Responses `instructions`, developer messages, and system messages without changing tool-call order.
- Kept all non-Qwen model request behavior unchanged and added regression coverage for both paths.

## 0.10.4 - 2026-09-07

- Made the installed `settings.json` API key authoritative over stale process-level environment variables.
- Kept `MOMO_API_KEY` as a bootstrap fallback only when no saved key exists.
- Added regression coverage for stale long-lived Codex/Desktop environments.

## 0.10.3 - 2026-09-07

- Normalized Claude legacy `tools.exec_command("...")` and `{ command: ... }` calls to the unified `{ cmd: ... }` executor contract.
- Added stable opaque `x-opencode-session` affinity for DeepSeek/OpenCode Go chat routes and tool-result turns.
- Added live Claude/DeepSeek tool-roundtrip verification plus regression coverage for both compatibility boundaries.

## 0.9.9 - 2026-09-07

- Fixed Windows System Tray daemon launcher: prioritized full script path execution and guarded against invoking raw Node.js binary copies.
- Removed legacy 92MB `node.exe` file duplication in Windows desktop installer.
- Added Gitleaks automated secret scanning with custom MOMO API token detection rules.
- Purged leaked credentials across all historical release assets and rewritten Git commits.

## 0.9.8 - 2026-09-06

- Preserved inline PDF uploads as native Claude `document` blocks so the server-side CPA compatibility fallback can read them.
- Covered PDF files returned by tools without copying their Base64 payloads into text.
- Added large-PDF regression coverage for the Claude route.

## 0.9.7 - 2026-09-06

- Selected the highest version across CDN and GitHub release sources instead of trusting the first response.
- Refused forced self-updates that would downgrade an installed proxy.

## 0.9.6 - 2026-09-06

- Preserved PDF and other supported files as native Responses or Gemini media instead of serializing Base64 into text.
- Routed Luna and Muse 1.3 through their verified native Responses paths.
- Rejected oversized Base64, opaque binary, encrypted content, and unsupported attachment shapes from text fallbacks.
- Added regression coverage for direct uploads, tool-result files, mislabeled binary text, and large PDF payloads.

## 0.9.5 - 2026-09-06

- Verified realistically large tool-result images stay in native image fields across Gemini, Claude, Responses, and Chat Completions model routes.
- Preserved direct user images when a model routes through the Chat Completions fallback.
- Recognized Gemini inline-data and Claude base64/URL image blocks without serializing their bytes into text.

## 0.9.4 - 2026-09-06

- Fixed replayed Gemini tool results using the fallback name `tool` instead of the matching call name.
- Preserved tool-result images as native multimodal input rather than embedding base64 data in text.
- Added Gemini Responses usage accounting so Codex can track context consumption.
- Added regression coverage for replayed custom tools, image results, and Gemini usage metadata.
- Removed API key literals from live-test scripts; live tests now require `MOMO_API_KEY`.
- Reconciled the 0.9.2/0.9.3 tray changes and updater URLs with the `momoapi-proxy` repository.

## 0.9.3 - 2026-09-04

- Restored the taskbar-tray “同步模型列表 (Sync)” action for refreshing the local model catalog.

## 0.9.2 - 2026-09-04

- Fixed native tray actions accidentally launching the copied `node.exe` runtime as `node doctor` / `node models`.
- Native tray now resolves the installed `.mjs` CLI before any compatibility fallback, independent of Explorer's working directory.

## 0.1.0 - 2026-08-21

- Initial MOMO-specific local Codex Responses proxy.
- Added Responses passthrough plus Gemini and Claude function-call bridges.
- Added a protected local listener, Codex catalog setup, doctor and rollback commands.
- Added Node, container and real Codex CLI smoke coverage.
