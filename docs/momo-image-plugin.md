# MOMO Image Plugin

plugins/momo-image packages the Codex-facing image feature for MOMO API Proxy. The plugin does not store a MOMO key: its STDIO MCP calls authenticated loopback endpoints, and the proxy uses the key already saved in local settings.

## Architecture

    Codex Desktop / CLI
      -> momo-image Skill + STDIO MCP
      -> momoapi-proxy authenticated 127.0.0.1 image endpoints
      -> model-specific MOMO API route

The MCP tools are image_capabilities, image_generate, image_edit, image_task_status, image_asset_get, and image_asset_list. Reference and mask URLs must use HTTPS, literal and DNS-resolved loopback/private-address targets are rejected, redirects are not followed, and each downloaded or inline image is limited to 20 MiB.

## Local image asset library

Generated and edited images are materialized and stored on the user's computer under `~/.momoapi-proxy/images` by default. MCP results return a short `asset_id`, `asset:img_...` reference, local path, MIME type, byte count, SHA-256, and—when available—an opaque signed vision reference. MCP never returns the full image as inline Base64. On the immediate next Responses turn, the proxy validates the signature and local asset metadata, then promotes only a same-origin MOMO HTTPS result URL to `input_image`. Historical, forged, missing, HTTP, and cross-origin references are not promoted.

Use the returned reference for a later edit:

```json
{
  "model": "gpt-image-2-momoapi",
  "prompt": "Add a red hat",
  "reference_images": ["asset:img_<sha256>"]
}
```

The proxy resolves only opaque asset IDs from its own library. It never accepts an arbitrary local path from the model, so a prompt cannot turn the image plugin into a general local-file reader. PNG, JPEG, and WebP are content-sniffed, size-limited, content-addressed, and integrity-checked before reuse. Defaults are 20 MiB per image, 2 GiB total, 2,000 assets, and 30 days since last access. Identical content is deduplicated.

The local library is not a CDN or persistent remote store. A selected asset leaves the computer only when the user asks an image model to edit it; the proxy then reads that one asset and sends it as the current upstream edit input.

Optional non-secret settings:

```json
{
  "imageAssets": {
    "maxAssetMb": 20,
    "maxTotalMb": 2048,
    "maxAssets": 2000,
    "retentionDays": 30
  }
}
```

## Model routing and protocol controls

| Model | Generation | Reference editing | n | References | Size controls |
| --- | --- | --- | ---: | ---: | --- |
| gpt-image-2 | POST /v1/images/generations | Same endpoint with image_urls; asynchronous task_id is supported | 1 | 1 | 1:1; 3:2/2:3; 16:9/9:16 aliases; 1k/2k/4k quality hints |
| gpt-image-2-momoapi | POST /v1/images/generations | Streaming multimodal POST /v1/chat/completions | 1-4 | 1-4 | Same GPT mapping; the prompt carries the requested output hint |
| gemini-3.1-flash-image | POST /v1/images/generations | Multimodal POST /v1/chat/completions with modalities and extra_body.google.image_config | 1 | 1 | aspect_ratio plus 1K/2K/4K image_size |
| gpt-image-2.5-sunburst | POST /v1/images/generations | Multipart POST /v1/images/edits | 1-10 | 1-16 | Native quality, arbitrary valid WIDTHxHEIGHT, format, compression, background, moderation, streaming |
| gpt-image-2.5-flare | POST /v1/images/generations | Multipart POST /v1/images/edits | 1-10 | 1-16 | Same native controls; optimized for faster everyday generation |

For GPT models, 16:9 maps to the available 1536x1024 canvas, whose physical ratio is 3:2; 9:16 maps to 1024x1536, whose physical ratio is 2:3. The resolution labels sent to GPT are low/medium/high quality hints and do not guarantee an exact pixel count. Gemini receives size as the aspect ratio and quality as 1K, 2K, or 4K on its Images generation route.

Mask input remains disabled for the three legacy routes. The GPT Image 2.5 protocol adapter supports mask input and `input_fidelity=low/high`. Its native output controls are `quality=auto/low/medium/high/xhigh/max`, `output_format=png/jpeg/webp`, `output_compression=0-100` for JPEG/WebP, `background=auto/opaque/transparent`, `moderation=auto/low`, `stream`, and `partial_images=0-3`. Custom dimensions must use multiples of 16, stay between 1:3 and 3:1, keep each edge at or below 3840 pixels, and contain 655,360-8,294,400 total pixels.

GPT Image 2.5 is catalog-gated. The plugin keeps Sunburst and Flare out of the MCP model enum until the authenticated MOMO `/v1/models` response actually contains them. `image_capabilities` still reports both as known protocol adapters with `available: false`, so operators can distinguish "implemented but upstream unavailable" from "unsupported by the plugin". Live generation/editing must not be claimed until a MOMO channel is present and the end-to-end matrix passes.

## Install and run locally

1. Install or update MOMO API Proxy from this repository.
2. Install plugins/momo-image with the Codex plugin manager.
3. Ensure the proxy is configured and running on 127.0.0.1:18789.
4. The plugin launches momoapi-proxy mcp image over STDIO.

Call image_capabilities at runtime instead of duplicating model limits in clients.
