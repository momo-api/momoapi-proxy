package integration

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestCodexTextToolsCatalogExplicitAndConservative(t *testing.T) {
	for _, model := range []string{"", "gpt-5.5 ", "GPT-5.5", "gpt-5.6-sol", "claude-sonnet-4-6", "../profile", "gpt-5.5\n"} {
		if data, err := CodexTextToolsCatalog(model); err == nil || data != "" {
			t.Fatal("unreviewed model accepted")
		}
	}
	data, err := CodexTextToolsCatalog("gpt-5.5")
	if err != nil || len(data) > 8192 {
		t.Fatal("catalog", err)
	}
	var envelope map[string]any
	json.Unmarshal([]byte(data), &envelope)
	models := envelope["models"].([]any)
	if len(envelope) != 1 || len(models) != 1 {
		t.Fatal("catalog scope")
	}
	m := models[0].(map[string]any)
	if m["slug"] != "gpt-5.5" || m["apply_patch_tool_type"] != nil || m["supports_search_tool"] != false || m["support_verbosity"] != false || m["node_repl_disabled"] != true || m["default_reasoning_summary"] != "auto" || len(m["supported_reasoning_levels"].([]any)) != 0 {
		t.Fatal("unsupported tool capabilities advertised")
	}
	for _, key := range []string{"default_reasoning_level", "context_window", "max_context_window", "auto_compact_token_limit", "comp_hash", "guardian", "approval_policy", "sandbox_mode", "model_provider", "base_url", "api_key"} {
		if _, present := m[key]; present {
			t.Fatal("catalog exceeds reviewed scope", key)
		}
	}
	if !strings.Contains(m["description"].(string), "not live model") || !strings.Contains(m["base_instructions"].(string), "sandbox and approvals") {
		t.Fatal("contract disclosure")
	}
}
