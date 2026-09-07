# Changelog

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
