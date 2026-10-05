package integration

import (
	"encoding/json"
	"errors"
)

// Manual client-side contract, not upstream metadata, availability, context or
// performance evidence. One explicitly requested, tested slug; no discovery.
// Never copy remote model instructions, account data or arbitrary JSON fields.
func CodexTextToolsCatalog(model string) (string, error) {
	if model != "gpt-5.5" {
		return "", errors.New("unsupported client catalog model")
	}
	entry := map[string]any{
		"slug": model, "display_name": model + " (MOMO text-tools preview)",
		"description":                "Manual converted-client contract, not live model capability or availability proof. No grammar/search/summary/encrypted continuation or prompt-cache guarantees.",
		"supported_reasoning_levels": []any{}, // no guessed effort/default/token/context limits
		"shell_type":                 "unified_exec", "visibility": "list", "supported_in_api": true, "priority": 1,
		"availability_nux": nil, "upgrade": nil, "model_messages": nil,
		"base_instructions": "Use only explicitly declared tools and respect client sandbox and approvals. Do not assume unavailable capabilities.",
		// Codex0.156 sends reasoning:{} when its summary parameter is disabled.
		// auto opts into the explicitly documented best-effort/no-summary policy.
		"default_reasoning_summary": "auto", "supports_reasoning_summary_parameter": true,
		"support_verbosity": false, "default_verbosity": nil, "apply_patch_tool_type": nil,
		"truncation_policy":            map[string]any{"mode": "bytes", "limit": 10000},
		"experimental_supported_tools": []any{}, "input_modalities": []string{"text"},
		"supports_search_tool": false, "include_skills_usage_instructions": true,
		"include_plugin_usage_instructions": true, "include_apps_usage_instructions": false,
		"node_repl_disabled": true,
	}
	data, err := json.MarshalIndent(map[string]any{"models": []any{entry}}, "", "  ")
	if err != nil {
		return "", errors.New("client catalog unavailable")
	}
	return string(data) + "\n", nil
}
