package appcore

import "strings"

// Claude is encoded from the same typed request, never via intermediate Chat JSON.
// Thinking/signature/media/continuation support must not be silently approximated.
func buildClaudePlan(data []byte) (*chatPlan, error) {
	ir, err := parseRoutedRequest(data)
	if err != nil {
		return nil, err
	}
	if ir.effort != "" || strings.Contains(ir.model, "-thinking") {
		return nil, errRouted
	}
	messages := []any{}
	system := []string{}
	for _, m := range ir.messages {
		if m.role == "system" {
			if m.text != "" {
				system = append(system, m.text)
			}
			continue
		}
		role := m.role
		content := []any{}
		if role == "tool" {
			role = "user"
			content = append(content, map[string]any{"type": "tool_result", "tool_use_id": m.resultID, "content": m.text})
		} else {
			for _, part := range m.parts {
				if part.image != nil {
					img := part.image
					source := map[string]any{"type": "url", "url": img.url}
					if img.data != "" {
						source = map[string]any{"type": "base64", "media_type": img.mime, "data": img.data}
					}
					content = append(content, map[string]any{"type": "image", "source": source})
					continue
				}
				if part.call == nil {
					if part.text != "" {
						content = append(content, map[string]string{"type": "text", "text": part.text})
					}
					continue
				}
				c := part.call
				args, err := decodeObject(c.args)
				if err != nil {
					return nil, err
				}
				content = append(content, map[string]any{"type": "tool_use", "id": c.id, "name": c.wire, "input": args})
			}
		}
		if len(content) == 0 {
			return nil, errRouted
		}
		// Messages API requires alternating roles; adjacent blocks form one turn.
		if len(messages) > 0 && obj(messages[len(messages)-1])["role"] == role {
			last := obj(messages[len(messages)-1])
			last["content"] = append(last["content"].([]any), content...)
		} else {
			messages = append(messages, map[string]any{"role": role, "content": content})
		}
	}
	if len(messages) == 0 || obj(messages[0])["role"] != "user" {
		return nil, errRouted
	}
	// System-only/later instructions are consolidated explicitly, not turned into user prose.
	// Match the current Node plain-Claude default (4048 + 8192); not a client option.
	body := map[string]any{"model": ir.model, "stream": true, "max_tokens": 12240, "messages": messages}
	if ir.maxOutputTokens != 0 {
		body["max_tokens"] = ir.maxOutputTokens
	}
	if len(system) > 0 {
		body["system"] = strings.Join(system, "\n\n")
	}
	tools := []any{}
	for _, t := range ir.callableTools() {
		tools = append(tools, map[string]any{"name": t.wire, "description": t.description, "input_schema": t.schema})
	}
	if len(tools) > 0 {
		body["tools"] = tools
		choice := ir.choice
		if choice == "required" {
			choice = "any"
		}
		body["tool_choice"] = map[string]string{"type": choice}
		if ir.selected != "" {
			body["tool_choice"] = map[string]string{"type": "tool", "name": ir.selected}
		}
		if ir.loading != nil && choice != "none" {
			selection := map[string]any{"type": choice, "disable_parallel_tool_use": true}
			if ir.selected != "" {
				selection["type"] = "tool"
				selection["name"] = ir.selected
			}
			body["tool_choice"] = selection
		}
	}
	return serializePlan(ir, body)
}
