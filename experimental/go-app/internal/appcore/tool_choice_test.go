package appcore

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

func selectedPayload(t *testing.T, payload string, selector any, stream bool) string {
	t.Helper()
	p, _ := decodeObject(payload)
	p["tool_choice"], p["stream"] = selector, stream
	b, _ := json.Marshal(p)
	return string(b)
}
func TestNamedToolChoiceRequestMappings(t *testing.T) {
	for _, tc := range []struct {
		name, payload string
		build         func([]byte) (*chatPlan, error)
	}{{"Chat", routedPayload, buildChatPlan}, {"Claude", claudePayload, buildClaudePlan}, {"Gemini", geminiPayload, buildGeminiPlan}} {
		for _, spec := range []struct{ kind, name string }{{"function", "read"}, {"custom", "write"}} {
			for _, ns := range []bool{true, false} {
				selector := map[string]any{"type": spec.kind, "name": spec.name}
				if ns {
					selector["namespace"] = "pad"
				}
				plan, err := tc.build([]byte(selectedPayload(t, tc.payload, selector, true)))
				if err != nil {
					t.Fatal(tc.name, err)
				}
				wire := "pad__" + spec.name
				if plan.selected != wire || plan.choice != "specific" {
					t.Fatal("IR identity")
				}
				p, _ := decodeObject(string(plan.body))
				switch tc.name {
				case "Chat":
					if str(obj(p["tool_choice"])["type"]) != "function" || str(obj(obj(p["tool_choice"])["function"])["name"]) != wire {
						t.Fatal("Chat selector")
					}
				case "Claude":
					if str(obj(p["tool_choice"])["type"]) != "tool" || str(obj(p["tool_choice"])["name"]) != wire {
						t.Fatal("Claude selector")
					}
				case "Gemini":
					config := obj(obj(p["toolConfig"])["functionCallingConfig"])
					if str(config["mode"]) != "ANY" || fmt.Sprint(config["allowedFunctionNames"]) != "["+wire+"]" {
						t.Fatal("Gemini selector")
					}
				}
			}
		}
	}
}
func TestNamedToolChoiceRejectsBeforeSend(t *testing.T) {
	selectors := []any{nil, 42, []any{}, map[string]any{"type": "function", "name": "missing"}, map[string]any{"type": "custom", "name": "read", "namespace": "pad"}, map[string]any{"type": "function", "name": "read", "namespace": 42}, map[string]any{"type": "function", "name": "read", "namespace": "wrong"}, map[string]any{"type": "function", "name": "read", "namespace": "pad", "parameters": map[string]any{}}, map[string]any{"type": "allowed_tools", "tools": []any{}}}
	for _, payload := range []string{routedPayload, claudePayload, geminiPayload} {
		c, endpoint := routedClaudeCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { t.Error("invalid selector sent upstream") }))
		for _, selector := range selectors {
			code, _, _ := request(t, c, endpoint, "/v1/responses", "POST", selectedPayload(t, payload, selector, false), nil)
			if code != 400 {
				t.Fatal("selector accepted")
			}
		}
	}
	p, _ := decodeObject(routedPayload)
	p["tools"] = []any{map[string]any{"type": "function", "name": "read"}, map[string]any{"type": "namespace", "name": "pad", "tools": []any{map[string]any{"type": "function", "name": "read"}}}}
	p["tool_choice"] = map[string]any{"type": "function", "name": "read"}
	b, _ := json.Marshal(p)
	if _, err := buildChatPlan(b); err == nil {
		t.Fatal("ambiguous bare selector guessed")
	}
	p["tool_choice"] = map[string]any{"type": "function", "name": "read", "namespace": "functions"}
	b, _ = json.Marshal(p)
	plan, err := buildChatPlan(b)
	if err != nil || plan.selected != "read" {
		t.Fatal("explicit top-level selector")
	}
	p["tools"] = []any{}
	b, _ = json.Marshal(p)
	if _, err := buildChatPlan(b); err == nil {
		t.Fatal("selector without tools")
	}
	p, _ = decodeObject(routedPayload)
	p["tool_choice"] = map[string]any{"type": "function", "name": "pad__read", "namespace": "functions"}
	b, _ = json.Marshal(p)
	if _, err := buildChatPlan(b); err == nil {
		t.Fatal("wire alias impersonated top-level identity")
	}
}
func TestToolChoiceOutputContract(t *testing.T) {
	chatRead := chatSSE(choice(map[string]any{"tool_calls": []any{map[string]any{"index": 0, "id": "a", "type": "function", "function": map[string]string{"name": "pad__read", "arguments": "{}"}}}}, "tool_calls"))
	chatWrite := strings.Replace(chatRead, "pad__read", "pad__write", 1)
	chatWrite = strings.Replace(chatWrite, `"arguments":"{}"`, `"arguments":"{\"input\":\"hi\"}"`, 1)
	for _, tc := range []struct{ name, payload, text, read, write string }{
		{"Chat", routedPayload, chatSSE(choice(map[string]any{"content": "hello"}, "stop")), chatRead, chatWrite},
		{"Claude", claudePayload, claudeStart() + claudeText(0, "hello") + claudeEnd("end_turn"), claudeStart() + claudeTool(0, "a", "pad__read", "{}") + claudeEnd("tool_use"), claudeStart() + claudeTool(0, "a", "pad__write", `{"input":"hi"}`) + claudeEnd("tool_use")},
		{"Gemini", geminiPayload, geminiFrame([]any{geminiText("hello")}, "STOP", geminiUsageFixture()), geminiFrame([]any{geminiCall("a", "pad__read", map[string]any{})}, "STOP", geminiUsageFixture()), geminiFrame([]any{geminiCall("a", "pad__write", map[string]any{"input": "hi"})}, "STOP", geminiUsageFixture())},
	} {
		for _, spec := range []struct {
			name, upstream string
			selector       any
			success        bool
		}{
			{"none text", tc.text, "none", true}, {"none call", tc.read, "none", false}, {"required call", tc.read, "required", true}, {"required text", tc.text, "required", false},
			{"specific function", tc.read, map[string]any{"type": "function", "name": "read", "namespace": "pad"}, true},
			{"specific custom", tc.write, map[string]any{"type": "custom", "name": "write", "namespace": "pad"}, true},
			{"wrong function", tc.write, map[string]any{"type": "function", "name": "read", "namespace": "pad"}, false},
			{"specific text", tc.text, map[string]any{"type": "function", "name": "read", "namespace": "pad"}, false},
		} {
			for _, stream := range []bool{true, false} {
				t.Run(fmt.Sprint(tc.name, "/", spec.name, "/", stream), func(t *testing.T) {
					c, endpoint := routedClaudeCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
						w.Header().Set("Content-Type", "text/event-stream")
						fmt.Fprint(w, spec.upstream)
					}))
					payload := selectedPayload(t, tc.payload, spec.selector, stream)
					req, _ := http.NewRequest("POST", endpoint+"/v1/responses", strings.NewReader(payload))
					req.Header.Set("Authorization", "Bearer "+c.token)
					req.Header.Set("Content-Type", "application/json")
					resp, err := http.DefaultClient.Do(req)
					if err != nil {
						if spec.success || !stream {
							t.Fatal(err)
						}
						return
					}
					b, readErr := io.ReadAll(resp.Body)
					resp.Body.Close()
					if spec.success {
						if resp.StatusCode != 200 || readErr != nil {
							t.Fatal("expected success")
						}
						if stream {
							responseCompletion(t, b)
						} else {
							p, _ := decodeObject(string(b))
							if p["status"] != "completed" {
								t.Fatal("JSON completion")
							}
						}
					} else {
						if strings.Contains(string(b), "response.completed") {
							t.Fatal("choice ignored")
						}
						if stream {
							if readErr == nil {
								t.Fatal("SSE not aborted")
							}
						} else {
							if resp.StatusCode != 502 {
								t.Fatal("JSON not rejected")
							}
						}
					}
				})
			}
		}
	}
}

func TestBareOutputToolCannotChooseBetweenTopLevelAndNamespace(t *testing.T) {
	p, _ := decodeObject(routedPayload)
	p["tools"] = []any{map[string]any{"type": "function", "name": "read"}, map[string]any{"type": "namespace", "name": "pad", "tools": []any{map[string]any{"type": "function", "name": "read"}}}}
	raw, _ := json.Marshal(p)
	plan, err := buildChatPlan(raw)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := plan.restoreTool("read"); ok {
		t.Fatal("ambiguous bare output selected top-level tool")
	}
	if tool, ok := plan.restoreTool("pad__read"); !ok || tool.namespace != "pad" {
		t.Fatal("explicit namespace alias lost")
	}
}

func TestAmbiguousBareOutputAbortsWithoutHistory(t *testing.T) {
	for _, tc := range []struct{ model, upstream string }{
		{"gpt-5.5", chatSSE(choice(map[string]any{"tool_calls": []any{map[string]any{"index": 0, "id": "a", "type": "function", "function": map[string]string{"name": "read", "arguments": "{}"}}}}, "tool_calls"))},
		{"claude-sonnet-4-6", claudeStart() + claudeTool(0, "a", "read", "{}") + claudeEnd("tool_use")},
		{"gemini-2.5-flash", geminiFrame([]any{geminiCall("a", "read", map[string]any{})}, "STOP", geminiUsageFixture())},
	} {
		for _, stream := range []bool{true, false} {
			t.Run(fmt.Sprint(tc.model, "/", stream), func(t *testing.T) {
				c, endpoint := routedClaudeCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					w.Header().Set("Content-Type", "text/event-stream")
					fmt.Fprint(w, tc.upstream)
				}))
				p, _ := decodeObject(routedPayload)
				p["model"], p["stream"] = tc.model, stream
				p["tools"] = []any{map[string]any{"type": "function", "name": "read"}, map[string]any{"type": "namespace", "name": "pad", "tools": []any{map[string]any{"type": "function", "name": "read"}}}}
				b, _ := json.Marshal(p)
				req, _ := http.NewRequest("POST", endpoint+"/v1/responses", strings.NewReader(string(b)))
				req.Header.Set("Authorization", "Bearer "+c.token)
				req.Header.Set("Content-Type", "application/json")
				client := http.Client{Timeout: 3 * time.Second}
				defer client.CloseIdleConnections()
				resp, err := client.Do(req)
				if err != nil {
					t.Fatal(err)
				}
				data, readErr := io.ReadAll(resp.Body)
				resp.Body.Close()
				if strings.Contains(string(data), "completed") || stream && readErr == nil || !stream && (readErr != nil || resp.StatusCode != 502) {
					t.Fatal("ambiguous output reported successful identity")
				}
				c.mu.Lock()
				count := len(c.history.entries)
				c.mu.Unlock()
				if count != 0 {
					t.Fatal("ambiguous output cached")
				}
			})
		}
	}
}
