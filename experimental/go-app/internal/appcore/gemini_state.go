package appcore

import (
	"encoding/base64"
	"strings"
)

// Provider-issued bytes, NOT a proxy signature or verified cryptographic token.
// Namespaced canonical metadata binds replay to the exact model; no fallback.
type geminiState struct {
	Model     string `json:"model"`
	Signature string `json:"thought_signature,omitempty"`
	// Preserve native shape; local matching IDs are not provider-issued IDs.
	CallIDAbsent bool `json:"call_id_absent,omitempty"`
	ThoughtFalse bool `json:"thought_false,omitempty"`
}

func validGeminiSignature(s string) bool {
	if len(s) == 0 || len(s) > 256<<10 || strings.ContainsAny(s, " \r\n\t") {
		return false
	}
	b, err := base64.StdEncoding.Strict().DecodeString(s)
	return err == nil && len(b) > 0 && base64.StdEncoding.EncodeToString(b) == s
}
func parseGeminiState(v any, model string) (*geminiState, error) {
	m := obj(v)
	if m == nil || !only(m, "model", "thought_signature", "call_id_absent", "thought_false") || m["model"] != model || !geminiModelName(model) {
		return nil, errRouted
	}
	s := &geminiState{Model: model}
	if v, exists := m["thought_false"]; exists {
		if v != true {
			return nil, errRouted
		}
		s.ThoughtFalse = true
	}
	if v, exists := m["call_id_absent"]; exists {
		if v != true {
			return nil, errRouted
		}
		s.CallIDAbsent = true
	}
	if v, exists := m["thought_signature"]; exists {
		value, ok := v.(string)
		if !ok || !validGeminiSignature(value) {
			return nil, errRouted
		}
		s.Signature = value
	}
	return s, nil
}
func geminiHistoryReasoning(m map[string]any, model string) (routePart, error) {
	if !only(m, "type", "summary", "momo_gemini") {
		return routePart{}, errRouted
	}
	state, err := parseGeminiState(m["momo_gemini"], model)
	parts, ok := m["summary"].([]any)
	if err != nil || state.CallIDAbsent || state.ThoughtFalse || !ok || len(parts) != 1 {
		return routePart{}, errRouted
	}
	p := obj(parts[0])
	text, ok := p["text"].(string)
	if !ok || !only(p, "type", "text") || p["type"] != "summary_text" {
		return routePart{}, errRouted
	}
	return routePart{text: text, gemini: state, thought: true}, nil
}
func geminiAssistantParts(v any, model string) (string, []routePart, error) {
	parts, ok := v.([]any)
	if !ok {
		return messageParts(v, "assistant", model, &imageBudget{})
	}
	hasState := false
	for _, value := range parts {
		if _, present := obj(value)["momo_gemini"]; present {
			hasState = true
		}
	}
	if !hasState {
		// Keep the legacy joining/empty-part semantics for ordinary messages.
		return messageParts(v, "assistant", model, &imageBudget{})
	}
	result := []routePart{}
	texts := []string{}
	for _, value := range parts {
		p := obj(value)
		if metadata, exists := p["momo_gemini"]; exists {
			state, err := parseGeminiState(metadata, model)
			text, ok := p["text"].(string)
			if err != nil || state.Signature == "" || state.CallIDAbsent || !ok || p["type"] != "output_text" || !only(p, "type", "text", "momo_gemini") {
				return "", nil, errRouted
			}
			result = append(result, routePart{text: text, gemini: state})
			texts = append(texts, text)
		} else {
			text, err := textParts([]any{value})
			if err != nil {
				return "", nil, err
			}
			result = append(result, routePart{text: text})
			texts = append(texts, text)
		}
	}
	return strings.Join(texts, "\n"), result, nil
}

func hasGeminiState(input []any) bool {
	for _, v := range input {
		m := obj(v)
		if m["momo_gemini"] != nil {
			return true
		}
		if parts, ok := m["content"].([]any); ok {
			for _, p := range parts {
				if obj(p)["momo_gemini"] != nil {
					return true
				}
			}
		}
	}
	return false
}
