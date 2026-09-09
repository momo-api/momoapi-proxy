---
name: momo-image
description: Generate or edit images with currently available MOMO image models through the locally authenticated MOMO API Proxy. Use for image creation, reference-image editing, masks, variations, or checking MOMO image capabilities.
---

# MOMO Image

Use the momo-image MCP tools. The local proxy owns the MOMO API key; never ask the user to paste that key into the conversation when the proxy is already configured.

## Workflow

1. Call image_capabilities before choosing a model or non-default controls. Treat its per-model limits and transports as authoritative.
2. For a new image, call image_generate with the prompt and supported options.
3. For a reference-image transformation, call image_edit with HTTPS image URLs or data:image base64 values in reference_images.
4. If a call returns a task_id without an image, poll image_task_status until an image or terminal status is returned. Stop on failed, error, cancelled/canceled, or expired instead of polling forever. Image jobs can take several minutes.
5. Present returned image content directly. Never expose MOMO keys, local tokens, authorization headers, or unredacted request logs.
6. Treat `available: false` as authoritative. Do not call or claim support for a catalog-gated model until it becomes available.

## Verified routing boundaries

- gpt-image-2: generation and single-reference editing use the Images generations route; an edit may return an asynchronous task_id.
- gpt-image-2-momoapi: reference editing uses streaming multimodal Chat Completions to avoid the public Images edits route timing out before its first response byte. Up to four references are accepted.
- gemini-3.1-flash-image: reference editing uses multimodal Chat Completions with Gemini image configuration. One reference is accepted.

Do not send a mask to the three legacy routes: mask editing remains unverified there. For those GPT routes, 16:9 and 9:16 are convenience aliases for the available 1536x1024 (3:2) and 1024x1536 (2:3) canvases. Their GPT 1k/2k/4k values are quality hints rather than guaranteed output dimensions.

## GPT Image 2.5 experimental adapter

- `gpt-image-2.5-sunburst` and `gpt-image-2.5-flare` appear in tool model enums only when MOMO's authenticated model catalog contains them.
- Both protocol adapters support generation and multipart editing, up to 16 reference images, mask input, `input_fidelity`, `n=1-10`, native quality through `max`, custom valid dimensions, output format/compression, background, moderation, and partial-image streaming.
- Sunburst is the precision/editing choice; Flare is the faster everyday-generation choice.
- These are protocol-tested but not live-verified while MOMO has no usable channel. Never state that a live Image 2.5 request succeeded unless it actually did.
