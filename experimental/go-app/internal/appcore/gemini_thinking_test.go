package appcore

import (
	"encoding/json"
	"io"
	"net/http"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
)

func TestGeminiThinkingControlsExactWire(t *testing.T) {
	for _, tc := range []struct {
		name    string
		control any
		effort  string
		want    map[string]any
	}{
		{"nativeLevel", map[string]any{"thinkingLevel": "MINIMAL", "includeThoughts": true}, "", map[string]any{"thinkingLevel": "MINIMAL", "includeThoughts": true}},
		{"includeFalse", map[string]any{"includeThoughts": false}, "", map[string]any{"includeThoughts": false}},
		{"budgetZero", map[string]any{"thinkingBudget": 0}, "", map[string]any{"thinkingBudget": 0}},
		{"budgetAutomatic", map[string]any{"thinkingBudget": -1, "includeThoughts": true}, "", map[string]any{"thinkingBudget": -1, "includeThoughts": true}},
		{"budgetExact", map[string]any{"thinkingBudget": 1024}, "", map[string]any{"thinkingBudget": 1024}},
		{"budgetInt32", map[string]any{"thinkingBudget": 2147483647}, "", map[string]any{"thinkingBudget": 2147483647}},
		{"effortMinimal", nil, "minimal", map[string]any{"thinkingLevel": "MINIMAL"}},
		{"effortLow", nil, "low", map[string]any{"thinkingLevel": "LOW"}},
		{"effortMedium", nil, "medium", map[string]any{"thinkingLevel": "MEDIUM"}},
		{"effortHigh", nil, "high", map[string]any{"thinkingLevel": "HIGH"}},
		{"consistent", map[string]any{"thinkingLevel": "HIGH", "includeThoughts": false}, "high", map[string]any{"thinkingLevel": "HIGH", "includeThoughts": false}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			p, _ := decodeObject(geminiPayload)
			p["max_output_tokens"] = 2048
			if tc.control != nil {
				p["momo_gemini_thinking"] = tc.control
			}
			if tc.effort != "" {
				p["reasoning"] = map[string]any{"effort": tc.effort}
			}
			plan, err := buildGeminiPlan(mustJSON(p))
			if err != nil {
				t.Fatal(err)
			}
			body, _ := decodeVideoObject(plan.body)
			cfg := obj(body["generationConfig"])
			if string(mustJSON(cfg["thinkingConfig"])) != string(mustJSON(tc.want)) || cfg["maxOutputTokens"] != json.Number("2048") {
				t.Fatal("thinking/max tokens changed", string(plan.body))
			}
		})
	}
}

func TestGeminiThinkingInvalidControlsBeforeSend(t *testing.T) {
	c, endpoint := routedClaudeCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { t.Error("invalid controls sent") }))
	for _, changes := range []map[string]any{
		{"momo_gemini_thinking": nil}, {"momo_gemini_thinking": map[string]any{}},
		{"momo_gemini_thinking": map[string]any{"thinkingBudget": -2}},
		{"momo_gemini_thinking": map[string]any{"thinkingBudget": 2147483648}},
		{"momo_gemini_thinking": map[string]any{"thinkingBudget": 1.5}},
		{"momo_gemini_thinking": map[string]any{"thinkingBudget": "1024"}},
		{"momo_gemini_thinking": map[string]any{"thinkingBudget": nil}},
		{"momo_gemini_thinking": map[string]any{"thinkingLevel": "low"}},
		{"momo_gemini_thinking": map[string]any{"thinkingLevel": "THINKING_LEVEL_UNSPECIFIED"}},
		{"momo_gemini_thinking": map[string]any{"thinkingLevel": "HIGH", "thinkingBudget": 1024}},
		{"momo_gemini_thinking": map[string]any{"thinking_level": "HIGH"}},
		{"momo_gemini_thinking": map[string]any{"includeThoughts": nil}},
		{"momo_gemini_thinking": map[string]any{"includeThoughts": "true"}},
		{"momo_gemini_thinking": map[string]any{"includeThoughts": true, "unknown": 1}},
		{"momo_gemini_thinking": map[string]any{"thinkingLevel": "LOW"}, "reasoning_effort": "high"},
		{"momo_gemini_thinking": map[string]any{"thinkingBudget": 1024}, "reasoning_effort": "low"},
		{"reasoning_effort": "low", "model_reasoning_effort": "high"},
		{"reasoning_effort": "low", "reasoning": map[string]any{"effort": "high"}},
		{"reasoning_effort": "", "model_reasoning_effort": "high"},
		{"model_reasoning_effort": "", "reasoning": map[string]any{"effort": "high"}},
		{"reasoning_effort": "xhigh"}, {"reasoning_effort": "max"}, {"reasoning_effort": "ultra"}, {"reasoning_effort": "none"}, {"reasoning_effort": "unknown"},
		{"model": "gpt-5.5", "momo_gemini_thinking": map[string]any{"thinkingLevel": "HIGH"}},
		{"model": "claude-sonnet-4-6", "momo_gemini_thinking": map[string]any{"thinkingLevel": "HIGH"}},
		{"momo_claude_thinking": map[string]any{"type": "adaptive"}, "momo_gemini_thinking": map[string]any{"thinkingLevel": "HIGH"}},
	} {
		p, _ := decodeObject(geminiPayload)
		for k, v := range changes {
			p[k] = v
		}
		code, _, _ := request(t, c, endpoint, "/v1/responses", "POST", string(mustJSON(p)), nil)
		if code != 400 {
			t.Fatal("invalid controls accepted", code, string(mustJSON(changes)))
		}
	}
	for _, raw := range []string{
		`"momo_gemini_thinking":{"thinkingLevel":"LOW","thinkingLevel":"HIGH"}`,
		`"momo_gemini_thinking":{"thinkingLevel":"LOW","thinking\u004cevel":"HIGH"}`,
		`"momo_gemini_thinking":{"thinkingBudget":1e3}`,
	} {
		payload := strings.Replace(geminiPayload, `"stream":true`, `"stream":true,`+raw, 1)
		code, _, _ := request(t, c, endpoint, "/v1/responses", "POST", payload, nil)
		if code != 400 {
			t.Fatal("ambiguous JSON accepted")
		}
	}
}

func TestGeminiThinkingDefaultAndNativePassthroughUnchanged(t *testing.T) {
	for _, model := range []string{"gemini-3.1-pro-preview", "gpt-5.6-sol"} {
		payload := `{ "model":"` + model + `", "input":[], "momo_gemini_thinking":{"thinkingLevel":"unknown", "thinkingBudget":null}, "reasoning_effort":"ultra", "unknown":true }`
		var sends atomic.Int32
		c, endpoint, _, _ := testCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			sends.Add(1)
			b, _ := io.ReadAll(r.Body)
			if string(b) != payload || r.URL.Path != "/v1/responses" {
				t.Error("native passthrough bytes changed")
			}
			w.Header().Set("Content-Type", "application/json")
			io.WriteString(w, "{\"unchanged\":true}")
		}))
		if model == "gpt-5.6-sol" {
			c.mu.Lock()
			c.config.Mode = "momo-routing"
			c.mu.Unlock()
		}
		code, b, _ := request(t, c, endpoint, "/v1/responses", "POST", payload, nil)
		if code != 200 || string(b) != "{\"unchanged\":true}" || sends.Load() != 1 {
			t.Fatal("passthrough gate changed")
		}
	}
}

func TestGeminiThinkingProviderRejectionNeverRetries(t *testing.T) {
	for _, status := range []int{400, 429, 500} {
		var sends atomic.Int32
		c, endpoint := routedClaudeCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			sends.Add(1)
			b, _ := io.ReadAll(r.Body)
			p, _ := decodeVideoObject(b)
			if !reflect.DeepEqual(obj(p["generationConfig"])["thinkingConfig"], map[string]any{"thinkingBudget": json.Number("2147483647")}) {
				t.Error("model-dependent budget was guessed/clamped")
			}
			w.WriteHeader(status)
			io.WriteString(w, "synthetic-provider-error-not-for-client")
		}))
		p, _ := decodeObject(geminiPayload)
		p["momo_gemini_thinking"] = map[string]any{"thinkingBudget": 2147483647}
		code, b, _ := request(t, c, endpoint, "/v1/responses", "POST", string(mustJSON(p)), nil)
		if code == 200 || strings.Contains(string(b), "synthetic-provider-error") || sends.Load() != 1 {
			t.Fatal("provider rejection concealed/retried/reflected")
		}
	}
}

func TestGeminiThinkingSignedContinuationControlsNotInherited(t *testing.T) {
	model := "gemini-3.1-pro-preview"
	sig := "c3ludGhldGljLXN0YXRl"
	parts := []any{map[string]any{"text": "public", "thought": true}, map[string]any{"functionCall": map[string]any{"id": "thinking_call", "name": "pad__read", "args": map[string]any{}}, "thoughtSignature": sig}}
	for _, stream := range []bool{false, true} {
		t.Run(map[bool]string{true: "SSE", false: "JSON"}[stream], func(t *testing.T) {
			var captures []map[string]any
			var mu sync.Mutex
			c, endpoint := routedClaudeCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				b, _ := io.ReadAll(r.Body)
				p, _ := decodeVideoObject(b)
				mu.Lock()
				captures = append(captures, p)
				firstTurn := len(captures) == 1
				mu.Unlock()
				w.Header().Set("Content-Type", "text/event-stream")
				if firstTurn {
					io.WriteString(w, geminiFrame(parts, "STOP", geminiUsageFixture()))
				} else {
					io.WriteString(w, geminiFrame([]any{geminiText("done")}, "STOP", geminiUsageFixture()))
				}
			}))
			p, _ := decodeObject(historyPayload(model, []any{map[string]any{"role": "user", "content": "first"}}, "", stream))
			p["momo_gemini_thinking"] = map[string]any{"includeThoughts": true}
			p["reasoning_effort"] = "high"
			first := historyFinal(t, c, endpoint, string(mustJSON(p)), stream)
			q, _ := decodeObject(historyPayload(model, []any{map[string]any{"type": "function_call_output", "call_id": "thinking_call", "output": "result"}}, str(first["id"]), stream))
			historyFinal(t, c, endpoint, string(mustJSON(q)), stream)
			mu.Lock()
			defer mu.Unlock()
			if len(captures) != 2 || captures[1]["generationConfig"] != nil {
				t.Fatal("per-turn control inherited")
			}
			if !reflect.DeepEqual(obj(captures[1]["contents"].([]any)[1])["parts"], parts) {
				t.Fatal("signed replay changed")
			}
		})
	}
}
