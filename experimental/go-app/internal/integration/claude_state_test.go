package integration

import (
	"strings"
	"testing"
)

func TestClaudeStateContract(t *testing.T) {
	capability, ok := Capabilities()["claude_state"].(string)
	if !ok {
		t.Fatal("missing Claude state contract")
	}
	for _, s := range []string{"momo_claude", "same-model", "redacted_thinking", "momo_claude_thinking", "signature_delta", "clean EOF"} {
		if !strings.Contains(capability, s) || !strings.Contains(Skill, s) {
			t.Fatal("missing boundary", s)
		}
	}
}
