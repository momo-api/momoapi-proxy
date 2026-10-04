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
	return map[string]any{"routes": []string{"GET /v1/models", "POST /v1/responses", "POST /v1/chat/completions"}, "protocol": "same-protocol passthrough", "mcp": "read-only stdio capability tool and skill resource", "media": false, "model_routing": false, "cross_device": false, "account_wallet": false}
}
