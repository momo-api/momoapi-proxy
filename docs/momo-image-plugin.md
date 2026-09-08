# MOMO Image Plugin

plugins/momo-image packages the Codex-facing image feature for MOMO API Proxy. The plugin does not store a MOMO key: its STDIO MCP calls authenticated loopback endpoints, and the proxy uses the key already saved in local settings.

## Architecture

    Codex Desktop / CLI
      -> momo-image Skill + STDIO MCP
      -> momoapi-proxy authenticated 127.0.0.1 image endpoints
      -> model-specific MOMO API route

The four MCP tools are image_capabilities, image_generate, image_edit, and image_task_status. Reference URLs must use HTTPS, literal and DNS-resolved loopback/private-address targets are rejected, redirects are not followed, and each downloaded or inline reference is limited to 20 MiB.

## Model routing and verified controls

| Model | Generation | Reference editing | n | References | Size controls |
| --- | --- | --- | ---: | ---: | --- |
| gpt-image-2 | POST /v1/images/generations | Same endpoint with image_urls; asynchronous task_id is supported | 1 | 1 | 1:1; 3:2/2:3; 16:9/9:16 aliases; 1k/2k/4k quality hints |
| gpt-image-2-momoapi | POST /v1/images/generations | Streaming multimodal POST /v1/chat/completions | 1-4 | 1-4 | Same GPT mapping; the prompt carries the requested output hint |
| gemini-3.1-flash-image | POST /v1/images/generations | Multimodal POST /v1/chat/completions with modalities and extra_body.google.image_config | 1 | 1 | aspect_ratio plus 1K/2K/4K image_size |

For GPT models, 16:9 maps to the available 1536x1024 canvas, whose physical ratio is 3:2; 9:16 maps to 1024x1536, whose physical ratio is 2:3. The resolution labels sent to GPT are low/medium/high quality hints and do not guarantee an exact pixel count. Gemini receives size as the aspect ratio and quality as 1K, 2K, or 4K on its Images generation route.

Mask input is not currently exposed. The upstream gpt-image-2-momoapi implementation has mask-related code, but the public route has not yet passed an end-to-end mask test; capabilities therefore report mask_edits as false.

## Install and run locally

1. Install or update MOMO API Proxy from this repository.
2. Install plugins/momo-image with the Codex plugin manager.
3. Ensure the proxy is configured and running on 127.0.0.1:18789.
4. The plugin launches momoapi-proxy mcp image over STDIO.

Call image_capabilities at runtime instead of duplicating model limits in clients.
