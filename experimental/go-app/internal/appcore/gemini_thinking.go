package appcore

import (
	"encoding/json"
	"strconv"
)

// generateContent ThinkingConfig, not Interactions thinking steps. Shape-only
// validation: model support and model-specific ranges remain upstream's decision.
// Never guess budgets, downgrade levels, retry, or inherit a previous turn's knobs.
func geminiThinkingControl(v any, present bool, effort string) (map[string]any, error) {
	var config map[string]any
	if present {
		m := obj(v)
		if m == nil || len(m) == 0 || !only(m, "includeThoughts", "thinkingLevel", "thinkingBudget") {
			return nil, errRouted
		}
		config = make(map[string]any, len(m)+1)
		for k, value := range m {
			config[k] = value
		}
		if b, ok := m["includeThoughts"]; ok {
			if _, valid := b.(bool); !valid {
				return nil, errRouted
			}
		}
		if level, ok := m["thinkingLevel"]; ok {
			if !includes([]string{"MINIMAL", "LOW", "MEDIUM", "HIGH"}, str(level)) {
				return nil, errRouted
			}
			if _, budget := m["thinkingBudget"]; budget {
				return nil, errRouted
			}
		}
		if budget, ok := m["thinkingBudget"]; ok {
			n, valid := budget.(json.Number)
			value, err := strconv.ParseInt(string(n), 10, 32)
			if !valid || err != nil || value < -1 || effort != "" {
				return nil, errRouted
			}
		}
	}
	if effort != "" {
		level := map[string]string{"minimal": "MINIMAL", "low": "LOW", "medium": "MEDIUM", "high": "HIGH"}[effort]
		if level == "" {
			return nil, errRouted
		}
		if config == nil {
			config = map[string]any{}
		}
		if explicit, ok := config["thinkingLevel"]; ok && explicit != level {
			return nil, errRouted
		}
		config["thinkingLevel"] = level
	}
	return config, nil
}
