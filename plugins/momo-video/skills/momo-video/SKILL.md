---
name: momo-video
description: Generate text-to-video or image-to-video tasks with MOMO video models through the locally authenticated MOMO API Proxy. Use for video generation, video model capability checks, and video task status polling; do not use it for editing an existing video file.
---

# MOMO Video

The production catalog includes `momoapi-veo-3-1-fast` as a video route. Select it only when `video_capabilities` reports it as available; the catalog remains authoritative for exact controls.

Use the MCP tools from this plugin. The local proxy keeps the MOMO credential out of tool arguments.

1. Call `video_capabilities` before choosing model-specific controls. Treat its returned duration, aspect ratio, resolution, audio, reference-image, availability, and operation fields as authoritative.
2. Call `video_generate` with a prompt and only parameters supported by the selected model. For image-to-video, pass references as `asset:img_...`, an image data URL, or a public HTTPS image URL.
3. If generation is asynchronous, call `video_task_status` with the returned task ID until it reaches a terminal state.
4. Return `playable_url` (or `remote_url`) to the user for browser playback or download. Never present `authenticated_content_url` as a clickable browser link: it requires the user's MOMO API bearer token and a normal browser navigation will receive `invalid token`. Do not download or duplicate the video on the local computer, VPS, R2, or another CDN unless the user explicitly requests that transfer.

Do not infer capabilities from model names or silently substitute another model when validation fails.
