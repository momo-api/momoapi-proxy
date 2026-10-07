package appcore

import (
	"context"
	"net/http"
	"strings"
	"testing"
)

func TestClaudeThinkingAliasExplicitControl(t *testing.T) {
	for _, model := range []string{"claude-opus-4-6-thinking", "claude-future-thinking"} {
		for _, mode := range []string{"adaptive", "enabled"} {
			p, _ := decodeObject(claudePayload)
			p["model"] = model
			p["max_output_tokens"] = 1536
			control := map[string]any{"type": mode}
			if mode == "enabled" {
				control["budget_tokens"] = 1024
			}
			p["momo_claude_thinking"] = control
			plan, err := buildClaudePlan(mustJSON(p))
			if err != nil {
				t.Fatal("explicit alias rejected")
			}
			wire, _ := decodeVideoObject(plan.body)
			if wire["model"] != model || string(mustJSON(wire["thinking"])) != string(mustJSON(control)) || str(plan.model) != model {
				t.Fatal("alias/control rewritten")
			}
		}
	}
	for _, tc := range []struct{ model, control, choice string }{
		{"claude-opus-4-6-thinking", "", ""},
		{"claude-opus-4-6-thinking", `{"type":"disabled"}`, ""},
		{"claude-opus-4-6-thinking", `{"type":"adaptive"}`, "required"},
		{"claude-opus-4-6-thinking", `{"type":"enabled","budget_tokens":1023}`, ""},
		{"claude-opus-4-6-thinking-preview", `{"type":"adaptive"}`, ""},
		{"claude-thinking-future", `{"type":"adaptive"}`, ""},
		{"claude-thinking-thinking", `{"type":"adaptive"}`, ""},
	} {
		p, _ := decodeObject(claudePayload)
		p["model"] = tc.model
		if tc.control != "" {
			p["momo_claude_thinking"], _ = decodeObject(tc.control)
		}
		if tc.choice != "" {
			p["tool_choice"] = tc.choice
		}
		if _, err := buildClaudePlan(mustJSON(p)); err == nil {
			t.Fatal("implicit/disabled/ambiguous alias accepted")
		}
	}
	p, _ := decodeObject(claudePayload)
	p["model"] = "claude-opus-4-6-thinking"
	p["reasoning_effort"] = "low"
	if _, err := buildClaudePlan(mustJSON(p)); err == nil {
		t.Fatal("effort-only alias enabled")
	}
	// Signed state cannot be rebound from the base model to an alias.
	if _, err := parseClaudeState(map[string]any{"model": "claude-opus-4-6", "type": "thinking", "signature": "synthetic"}, "claude-opus-4-6-thinking"); err == nil {
		t.Fatal("base/alias signed state rebound")
	}
}

func TestClaudeThinkingStartSignatureDeferred(t *testing.T) {
	model := "claude-opus-4-6-thinking"
	good := strings.ReplaceAll(claudeStart()+claudeThinkingFixture(0, "synthetic public summary", "synthetic opaque signature")+claudeText(1, "MOMO_OK")+claudeEnd("end_turn"), "claude-sonnet-4-6", model)
	good = strings.Replace(good, `"signature":"",`, "", 1)
	// A thinking block start may omit signature, but closing still requires
	// exactly one final validated provider signature_delta.
	w := &claudeCaptureWriter{jsonProbeWriter: jsonProbeWriter{header: make(http.Header), mode: "ok"}}
	if err := convertClaudeStream(context.Background(), w, strings.NewReader(good), &chatPlan{model: model}); err != nil {
		t.Fatal("deferred signature rejected")
	}
	for _, bad := range []string{
		strings.Replace(good, `"thinking":""`, `"thinking":"","signature":null`, 1),
		strings.Replace(good, `"thinking":""`, `"thinking":"","signature":"initial"`, 1),
		strings.Replace(good, claudeFrame("content_block_delta", map[string]any{"index": 0, "delta": map[string]any{"type": "signature_delta", "signature": "synthetic opaque signature"}}), "", 1),
	} {
		x := &claudeCaptureWriter{jsonProbeWriter: jsonProbeWriter{header: make(http.Header), mode: "ok"}}
		if err := convertClaudeStream(context.Background(), x, strings.NewReader(bad), &chatPlan{model: model}); err == nil || x.body.Len() != 0 {
			t.Fatal("invalid/missing final signature completed")
		}
	}
}
