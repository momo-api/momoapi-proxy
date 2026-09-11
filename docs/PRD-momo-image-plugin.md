# MOMO Image Plugin PRD

Status: implemented for the current model set; GPT Image 2.5 is protocol-ready and catalog-gated.

## Problem and outcome

Codex and ChatGPT Desktop users configured through MOMO API Proxy can use text models without placing the MOMO key in each tool, but image generation is not automatically available through a text-model provider configuration. The product must give the agent explicit image tools while continuing to keep the saved MOMO key inside the local proxy.

The intended user flow is:

```text
User asks for an image
  -> momo-image Skill selects an available model and valid controls
  -> momo-image MCP calls authenticated loopback endpoints
  -> MOMO API Proxy adds the saved MOMO key and selects the model-specific route
  -> image bytes or an asynchronous task result return to Codex
```

## Product scope

The plugin provides four tools:

- `image_capabilities`: return known models, current availability, operations, transports, and limits.
- `image_generate`: create images from a text prompt.
- `image_edit`: edit or compose from reference images, with mask support where verified.
- `image_task_status`: poll asynchronous MOMO image jobs.

The local proxy owns authentication, request validation, reference-image fetching, response normalization, and upstream error translation. The Skill owns model selection and tool workflow. The plugin never stores or requests a second copy of the MOMO key.

## Model matrix

| Model | Generate | Edit | References | Mask | Availability rule |
| --- | --- | --- | ---: | --- | --- |
| `gpt-image-2` | Images generations | Images generations with `image_urls` | 1 | No | Current verified route |
| `gpt-image-2-momoapi` | Images generations | Streaming multimodal Chat Completions | 4 | No | Current verified route |
| `gemini-3.1-flash-image` | Images generations | Multimodal Chat Completions | 1 | No | Current verified route |
| `gpt-image-2.5-sunburst` | Images generations | Same Images generations route with image_urls | 16 | No (not in APIMart contract) | Expose only when authenticated `/v1/models` contains it |
| `gpt-image-2.5-flare` | Images generations | Same Images generations route with image_urls | 16 | No (not in APIMart contract) | Expose only when authenticated `/v1/models` contains it |

Sunburst is preferred for editing precision. Flare is preferred for faster everyday generation. Presence in this PRD means protocol support, not proof that a production MOMO channel is currently available.

## GPT Image 2.5 request contract

Both Image 2.5 adapters support:

- `prompt`: required non-empty text, at most 32,000 characters in the proxy.
- `n`: integer from 1 to 4.
- `size`: `auto` or `WIDTHxHEIGHT`; both edges divisible by 16, ratio from 1:3 to 3:1, each edge at most 3,840 pixels, and 655,360-8,294,400 total pixels.
- `quality`: `auto`, `low`, `medium`, `high`, `xhigh`, or `max`.
- `output_format`: `png`, `jpeg`, or `webp`.
- `output_compression`: integer from 0 to 100 for JPEG or WebP.
- `background`: `auto`, `opaque`, or `transparent`; transparent output requires PNG or WebP.
- `moderation`: `auto` or `low`.
- `resolution`: `1k`, `2k`, or `4k`.
- `reference_images`: 1-16 data URLs, opaque local asset IDs, or HTTPS URLs for editing. Local/data inputs are uploaded first.

Generation and editing both use JSON `POST /v1/images/generations`. Editing supplies `image_urls` as a string array. Public HTTPS references are forwarded directly; data URLs and local asset references are uploaded with multipart `POST /v1/uploads/images` (`file` field) and replaced by the returned temporary URL. The APIMart GPT Image 2.5 contract does not include `/v1/images/edits`, `images[].image_url`, `mask`, `input_fidelity`, `stream`, or `partial_images`; the adapter fails closed when those fields are requested.

## Availability and failure behavior

Image 2.5 models are known-but-unavailable by default. Before showing them in the MCP tool schema or routing a call, the proxy requests the authenticated MOMO model catalog.

- If a model is present, `image_capabilities` marks it available and the MCP enum includes it.
- If it is absent, the MCP enum omits it.
- If a client bypasses the enum and calls it directly, the proxy returns HTTP 503 with `model_unavailable`.
- A catalog failure fails closed for gated models and does not affect the three current routes.

This prevents a protocol implementation from being mistaken for a live production capability. Once a NewAPI/upstream channel is configured and the model appears in the catalog, no plugin release is required merely to make the enum include it.

## Security and privacy requirements

- Bind internal image routes to loopback and require the proxy's random local token.
- Keep the MOMO key only in existing proxy settings; never place it in plugin manifests, MCP JSON, Codex prompts, responses, or logs.
- Accept remote references and masks only over HTTPS.
- Reject URL credentials, literal IPs, localhost/local domains, private/link-local/multicast addresses, and DNS results containing non-public addresses.
- Do not follow redirects when downloading images.
- Limit every inline or downloaded reference/mask to 20 MiB and preserve the proxy's overall request-body limit.
- Return image data as MCP image content, not as base64 text placed into model context.
- Preserve upstream moderation errors and do not automatically retry user-correctable image errors without changing input.

## Acceptance criteria

Release acceptance requires:

1. Unit coverage for model limits, size validation, native output controls, 16 references, mask, singular/plural multipart image fields, SSE partial-image extraction, and `model_unavailable`.
2. MCP end-to-end coverage through the authenticated local HTTP server, including dynamic removal of unavailable models from tool schemas.
3. Regression coverage for the three existing image routes and all non-image proxy behavior.
4. Plugin manifest and Skill validation.
5. An isolated marketplace add and plugin install using the published Git repository.
6. Secret scanning and release-archive hash verification.
7. For each newly available production model: live generation, live edit, 16-reference acceptance, mask, `xhigh` and `max`, custom size, transparent PNG/WebP, JPEG/WebP compression, `n>1`, streaming partial images, latency, billing, and moderation-error checks.

Until item 7 passes for Sunburst or Flare, documentation must say "protocol-ready, not live-verified".

## Release and operations

- Source changes go through a focused branch, PR, automated Node/container checks, and Secret Scan.
- Publish an immutable GitHub release archive with SHA-256.
- Users update MOMO API Proxy, add the Git marketplace once, install `momo-image`, and start a new Codex thread.
- Image model/channel changes remain server-side operational work. The plugin automatically discovers Image 2.5 only after the authenticated catalog exposes it.
- Do not add Image 2.5 to the public catalog solely because the plugin understands its protocol; a usable upstream channel and live acceptance are prerequisites.

## Out of scope

- Video generation.
- A browser-hosted public upload service.
- Cloud CDN storage for generated user images. The current tool returns direct/base64/async MOMO results; durable asset storage requires a separate retention, privacy, access-control, and deletion design.
- Claiming general compatibility with every OpenAI-compatible image provider. Routing remains explicitly model-specific and test-backed.

## References

- [MOMO Image implementation notes](momo-image-plugin.md)
- [OpenAI image generation guide](https://developers.openai.com/api/docs/guides/image-generation)
- [GPT Image 2.5 Sunburst](https://developers.openai.com/api/docs/models/gpt-image-2.5-sunburst)
- [GPT Image 2.5 Flare](https://developers.openai.com/api/docs/models/gpt-image-2.5-flare)
