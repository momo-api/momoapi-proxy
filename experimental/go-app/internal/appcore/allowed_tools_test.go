package appcore

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
)

func allowedChoice(mode string, names ...string) map[string]any {
	selectors := []any{}
	for _, name := range names {
		kind := "function"
		if name == "write" {
			kind = "custom"
		}
		selectors = append(selectors, map[string]string{"type": kind, "name": name, "namespace": "pad"})
	}
	return map[string]any{"type": "allowed_tools", "mode": mode, "tools": selectors}
}

func TestAllowedToolsRequestMappingsAndHistory(t *testing.T) {
	for _, tc := range []struct {
		name, payload string
		build         func([]byte) (*chatPlan, error)
	}{
		{"Chat", routedPayload, buildChatPlan}, {"Claude", claudePayload, buildClaudePlan}, {"Gemini", geminiPayload, buildGeminiPlan},
	} {
		for _, mode := range []string{"auto", "required"} {
			for _, names := range [][]string{{"read"}, {"write"}, {"read", "write"}} {
				t.Run(fmt.Sprint(tc.name, "/", mode, "/", names), func(t *testing.T) {
					p, _ := decodeObject(tc.payload)
					// Past calls remain legal even when not callable in this new turn.
					p["input"] = append(p["input"].([]any), map[string]string{"type": "custom_tool_call", "name": "write", "namespace": "pad", "call_id": "old", "input": "exact old"}, map[string]string{"type": "custom_tool_call_output", "call_id": "old", "output": "exact result"}, map[string]string{"role": "user", "content": "current"})
					p["tool_choice"] = allowedChoice(mode, names...)
					b, _ := json.Marshal(p)
					plan, err := tc.build(b)
					if err != nil || plan.choice != mode || len(plan.allowed) != len(names) || len(plan.tools) != 2 {
						t.Fatal("allowed IR/history")
					}
					wire, _ := decodeObject(string(plan.body))
					tools := wire["tools"].([]any)
					var actual []string
					switch tc.name {
					case "Chat":
						for _, v := range tools {
							actual = append(actual, str(obj(obj(v)["function"])["name"]))
						}
						if wire["tool_choice"] != mode {
							t.Fatal("Chat choice")
						}
					case "Claude":
						for _, v := range tools {
							actual = append(actual, str(obj(v)["name"]))
						}
						want := mode
						if want == "required" {
							want = "any"
						}
						if obj(wire["tool_choice"])["type"] != want {
							t.Fatal("Claude choice")
						}
					case "Gemini":
						for _, v := range obj(tools[0])["functionDeclarations"].([]any) {
							actual = append(actual, str(obj(v)["name"]))
						}
						want := map[string]string{"auto": "AUTO", "required": "ANY"}[mode]
						if obj(obj(wire["toolConfig"])["functionCallingConfig"])["mode"] != want {
							t.Fatal("Gemini choice")
						}
					}
					if len(actual) != len(names) {
						t.Fatal("callable subset")
					}
					for i, n := range names {
						if actual[i] != "pad__"+n {
							t.Fatal("subset order/identity")
						}
					}
					if !strings.Contains(string(plan.body), "pad__write") || !strings.Contains(string(plan.body), "exact old") || !strings.Contains(string(plan.body), "exact result") {
						t.Fatal("disallowed historical evidence erased")
					}
				})
			}
		}
	}
}

func TestAllowedToolsRejectBeforeSend(t *testing.T) {
	bad := []any{allowedChoice("none", "read"), allowedChoice("specific", "read"), allowedChoice("auto"), allowedChoice("auto", "read", "read"), allowedChoice("auto", "missing"), map[string]any{"type": "allowed_tools", "mode": "auto", "tools": nil}, map[string]any{"type": "allowed_tools", "mode": "auto", "tools": "read"}, map[string]any{"type": "allowed_tools", "mode": "auto", "extra": true, "tools": []any{map[string]string{"type": "function", "name": "read"}}}}
	for _, selector := range []any{nil, 17, map[string]string{"type": "custom", "name": "read"}, map[string]string{"type": "mcp", "name": "read"}, map[string]string{"type": "namespace", "name": "pad"}, map[string]string{"type": "function", "name": "read", "namespace": "wrong"}, map[string]any{"type": "function", "name": "read", "namespace": nil}, map[string]any{"type": "function", "name": "read", "parameters": map[string]any{}}} {
		bad = append(bad, map[string]any{"type": "allowed_tools", "mode": "auto", "tools": []any{selector}})
	}
	for _, payload := range []string{routedPayload, claudePayload, geminiPayload} {
		var sends atomic.Int32
		c, endpoint := routedClaudeCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { sends.Add(1) }))
		for _, selector := range bad {
			code, _, _ := request(t, c, endpoint, "/v1/responses", "POST", selectedPayload(t, payload, selector, false), nil)
			if code != 400 {
				t.Fatal("invalid allowed selector accepted")
			}
		}
		if sends.Load() != 0 {
			t.Fatal("invalid allowed tools sent upstream")
		}
	}
	p, _ := decodeObject(routedPayload)
	p["tools"] = []any{map[string]string{"type": "function", "name": "read"}, map[string]any{"type": "namespace", "name": "pad", "tools": []any{map[string]string{"type": "function", "name": "read"}}}}
	p["tool_choice"] = map[string]any{"type": "allowed_tools", "mode": "auto", "tools": []any{map[string]string{"type": "function", "name": "read"}}}
	b, _ := json.Marshal(p)
	if _, err := buildChatPlan(b); err == nil {
		t.Fatal("ambiguous bare allowed selector")
	}
	p["tool_choice"] = map[string]any{"type": "allowed_tools", "mode": "auto", "tools": []any{map[string]string{"type": "function", "name": "read", "namespace": "functions"}}}
	b, _ = json.Marshal(p)
	plan, err := buildChatPlan(b)
	if err != nil || !plan.allowed["read"] {
		t.Fatal("explicit top-level allowed identity")
	}
	if _, ok := plan.restoreTool("read"); ok {
		t.Fatal("allowed subset guessed ambiguous upstream identity")
	}
	p["tool_choice"] = map[string]any{"type": "allowed_tools", "mode": "auto", "tools": []any{map[string]string{"type": "function", "name": "pad__read", "namespace": "functions"}}}
	b, _ = json.Marshal(p)
	if _, err := buildChatPlan(b); err == nil {
		t.Fatal("wire alias impersonated selector")
	}
}

func TestAllowedToolsOutputContract(t *testing.T) {
	chatCall := func(name, args string) string {
		return chatSSE(choice(map[string]any{"tool_calls": []any{map[string]any{"index": 0, "id": "one", "type": "function", "function": map[string]string{"name": name, "arguments": args}}}}, "tool_calls"))
	}
	for _, tc := range []struct{ name, payload, text, read, write, limited string }{
		{"Chat", routedPayload, chatSSE(choice(map[string]any{"content": "hello"}, "stop")), chatCall("pad__read", "{}"), chatCall("pad__write", `{"input":"hi"}`), chatSSE(choice(map[string]any{"content": "partial"}, "length"))},
		{"Claude", claudePayload, claudeStart() + claudeText(0, "hello") + claudeEnd("end_turn"), claudeStart() + claudeTool(0, "one", "pad__read", "{}") + claudeEnd("tool_use"), claudeStart() + claudeTool(0, "one", "pad__write", `{"input":"hi"}`) + claudeEnd("tool_use"), claudeStart() + claudeText(0, "partial") + claudeEnd("max_tokens")},
		{"Gemini", geminiPayload, geminiFrame([]any{geminiText("hello")}, "STOP", geminiUsageFixture()), geminiFrame([]any{geminiCall("one", "pad__read", map[string]any{})}, "STOP", geminiUsageFixture()), geminiFrame([]any{geminiCall("one", "pad__write", map[string]any{"input": "hi"})}, "STOP", geminiUsageFixture()), geminiFrame([]any{geminiText("partial")}, "MAX_TOKENS", geminiUsageFixture())},
	} {
		for _, stream := range []bool{true, false} {
			for _, spec := range []struct {
				label, upstream, mode string
				names                 []string
				ok, incomplete        bool
			}{
				{"auto text", tc.text, "auto", []string{"read"}, true, false},
				{"required text", tc.text, "required", []string{"read"}, false, false},
				{"allowed function", tc.read, "required", []string{"read"}, true, false},
				{"allowed custom", tc.write, "required", []string{"write"}, true, false},
				{"subset allows either", tc.write, "auto", []string{"read", "write"}, true, false},
				{"disallowed function", tc.read, "auto", []string{"write"}, false, false},
				{"disallowed custom", tc.write, "required", []string{"read"}, false, false},
				{"required incomplete text", tc.limited, "required", []string{"read"}, true, true},
			} {
				t.Run(fmt.Sprint(tc.name, "/", stream, "/", spec.label), func(t *testing.T) {
					c, endpoint := routedClaudeCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
						w.Header().Set("Content-Type", "text/event-stream")
						fmt.Fprint(w, spec.upstream)
					}))
					payload := selectedPayload(t, tc.payload, allowedChoice(spec.mode, spec.names...), stream)
					req, _ := http.NewRequest("POST", endpoint+"/v1/responses", strings.NewReader(payload))
					req.Header.Set("Authorization", "Bearer "+c.token)
					req.Header.Set("Content-Type", "application/json")
					resp, err := http.DefaultClient.Do(req)
					if err != nil {
						t.Fatal(err)
					}
					data, readErr := io.ReadAll(resp.Body)
					resp.Body.Close()
					if spec.ok {
						if readErr != nil || resp.StatusCode != 200 {
							t.Fatal("allowed output failed")
						}
						if stream {
							if !strings.Contains(string(data), map[bool]string{false: "response.completed", true: "response.incomplete"}[spec.incomplete]) {
								t.Fatal("missing terminal")
							}
						} else {
							out, _ := decodeObject(string(data))
							if out["status"] != map[bool]string{false: "completed", true: "incomplete"}[spec.incomplete] {
								t.Fatal("JSON terminal")
							}
						}
					} else {
						if strings.Contains(string(data), "response.completed") || stream && readErr == nil || !stream && (resp.StatusCode != 502 || readErr != nil) {
							t.Fatal("allowed output contract ignored")
						}
					}
					c.mu.Lock()
					anchors := len(c.history.entries)
					c.mu.Unlock()
					if (!spec.ok || spec.incomplete) && anchors != 0 {
						t.Fatal("failed/incomplete allowed output cached")
					}
				})
			}
		}
	}
}

func TestAllowedToolsMixedOutputAndExplicitReplay(t *testing.T) {
	for _, tc := range []struct{ model, wire string }{
		{"gpt-5.5", goodChatSSE()},
		{"claude-sonnet-4-6", goodClaudeSSE()},
		{"gemini-2.5-flash", goodGeminiSSE()},
	} {
		for _, stream := range []bool{true, false} {
			for _, allowBoth := range []bool{false, true} {
				t.Run(fmt.Sprint(tc.model, "/", stream, "/", allowBoth), func(t *testing.T) {
					var sends atomic.Int32
					c, endpoint := routedClaudeCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
						sends.Add(1)
						w.Header().Set("Content-Type", "text/event-stream")
						fmt.Fprint(w, tc.wire)
					}))
					p, _ := decodeObject(historyPayload(tc.model, []any{map[string]string{"role": "user", "content": "first"}}, "", stream))
					if allowBoth {
						p["tool_choice"] = allowedChoice("required", "read", "write")
					} else {
						p["tool_choice"] = allowedChoice("auto", "read")
					}
					b, _ := json.Marshal(p)
					req, _ := http.NewRequest("POST", endpoint+"/v1/responses", strings.NewReader(string(b)))
					req.Header.Set("Content-Type", "application/json")
					req.Header.Set("Authorization", "Bearer "+c.token)
					resp, err := http.DefaultClient.Do(req)
					if err != nil {
						t.Fatal(err)
					}
					data, readErr := io.ReadAll(resp.Body)
					resp.Body.Close()
					if !allowBoth {
						if strings.Contains(string(data), "response.completed") || stream && readErr == nil || !stream && (resp.StatusCode != 502 || readErr != nil) {
							t.Fatal("mixed excluded call completed")
						}
						c.mu.Lock()
						anchors := len(c.history.entries)
						c.mu.Unlock()
						if anchors != 0 {
							t.Fatal("mixed disallowed history")
						}
						return
					}
					if readErr != nil || resp.StatusCode != 200 {
						t.Fatal("allowed mixed output")
					}
					var final map[string]any
					if stream {
						final = responseCompletion(t, data)
					} else {
						final, _ = decodeObject(string(data))
					}
					out := final["output"].([]any)
					suffix := []any{}
					for _, v := range out {
						item := obj(v)
						switch item["type"] {
						case "function_call":
							suffix = append(suffix, map[string]any{"type": "function_call_output", "call_id": item["call_id"], "output": "exact read result"})
						case "custom_tool_call":
							suffix = append(suffix, map[string]any{"type": "custom_tool_call_output", "call_id": item["call_id"], "output": "exact write result"})
						}
					}
					suffix = append(suffix, map[string]string{"role": "user", "content": "next"})
					// Re-declare a different set; the prior selection is not inherited.
					p["previous_response_id"], p["input"], p["tool_choice"] = final["id"], suffix, allowedChoice("required", "read")
					next, _ := json.Marshal(p)
					prepared, _, err := c.prepareRoutedHistory(next, tc.model)
					if err != nil {
						t.Fatal("allowed history replay")
					}
					ir, err := parseRoutedRequest(prepared)
					if err != nil || len(ir.allowed) != 1 || !ir.allowed["pad__read"] || !strings.Contains(string(prepared), "exact write result") || !strings.Contains(string(prepared), "pad") {
						t.Fatal("selection inherited or history dropped")
					}
					if sends.Load() != 1 {
						t.Fatal("duplicate send")
					}
				})
			}
		}
	}
}
