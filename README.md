# MOMO API Proxy

`MOMO API Proxy` (formerly MOMO Codex Bridge/Switch) is a dedicated, lightweight local proxy that lets Codex CLI and ChatGPT/Codex Desktop use MOMO models with one MOMO API key.

```text
Codex CLI / Desktop -> 127.0.0.1 MOMO API Proxy -> https://momoapi.us/v1 -> MOMO routing
```

It is deliberately MOMO-specific. It does not collect provider keys, run an account pool, expose a LAN listener, or replace MOMO server-side billing and routing.
It implements a focused subset of OpenCodex-inspired protocol compatibility; it is not a feature-complete or drop-in copy of OpenCodex.

> **2026-09-07 multimodal/file notice:** The Base64 token-explosion path is fixed and verified across five production model routes. See the [Chinese service announcement](docs/announcements/2026-09-07-multimodal-file-fix-zh-CN.md) and the [full benchmark report](docs/multimodal-file-benchmark-2026-09-06.md).

## Key Capabilities

- **Zero OpenAI Auth / Sign-in Dependency**: Emits `requires_openai_auth = false` in loopback provider config.
- **Desktop App Picker Compatibility**: Maps slots for Desktop (`gpt-5.6-sol` -> DeepSeek V4 Pro, `gpt-5.6-terra` -> Claude Opus 4.6 Thinking, `gpt-5.6-luna` -> Gemini 3.7 Flash).
- **Thinking / Reasoning Mapping**: Maps per-model reasoning efforts to native upstream parameters (`thinkingConfig.thinkingLevel`, `adaptive` thinking, or `reasoning.effort`).
- **Multimodal Tool Results**: Keeps tool-returned images in native Gemini, Claude, and OpenAI-compatible image fields instead of serializing base64 image data as text.
- **Context / Media Admission**: Deduplicates and expires historical inline images, protects current-turn media, and enforces a 16 MiB soft / 18 MiB hard final upstream body envelope.
- **Accurate Failure Semantics**: Preserves upstream 413/429/5xx status, emits `response.failed`, and never replays those failures through another billable endpoint.
- **Gemini Usage Accounting**: Returns Gemini token usage in Responses events so Codex can track its context budget.
- **Hourly Model Sync**: Background worker periodically pulls rich model capabilities from `https://momoapi.us/agent/catalog` (fallback to `/v1/models`).
- **Autostart Support**: Configures login autostart on Windows, macOS launchd, and Linux systemd.
- **Doctor & Rollback**: Built-in environment diagnostic and one-step backup restore.
- **Local-Only Diagnostics**: Keeps bounded metadata for 413/429/5xx and lifecycle failures in the user's profile; the proxy has no remote telemetry sender.
- **Safe Automatic Updates**: Checks official MOMO/GitHub release metadata, accepts packages only from approved HTTPS hosts, verifies SHA-256 and archive structure, stages Windows updates outside the running app, and automatically rolls back failed activation. Set `updateMode` to `notify` for notification-only operation.
- **Automatic MOMO Image Plugin**: One-click setup installs and enables the bundled Codex image plugin by default; no second API key or manual marketplace command is required.

## Local security model

- The server binds only to `127.0.0.1`.
- Codex receives a random **local** bearer token. The MOMO key is not written into `~/.codex/auth.json` after setup.
- The MOMO key is stored in the Bridge settings file under the user's profile and never logged.
- Diagnostic events remain on the local machine in `~/.momoapi-proxy/diagnostic-events.jsonl` (bounded to 2 MiB / 1,000 retained lines) and are never uploaded automatically.
- `rollback` restores the backed-up Codex configuration and auth file.

## CLI Usage

### One-Click Quick Install

**Windows (PowerShell):**
```powershell
irm https://raw.githubusercontent.com/momo-api/momoapi-proxy/main/install.ps1 | iex
```

**macOS / Linux (Bash):**
```bash
curl -fsSL https://raw.githubusercontent.com/momo-api/momoapi-proxy/main/install.sh | bash
```

---

### Manual Commands

```bash
# Install & configure
momo-codex-bridge install --api-key <MOMO_KEY>

# Start bridge daemon
momo-codex-bridge serve

# Inspect status
momo-codex-bridge status

# List synced models
momo-codex-bridge models

# Run full diagnostic
momo-codex-bridge doctor

# Print bounded local-only error metadata for support
momo-codex-bridge diagnostics -n 100

# Test streaming turn
momo-codex-bridge test gpt-5.5

# Restore prior configuration
momo-codex-bridge rollback

# Uninstall
momo-codex-bridge uninstall [--remove-key]
```

```powershell
git clone https://github.com/momo-api/momoapi-proxy.git
cd momoapi-proxy
node .\bin\momo-codex-switch.mjs setup --api-key $env:MOMO_API_KEY
node .\bin\momo-codex-switch.mjs serve
```

In another terminal:

```powershell
codex
```

The setup command backs up `~/.codex/config.toml` and `~/.codex/auth.json`, writes the local provider, and generates `~/.codex/model-catalogs/momo-codex-switch.json` from the models returned by MOMO.

### MOMO Image plugin

The one-click installer and momoapi install now add and enable the bundled momo-image plugin automatically. Start a new Codex conversation after installation so Codex loads the plugin.

To check or repair the plugin installation:

```powershell
momoapi plugin status
momoapi plugin install
```

Use momoapi install --no-image-plugin only when an administrator intentionally does not want Codex image capabilities. The plugin uses the MOMO key already stored by the local proxy; it does not ask users to paste the key again. GPT Image 2.5 Sunburst and Flare remain hidden until the authenticated MOMO model catalog reports an available channel.

Image results are saved on the user's own computer under `~/.momoapi-proxy/images`. The plugin returns only compact metadata, a short `asset_id`, and a local path—never the full image Base64—so generated pictures do not accumulate in conversation history. When MOMO also returns a same-origin HTTPS result URL, the proxy adds a signed opaque vision reference; on the immediate next model turn it resolves that reference locally and sends the trusted HTTPS URL as `input_image`. Later image edits can reference `asset:img_...`.

The library does not upload images to a CDN or remote storage. When the user requests a later edit, only the selected asset is read locally and sent as that edit request's model input.

Local management commands are `momoapi images list`, `momoapi images info <asset_id>`, `momoapi images clean`, and `momoapi images delete <asset_id>`. Deletion is deliberately a CLI-only action; the image plugin does not expose a delete tool to the model.

Useful commands:

```powershell
node .\bin\momo-codex-switch.mjs doctor
node .\bin\momo-codex-switch.mjs rollback
npm test
npm run test:container
npm run test:codex-container
node .\scripts\codex-cli-smoke.mjs
node .\scripts\codex-cli-smoke.mjs --claude
```

`rollback` must be run before a second setup invocation.

## Deliberate limits

- It is for Codex CLI first. Codex Desktop needs a separate acceptance pass per release.
- It supports standard function tools. Image generation and editing are installed by default through the MOMO Image plugin; Codex-hosted services such as `codex-auto-review`, browser/computer use, video generation, and every third-party MCP shape are not marked universally compatible.
- It implements the tested MOMO/Codex subset of `/v1/responses/compact`, server-side `context_management` admission, and `compaction_trigger`. It does not claim every OpenCodex persistence, routing, or account-pool behavior.
- The signed one-line installers configure the proxy, background service, and bundled image plugin. Platform-specific Codex Desktop behavior still receives a separate acceptance pass per release.

## Context and media limits

### Local request admission

Responses, compact, raw Chat, and internal image POST requests share a per-server
ingress gate after authentication. Defaults: 4 active handlers, 8 FIFO waiters,
128 MiB reserved incoming bodies, 30s queue wait, and 120s body-read deadline.
The body-read clock starts after admission; it is not a model/SSE timeout.
Health, local metrics, shutdown, and GET routes do not consume these slots.

An admitted request keeps its slot/reservation through parsing, transformation,
and upstream completion/cancellation. Waiting requests have no body collector;
Node/socket buffering still exists. Known Content-Length reserves that length
(minimum 64 KiB) before allocation and reads into one destination buffer. Chunked
or missing lengths reserve the full single-body limit (64 MiB by default), and
still count actual incoming bytes. FIFO intentionally allows head-of-line waiting.
Unknown-length upload chunks are coalesced into 64 KiB slabs so metadata does not
grow by one retained array entry per tiny network chunk.

Non-secret advanced settings under the requestAdmission object in settings.json
(restart required):

| Setting | Default | Valid integer range |
| --- | --- | --- |
| maxConcurrent | 4 | 1–32 |
| maxQueued | 8 | 0–64 |
| maxBodyBudgetMb | 128 | 1–1024 |
| queueTimeoutMs | 30000 | 1–120000 |
| bodyReadTimeoutMs | 120000 | 1–600000 |

Invalid settings fall back to defaults. If the total budget is below the
single-body ceiling, unknown-length uploads cannot fit and return 413 even
if their eventual body would be small; send Content-Length or align the budgets.

Admission failures return JSON before contacting a model: 503 request_queue_full
or request_queue_timeout with Retry-After, 413 admission_request_too_large or
payload_too_large, or 408 request_body_timeout. An unfinished rejected upload
gets Connection: close; only its connection closes after the error is sent.
The proxy never retries model POSTs automatically. Shutdown rejects queued work
with 503 server_draining.

Authenticated /internal/metrics adds admission counters, active/queued counts,
reserved bytes and configured policy; no body, model arguments, or credentials.
This is a raw ingress budget, not an RSS cap: decoded JSON, transformations,
outgoing data and cross-request caches require additional memory. Aggregate
output budgets and event-loop blocking remain tracked follow-ups in
[the refactor plan](docs/REFACTOR-PLAN-2026-09.md).

### Local output safety budgets

Responses and its Chat/Gemini/Claude adapters count upstream UTF-8 wire bytes
before parsing (default 64 MiB) and SSE blocks including comments (65,536).
Raw Chat passthrough counts wire bytes only. The existing 32 MiB single-event
limit still applies to parsed SSE. Upstream diagnostic/error bodies have a
separate fixed 1 MiB read ceiling; compact retains its existing 32 MiB limit.

Each retained accumulator (DSML/text, adapter tool state, native custom restoration,
provider-output collection, or response emitter) defaults to 16 MiB logical UTF-8
bytes and 16,384 structural nodes/items; object traversal is limited to depth 64.
These are per-accumulator monotonic budgets: repeated snapshots consume budget
again; they are not a combined V8 heap/RSS cap. Already received frames and
JSON parsing/serialization still have transient allocations.

Optional non-secret settings under outputPolicy (restart required):

| Setting | Default | Valid integer range |
| --- | --- | --- |
| maxStreamMb | 64 | 1–256 |
| maxRetainedMb | 16 | 1–64 |
| maxEvents | 65536 | 1–262144 |
| maxItems | 16384 | 1–65536 |
| maxCallCacheMb | 64 | 1–256 |

Invalid fields fall back to defaults. The per-server tool continuation cache is
limited to 512 whole entries and maxCallCacheMb logical bytes; each entry also
uses maxItems/depth validation. Shared histories are conservatively charged for
each entry. Oldest entries are evicted whole; an oversized entry fails before
its executable tool call is emitted. Result-only Gemini/Claude continuations
with missing/evicted state return 409 tool_continuation_unavailable before an
upstream POST. Provide complete history with required provider metadata, or an
explicit new-task handoff. Local metrics expose only aggregate cache counts/bytes.

On overflow, Responses sends response.failed with output_budget_exceeded using
the current response ID when known, aborts upstream work, and never synthesizes
a success terminal. HTTP headers may already be 200: clients must inspect the
SSE terminal event. Already delivered deltas are not retractable. Raw Chat already
in flight ends as a truncated transport; the proxy does not append incompatible
Responses events or a fake DONE. No automatic model POST replay is added.

Unmatched native argument events must resolve by terminal/EOF, including calls
identified only in the final output snapshot; otherwise unmatched_tool_arguments
is returned, not a silently incomplete success. Existing namespace/custom lowering
and accepted tool call/result semantics are covered by synthetic regressions.

These budgets do not cover GET routes, image-result processing, every transient
allocation, or model/SSE idle timeouts. See the plan for remaining performance
work, notably compact/checkpoint repeated serialization and terminal copies.
DSML marker detection now inspects only new text plus an 11-code-unit boundary;
native custom-input decoding carries prefix/escape state across chunks. Pending
arguments use ID/index buckets with stable arrival order, without scanning other
calls. Final parsing, output budgets and existing tolerant partial-input semantics
are unchanged. See npm run benchmark:incremental-stream -- --baseline-root=...
for an explicit clean-baseline, sequential A/B comparison.
Chat/Gemini/Claude
custom-input normalization recognizes unified-exec host helper calls such as
text(...), image(...), and store(...) as JavaScript rather than wrapping them as
shell; bare shell compatibility is retained. This classification is not a full
JavaScript parser and never executes code inside the proxy.

### Upstream context admission

The proxy evaluates the final UTF-8 body after protocol conversion, not just the incoming `Content-Length`. By default it begins historical-image cleanup above 16 MiB and rejects any final upstream body above 18 MiB, leaving headroom below MOMO's 20 MiB edge limit. Historical images are SHA-256 deduplicated and old tool screenshots are removed first. Current-turn images are never silently deleted; an oversized current image returns `media_budget_exceeded`. Images generated by the MOMO Image plugin use the local asset library described above, so their normal tool results add only a small ID and path to history.

Advanced users may override the non-secret defaults in `settings.json`:

```json
{
  "contextPolicy": {
    "outboundBodySoftLimitMb": 16,
    "outboundBodyHardLimitMb": 18,
    "maxHistoricalImages": 8,
    "maxHistoricalImageBytesMb": 4,
    "maxCurrentTurnImageBytesMb": 8,
    "maxSingleImageBytesMb": 2
  }
}
```

The hard limit is deliberately capped at 18 MiB in the proxy. Raising nginx alone is not a supported fix for repeated image history. Local authenticated metrics at `/internal/metrics` expose admission, rewrite, rejection, and image-byte counters without logging prompts or Base64.

Long-running Responses clients may use either official compact mode:

```json
{
  "model": "gpt-5.6-sol",
  "input": [{ "role": "user", "content": "Continue the task" }],
  "context_management": [{ "type": "compaction", "compact_threshold": 200000 }]
}
```

or `POST /v1/responses/compact`. Compaction defaults to a local recoverable checkpoint, so old history is not sent to or billed by an upstream model. Set `MOMO_COMPACTION_MODE=upstream` only when upstream semantic compaction is explicitly wanted. The upstream mode has an independent 32 MiB default budget (`MOMO_COMPACT_BODY_LIMIT_MB`, capped at 64 MiB), validates the returned `response.compaction`, caps the upstream response at 32 MiB, and safely markerizes old binary history before dispatch. Codex v2 local compaction envelopes are capped at 1 MiB and fall back to the fixed checkpoint when needed. Ordinary model-switch replays larger than 512 KiB are also replaced with a local history checkpoint while the current user turn is preserved; customize that ceiling with `MOMO_MAX_HISTORICAL_REPLAY_MB`. Model, authentication, quota and server errors are never converted into a fake compact success.

`previous_response_id` continuation is conservative: for native Responses routes, the proxy drops a repeated transcript only after an exact complete-prefix match crosses a recorded provider-output boundary containing a provider-issued item id. Partial or ambiguous matches, model changes, `store:false`, and non-Responses routes fail open and remain untouched. Continuation fingerprints are SHA-256 hashes, bounded, and memory-only.

Local checkpoints preserve task text, system/developer constraints, pending tool calls, cross-turn call/result links, and the latest execution evidence. Optional recent tool groups are retained atomically. They are lossy history indexes, not semantic summaries or proof that omitted work finished. If required state exceeds the bounded checkpoint budget, the proxy returns `checkpoint_state_budget_exceeded` (413); start a new task with an explicit handoff rather than retrying the same oversized history. Native Responses request logs include bounded tool structure and hashed identities, never tool arguments/results or chat text. See [checkpoint investigation and limitations](docs/checkpoint-tool-continuity.md).

## Test evidence

`npm run test:container` verifies the local admission token, Responses passthrough, Gemini `functionCall` to Responses SSE conversion, and setup/rollback in a clean Node 24 container.

`scripts/codex-cli-smoke.mjs` uses an actual local Codex CLI with mocked Gemini or Claude wire endpoints. It requires the model to invoke `shell_command`, return its tool result, and complete the follow-up turn. `npm run test:codex-container` performs the Claude case in a clean Debian container with Codex CLI installed inside it.

## License

MIT. The design is informed by OpenCodex's public MIT-licensed protocol work, but this repository is a small MOMO-specific implementation and does not vendor OpenCodex.
