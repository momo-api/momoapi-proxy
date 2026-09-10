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
- **Safe Update Checks**: Checks official MOMO/GitHub release metadata, accepts packages only from approved HTTPS hosts, verifies SHA-256 and archive structure, and leaves unattended installation disabled unless explicitly enabled.
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

or `POST /v1/responses/compact`. The standalone compact route has an independent 32 MiB default budget (`MOMO_COMPACT_BODY_LIMIT_MB`, capped at 64 MiB), validates the returned `response.compaction`, caps the upstream response at 32 MiB, and safely markerizes old binary history before dispatch. Codex v2 local compaction envelopes are capped at 1 MiB and fall back to the fixed checkpoint when needed. If the MOMO upstream explicitly lacks compact support or rejects only the compact body as 413, the local proxy returns a fixed recoverable checkpoint. Model, authentication, quota and server errors are never converted into a fake compact success.

`previous_response_id` continuation is conservative: for native Responses routes, the proxy drops a repeated transcript only after an exact complete-prefix match crosses a recorded provider-output boundary containing a provider-issued item id. Partial or ambiguous matches, model changes, `store:false`, and non-Responses routes fail open and remain untouched. Continuation fingerprints are SHA-256 hashes, bounded, and memory-only.

## Test evidence

`npm run test:container` verifies the local admission token, Responses passthrough, Gemini `functionCall` to Responses SSE conversion, and setup/rollback in a clean Node 24 container.

`scripts/codex-cli-smoke.mjs` uses an actual local Codex CLI with mocked Gemini or Claude wire endpoints. It requires the model to invoke `shell_command`, return its tool result, and complete the follow-up turn. `npm run test:codex-container` performs the Claude case in a clean Debian container with Codex CLI installed inside it.

## License

MIT. The design is informed by OpenCodex's public MIT-licensed protocol work, but this repository is a small MOMO-specific implementation and does not vendor OpenCodex.
