---
name: momo-video
description: Generate text-to-video or image-to-video tasks with MOMO video models through the locally authenticated MOMO API Proxy. Use for video generation, video model capability checks, and video task status polling; do not use it for editing an existing video file.
---

# MOMO Video

The production catalog may expose MiniMax-H3-Max and seedance-2.5 through NewAPI's APIMart channel #4. Select a model only when video_capabilities reports it as available. An old Adobe route appearing in a plugin enum is not evidence of availability.

Use the MCP tools from this plugin. The local proxy keeps the MOMO credential out of tool arguments.

1. Call `video_capabilities` before choosing model-specific controls. Treat its returned duration, aspect ratio, resolution, audio, reference-image, availability, and operation fields as authoritative.
2. Call `video_generate` with a prompt and only parameters supported by the selected model. For APIMart image-to-video, `first_frame_image`, `last_frame_image`, and `reference_images` accept **public HTTPS URLs only**; `asset:img_...` and data URLs are supported only by compatible legacy routes. Do not silently upload local assets to a third-party host.
3. If generation is asynchronous, call `video_task_status` with the returned task ID until it reaches a terminal state.
4. Return `playable_url` (or `remote_url`) to the user for browser playback or download. Never present `authenticated_content_url` as a clickable browser link: it requires the user's MOMO API bearer token and a normal browser navigation will receive `invalid token`. Do not download or duplicate the video on the local computer, VPS, R2, or another CDN unless the user explicitly requests that transfer.

## APIMart video controls

- MiniMax-H3-Max: duration 5-15 s; resolution 480P (cheapest), 768P (default), or 1080P; text, first/last-frame and up to 9 HTTPS reference images. The first TWO input images incur no **additional image-input fee**, not free video generation; more images are charged. The first-five-free-input-images rule belongs to the distinct MiniMax-H3 model. The current plugin does not support APIMart reference video/audio or 2K.
- seedance-2.5: duration 4-30 s; resolution 480p (default), 720p, or 1080p; text, first/last-frame and up to 30 HTTPS reference images. The supported aspect ratios are 16:9, 4:3, 1:1, 3:4, 9:16, 21:9, adaptive (default); image-reference or first/last-frame requests require adaptive. The deployed NewAPI channel prices every reference image as an additional input: **zero images are free of the input surcharge** under its current pricing rule. This is not a guarantee about any APIMart promotion; video generation itself is billed.
- reference_images are reference media, NOT first-frame controls. Use first_frame_image and last_frame_image for frame-based image-to-video; do not mix frames with references. These fields need public HTTPS URLs. Frame control needs adaptive aspect ratio; for Seedance references, use adaptive or omit aspect_ratio.
- The APIMart route uses MOMO /v1/video/generations and polls the compatible /v1/videos/{task_id} endpoint. Never automatically retry an uncertain paid submission.

Official parameters: https://docs.apimart.ai/en/api-reference/videos/minimax-h3/max and https://docs.apimart.ai/en/api-reference/videos/seedance-2-5/generation . Only MiniMax 480P/5s text and one-frame cases have been accepted end-to-end so far; all other combinations are document- and adapter-validated, not live paid-tested.

Do not infer capabilities from model names or silently substitute another model when validation fails.
