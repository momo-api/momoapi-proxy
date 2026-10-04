package appcore

import (
	"encoding/json"
	"errors"
	"strings"
)

var errRouted = errors.New("unsupported routed payload")

// Same model classifier as Node's Responses entry; classification is not proof
// that the corresponding protocol adapter exists. Unsupported adapters fail.
func resolveProtocol(model string) string {
	if model == "muse-auto" {
		return "muse"
	}
	if strings.HasPrefix(model, "gemini-") {
		return "gemini"
	}
	if strings.HasPrefix(model, "claude-") {
		return "claude"
	}
	if strings.HasPrefix(model, "mimo-") || strings.HasSuffix(model, "-sol") || strings.HasSuffix(model, "-luna") || strings.HasSuffix(model, "-responses") {
		return "responses"
	}
	return "chat"
}

type chatTool struct{ wire, name, namespace, kind string }
type chatPlan struct {
	body  []byte
	model string
	tools map[string]chatTool
}

func str(v any) string         { s, _ := v.(string); return s }
func obj(v any) map[string]any { m, _ := v.(map[string]any); return m }
func only(m map[string]any, keys ...string) bool {
	for k := range m {
		found := false
		for _, key := range keys {
			if k == key {
				found = true
				break
			}
		}
		if !found {
			return false
		}
	}
	return true
}
func wireName(s string) bool {
	if len(s) == 0 || len(s) > 64 {
		return false
	}
	for _, r := range s {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '_' || r == '-') {
			return false
		}
	}
	return true
}
func textParts(v any) (string, error) {
	if s, ok := v.(string); ok {
		return s, nil
	}
	parts, ok := v.([]any)
	if !ok {
		return "", errRouted
	}
	result := []string{}
	for _, p := range parts {
		m := obj(p)
		s, ok := m["text"].(string)
		if !ok || !only(m, "type", "text") || (str(m["type"]) != "input_text" && str(m["type"]) != "output_text" && str(m["type"]) != "text") {
			return "", errRouted
		}
		result = append(result, s)
	}
	return strings.Join(result, "\n"), nil
}

// Intentionally explicit subset. Never silently discard media/history refs,
// unsupported knobs, built-in tools or ambiguous namespace collisions.
func buildChatPlan(data []byte) (*chatPlan, error) {
	var p map[string]any
	if json.Unmarshal(data, &p) != nil || !only(p, "model", "stream", "input", "instructions", "tools", "tool_choice", "reasoning", "reasoning_effort", "model_reasoning_effort") || p["stream"] != true {
		return nil, errRouted
	}
	plan := &chatPlan{model: str(p["model"]), tools: map[string]chatTool{}}
	if plan.model == "" {
		return nil, errRouted
	}
	for _, key := range []string{"reasoning_effort", "model_reasoning_effort"} {
		if v, present := p[key]; present {
			if _, ok := v.(string); !ok {
				return nil, errRouted
			}
		}
	}
	tools := []any{}
	var addTool func(map[string]any, string) error
	addTool = func(t map[string]any, ns string) error {
		if t == nil {
			return errRouted
		}
		if str(t["type"]) == "namespace" {
			if ns != "" || !only(t, "type", "name", "tools") {
				return errRouted
			}
			namespace := str(t["name"])
			if !wireName(namespace) {
				return errRouted
			}
			children, ok := t["tools"].([]any)
			if !ok || len(children) == 0 {
				return errRouted
			}
			for _, child := range children {
				if err := addTool(obj(child), namespace); err != nil {
					return err
				}
			}
			return nil
		}
		kind := str(t["type"])
		if kind != "function" && kind != "custom" {
			return errRouted
		}
		if !only(t, "type", "name", "description", "parameters") {
			return errRouted
		}
		name := str(t["name"])
		if !wireName(name) || name == "exec" || name == "apply_patch" {
			return errRouted
		}
		wire := name
		if ns != "" && ns != "functions" {
			wire = ns + "__" + name
		} else {
			ns = ""
		}
		if !wireName(wire) || len(plan.tools) >= 128 {
			return errRouted
		}
		if _, exists := plan.tools[wire]; exists {
			return errRouted
		}
		description := "Codex tool"
		if v, ok := t["description"]; ok {
			s, valid := v.(string)
			if !valid {
				return errRouted
			}
			if s != "" {
				description = s
			}
		}
		parameters := any(map[string]any{"type": "object", "properties": map[string]any{}})
		if v, ok := t["parameters"]; ok {
			if obj(v) == nil {
				return errRouted
			}
			parameters = v
		}
		if kind == "custom" {
			if str(t["description"]) == "" {
				description = "Codex custom tool"
			}
			if _, present := t["parameters"]; present {
				return errRouted
			}
			description += "\nRaw freeform input for this tool."
			parameters = map[string]any{"type": "object", "properties": map[string]any{"input": map[string]any{"type": "string", "description": "Raw freeform input for this tool."}}, "required": []string{"input"}, "additionalProperties": false}
		}
		plan.tools[wire] = chatTool{wire, name, ns, kind}
		tools = append(tools, map[string]any{"type": "function", "function": map[string]any{"name": wire, "description": description, "parameters": parameters}})
		return nil
	}
	if v, present := p["tools"]; present {
		ts, ok := v.([]any)
		if !ok {
			return nil, errRouted
		}
		for _, t := range ts {
			if err := addTool(obj(t), ""); err != nil {
				return nil, err
			}
		}
	}
	messages := []any{}
	if v, present := p["instructions"]; present {
		s, ok := v.(string)
		if !ok {
			return nil, errRouted
		}
		if s = strings.TrimSpace(s); s != "" {
			messages = append(messages, map[string]any{"role": "system", "content": s})
		}
	}
	input, ok := p["input"].([]any)
	if !ok || len(input) == 0 {
		return nil, errRouted
	}
	pending := map[string]string{}
	seen := map[string]bool{}
	for _, entry := range input {
		m := obj(entry)
		if m == nil {
			return nil, errRouted
		}
		if v, present := m["type"]; present {
			if _, ok := v.(string); !ok {
				return nil, errRouted
			}
		}
		switch str(m["type"]) {
		case "function_call", "custom_tool_call":
			if !only(m, "type", "name", "namespace", "call_id", "arguments", "input") {
				return nil, errRouted
			}
			name := str(m["name"])
			ns := str(m["namespace"])
			if v, present := m["namespace"]; present {
				if _, ok := v.(string); !ok {
					return nil, errRouted
				}
			}
			wire := name
			if ns != "" && ns != "functions" {
				wire = ns + "__" + name
			}
			tool, exists := plan.tools[wire]
			id := str(m["call_id"])
			if !exists || len(id) == 0 || len(id) > 128 || seen[id] || ((str(m["type"]) == "custom_tool_call") != (tool.kind == "custom")) {
				return nil, errRouted
			}
			if tool.kind == "custom" {
				if _, present := m["arguments"]; present {
					return nil, errRouted
				}
			} else {
				if _, present := m["input"]; present {
					return nil, errRouted
				}
			}
			args, ok := m["arguments"].(string)
			if tool.kind == "custom" {
				s, valid := m["input"].(string)
				if !valid {
					return nil, errRouted
				}
				b, _ := json.Marshal(map[string]string{"input": s})
				args = string(b)
				ok = true
			}
			if !ok || !json.Valid([]byte(args)) {
				return nil, errRouted
			}
			seen[id] = true
			pending[id] = tool.kind
			call := map[string]any{"id": id, "type": "function", "function": map[string]string{"name": wire, "arguments": args}}
			if len(messages) > 0 && obj(messages[len(messages)-1])["role"] == "assistant" {
				last := obj(messages[len(messages)-1])
				prior, _ := last["tool_calls"].([]any)
				last["tool_calls"] = append(prior, call)
			} else {
				messages = append(messages, map[string]any{"role": "assistant", "content": "", "tool_calls": []any{call}})
			}
		case "function_call_output", "custom_tool_call_output":
			if !only(m, "type", "call_id", "output") {
				return nil, errRouted
			}
			id := str(m["call_id"])
			kind, exists := pending[id]
			if !exists || ((str(m["type"]) == "custom_tool_call_output") != (kind == "custom")) {
				return nil, errRouted
			}
			content, err := textParts(m["output"])
			if err != nil {
				return nil, err
			}
			delete(pending, id)
			messages = append(messages, map[string]any{"role": "tool", "tool_call_id": id, "content": content})
		case "", "message":
			if len(pending) != 0 || !only(m, "type", "role", "content") {
				return nil, errRouted
			}
			role := str(m["role"])
			switch role {
			case "developer", "system":
				role = "system"
			case "assistant", "user":
			default:
				return nil, errRouted
			}
			content, err := textParts(m["content"])
			if err != nil {
				return nil, err
			}
			if content == "" && role == "user" {
				content = "Continue."
			}
			messages = append(messages, map[string]any{"role": role, "content": content})
		default:
			return nil, errRouted
		}
	}
	if len(pending) != 0 {
		return nil, errRouted
	}
	if strings.Contains(strings.ToLower(plan.model), "qwen") {
		system := []string{}
		rest := []any{}
		for _, v := range messages {
			m := obj(v)
			if m["role"] == "system" {
				if s := strings.TrimSpace(str(m["content"])); s != "" {
					system = append(system, s)
				}
			} else {
				rest = append(rest, v)
			}
		}
		messages = rest
		if len(system) > 0 {
			messages = append([]any{map[string]any{"role": "system", "content": strings.Join(system, "\n\n")}}, rest...)
		}
	}
	body := map[string]any{"model": plan.model, "messages": messages, "stream": true}
	if len(tools) > 0 {
		body["tools"] = tools
		choice := "auto"
		if v, present := p["tool_choice"]; present {
			choice = str(v)
			if choice != "auto" && choice != "none" && choice != "required" {
				return nil, errRouted
			}
		}
		body["tool_choice"] = choice
	} else if _, present := p["tool_choice"]; present {
		return nil, errRouted
	}
	effort := str(p["reasoning_effort"])
	if effort == "" {
		effort = str(p["model_reasoning_effort"])
	}
	if r, present := p["reasoning"]; present {
		m := obj(r)
		if m == nil || !only(m, "effort") || str(m["effort"]) == "" {
			return nil, errRouted
		}
		if effort == "" {
			effort = str(m["effort"])
		}
	}
	if effort != "" {
		body["reasoning_effort"] = strings.ToLower(effort)
	}
	b, err := json.Marshal(body)
	if err != nil || len(b) > MaxRequest {
		return nil, errRouted
	}
	plan.body = b
	return plan, nil
}

// Bare names are restored only if unambiguous; never guess between namespaces.
func (p *chatPlan) restoreTool(name string) (chatTool, bool) {
	if tool, ok := p.tools[name]; ok {
		return tool, true
	}
	var match chatTool
	found := false
	for _, tool := range p.tools {
		if tool.name == name {
			if found {
				return chatTool{}, false
			}
			match = tool
			found = true
		}
	}
	return match, found
}
