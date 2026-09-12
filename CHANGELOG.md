# Changelog

## Unreleased

- Add bounded per-server ingress admission for Responses, compact, raw Chat and internal image POSTs: FIFO slots/body reservations, queue/read deadlines, shutdown and cancellation cleanup, and aggregate-only local metrics.
- Validate Content-Length before allocating/reading, count actual uploaded bytes, and return explicit pre-upstream JSON admission errors; no automatic model replay, version bump or live runtime replacement.
- Track P2a separately from future output/cache budgets and record the full synthetic 10/25/50MiB concurrency matrix, including memory/latency regressions.

- Unify incremental UTF-8/SSE framing for native Responses and protocol bridges: preserve split Chinese/emoji tool arguments, forward CRLF/CR events before EOF, and handle multi-line data through tool restoration and audits.
- Await downstream drain for native Responses, raw Chat passthrough, and between bridge input events; preserve cancellation. Reject malformed UTF-8 and oversized individual SSE frames instead of silently corrupting or buffering them indefinitely.
- Add a staged refactor plan, transport regression matrix, and local-only framing benchmark; no checkpoint policy, package version, or runtime installation changes.

- Show the actual running version in the native tray menu and tooltip, with installed-version fallback when stopped. Remove the PowerShell tray's fixed version.
- Brand Windows startup entries as MOMO API Proxy Service.cmd and MOMO API Proxy Tray.lnk, preserving existing entry data and startup approval state during migration.
- Stop only the exact installed tray before replacing its locked executable; leave an unchanged running tray alive. Generate Windows product/file version metadata from package.json.

## 0.13.12 - 2026-09-12

- Preserve bounded checkpoint task/constraint text, latest execution evidence, pending calls and cross-boundary call/result associations. Refuse required state that cannot fit with explicit `checkpoint_state_budget_exceeded` (413), instead of silently discarding it.
- Decode local checkpoints before tool lowering; fix custom tool selectors and namespace restoration in final SSE blocks.
- Add native Responses structural tool audits with hashed identities and no chat bodies, tool arguments/results or credentials. Synthetic regression coverage compares checkpoint on/off and full tool-result follow-up.
- This restores future checkpoint continuity, not state already lost in earlier checkpoints. Very large required histories need a new task with an explicit handoff.

## 0.13.11 - 2026-09-12

- Repair Gemini function-call history before forwarding: pair tool results by call ID, correct mismatched result names such as `apply_patch` returned as `exec`, and safely omit orphaned function history that Gemini rejects.

## 0.13.10 - 2026-09-11

- Default Codex history compaction to a bounded local checkpoint, advertise a 120K auto-compaction threshold, and prevent hidden multi-megabyte history from being replayed when switching models.

## Unreleased

## 0.13.9 - 2026-09-11

- Bump the bundled MOMO Image plugin to 0.5.1 so Codex refreshes the corrected APIMart GPT Image 2.5 Skill and MCP metadata instead of retaining the 0.5.0 cache.

## 0.13.8 - 2026-09-11

- Correct the GPT Image 2.5 adapter for APIMart/NewAPI channel 4: generation and editing use `POST /v1/images/generations` with `image_urls` string arrays, not `/v1/images/edits` or OpenAI `images[].image_url`.
- Upload local/data-URL references through `POST /v1/uploads/images` before editing; forward validated public HTTPS references without downloading them.
- Follow APIMart asynchronous jobs at `GET /v1/tasks/{task_id}` and parse `data.result.images[].url[]`. Enforce APIMart limits (`n=1-4`, up to 16 references, no mask/input_fidelity/partial-image streaming).

## 0.13.7 - 2026-09-11

- Accept GitHub release downloads after they resolve to GitHub's signed `release-assets.githubusercontent.com` or `objects.githubusercontent.com` hosts.
- Preserve the full update trust chain: the versioned GitHub release asset remains the discovery source, GitHub's digest or release SHA-256 remains mandatory, downloaded bytes are rehashed, and archive path/type/size plus package-version validation still run before activation.
- Add an end-to-end regression for the signed GitHub release redirect used by real release downloads.

## 0.13.6 - 2026-09-11

- Send GPT Image 2.5 HTTPS reference images and masks through the current `/v1/images/edits` JSON `images[].image_url` protocol, so signed R2 URLs remain compact instead of being downloaded and expanded into Base64 or multipart uploads by the local proxy.
- Keep the existing multipart file fallback for local asset IDs, data URLs, and mixed local/remote edit inputs.
- Add regression coverage for sixteen signed HTTPS references plus a URL mask without any proxy-side image download.

## 0.13.5 - 2026-09-10

- Mirror the bundled MOMO Image marketplace into a versioned directory outside the application tree so Codex can monitor plugin files without locking proxy self-updates.
- When Windows blocks renaming the installed application directory, fall back to a transactional in-place activation: copy a complete backup, replace the verified program tree, validate the target version, health-check it, and restore the backup automatically on any failure.

## 0.13.4 - 2026-09-10

- Stop only the exact Windows `node.exe .../app/bin/momoapi-proxy.mjs mcp image` processes managed by the installed MOMO image plugin before switching the application directory. This closes the remaining `EPERM` update lock without terminating Codex, unrelated Node processes, or other proxy commands.

## 0.13.3 - 2026-09-10

- Fix Windows self-update failures caused by the running proxy trying to rename its own application directory (`EPERM`). Updates are verified into a sibling staging directory and activated by an external supervisor after the updater exits.
- Stop the old Windows service before switching files, verify the new daemon health, and restore the previous version automatically if activation fails.
- Make automatic verified updates the default for new and existing installations. Administrators can explicitly select notification-only mode with `updateMode: "notify"`.
- Improve tray update waiting and error reporting so it does not display only the initial "Checking..." line when the update fails.

## 0.13.2 - 2026-09-10

- Image MCP results never return full inline Base64, even if an older caller sends `include_preview`; generated files remain in the user's local asset library.
- Preserve same-origin MOMO HTTPS result URLs in private local asset metadata and attach a signed opaque vision reference to compact MCP results.
- Promote only valid current-turn signed references backed by an existing local asset into native Responses `input_image` URL parts; reject forged, historical, HTTP, cross-origin, missing, or damaged references.
- Added host, container, security, and live end-to-end coverage proving an approximately 0.8 MiB generated image continues as an approximately 0.8 KiB upstream request and is correctly recognized by the vision model.

## 0.13.1 - 2026-09-10

- The one-click installer, setup, and install now install and enable the bundled momo-image Codex plugin automatically. Existing installations also repair the plugin after a successful proxy update.
- Added momoapi plugin status and momoapi plugin install for verification and repair, plus an explicit --no-image-plugin opt-out. Missing or outdated Codex CLIs produce a warning without breaking the text proxy installation.

## 0.13.0 - 2026-09-10

- Added a local image asset library under the user's MOMO Proxy home. Image plugin results now return short content-addressed asset IDs and local paths instead of Base64 by default, while later edits can safely reuse `asset:img_...` references.
- Added PNG/JPEG/WebP content sniffing, MIME and SHA-256 integrity validation, atomic private writes, deduplication, retention/quota cleanup, and opt-in inline previews.
- Added `image_asset_get` and `image_asset_list` tools. Arbitrary local paths remain forbidden, and the local library does not upload images for persistent storage or CDN hosting. A selected asset is sent upstream only for a user-requested edit.
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
