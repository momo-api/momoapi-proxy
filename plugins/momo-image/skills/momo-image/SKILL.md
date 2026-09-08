---
name: momo-image
description: Generate or edit images through MOMO API using the local momoapi-proxy image MCP tools. Use when the user asks for an image, image variation, or image edit.
---

# MOMO Image

Use the `momo-image` MCP tools instead of asking the user to paste a MOMO API key. The local proxy owns the key and only exposes authenticated loopback endpoints.

## Workflow

1. Call `image_capabilities` when the model or supported controls are unclear.
2. For a new image, call `image_generate` with a concise prompt and only supported options.
3. For an edit, call `image_edit` and provide one or more `reference_images` as HTTPS image URLs or `data:image/...;base64,...` values.
4. If the result contains a `task_id` and no image, call `image_task_status` until it returns an image or a terminal error.
5. Present returned image content directly; do not expose local tokens, MOMO keys, raw authorization headers, or full unredacted request logs.

## Models

The first release supports `gpt-image-2-momoapi`, `gpt-image-2`, and `gemini-3.1-flash-image`. Do not claim unsupported controls; use the capability response as the source of truth.
