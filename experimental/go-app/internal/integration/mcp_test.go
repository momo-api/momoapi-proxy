package integration

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
)

func TestMCPAndSkillExports(t *testing.T) {
	if !strings.Contains(Capabilities()["parallel_tools"].(string), "false at most one NEW") || !strings.Contains(Skill, "never inherit constraint") || !strings.Contains(Skill, "SSE may expose first proposal") {
		t.Fatal("stale explicit parallel tool contract")
	}
	if !strings.Contains(Capabilities()["tool_aliases"].(string), "64-byte mta_") || !strings.Contains(Skill, "reserved") || !strings.Contains(Skill, "canonical output retains original identity") {
		t.Fatal("stale long tool identity contract")
	}
	if Capabilities()["video_mcp"] == nil || !strings.Contains(Skill, "mcp-videos-connect") || !strings.Contains(Skill, "NOT verified human consent") || strings.Contains(Capabilities()["video_generation"].(string), "No video MCP yet") {
		t.Fatal("stale explicit video MCP boundary")
	}
	if Capabilities()["video_generation"] == nil || !strings.Contains(Skill, "Video API + desktop workbench + explicit MCP subset") || !strings.Contains(Skill, "NOT full plugin compatibility") || !strings.Contains(Skill, "Desktop video workbench") || !strings.Contains(Capabilities()["video_generation"].(string), "Desktop video workbench") || strings.Contains(Skill, "GUI/video MCP/legacy Adobe not yet migrated") {
		t.Fatal("stale video API support boundary")
	}
	if !strings.Contains(Capabilities()["image_mcp"].(string), "NOT verified human consent") || !strings.Contains(Skill, "mcp-images") || !strings.Contains(Skill, "trusted launcher") {
		t.Fatal("stale opt-in MCP boundaries")
	}
	if !strings.Contains(Capabilities()["image_mcp"].(string), "mcp-images-connect") || !strings.Contains(Skill, "no private config prelude") || !strings.Contains(Skill, "MOMO_LOCAL_API_KEY") {
		t.Fatal("stale connected MCP exports")
	}
	if !strings.Contains(Skill, "Desktop image workbench") || !strings.Contains(Capabilities()["image_generation"].(string), "Desktop workbench") {
		t.Fatal("stale image workbench export")
	}
	if Capabilities()["image_generation"] == nil || Capabilities()["media"] != false || !strings.Contains(Skill, "/internal/images/generate") || !strings.Contains(Skill, "no retry or auto-poll") {
		t.Fatal("stale generation subset exports")
	}
	input := strings.Join([]string{
		`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05"}}`,
		`{"jsonrpc":"2.0","method":"notifications/initialized"}`,
		`{"jsonrpc":"2.0","id":"tools","method":"tools/list"}`,
		`{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"gateway_capabilities","arguments":{}}}`,
		`{"jsonrpc":"2.0","id":4,"method":"resources/list"}`,
		`{"jsonrpc":"2.0","id":5,"method":"resources/read","params":{"uri":"momo://preview/skill"}}`,
		`{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"run_shell","arguments":{"key":"synthetic-private"}}}`,
		`{"jsonrpc":"2.0","id":7,"method":"resources/read","params":{"uri":"file:///private"}}`,
		`{"jsonrpc":"2.0","id":8,"method":"unknown"}`,
	}, "\n") + "\n"
	for _, line := range strings.Split(strings.TrimSpace(input), "\n") {
		if !json.Valid([]byte(line)) {
			t.Fatal("invalid fixture")
		}
	}
	var out bytes.Buffer
	if ServeMCP(strings.NewReader(input), &out) != nil {
		t.Fatal("MCP failed")
	}
	lines := strings.Split(strings.TrimSpace(out.String()), "\n")
	if len(lines) != 8 || strings.Contains(out.String(), "synthetic-private") {
		t.Fatal("notification or secret echoed")
	}
	for i, line := range lines {
		var reply map[string]json.RawMessage
		if json.Unmarshal([]byte(line), &reply) != nil {
			t.Fatal("invalid reply")
		}
		if i >= 5 && reply["error"] == nil {
			t.Fatal("unsupported action accepted")
		}
	}
	if !strings.Contains(out.String(), "gateway_capabilities") || !strings.Contains(out.String(), "MOMO local gateway preview") {
		t.Fatal("missing capability/skill")
	}
	if !strings.Contains(out.String(), "output_limits") || !strings.Contains(out.String(), "max_output_tokens integer 1..1048576") || !strings.Contains(Skill, "Incomplete never creates a history") || strings.Contains(Skill, "explicit token-limit options are not") {
		t.Fatal("stale output-limit capability/skill")
	}
	if !strings.Contains(out.String(), `POST /v1/responses/compact`) || !strings.Contains(Skill, "cmp_ IDs are NOT") || !strings.Contains(Skill, "not native provider compact or a semantic summary") {
		t.Fatal("stale checkpoint capability/skill")
	}
	config := MCPConfig(`C:\Program Files\MOMO\preview.exe`)
	if !strings.Contains(Capabilities()["function_strict"].(string), "independent of client-search") || !strings.Contains(Skill, "Ordinary function strict:true is independent") {
		t.Fatal("stale ordinary strict exports")
	}
	if !strings.Contains(Capabilities()["search_checkpoint"].(string), "whole completed") || !strings.Contains(Skill, "whole completed search/loading/call-result turns") || strings.Contains(Skill, "search lifecycle local compact unsupported") {
		t.Fatal("stale search checkpoint exports")
	}
	if !strings.Contains(Skill, "X-MOMO-Compact:native") || !strings.Contains(out.String(), "tool_loading") || !strings.Contains(Skill, "momo_tool_loading") {
		t.Fatal("stale native compact/search capability exports")
	}
	if !strings.Contains(out.String(), "input_images") || !strings.Contains(Skill, "Gemini URL requires explicit mime_type") {
		t.Fatal("stale image capability exports")
	}
	if !strings.Contains(out.String(), "tool_images") || !strings.Contains(Skill, "momo_tool_images") {
		t.Fatal("stale tool image capability export")
	}
	if !strings.Contains(out.String(), "input_files") || !strings.Contains(out.String(), "tool_files") || !strings.Contains(Skill, "momo_tool_files") || !strings.Contains(Skill, "Max16 PDFs/32 images") || Capabilities()["max_pdfs"] != 16 {
		t.Fatal("stale PDF capability/skill export")
	}
	if !strings.Contains(out.String(), "client_config") || !strings.Contains(Skill, "MOMO_LOCAL_API_KEY") {
		t.Fatal("stale manual client config export boundaries")
	}
	if !strings.Contains(out.String(), "attachments") || !strings.Contains(Skill, "X-MOMO-Attachments:inline") || !strings.Contains(Skill, "deletion does NOT erase") {
		t.Fatal("stale attachment capability/skill")
	}
	if !json.Valid([]byte(config)) || !strings.Contains(config, "mcpServers") || strings.Contains(config, "api_key") {
		t.Fatal("config export")
	}
}

func TestMCPBounds(t *testing.T) {
	var out bytes.Buffer
	if ServeMCP(strings.NewReader(strings.Repeat("x", 65537)), &out) == nil || out.Len() != 0 {
		t.Fatal("unbounded input")
	}
	out.Reset()
	if ServeMCP(strings.NewReader("broken\n"), &out) != nil || strings.Contains(out.String(), "broken") || !strings.Contains(out.String(), "Invalid request") {
		t.Fatal("parse error contract")
	}
}
