package appcore

import (
	"encoding/json"
	"strconv"
	"unicode/utf8"
)

// Provider-issued opaque state, not proxy-verified crypto or readable reasoning.
// Never decode signatures/redacted data or transfer them to a different model.
type claudeState struct {
	Model     string `json:"model"`
	Type      string `json:"type"`
	Signature string `json:"signature,omitempty"`
	Data      string `json:"data,omitempty"`
}

func objFromClaudeState(s *claudeState) map[string]any {
	b, _ := json.Marshal(s)
	m, _ := decodeVideoObject(b)
	return m
}

func validClaudeOpaque(s string) bool {
	return len(s) > 0 && len(s) <= 256<<10 && utf8.ValidString(s)
}

// encoding/json replaces lone UTF16 surrogates with U+FFFD. Signed opaque
// strings must not be silently changed, even if the surrounding JSON is valid.
func validClaudeUnicode(raw []byte) bool {
	for i := 0; i < len(raw); i++ {
		if raw[i] != '\\' {
			continue
		}
		i++
		if i >= len(raw) {
			return false
		}
		if raw[i] != 'u' {
			continue
		}
		if i+4 >= len(raw) {
			return false
		}
		n, err := strconv.ParseUint(string(raw[i+1:i+5]), 16, 16)
		if err != nil {
			return false
		}
		i += 4
		if n >= 0xdc00 && n <= 0xdfff {
			return false
		}
		if n >= 0xd800 && n <= 0xdbff {
			if i+6 >= len(raw) || raw[i+1] != '\\' || raw[i+2] != 'u' {
				return false
			}
			low, err := strconv.ParseUint(string(raw[i+3:i+7]), 16, 16)
			if err != nil || low < 0xdc00 || low > 0xdfff {
				return false
			}
			i += 6
		}
	}
	return true
}
func parseClaudeState(v any, model string) (*claudeState, error) {
	m := obj(v)
	if m == nil || m["model"] != model || resolveProtocol(model) != "claude" {
		return nil, errRouted
	}
	s := &claudeState{Model: model, Type: str(m["type"])}
	switch s.Type {
	case "thinking":
		if !only(m, "model", "type", "signature") || !validClaudeOpaque(str(m["signature"])) {
			return nil, errRouted
		}
		s.Signature = str(m["signature"])
	case "redacted_thinking":
		if !only(m, "model", "type", "data") || !validClaudeOpaque(str(m["data"])) {
			return nil, errRouted
		}
		s.Data = str(m["data"])
	default:
		return nil, errRouted
	}
	return s, nil
}
func claudeHistoryReasoning(m map[string]any, model string) (routePart, error) {
	if !only(m, "type", "summary", "momo_claude") {
		return routePart{}, errRouted
	}
	s, err := parseClaudeState(m["momo_claude"], model)
	parts, ok := m["summary"].([]any)
	if err != nil || !ok {
		return routePart{}, errRouted
	}
	if s.Type == "redacted_thinking" {
		if len(parts) != 0 {
			return routePart{}, errRouted
		}
		return routePart{claude: s}, nil
	}
	if len(parts) != 1 {
		return routePart{}, errRouted
	}
	p := obj(parts[0])
	text, ok := p["text"].(string)
	if !ok || !only(p, "type", "text") || p["type"] != "summary_text" {
		return routePart{}, errRouted
	}
	return routePart{claude: s, text: text}, nil
}
func hasProviderState(input []any) bool {
	if hasGeminiState(input) {
		return true
	}
	for _, v := range input {
		if _, present := obj(v)["momo_claude"]; present {
			return true
		}
	}
	return false
}

// Explicit native controls avoid guessed per-model budgets, aliases or fallback.
// Provider availability is checked upstream; local validation proves shape only.
func claudeThinkingControl(v any, ir *routeRequest) (map[string]any, error) {
	m := obj(v)
	if m == nil {
		return nil, errRouted
	}
	mode := str(m["type"])
	if mode == "disabled" {
		if !only(m, "type") || ir.effort != "" {
			return nil, errRouted
		}
		return m, nil
	}
	if ir.choice == "required" || ir.selected != "" {
		return nil, errRouted // forced calls are incompatible with signed thinking
	}
	if display, present := m["display"]; present && display != "summarized" && display != "omitted" {
		return nil, errRouted
	}
	switch mode {
	case "adaptive":
		if !only(m, "type", "display") {
			return nil, errRouted
		}
		if ir.effort != "" && !includes([]string{"low", "medium", "high", "xhigh", "max"}, ir.effort) {
			return nil, errRouted
		}
	case "enabled":
		budget, ok := tokenCount(m["budget_tokens"])
		max := ir.maxOutputTokens
		if max == 0 {
			max = 12240
		}
		if !only(m, "type", "budget_tokens", "display") || !ok || budget < 1024 || budget >= max || ir.effort != "" {
			return nil, errRouted
		}
	default:
		return nil, errRouted
	}
	return m, nil
}
