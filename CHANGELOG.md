# Changelog

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
