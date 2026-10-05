package appcore

import (
	"encoding/json"
	"io"
	"net/http"
	"testing"
)

func sameSchemaJSON(a, b any) bool {
	x, _ := json.Marshal(a)
	y, _ := json.Marshal(b)
	return string(x) == string(y)
}

// Google v1beta discovery documents parameters as restricted Schema (no
// additionalProperties), and parametersJsonSchema as mutually exclusive,
// arbitrary JSON Schema. Preserve the client/shim schema instead of weakening it.
func TestGeminiJSONSchemaDeclarationField(t *testing.T) {
	for _, model := range []string{"gemini-2.5-flash", "gemini-3.1-flash"} {
		for _, stream := range []bool{true, false} {
			p := toolImagePayload(model, "", []any{map[string]any{"type": "input_text", "text": "result"}}, true)
			p["stream"] = stream
			defs := obj(p["tools"].([]any)[0])["tools"].([]any)
			schema := map[string]any{"type": "object", "properties": map[string]any{"value": map[string]any{"type": "object", "properties": map[string]any{"label": map[string]any{"type": "string"}}, "additionalProperties": false}}, "required": []any{"value"}, "additionalProperties": false}
			obj(defs[0])["parameters"] = schema
			b, _ := json.Marshal(p)
			ir, err := parseRoutedRequest(b)
			if err != nil {
				t.Fatal(err)
			}
			c, endpoint := routedClaudeCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				body, _ := io.ReadAll(r.Body)
				wire, _ := decodeObject(string(body))
				declarations := obj(wire["tools"].([]any)[0])["functionDeclarations"].([]any)
				if len(declarations) != len(ir.tools) {
					t.Error("declaration count changed")
					w.WriteHeader(400)
					return
				}
				for i, value := range declarations {
					decl := obj(value)
					if decl["parameters"] != nil || !sameSchemaJSON(decl["parametersJsonSchema"], ir.tools[i].schema) {
						t.Error("schema sent in restricted field, stripped or changed", model, i)
						w.WriteHeader(400)
						return
					}
				}
				w.Header().Set("Content-Type", "text/event-stream")
				io.WriteString(w, geminiFrame([]any{geminiText("answer")}, "STOP", geminiUsageFixture()))
			}))
			historyFinal(t, c, endpoint, string(b), stream)
		}
	}
	// Loaded search schemas also use additionalProperties and remain exact.
	p := searchPayload("gemini-2.5-flash", false)
	p["input"] = []any{map[string]any{"role": "user", "content": "discover"}, searchCallInput("s"), searchResult("s", searchDefs(p))}
	b, _ := json.Marshal(p)
	ir, err := parseRoutedRequest(b)
	if err != nil {
		t.Fatal(err)
	}
	plan := buildSearchPlan(t, p)
	wire, _ := decodeObject(string(plan.body))
	declarations := obj(wire["tools"].([]any)[0])["functionDeclarations"].([]any)
	for i, value := range declarations {
		if obj(value)["parameters"] != nil || !sameSchemaJSON(obj(value)["parametersJsonSchema"], ir.callableTools()[i].schema) {
			t.Fatal("search schema not preserved in JSON Schema field")
		}
	}
}
