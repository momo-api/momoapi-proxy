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
	return map[string]any{"routes": []string{"GET /v1/models", "POST /v1/responses", "POST /v1/chat/completions", "POST /v1/responses/compact"}, "protocol": "default exact passthrough; opt-in partial MOMO Responses/Chat/Claude/Gemini routing with SSE or final JSON", "compact": "explicit X-MOMO-Compact:native request for native Responses model forwards exact JSON; capability/live semantics unverified, no fallback; otherwise explicit routing-mode local lossy checkpoint with ordinary output replay, no opaque or anchor state", "tool_loading": "explicit momo_tool_loading:client-search + parallel_tool_calls:false; ordered client-loaded definitions/local bounded strict validation, not native prompt/cache or constrained generation; no proxy execution", "output_limits": "converted max_output_tokens integer 1..1048576; verified limit terminal is incomplete, never a history anchor", "history": "converted same-model memory anchors only; Stop clears; no transcript export", "mcp": "read-only stdio capability tool and skill resource", "media": false, "model_routing": "opt-in partial", "cross_device": false, "account_wallet": false}
}
