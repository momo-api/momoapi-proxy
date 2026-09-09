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
- It does not currently implement OpenCodex's complete `/v1/responses/compact` subsystem; compatibility claims are limited to the paths covered by this repository's tests.
- The installer is a developer command today; a signed one-line PowerShell/Bash installer and background process manager belong to the release work.

## Test evidence

`npm run test:container` verifies the local admission token, Responses passthrough, Gemini `functionCall` to Responses SSE conversion, and setup/rollback in a clean Node 24 container.

`scripts/codex-cli-smoke.mjs` uses an actual local Codex CLI with mocked Gemini or Claude wire endpoints. It requires the model to invoke `shell_command`, return its tool result, and complete the follow-up turn. `npm run test:codex-container` performs the Claude case in a clean Debian container with Codex CLI installed inside it.

## License

MIT. The design is informed by OpenCodex's public MIT-licensed protocol work, but this repository is a small MOMO-specific implementation and does not vendor OpenCodex.
