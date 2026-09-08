# MOMO Image Plugin

`plugins/momo-image` is the Codex-distributed image feature for MOMO API Proxy.

## Architecture

```text
Codex Desktop / CLI
  -> plugin Skill + local STDIO MCP
  -> momoapi-proxy 127.0.0.1 internal image endpoints
  -> https://momoapi.us/v1/images/*
```

The plugin never receives or sends a MOMO API key. The proxy reads the key from its existing local settings and only accepts image requests from authenticated loopback clients.

## Install and run locally

1. Install or update MOMO API Proxy from this repository.
2. Install `plugins/momo-image` with the Codex plugin manager.
3. Ensure the proxy is configured and running on `127.0.0.1:18789`.
4. The plugin starts `momoapi-proxy mcp image` over STDIO.

The MCP tools are `image_capabilities`, `image_generate`, `image_edit`, and `image_task_status`.

## Supported first-release models

- `gpt-image-2-momoapi`
- `gpt-image-2`
- `gemini-3.1-flash-image`

The proxy normalizes aspect ratio and resolution controls, supports URL/base64/task responses, and polls asynchronous generation tasks. The live capabilities endpoint remains the source of truth for model controls.
