// Package integration contains secret-free, explicit client exports.
package integration

import (
	_ "embed"
	"encoding/json"
)

//go:embed SKILL.md
var Skill string

func MCPConfig(executable string) string {
	data, _ := json.MarshalIndent(map[string]any{"mcpServers": map[string]any{"momo-preview": map[string]any{"command": executable, "args": []string{"mcp"}}}}, "", "  ")
	return string(data)
}

func Capabilities() map[string]any {
	files := map[string]any{"input_files": "ordered bounded PDF only; canonical inline file_data, Claude/Gemini delegated HTTPS file_url with explicit application/pdf; Chat inline only; max16 PDFs/32 images share decoded 1MiB and JSON/history limits; header/EOF framing not structure/safety; no reads/cloud uploads/fetch; explicit local memory snapshots separately described", "tool_files": "paired PDF: Claude nested; Chat/ALL Gemini explicit momo_tool_files:user-projection, mixed images require momo_tool_images too; non-native trust equivalence; re-declare for history/compact; no automatic fallback", "max_pdfs": 16}
	capabilities := map[string]any{"routes": []string{"GET /v1/models", "POST /v1/responses", "POST /v1/chat/completions", "POST /v1/responses/compact"}, "protocol": "default exact passthrough; opt-in partial MOMO Responses/Chat/Claude/Gemini routing with SSE or final JSON", "compact": "explicit X-MOMO-Compact:native request for native Responses model forwards exact JSON; capability/live semantics unverified, no fallback; otherwise explicit routing-mode local lossy checkpoint with ordinary output replay, no opaque or anchor state", "tool_loading": "explicit momo_tool_loading:client-search + parallel_tool_calls:false; ordered client-loaded definitions/local bounded strict validation, not native prompt/cache or constrained generation; no proxy execution", "output_limits": "converted max_output_tokens integer 1..1048576; verified limit terminal is incomplete, never a history anchor", "history": "converted same-model memory anchors only; Stop clears; no transcript export", "mcp": "read-only stdio capability tool and skill resource", "input_images": "converted ordered user inline PNG/JPEG/static GIF/WebP or delegated HTTPS references; same-model history; header/framing only, no fetch/DNS/redirect validation; Gemini URL requires explicit mime_type; no cloud uploads or generation; explicit local memory snapshots separately described", "tool_images": "paired outputs: Claude nested; unsigned Gemini3 inline native parts with MOMO ordered index JSON; Chat/legacy Gemini need explicit momo_tool_images:user-projection, non-native role/trust equivalence; no auto fallback/execution", "media": false, "model_routing": "opt-in partial", "cross_device": false, "account_wallet": false}
	for key, value := range files {
		capabilities[key] = value
	}
	capabilities["image_generation"] = "authenticated non-browser GET /internal/images/capabilities then explicit POST /internal/images/generate; known catalog-authorized generation profiles only; 5min permission, 300s bounded send, no retries/model substitution. GET /internal/images/tasks/<id> only generation-returned IDs in this Core:64 slots/absolute30minTTL, Stop/configure clears. Bounded JSON URL/Base64/tasks; public HTTPS URLs delegated without download/DNS checks, inline framing not pixel safety. Desktop workbench explicit catalog/model/consent generation/manual latest-task and opt-in data-only preview; URL text not auto-loaded; Stop/configure/load clear UI and fence late results. No edit/video/disk assets; media:false means full media suite unimplemented. Upstream calls may bill; failed delivery/Stop cannot undo them."
	capabilities["image_mcp"] = "separate opt-in mcp-images: private stdin config line (exact Endpoint/APIKey/optional Mode), then bounded newline stdio MCP. Owned Core, no listener/keyring/env/account discovery/token handoff. image_capabilities/image_generate/image_task; client confirmed:true is NOT verified human consent; catalog first, one send, no retry/poll/download. Text JSON only, no image content blocks/disk/edit/video; returned session IDs only. Sequential requests: EOF noticed between calls, pending disconnect bounded by Core deadlines, signal cancels. Read-only mcp and desktop copied MCP config remain unchanged; generic MCP clients need a trusted launcher injecting private config prelude, not directly compatible."
	capabilities["client_config"] = "explicit desktop clipboard export of credential-free user-level Codex provider snippet; loopback port + MOMO_LOCAL_API_KEY env reference; no model/client file/account access, no installation; actual agent compatibility unverified"
	capabilities["attachments"] = "routing-mode only: POST /internal/attachments registers one validated inline image/PDF part, GET/DELETE /internal/attachments/att_<random64hex> metadata/deletion; no listing/content export; per-Core 64 entries/8MiB canonical JSON/absolute30minTTL, Stop/configure clears. X-MOMO-Attachments:inline resolves exact user.content or paired tool.output momo_attachment refs only on converted Responses/localcompact. Full inline history snapshots survive asset deletion/expiry; deleted full refs reject. Not cloud upload, provider file_id, disk storage, cross-device or media generation; no account/key access through MCP"
	return capabilities
}
