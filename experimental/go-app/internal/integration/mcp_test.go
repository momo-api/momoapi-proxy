package integration

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
)

func TestMCPAndSkillExports(t *testing.T) {
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
	config := MCPConfig(`C:\Program Files\MOMO\preview.exe`)
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
