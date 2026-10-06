package appcore

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
)

func clientToolPayload(model, name string, format any, stream bool) map[string]any {
	tool := map[string]any{"type": "custom", "name": name}
	if format != nil {
		tool["format"] = format
	}
	return map[string]any{"model": model, "stream": stream, "input": []any{map[string]string{"role": "user", "content": "client-tools"}}, "tools": []any{map[string]any{"type": "namespace", "name": "pad", "tools": []any{tool}}}, "tool_choice": map[string]string{"type": "custom", "name": name, "namespace": "pad"}}
}

func clientToolStream(model, name, args, terminal string) string {
	switch resolveProtocol(model) {
	case "chat":
		return chatSSE(choice(map[string]any{"tool_calls": []any{map[string]any{"index": 0, "id": "client_call", "type": "function", "function": map[string]string{"name": "pad__" + name, "arguments": args}}}}, terminal))
	case "claude":
		return claudeStart() + claudeTool(0, "client_call", "pad__"+name, args) + claudeEnd(terminal)
	default:
		m, _ := decodeObject(args)
		return geminiFrame([]any{geminiCall("client_call", "pad__"+name, m)}, terminal, geminiUsageFixture())
	}
}

func TestClientCustomTextExactOutputAndHistory(t *testing.T) {
	for _, model := range []string{"gpt-5.5", "claude-sonnet-4-6", "gemini-2.5-flash"} {
		for _, stream := range []bool{true, false} {
			for _, tc := range []struct{ name, raw string }{
				{"exec", " \r\nawait tools.exec_command({cmd: \x60echo $" + "{x} $(whoami) 中文🙂\x60});\r\n "},
				{"exec", "git status"}, {"exec", ""},
				{"apply_patch", "\n*** Begin Patch\r\n*** Add File: example.txt\r\n+中文🙂\r\n*** End Patch\r\n "},
			} {
				t.Run(fmt.Sprint(model, "/", stream, "/", tc.name, "/", len(tc.raw)), func(t *testing.T) {
					var mu sync.Mutex
					var captures [][]byte
					args, _ := json.Marshal(map[string]string{"input": tc.raw})
					terminal := map[string]string{"chat": "tool_calls", "claude": "tool_use", "gemini": "STOP"}[resolveProtocol(model)]
					c, endpoint := routedClaudeCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
						b, _ := io.ReadAll(r.Body)
						mu.Lock()
						captures = append(captures, b)
						mu.Unlock()
						w.Header().Set("Content-Type", "text/event-stream")
						fmt.Fprint(w, clientToolStream(model, tc.name, string(args), terminal))
					}))
					for _, format := range []any{nil, map[string]string{"type": "text"}} {
						p := clientToolPayload(model, tc.name, format, stream)
						b, _ := json.Marshal(p)
						final := historyFinal(t, c, endpoint, string(b), stream)
						output := final["output"].([]any)
						if len(output) != 1 {
							t.Fatal("custom output count")
						}
						call := obj(output[0])
						if call["type"] != "custom_tool_call" || call["name"] != tc.name || call["namespace"] != "pad" || call["call_id"] != "client_call" || call["input"] != tc.raw {
							t.Fatal("custom raw string or declared identity changed")
						}
						p["previous_response_id"] = final["id"]
						p["input"] = []any{map[string]string{"type": "custom_tool_call_output", "call_id": "client_call", "output": "client-executed-result"}, map[string]string{"role": "user", "content": "continue"}}
						b, _ = json.Marshal(p)
						historyFinal(t, c, endpoint, string(b), stream)
						mu.Lock()
						wire, _ := decodeObject(string(captures[len(captures)-1]))
						mu.Unlock()
						var wrapper map[string]any
						switch resolveProtocol(model) {
						case "chat":
							m := obj(wire["messages"].([]any)[1])
							f := obj(obj(m["tool_calls"].([]any)[0])["function"])
							wrapper, _ = decodeObject(str(f["arguments"]))
							if f["name"] != "pad__"+tc.name {
								t.Fatal("Chat history alias")
							}
						case "claude":
							call := obj(obj(wire["messages"].([]any)[1])["content"].([]any)[0])
							wrapper = obj(call["input"])
							if call["name"] != "pad__"+tc.name {
								t.Fatal("Claude history alias")
							}
						default:
							call := obj(obj(obj(wire["contents"].([]any)[1])["parts"].([]any)[0])["functionCall"])
							wrapper = obj(call["args"])
							if call["name"] != "pad__"+tc.name {
								t.Fatal("Gemini history alias")
							}
						}
						if len(wrapper) != 1 || wrapper["input"] != tc.raw {
							t.Fatal("custom history raw changed")
						}
					}
					mu.Lock()
					defer mu.Unlock()
					if len(captures) != 4 {
						t.Fatal("custom fallback/retry")
					}
				})
			}
		}
	}
}

func TestClientCustomFormatRejectedBeforeSend(t *testing.T) {
	formats := []any{map[string]string{"type": "grammar", "syntax": "lark", "definition": "start: /.+/\r\n"}, map[string]string{"type": "grammar", "syntax": "regex", "definition": ".*"}, map[string]any{"type": "text", "extra": true}, map[string]string{"type": "unknown"}, "text", map[string]any{}}
	for _, model := range []string{"gpt-5.5", "claude-sonnet-4-6", "gemini-2.5-flash"} {
		var sends atomic.Int32
		c, endpoint := routedClaudeCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { sends.Add(1) }))
		for _, format := range formats {
			p := clientToolPayload(model, "exec", format, false)
			b, _ := json.Marshal(p)
			if _, err := parseRoutedRequest(b); !errors.Is(err, errUnsupportedToolFormat) {
				t.Fatal("format error lost")
			}
			code, body, _ := request(t, c, endpoint, "/v1/responses", "POST", string(b), nil)
			if code != 400 || string(body) != "unsupported_tool_format\n" {
				t.Fatal("unsafe format rejection")
			}
		}
		for _, mutate := range []func(map[string]any){
			func(tool map[string]any) { tool["format"] = nil },
			func(tool map[string]any) { tool["parameters"] = map[string]string{"type": "object"} },
			func(tool map[string]any) { tool["type"] = "function" },
		} {
			p := clientToolPayload(model, "apply_patch", map[string]string{"type": "text"}, false)
			mutate(obj(obj(p["tools"].([]any)[0])["tools"].([]any)[0]))
			b, _ := json.Marshal(p)
			code, _, _ := request(t, c, endpoint, "/v1/responses", "POST", string(b), nil)
			if code != 400 {
				t.Fatal("invalid custom definition")
			}
		}
		if sends.Load() != 0 {
			t.Fatal("unsupported format sent upstream")
		}
	}
}

func TestClientCustomBadWrappersNoCompletionOrHistory(t *testing.T) {
	for _, model := range []string{"gpt-5.5", "claude-sonnet-4-6", "gemini-2.5-flash"} {
		for _, stream := range []bool{true, false} {
			for _, args := range []string{`{"cmd":"git status"}`, `{"patch":"*** Begin Patch"}`, `{"input":"ok","extra":true}`, `{"input":17}`, `{"input":null}`} {
				t.Run(fmt.Sprint(model, "/", stream, "/", args), func(t *testing.T) {
					terminal := map[string]string{"chat": "tool_calls", "claude": "tool_use", "gemini": "STOP"}[resolveProtocol(model)]
					c, endpoint := routedClaudeCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
						w.Header().Set("Content-Type", "text/event-stream")
						fmt.Fprint(w, clientToolStream(model, "exec", args, terminal))
					}))
					p := clientToolPayload(model, "exec", nil, stream)
					b, _ := json.Marshal(p)
					req, _ := http.NewRequest("POST", endpoint+"/v1/responses", strings.NewReader(string(b)))
					req.Header.Set("Authorization", "Bearer "+c.token)
					req.Header.Set("Content-Type", "application/json")
					resp, err := http.DefaultClient.Do(req)
					if err != nil {
						t.Fatal(err)
					}
					body, readErr := io.ReadAll(resp.Body)
					resp.Body.Close()
					if strings.Contains(string(body), "response.completed") || strings.Contains(string(body), "custom_tool_call") || (stream && readErr == nil) || (!stream && resp.StatusCode != 502) {
						t.Fatal("invalid wrapper fabricated success or call")
					}
					c.mu.Lock()
					defer c.mu.Unlock()
					if len(c.history.entries) != 0 {
						t.Fatal("invalid wrapper stored history")
					}
				})
			}
		}
	}
}

func TestNativeCustomGrammarExactPassthrough(t *testing.T) {
	for _, mode := range []string{"passthrough", "momo-routing"} {
		c, endpoint, _, _ := testCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			b, _ := io.ReadAll(r.Body)
			w.Header().Set("Content-Type", "application/json")
			w.Write(b)
		}))
		c.Stop()
		if err := c.Configure(Config{Endpoint: "https://mock.example", APIKey: syntheticKey, Mode: mode}); err != nil {
			t.Fatal(err)
		}
		if err := c.Start(); err != nil {
			t.Fatal(err)
		}
		p := clientToolPayload("gpt-5.6-sol", "exec", map[string]string{"type": "grammar", "syntax": "lark", "definition": "start: /.+/\r\n // 中文\n"}, false)
		b, _ := json.Marshal(p)
		code, body, _ := request(t, c, endpoint, "/v1/responses", "POST", string(b), nil)
		if code != 200 || string(body) != string(b) {
			t.Fatal("native grammar bytes changed")
		}
	}
}

func TestClientCustomChoiceAndWriteBoundary(t *testing.T) {
	for _, model := range []string{"gpt-5.5", "claude-sonnet-4-6", "gemini-2.5-flash"} {
		for _, name := range []string{"exec", "apply_patch"} {
			p := clientToolPayload(model, name, map[string]string{"type": "text"}, false)
			b, _ := json.Marshal(p)
			build := map[string]func([]byte) (*chatPlan, error){"chat": buildChatPlan, "claude": buildClaudePlan, "gemini": buildGeminiPlan}[resolveProtocol(model)]
			plan, err := build(b)
			if err != nil {
				t.Fatal(err)
			}
			for _, mode := range []string{"short", "error", "flush", "deadline", "ok", "incomplete"} {
				var committed bool
				plan.prepareCompletion = func(string, []any) (func(), error) { return func() { committed = true }, nil }
				w := &jsonProbeWriter{header: make(http.Header), mode: mode}
				e, err := newRoutedResponseWriter(w, plan)
				if err != nil || e.accept(streamEvent{kind: "tool", call: streamToolCall{id: "a", name: "pad__" + name, args: `{"input":" \r\nraw\n "}`}}, plan) != nil {
					t.Fatal("custom writer setup")
				}
				if w.writes != 0 {
					t.Fatal("custom JSON wrote before terminal")
				}
				terminal := "complete"
				if mode == "incomplete" {
					terminal = "incomplete"
				}
				err = e.accept(streamEvent{kind: terminal}, plan)
				if mode == "ok" || mode == "incomplete" {
					if err != nil || committed != (mode == "ok") {
						t.Fatal("custom terminal history boundary")
					}
				} else if err == nil || committed {
					t.Fatal("custom write failure committed")
				}
			}
			for _, choice := range []string{"none", "specific", "allowed"} {
				plan.choice, plan.selected, plan.allowed = choice, "", nil
				if choice == "specific" {
					plan.selected = "not_this_tool"
				}
				if choice == "allowed" {
					plan.allowed = map[string]bool{"not_this_tool": true}
				}
				w := &jsonProbeWriter{header: make(http.Header), mode: "ok"}
				e, _ := newRoutedResponseWriter(w, plan)
				if e.accept(streamEvent{kind: "tool", call: streamToolCall{id: "a", name: "pad__" + name, args: `{"input":"raw"}`}}, plan) == nil || w.writes != 0 {
					t.Fatal("custom identity bypassed selection")
				}
			}
		}
	}
}
