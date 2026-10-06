package appcore

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestParallelToolsRequestMappings(t *testing.T) {
	for _, model := range []string{"gpt-5.5", "claude-sonnet-4-6", "gemini-2.5-flash"} {
		for _, parallel := range []bool{false, true} {
			p := aliasPayload(model, "pad", "read", "function", false)
			p["parallel_tool_calls"] = parallel
			for _, choice := range []any{"auto", "none", "required", map[string]string{"type": "function", "name": "read", "namespace": "pad"}, map[string]any{"type": "allowed_tools", "mode": "required", "tools": []any{map[string]string{"type": "function", "name": "read", "namespace": "pad"}}}} {
				p["tool_choice"] = choice
				plan, err := aliasBuild(p)
				if err != nil {
					t.Fatal(model, parallel, choice, err)
				}
				b, _ := decodeObject(string(plan.body))
				switch resolveProtocol(model) {
				case "chat":
					if b["parallel_tool_calls"] != parallel {
						t.Fatal("Chat boolean lost")
					}
				case "claude":
					if choice == "none" {
						if len(obj(b["tool_choice"])) != 1 {
							t.Fatal("Claude none received unsupported field")
						}
					} else if obj(b["tool_choice"])["disable_parallel_tool_use"] != !parallel {
						t.Fatal("Claude inverse boolean lost")
					}
				case "gemini":
					if strings.Contains(string(plan.body), "parallel") {
						t.Fatal("undocumented Gemini field invented")
					}
				}
			}
			delete(p, "parallel_tool_calls")
			plan, err := aliasBuild(p)
			if err != nil {
				t.Fatal(err)
			}
			if strings.Contains(string(plan.body), "parallel") {
				t.Fatal("absent default altered")
			}
		}
	}
}
func parallelStream(model string, count int, kind string, incomplete bool) string {
	args := "{}"
	if kind == "custom" {
		args = `{"input":"raw 中文🙂"}`
	}
	switch resolveProtocol(model) {
	case "chat":
		calls := []any{}
		for i := 0; i < count; i++ {
			calls = append(calls, map[string]any{"index": i, "id": fmt.Sprint("single_", i), "type": "function", "function": map[string]string{"name": "pad__read", "arguments": args}})
		}
		reason := "tool_calls"
		if incomplete {
			reason = "length"
		}
		if count == 0 {
			return chatSSE(choice(map[string]any{"content": "single-done"}, map[bool]string{true: "length", false: "stop"}[incomplete]))
		}
		return chatSSE(choice(map[string]any{"tool_calls": calls}, reason))
	case "claude":
		s := claudeStart()
		for i := 0; i < count; i++ {
			s += claudeTool(i, fmt.Sprint("single_", i), "pad__read", args)
		}
		reason := "tool_use"
		if count == 0 {
			s += claudeText(0, "single-done")
			reason = "end_turn"
		}
		if incomplete {
			reason = "max_tokens"
		}
		return s + claudeEnd(reason)
	default:
		a, _ := decodeObject(args)
		parts := []any{}
		for i := 0; i < count; i++ {
			parts = append(parts, geminiCall(fmt.Sprint("single_", i), "pad__read", a))
		}
		if count == 0 {
			parts = append(parts, geminiText("single-done"))
		}
		reason := "STOP"
		if incomplete {
			reason = "MAX_TOKENS"
		}
		return geminiFrame(parts, reason, geminiUsageFixture())
	}
}
func TestParallelToolsOutputAndClientPolicyContract(t *testing.T) {
	for _, model := range []string{"gpt-5.5", "claude-sonnet-4-6", "gemini-2.5-flash"} {
		for _, stream := range []bool{true, false} {
			for _, kind := range []string{"function", "custom"} {
				for _, count := range []int{0, 1, 2} {
					for _, parallel := range []bool{false, true} {
						for _, incomplete := range []bool{false, true} {
							t.Run(fmt.Sprint(model, "/", stream, kind, count, parallel, incomplete), func(t *testing.T) {
								c, endpoint := routedClaudeCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
									w.Header().Set("Content-Type", "text/event-stream")
									io.WriteString(w, parallelStream(model, count, kind, incomplete))
								}))
								p := aliasPayload(model, "pad", "read", kind, stream)
								p["parallel_tool_calls"] = parallel
								b, _ := json.Marshal(p)
								req, _ := http.NewRequest("POST", endpoint+"/v1/responses", strings.NewReader(string(b)))
								req.Header.Set("Authorization", "Bearer "+c.token)
								req.Header.Set("Content-Type", "application/json")
								resp, err := http.DefaultClient.Do(req)
								success := parallel || count < 2
								if err != nil {
									if success || !stream {
										t.Fatal(err)
									}
									return
								}
								data, readErr := io.ReadAll(resp.Body)
								resp.Body.Close()
								if success {
									if resp.StatusCode != 200 || readErr != nil {
										t.Fatal("valid call count rejected", resp.StatusCode, readErr)
									}
									var final map[string]any
									if stream {
										if incomplete {
											for _, block := range strings.Split(string(data), "\n\n") {
												for _, line := range strings.Split(block, "\n") {
													if strings.HasPrefix(line, "data: ") {
														m, _ := decodeObject(strings.TrimPrefix(line, "data: "))
														if m["type"] == "response.incomplete" {
															final = obj(m["response"])
														}
													}
												}
											}
										} else {
											final = responseCompletion(t, data)
										}
									} else {
										final, _ = decodeObject(string(data))
									}
									if final["status"] != map[bool]string{true: "incomplete", false: "completed"}[incomplete] {
										t.Fatal("terminal contract")
									}
									if count > 0 {
										if len(final["output"].([]any)) != count {
											t.Fatal("tool count changed")
										}
										for _, v := range final["output"].([]any) {
											m := obj(v)
											if m["name"] != "read" || m["namespace"] != "pad" {
												t.Fatal("identity lost")
											}
										}
									}
									if incomplete && len(c.history.entries) != 0 {
										t.Fatal("incomplete anchor created")
									}
								} else {
									if !stream && resp.StatusCode != 502 {
										t.Fatal("multiple calls not rejected before JSON", resp.StatusCode)
									}
									if strings.Contains(string(data), "response.completed") || strings.Contains(string(data), "response.incomplete") || len(c.history.entries) != 0 {
										t.Fatal("false single-call completion/history")
									}
								}
							})
						}
					}
				}
			}
		}
	}
	// Client opt-in normalization must preserve both boolean constraints, not drop false.
	for _, value := range []bool{false, true} {
		p := clientPolicyPayload("gpt-5.5", false)
		p["parallel_tool_calls"] = value
		b, _ := json.Marshal(p)
		normalized, err := normalizeTextToolsClient(b)
		if err != nil {
			t.Fatal(err)
		}
		m, _ := decodeObject(string(normalized))
		if m["parallel_tool_calls"] != value {
			t.Fatal("client constraint erased")
		}
		prepared, _, err := (&Core{}).prepareRoutedHistory(normalized, "gpt-5.5")
		if err != nil {
			t.Fatal(err)
		}
		if _, err := buildChatPlan(prepared); err != nil {
			t.Fatal("client bool not admitted", err)
		}
	}
}
func TestParallelToolsHistoricalCallsAndNoInheritance(t *testing.T) {
	for _, model := range []string{"gpt-5.5", "claude-sonnet-4-6", "gemini-2.5-flash"} {
		var mu sync.Mutex
		captures := [][]byte{}
		c, endpoint := routedClaudeCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			b, _ := io.ReadAll(r.Body)
			mu.Lock()
			captures = append(captures, b)
			n := len(captures)
			mu.Unlock()
			w.Header().Set("Content-Type", "text/event-stream")
			if n == 1 {
				io.WriteString(w, parallelStream(model, 2, "function", false))
			} else {
				io.WriteString(w, parallelStream(model, 0, "function", false))
			}
		}))
		p := aliasPayload(model, "pad", "read", "function", false)
		p["parallel_tool_calls"] = true
		b, _ := json.Marshal(p)
		first := historyFinal(t, c, endpoint, string(b), false)
		original := p["input"].([]any)
		suffix := []any{map[string]string{"type": "function_call_output", "call_id": "single_1", "output": "second"}, map[string]string{"type": "function_call_output", "call_id": "single_0", "output": "first"}}
		p["parallel_tool_calls"] = false
		p["previous_response_id"] = first["id"]
		p["input"] = suffix
		b, _ = json.Marshal(p)
		historyFinal(t, c, endpoint, string(b), false)
		p["input"] = append(append(append([]any{}, original...), first["output"].([]any)...), suffix...)
		b, _ = json.Marshal(p)
		historyFinal(t, c, endpoint, string(b), false)
		delete(p, "parallel_tool_calls")
		b, _ = json.Marshal(p)
		historyFinal(t, c, endpoint, string(b), false)
		mu.Lock()
		if len(captures) != 4 || !reflect.DeepEqual(captures[1], captures[2]) || strings.Contains(string(captures[3]), "parallel") {
			t.Fatal("history constraints inherited or past calls rejected/duplicated")
		}
		mu.Unlock()
	}
}
func TestParallelToolsDSMLCountAndInvalidBooleans(t *testing.T) {
	for _, count := range []int{1, 2} {
		for _, stream := range []bool{false, true} {
			c, endpoint := routedClaudeCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "text/event-stream")
				io.WriteString(w, chatSSE(choice(map[string]any{"content": strings.Repeat(`<invoke name="pad__read"></invoke>`, count)}, "stop")))
			}))
			p := aliasPayload("gpt-5.5", "pad", "read", "function", stream)
			p["parallel_tool_calls"] = false
			b, _ := json.Marshal(p)
			req, _ := http.NewRequest("POST", endpoint+"/v1/responses", strings.NewReader(string(b)))
			req.Header.Set("Authorization", "Bearer "+c.token)
			req.Header.Set("X-MOMO-Tool-Text", "dsml-v1")
			req.Header.Set("Content-Type", "application/json")
			resp, err := http.DefaultClient.Do(req)
			if err != nil {
				if count == 1 {
					t.Fatal(err)
				}
				continue
			}
			data, _ := io.ReadAll(resp.Body)
			resp.Body.Close()
			if count == 1 {
				if resp.StatusCode != 200 || !strings.Contains(string(data), "call_dsml_") {
					t.Fatal("single DSML rejected", resp.StatusCode, string(data))
				}
			} else if strings.Contains(string(data), "response.completed") || len(c.history.entries) != 0 || !stream && resp.StatusCode != 502 {
				t.Fatal("DSML count bypassed")
			}
		}
	}
	for _, model := range []string{"gpt-5.5", "claude-sonnet-4-6", "gemini-2.5-flash"} {
		for _, v := range []any{nil, 1, "false", []any{}, map[string]any{}} {
			p := aliasPayload(model, "pad", "read", "function", false)
			p["parallel_tool_calls"] = v
			if _, err := aliasBuild(p); err == nil {
				t.Fatal("invalid boolean accepted")
			}
		}
	}
}

func TestParallelToolsPreflightNativeAndWriteFailures(t *testing.T) {
	c, endpoint := routedClaudeCore(t, http.HandlerFunc(func(http.ResponseWriter, *http.Request) { t.Error("invalid boolean sent upstream") }))
	for _, raw := range []string{`{"model":"gpt-5.5","input":[{"role":"user","content":"hi"}],"parallel_tool_calls":false,"parallel_tool_calls":true}`, `{"model":"gpt-5.5","input":[{"role":"user","content":"hi"}],"parallel_tool_calls":null}`} {
		code, _, _ := request(t, c, endpoint, "/v1/responses", "POST", raw, nil)
		if code != 400 {
			t.Fatal("boolean preflight", code)
		}
	}
	for _, model := range []string{"gpt-5.5", "claude-sonnet-4-6", "gemini-2.5-flash"} {
		for _, mode := range []string{"short", "error", "flush", "deadline"} {
			p := aliasPayload(model, "pad", "read", "function", false)
			p["parallel_tool_calls"] = false
			plan, err := aliasBuild(p)
			if err != nil {
				t.Fatal(err)
			}
			committed := false
			plan.prepareCompletion = func(string, []any) (func(), error) { return func() { committed = true }, nil }
			writer := &jsonProbeWriter{header: make(http.Header), mode: mode}
			convert := map[string]func(context.Context, http.ResponseWriter, io.Reader, *chatPlan) error{"chat": convertChatStream, "claude": convertClaudeStream, "gemini": convertGeminiStream}[resolveProtocol(model)]
			if convert(context.Background(), writer, strings.NewReader(parallelStream(model, 1, "function", false)), plan) == nil || committed || writer.writes > 1 {
				t.Fatal("failed terminal write committed/retried")
			}
		}
	}
	for _, mode := range []string{"passthrough", "momo-routing"} {
		var captured []byte
		var mu sync.Mutex
		c, endpoint, _, _ := testCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			b, _ := io.ReadAll(r.Body)
			mu.Lock()
			captured = b
			mu.Unlock()
			w.Header().Set("Content-Type", "application/json")
			io.WriteString(w, `{"ok":true}`)
		}))
		c.Stop()
		if c.Configure(Config{Endpoint: "https://mock.example", APIKey: syntheticKey, Mode: mode}) != nil || c.Start() != nil {
			t.Fatal("config")
		}
		model := "gpt-5.5"
		if mode == "momo-routing" {
			model = "gpt-5.6-sol"
		}
		p := aliasPayload(model, "pad", "read", "function", false)
		p["parallel_tool_calls"] = false
		b, _ := json.Marshal(p)
		code, _, _ := request(t, c, endpoint, "/v1/responses", "POST", string(b), nil)
		mu.Lock()
		if code != 200 || string(captured) != string(b) {
			t.Error("native/default bytes changed", mode)
		}
		mu.Unlock()
	}
}
func TestParallelToolsStopNoAnchorOrRetry(t *testing.T) {
	full := parallelStream("gpt-5.5", 1, "function", false)
	stalled := strings.TrimSuffix(full, "data: [DONE]\r\n\r\n")
	if stalled == full || strings.Contains(stalled, "[DONE]") {
		t.Fatal("stalled fixture must contain no upstream terminal")
	}
	entered := make(chan struct{})
	var mu sync.Mutex
	sends := 0
	c, endpoint := routedClaudeCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		sends++
		mu.Unlock()
		w.Header().Set("Content-Type", "text/event-stream")
		io.WriteString(w, stalled)
		w.(http.Flusher).Flush()
		close(entered)
		<-r.Context().Done()
	}))
	p := aliasPayload("gpt-5.5", "pad", "read", "function", true)
	p["parallel_tool_calls"] = false
	b, _ := json.Marshal(p)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, "POST", endpoint+"/v1/responses", strings.NewReader(string(b)))
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	<-entered
	c.Stop()
	data, err := io.ReadAll(resp.Body)
	mu.Lock()
	defer mu.Unlock()
	c.mu.Lock()
	defer c.mu.Unlock()
	if err == nil || strings.Contains(string(data), "response.completed") || sends != 1 || len(c.history.entries) != 0 {
		t.Fatalf("Stop completed/retried/retained anchor: status=%d readError=%v completed=%v sends=%d anchors=%d", resp.StatusCode, err, strings.Contains(string(data), "response.completed"), sends, len(c.history.entries))
	}
}

func TestParallelToolsFragmentedSameCallAndChoiceGates(t *testing.T) {
	c, endpoint := routedClaudeCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		io.WriteString(w, chatSSE(
			choice(map[string]any{"tool_calls": []any{map[string]any{"index": 0, "id": "single_0", "type": "function", "function": map[string]string{"name": "pad__", "arguments": "{"}}}}, nil),
			choice(map[string]any{"tool_calls": []any{map[string]any{"index": 0, "function": map[string]string{"name": "read", "arguments": `"x":1}`}}}}, "tool_calls")))
	}))
	p := aliasPayload("gpt-5.5", "pad", "read", "function", false)
	p["parallel_tool_calls"] = false
	b, _ := json.Marshal(p)
	first := historyFinal(t, c, endpoint, string(b), false)
	call := obj(first["output"].([]any)[0])
	if call["call_id"] != "single_0" || call["arguments"] != `{"x":1}` {
		t.Fatal("fragments counted as distinct calls")
	}
	for _, model := range []string{"gpt-5.5", "claude-sonnet-4-6", "gemini-2.5-flash"} {
		for _, choice := range []any{"none", map[string]string{"type": "function", "name": "other", "namespace": "pad"}, map[string]any{"type": "allowed_tools", "mode": "auto", "tools": []any{map[string]string{"type": "function", "name": "other", "namespace": "pad"}}}} {
			c, endpoint := routedClaudeCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "text/event-stream")
				io.WriteString(w, parallelStream(model, 1, "function", false))
			}))
			p := aliasPayload(model, "pad", "read", "function", false)
			obj(p["tools"].([]any)[0])["tools"] = []any{map[string]string{"type": "function", "name": "read"}, map[string]string{"type": "function", "name": "other"}}
			p["tool_choice"], p["parallel_tool_calls"] = choice, false
			b, _ := json.Marshal(p)
			code, _, _ := request(t, c, endpoint, "/v1/responses", "POST", string(b), nil)
			if code != 502 || len(c.history.entries) != 0 {
				t.Fatal("single-call bypassed none/named/allowed", model, choice)
			}
		}
	}
}
