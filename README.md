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

## Local security model

- The server binds only to `127.0.0.1`.
- Codex receives a random **local** bearer token. The MOMO key is not written into `~/.codex/auth.json` after setup.
- The MOMO key is stored in the Bridge settings file under the user's profile and never logged.
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

After installing and configuring MOMO API Proxy, add the repository marketplace and install the image plugin:

```powershell
codex plugin marketplace add momo-api/momoapi-proxy --ref main
codex plugin add momo-image@momo-api
```

Start a new Codex conversation after installation. The plugin uses the MOMO key already stored by the local proxy; it does not ask users to paste the key again. GPT Image 2.5 Sunburst and Flare remain hidden until the authenticated MOMO model catalog reports an available channel.

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
- It supports standard function tools. Image generation and editing are available through the optional MOMO Image plugin; Codex-hosted services such as `codex-auto-review`, browser/computer use, video generation, and every third-party MCP shape are not marked universally compatible.
- It implements the tested MOMO/Codex subset of `/v1/responses/compact`, server-side `context_management` admission, and `compaction_trigger`. It does not claim every OpenCodex persistence, routing, or account-pool behavior.
- The installer is a developer command today; a signed one-line PowerShell/Bash installer and background process manager belong to the release work.

## Context and media limits

The proxy evaluates the final UTF-8 body after protocol conversion, not just the incoming `Content-Length`. By default it begins historical-image cleanup above 16 MiB and rejects any final upstream body above 18 MiB, leaving headroom below MOMO's 20 MiB edge limit. Historical images are SHA-256 deduplicated and old tool screenshots are removed first. Current-turn images are never silently deleted; an oversized current image returns `media_budget_exceeded`.

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
