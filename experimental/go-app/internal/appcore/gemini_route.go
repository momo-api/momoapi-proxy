package appcore

import "strings"

// The bounded text/tool subset is encoded directly from the shared IR.
// Signed thinking/tool continuation must not be silently stripped or forged.
func buildGeminiPlan(data []byte) (*chatPlan, error) {
	ir, err := parseRoutedRequest(data)
	if err != nil {
		return nil, err
	}
	if !geminiModelName(ir.model) || ir.effort != "" || strings.Contains(ir.model, "-thinking") {
		return nil, errRouted
	}
	contents := []any{}
	systems := []any{}
	seenSystem := map[string]bool{}
	calls := map[string]string{}
	projections := []any{}
	for _, m := range ir.messages {
		flushedProjection := false
		if m.role != "tool" && len(projections) > 0 {
			contents = append(contents, projections...)
			projections = nil
			flushedProjection = true
		}
		if m.role == "system" {
			if m.text != "" && !seenSystem[m.text] {
				systems = append(systems, map[string]string{"text": m.text})
				seenSystem[m.text] = true
			}
			continue
		}
		role := m.role
		parts := []any{}
		if role == "assistant" {
			role = "model"
		}
		if role == "tool" {
			role = "user"
			name, ok := calls[m.resultID]
			if !ok {
				return nil, errRouted
			}
			response := map[string]any{"id": m.resultID, "name": name, "response": map[string]string{"result": m.text}}
			if hasImages(m.parts) {
				if ir.toolImages == "user-projection" {
					marker := toolImageMarker(m.resultID)
					response["response"] = map[string]string{"result": marker}
					projected := []any{map[string]any{"text": marker}}
					for _, part := range m.parts {
						if part.image != nil {
							projected = append(projected, geminiImage(part.image))
						} else {
							projected = append(projected, map[string]any{"text": part.text})
						}
					}
					projections = append(projections, map[string]any{"role": "user", "parts": projected})
				} else {
					media := []any{}
					ordered := []any{}
					for _, part := range m.parts {
						if img := part.image; img != nil {
							ordered = append(ordered, map[string]any{"image_part": len(media)})
							media = append(media, map[string]any{"inlineData": map[string]any{"mimeType": img.mime, "data": img.data}})
						} else {
							ordered = append(ordered, map[string]any{"text": part.text})
						}
					}
					response["response"] = map[string]any{"result": ordered}
					response["parts"] = media
				}
			}
			parts = append(parts, map[string]any{"functionResponse": response})
		} else {
			for _, part := range m.parts {
				if part.image != nil {
					parts = append(parts, geminiImage(part.image))
					continue
				}
				if part.call == nil {
					if part.text != "" {
						parts = append(parts, map[string]string{"text": part.text})
					}
					continue
				}
				call := part.call
				args, err := decodeObject(call.args)
				if err != nil {
					return nil, err
				}
				calls[call.id] = call.wire
				parts = append(parts, map[string]any{"functionCall": map[string]any{"id": call.id, "name": call.wire, "args": args}})
			}
		}
		if len(parts) == 0 {
			return nil, errRouted
		}
		if !flushedProjection && len(contents) > 0 && obj(contents[len(contents)-1])["role"] == role {
			last := obj(contents[len(contents)-1])
			last["parts"] = append(last["parts"].([]any), parts...)
		} else {
			contents = append(contents, map[string]any{"role": role, "parts": parts})
		}
	}
	contents = append(contents, projections...)
	if len(contents) == 0 || obj(contents[0])["role"] != "user" {
		return nil, errRouted
	}
	body := map[string]any{"contents": contents}
	if ir.maxOutputTokens != 0 {
		body["generationConfig"] = map[string]any{"maxOutputTokens": ir.maxOutputTokens}
	}
	if len(systems) > 0 {
		body["systemInstruction"] = map[string]any{"parts": systems}
	}
	declarations := []any{}
	for _, tool := range ir.callableTools() {
		// parameters is Google's restricted Schema, not arbitrary JSON Schema.
		// Preserve additionalProperties and nested client/shim constraints through
		// the documented JSON Schema field; never send both fields or strip keys.
		declarations = append(declarations, map[string]any{"name": tool.wire, "description": tool.description, "parametersJsonSchema": tool.schema})
	}
	if len(declarations) > 0 {
		body["tools"] = []any{map[string]any{"functionDeclarations": declarations}}
		mode := map[string]string{"auto": "AUTO", "none": "NONE", "required": "ANY"}[ir.choice]
		body["toolConfig"] = map[string]any{"functionCallingConfig": map[string]string{"mode": mode}}
		if ir.selected != "" {
			body["toolConfig"] = map[string]any{"functionCallingConfig": map[string]any{"mode": "ANY", "allowedFunctionNames": []string{ir.selected}}}
		}
	}
	return serializePlan(ir, body)
}
func geminiModelName(s string) bool {
	if !strings.HasPrefix(s, "gemini-") || len(s) <= len("gemini-") || len(s) > 128 {
		return false
	}
	for _, r := range s {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '-' || r == '_' || r == '.') {
			return false
		}
	}
	return true
}
