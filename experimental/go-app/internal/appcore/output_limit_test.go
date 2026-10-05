package appcore

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

func TestOutputTokenLimitMappingsAndValidation(t *testing.T) {
	for _, tc := range []struct {
		name, payload string
		build         func([]byte) (*chatPlan, error)
	}{{"Chat", routedPayload, buildChatPlan}, {"Claude", claudePayload, buildClaudePlan}, {"Gemini", geminiPayload, buildGeminiPlan}} {
		for _, n := range []int{1, 17, 1048576} {
			p, _ := decodeObject(tc.payload)
			p["max_output_tokens"] = n
			b, _ := json.Marshal(p)
			plan, err := tc.build(b)
			if err != nil {
				t.Fatal(err)
			}
			wire, _ := decodeObject(string(plan.body))
			var actual any
			switch tc.name {
			case "Chat":
				actual = wire["max_completion_tokens"]
			case "Claude":
				actual = wire["max_tokens"]
			case "Gemini":
				actual = obj(wire["generationConfig"])["maxOutputTokens"]
			}
			if actual != json.Number(fmt.Sprint(n)) {
				t.Fatal("output token limit mapping")
			}
		}
		c, endpoint := routedClaudeCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { t.Error("invalid limit sent upstream") }))
		for _, bad := range []any{nil, 0, -1, 1.5, "17", 1048577, []any{}, true} {
			p, _ := decodeObject(tc.payload)
			p["max_output_tokens"] = bad
			b, _ := json.Marshal(p)
			code, _, _ := request(t, c, endpoint, "/v1/responses", "POST", string(b), nil)
			if code != 400 {
				t.Fatal("invalid token limit accepted")
			}
		}
	}
}

func TestOutputLimitIncompleteNotCachedAndJSONMatchesSSE(t *testing.T) {
	for _, tc := range []struct{ model, upstream string }{
		{"gpt-5.5", chatSSE(choice(map[string]any{"content": "partial中文🙂"}, "length"))},
		{"claude-sonnet-4-6", claudeStart() + claudeText(0, "partial中文🙂") + claudeEnd("max_tokens")},
		{"gemini-2.5-flash", geminiFrame([]any{geminiText("partial中文🙂")}, "MAX_TOKENS", geminiUsageFixture())},
	} {
		t.Run(tc.model, func(t *testing.T) {
			c, endpoint := routedClaudeCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "text/event-stream")
				fmt.Fprint(w, tc.upstream)
			}))
			var want string
			for _, stream := range []bool{true, false} {
				p, _ := decodeObject(historyPayload(tc.model, []any{map[string]string{"role": "user", "content": "hi"}}, "", stream))
				// required must not turn a legitimate output-limit terminal into fake success/failure.
				p["tool_choice"] = "required"
				p["max_output_tokens"] = 17
				b, _ := json.Marshal(p)
				code, data, _ := request(t, c, endpoint, "/v1/responses", "POST", string(b), nil)
				if code != 200 || strings.Contains(string(data), "response.completed") {
					t.Fatal("incomplete status")
				}
				var final map[string]any
				if stream {
					for _, line := range strings.Split(string(data), "\n") {
						if strings.HasPrefix(line, "data: ") {
							m, _ := decodeObject(line[6:])
							if m["type"] == "response.incomplete" {
								if final != nil {
									t.Fatal("duplicate incomplete")
								}
								final = obj(m["response"])
							}
						}
					}
				} else {
					final, _ = decodeObject(string(data))
				}
				if final == nil || final["status"] != "incomplete" || obj(final["incomplete_details"])["reason"] != "max_output_tokens" {
					t.Fatal("missing incomplete terminal")
				}
				if !strings.Contains(string(data), "partial中文🙂") {
					t.Fatal("partial text lost")
				}
				id := str(final["id"])
				semantic := responseSemantic(final)
				if stream {
					want = semantic
				} else if semantic != want {
					t.Fatal("incomplete JSON/SSE differ")
				}
				code, _, _ = request(t, c, endpoint, "/v1/responses", "POST", historyPayload(tc.model, []any{map[string]string{"role": "user", "content": "next"}}, id, false), nil)
				if code != 400 {
					t.Fatal("incomplete minted history anchor")
				}
				c.mu.Lock()
				count := len(c.history.entries)
				c.mu.Unlock()
				if count != 0 {
					t.Fatal("incomplete history cached")
				}
			}
		})
	}
}

func TestOutputLimitPartialToolsStillFail(t *testing.T) {
	for _, tc := range []struct{ model, upstream string }{
		{"gpt-5.5", chatSSE(choice(map[string]any{"tool_calls": []any{map[string]any{"index": 0, "id": "a", "type": "function", "function": map[string]string{"name": "pad__read", "arguments": "{"}}}}, "length"))},
		{"claude-sonnet-4-6", claudeStart() + claudeTool(0, "a", "pad__read", "{") + claudeEnd("max_tokens")},
		{"gemini-2.5-flash", geminiFrame([]any{map[string]any{"functionCall": map[string]any{"name": "pad__read", "args": "{"}}}, "MAX_TOKENS", geminiUsageFixture())},
	} {
		for _, stream := range []bool{true, false} {
			c, endpoint := routedClaudeCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "text/event-stream")
				fmt.Fprint(w, tc.upstream)
			}))
			req, _ := http.NewRequest("POST", endpoint+"/v1/responses", strings.NewReader(historyPayload(tc.model, []any{map[string]string{"role": "user", "content": "hi"}}, "", stream)))
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("Authorization", "Bearer "+c.token)
			client := http.Client{Timeout: 3 * time.Second}
			resp, err := client.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			data, readErr := io.ReadAll(resp.Body)
			resp.Body.Close()
			client.CloseIdleConnections()
			if strings.Contains(string(data), "response.incomplete") || strings.Contains(string(data), "response.completed") || stream && readErr == nil || !stream && (resp.StatusCode != 502 || readErr != nil) {
				t.Fatal("malformed partial tool escaped limit failure")
			}
		}
	}
}

func TestOutputLimitTerminalStillRequiresValidTransportAndUsage(t *testing.T) {
	chat := chatSSE(choice(map[string]any{"content": "partial"}, "length"))
	claude := claudeStart() + claudeText(0, "partial") + claudeEnd("max_tokens")
	gemini := geminiFrame([]any{geminiText("partial")}, "MAX_TOKENS", geminiUsageFixture())
	for _, tc := range []struct {
		name, model, wire string
		disconnect        bool
	}{
		{"Chat missing DONE", "gpt-5.5", strings.TrimSuffix(chat, "data: [DONE]\r\n\r\n"), false},
		{"Chat late error", "gpt-5.5", strings.Replace(chat, "data: [DONE]", "data: {\"error\":{\"message\":\"private-limit-detail\"}}\r\n\r\ndata: [DONE]", 1), false},
		{"Chat invalid usage", "gpt-5.5", strings.Replace(chat, "data: [DONE]", "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":3,\"completion_tokens\":5,\"total_tokens\":9}}\r\n\r\ndata: [DONE]", 1), false},
		{"Claude missing stop", "claude-sonnet-4-6", strings.TrimSuffix(claude, claudeFrame("message_stop", map[string]any{})), false},
		{"Claude late error", "claude-sonnet-4-6", strings.Replace(claude, claudeFrame("message_stop", map[string]any{}), claudeFrame("error", map[string]any{"error": map[string]string{"message": "private-limit-detail"}})+claudeFrame("message_stop", map[string]any{}), 1), false},
		{"Claude invalid usage", "claude-sonnet-4-6", strings.Replace(claude, `"output_tokens":5`, `"output_tokens":-1`, 1), false},
		{"Gemini partial frame", "gemini-2.5-flash", strings.TrimSuffix(gemini, "\r\n\r\n"), false},
		{"Gemini late error", "gemini-2.5-flash", gemini + "data: {\"error\":{\"message\":\"private-limit-detail\"}}\r\n\r\n", false},
		{"Gemini decreasing usage", "gemini-2.5-flash", gemini + geminiFrame(nil, "", map[string]any{"promptTokenCount": 3, "candidatesTokenCount": 4, "totalTokenCount": 7}), false},
		{"Gemini physical disconnect", "gemini-2.5-flash", gemini, true},
	} {
		for _, stream := range []bool{true, false} {
			t.Run(fmt.Sprintf("%s/%t", tc.name, stream), func(t *testing.T) {
				c, endpoint := routedClaudeCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					w.Header().Set("Content-Type", "text/event-stream")
					if tc.disconnect {
						w.Header().Set("Content-Length", fmt.Sprint(len(tc.wire)+20))
					}
					fmt.Fprint(w, tc.wire)
				}))
				req, _ := http.NewRequest("POST", endpoint+"/v1/responses", strings.NewReader(historyPayload(tc.model, []any{map[string]string{"role": "user", "content": "hi"}}, "", stream)))
				req.Header.Set("Content-Type", "application/json")
				req.Header.Set("Authorization", "Bearer "+c.token)
				client := http.Client{Timeout: 3 * time.Second}
				defer client.CloseIdleConnections()
				resp, err := client.Do(req)
				if err != nil {
					t.Fatal(err)
				}
				data, readErr := io.ReadAll(resp.Body)
				resp.Body.Close()
				if strings.Contains(string(data), "response.incomplete") || strings.Contains(string(data), "response.completed") || strings.Contains(string(data), "private-limit-detail") || stream && readErr == nil || !stream && (resp.StatusCode != 502 || readErr != nil) {
					t.Fatal("invalid limited stream escaped failure")
				}
				c.mu.Lock()
				count := len(c.history.entries)
				c.mu.Unlock()
				if count != 0 {
					t.Fatal("failed limit cached")
				}
			})
		}
	}
}

func TestIncompleteJSONWriteBoundaryNeverPreparesHistory(t *testing.T) {
	for _, mode := range []string{"short", "error", "flush", "deadline", "ok"} {
		t.Run(mode, func(t *testing.T) {
			w := &jsonProbeWriter{header: make(http.Header), mode: mode}
			p := &chatPlan{model: "mock", prepareCompletion: func(string, []any) (func(), error) {
				t.Fatal("incomplete prepared history")
				return nil, errRouted
			}}
			e, err := newRoutedResponseWriter(w, p)
			if err != nil || e.accept(streamEvent{kind: "text", text: "partial"}, p) != nil || w.writes != 0 || len(w.header) != 0 {
				t.Fatal("early incomplete JSON write")
			}
			err = e.accept(streamEvent{kind: "incomplete"}, p)
			switch mode {
			case "short", "error", "flush":
				if !errors.Is(err, errRoutedWrite) || w.writes != 1 {
					t.Fatal("incomplete partial write boundary")
				}
			case "deadline":
				if err == nil || errors.Is(err, errRoutedWrite) || w.writes != 0 || len(w.header) != 0 {
					t.Fatal("incomplete pre-write boundary")
				}
			case "ok":
				if err != nil || w.writes != 1 {
					t.Fatal("incomplete final write")
				}
			}
			if e.accept(streamEvent{kind: "complete"}, p) == nil || e.accept(streamEvent{kind: "incomplete"}, p) == nil {
				t.Fatal("incomplete terminal reused")
			}
		})
	}
}

func TestOutputLimitValidToolsRetainedAndChoiceStillEnforced(t *testing.T) {
	for _, tc := range []struct{ model, wire string }{
		{"gpt-5.5", chatSSE(choice(map[string]any{"tool_calls": []any{map[string]any{"index": 0, "id": "call_limit", "type": "function", "function": map[string]string{"name": "pad__read", "arguments": "{}"}}}}, "length"))},
		{"claude-sonnet-4-6", claudeStart() + claudeTool(0, "call_limit", "pad__read", "{}") + claudeEnd("max_tokens")},
		{"gemini-2.5-flash", geminiFrame([]any{geminiCall("call_limit", "pad__read", map[string]any{})}, "MAX_TOKENS", geminiUsageFixture())},
	} {
		for _, choice := range []any{"required", "none", map[string]string{"type": "function", "name": "read", "namespace": "pad"}, map[string]string{"type": "custom", "name": "write", "namespace": "pad"}} {
			for _, stream := range []bool{true, false} {
				c, endpoint := routedClaudeCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					w.Header().Set("Content-Type", "text/event-stream")
					fmt.Fprint(w, tc.wire)
				}))
				p, _ := decodeObject(historyPayload(tc.model, []any{map[string]string{"role": "user", "content": "hi"}}, "", stream))
				p["tool_choice"] = choice
				b, _ := json.Marshal(p)
				req, _ := http.NewRequest("POST", endpoint+"/v1/responses", strings.NewReader(string(b)))
				req.Header.Set("Content-Type", "application/json")
				req.Header.Set("Authorization", "Bearer "+c.token)
				client := http.Client{Timeout: 3 * time.Second}
				resp, err := client.Do(req)
				if err != nil {
					t.Fatal(err)
				}
				data, readErr := io.ReadAll(resp.Body)
				resp.Body.Close()
				client.CloseIdleConnections()
				named, _ := choice.(map[string]string)
				valid := choice == "required" || named["name"] == "read"
				if valid {
					if resp.StatusCode != 200 || readErr != nil || !strings.Contains(string(data), `"status":"incomplete"`) || !strings.Contains(string(data), `"call_id":"call_limit"`) || !strings.Contains(string(data), `"namespace":"pad"`) || !strings.Contains(string(data), `"arguments":"{}"`) {
						t.Fatal("valid incomplete tool lost")
					}
				} else if strings.Contains(string(data), `"status":"incomplete"`) || stream && readErr == nil || !stream && (resp.StatusCode != 502 || readErr != nil) {
					t.Fatal("incomplete bypassed tool choice")
				}
				c.mu.Lock()
				count := len(c.history.entries)
				c.mu.Unlock()
				if count != 0 {
					t.Fatal("incomplete tools cached")
				}
			}
		}
	}
}
