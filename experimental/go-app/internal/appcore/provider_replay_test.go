package appcore

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestProviderReplayCanonicalToolsAcrossConvertedModels(t *testing.T) {
	models := []string{"gpt-5.5", "gpt-5.4", "claude-sonnet-4-6", "gemini-2.5-flash"}
	for _, source := range models {
		for _, target := range models {
			if source == target {
				continue
			}
			for _, streaming := range []bool{true, false} {
				t.Run(source+"/"+target+"/"+map[bool]string{true: "SSE", false: "JSON"}[streaming], func(t *testing.T) {
					var mu sync.Mutex
					captures := [][]byte{}
					c, endpoint := routedClaudeCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
						b, _ := io.ReadAll(r.Body)
						mu.Lock()
						captures = append(captures, b)
						n := len(captures)
						mu.Unlock()
						if r.Header.Get("X-MOMO-History") != "" {
							t.Error("history policy forwarded")
						}
						w.Header().Set("Content-Type", "text/event-stream")
						if n == 1 {
							switch resolveProtocol(source) {
							case "chat":
								io.WriteString(w, goodChatSSE())
							case "claude":
								io.WriteString(w, goodClaudeSSE())
							case "gemini":
								io.WriteString(w, goodGeminiSSE())
							}
						} else {
							switch resolveProtocol(target) {
							case "chat":
								io.WriteString(w, chatSSE(choice(map[string]any{"content": "target-done"}, "stop")))
							case "claude":
								io.WriteString(w, claudeStart()+claudeText(0, "target-done")+claudeEnd("end_turn"))
							case "gemini":
								io.WriteString(w, geminiFrame([]any{geminiText("target-done")}, "STOP", geminiUsageFixture()))
							}
						}
					}))
					original := []any{map[string]string{"role": "developer", "content": "historical-rule"}, map[string]string{"role": "user", "content": "source-turn"}}
					first := historyFinal(t, c, endpoint, historyPayload(source, original, "", false), false)
					suffix := []any{}
					for _, v := range first["output"].([]any) {
						m := obj(v)
						switch m["type"] {
						case "function_call":
							suffix = append(suffix, map[string]any{"type": "function_call_output", "call_id": m["call_id"], "output": "function-result"})
						case "custom_tool_call":
							suffix = append(suffix, map[string]any{"type": "custom_tool_call_output", "call_id": m["call_id"], "output": "custom-result"})
						}
					}
					if len(suffix) != 2 {
						t.Fatal("fixture lost parallel calls")
					}
					suffix[0], suffix[1] = suffix[1], suffix[0]
					suffix = append(suffix, map[string]string{"role": "user", "content": "target-turn"})
					payload := historyPayload(target, suffix, str(first["id"]), streaming)
					code, data, headers := request(t, c, endpoint, "/v1/responses", "POST", payload, map[string]string{"X-MOMO-History": "replay-v1"})
					if code != 200 {
						t.Fatalf("explicit provider replay rejected: %d", code)
					}
					if headers.Get("X-MOMO-History") != "replay-v1" {
						t.Fatal("policy acknowledgment missing")
					}
					var final map[string]any
					if streaming {
						final = responseCompletion(t, data)
					} else {
						final, _ = decodeObject(string(data))
					}
					if final["model"] != target || final["status"] != "completed" {
						t.Fatal("target terminal")
					}
					full := append(append(append([]any{}, original...), first["output"].([]any)...), suffix...)
					code, _, _ = request(t, c, endpoint, "/v1/responses", "POST", historyPayload(target, full, str(first["id"]), streaming), map[string]string{"X-MOMO-History": "replay-v1"})
					if code != 200 {
						t.Fatal("explicit full provider replay")
					}
					expected, _, err := c.prepareRoutedHistory([]byte(historyPayload(target, full, "", streaming)), target)
					if err != nil {
						t.Fatal(err)
					}
					var plan *chatPlan
					switch resolveProtocol(target) {
					case "chat":
						plan, err = buildChatPlan(expected)
					case "claude":
						plan, err = buildClaudePlan(expected)
					case "gemini":
						plan, err = buildGeminiPlan(expected)
					}
					if err != nil {
						t.Fatal(err)
					}
					mu.Lock()
					defer mu.Unlock()
					if len(captures) != 3 {
						t.Fatal("replay retried")
					}
					if string(captures[1]) != string(captures[2]) {
						t.Fatal("full provider replay duplicated transcript")
					}
					want, _ := decodeObject(string(plan.body))
					actual, _ := decodeObject(string(captures[1]))
					if !reflect.DeepEqual(want, actual) {
						t.Fatal("target wire lost ordered canonical tools/results/instructions")
					}
					c.mu.Lock()
					defer c.mu.Unlock()
					if len(c.history.entries) != 3 || c.history.entries[str(first["id"])].model != source || c.history.entries[str(final["id"])].model != target {
						t.Fatal("source consumed or wrong target anchor")
					}
					if strings.Contains(string(captures[1]), "previous_response_id") {
						t.Fatal("source anchor leaked upstream")
					}
				})
			}
		}
	}
}

func TestProviderReplayRequestStrictFraming(t *testing.T) {
	c, endpoint := routedClaudeCore(t, http.HandlerFunc(func(http.ResponseWriter, *http.Request) { t.Error("bad replay sent upstream") }))
	for _, payload := range []string{`{"model":"gpt-5.5","model":"gpt-5.5","input":[]}`, `{"model":"gpt-5.5","input":null}`} {
		code, _, _ := request(t, c, endpoint, "/v1/responses", "POST", payload, map[string]string{"X-MOMO-History": "replay-v1"})
		if code != 400 {
			t.Fatal("invalid framing accepted", code)
		}
	}
}

func TestProviderReplayFailureTCPDoesNotCompleteOrSave(t *testing.T) {
	for _, streaming := range []bool{true, false} {
		sends := 0
		c, endpoint := routedClaudeCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			sends++
			w.Header().Set("Content-Type", "text/event-stream")
			if sends == 1 {
				io.WriteString(w, chatSSE(choice(map[string]any{"content": "source"}, "stop")))
			} else {
				io.WriteString(w, claudeStart()+claudeText(0, "partial"))
			}
		}))
		first := historyFinal(t, c, endpoint, historyPayload("gpt-5.5", []any{map[string]string{"role": "user", "content": "source-turn"}}, "", false), false)
		req, _ := http.NewRequest("POST", endpoint+"/v1/responses", strings.NewReader(historyPayload("claude-sonnet-4-6", []any{map[string]string{"role": "user", "content": "target-turn"}}, str(first["id"]), streaming)))
		req.Header.Set("Authorization", "Bearer "+c.token)
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-MOMO-History", "replay-v1")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		data, err := io.ReadAll(resp.Body)
		resp.Body.Close()
		if streaming && err == nil || !streaming && (err != nil || resp.StatusCode != 502) || strings.Contains(string(data), "response.completed") {
			t.Fatal("truncated provider switch completed")
		}
		c.mu.Lock()
		count := len(c.history.entries)
		order := append([]string{}, c.history.order...)
		c.mu.Unlock()
		if sends != 2 || count != 1 || !reflect.DeepEqual(order, []string{str(first["id"])}) {
			t.Fatal("failed target retried/consumed history")
		}
	}
}

func TestProviderReplayConcurrentBranchesAndNoInheritedPermission(t *testing.T) {
	var mu sync.Mutex
	sends := 0
	c, endpoint := routedClaudeCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		sends++
		mu.Unlock()
		w.Header().Set("Content-Type", "text/event-stream")
		switch r.URL.Path {
		case "/v1/messages":
			io.WriteString(w, claudeStart()+claudeText(0, "target")+claudeEnd("end_turn"))
		case geminiPath:
			io.WriteString(w, geminiFrame([]any{geminiText("target")}, "STOP", geminiUsageFixture()))
		default:
			io.WriteString(w, chatSSE(choice(map[string]any{"content": "source"}, "stop")))
		}
	}))
	first := historyFinal(t, c, endpoint, historyPayload("gpt-5.5", []any{map[string]string{"role": "user", "content": "source-turn"}}, "", false), false)
	var wg sync.WaitGroup
	ids := make(chan string, 4)
	for _, target := range []string{"gpt-5.4", "claude-sonnet-4-6", "gemini-2.5-flash", "gpt-5.4"} {
		wg.Add(1)
		go func(target string) {
			defer wg.Done()
			code, data, _ := request(t, c, endpoint, "/v1/responses", "POST", historyPayload(target, []any{map[string]string{"role": "user", "content": "branch"}}, str(first["id"]), false), map[string]string{"X-MOMO-History": "replay-v1"})
			if code != 200 {
				t.Error("branch failed", code)
				return
			}
			p, err := decodeObject(string(data))
			if err != nil {
				t.Error(err)
				return
			}
			ids <- str(p["id"])
		}(target)
	}
	wg.Wait()
	close(ids)
	for id := range ids {
		code, _, _ := request(t, c, endpoint, "/v1/responses", "POST", historyPayload("gpt-5.5", []any{map[string]string{"role": "user", "content": "next"}}, id, false), nil)
		if code != 400 {
			t.Fatal("cross-model permission inherited")
		}
	}
	c.mu.Lock()
	count := len(c.history.entries)
	source := c.history.entries[str(first["id"])].model
	c.mu.Unlock()
	mu.Lock()
	total := sends
	mu.Unlock()
	if count != 5 || source != "gpt-5.5" || total != 5 {
		t.Fatal("branch isolation/rejected request send")
	}
}

func TestProviderReplayMediaMustSatisfyTargetPolicy(t *testing.T) {
	inline := inlineFixture(t, "image/png")
	original := []any{map[string]any{"role": "user", "content": []any{map[string]string{"type": "input_text", "text": "before"}, imagePart(inline), map[string]string{"type": "input_text", "text": "after"}}}}
	c, _ := routedClaudeCore(t, http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	_, seed, err := c.prepareRoutedHistory([]byte(historyPayload("claude-sonnet-4-6", original, "", false)), "claude-sonnet-4-6")
	if err != nil {
		t.Fatal(err)
	}
	output := []any{map[string]string{"type": "function_call", "call_id": "media-source-call", "namespace": "pad", "name": "read", "arguments": "{}"}}
	commit, err := c.historyCompletion(context.Background(), seed)("media-source-anchor", output)
	if err != nil {
		t.Fatal(err)
	}
	commit()
	suffix := []any{map[string]any{"type": "function_call_output", "call_id": "media-source-call", "output": []any{map[string]string{"type": "input_text", "text": "tool-before"}, imagePart(inline), map[string]string{"type": "input_text", "text": "tool-after"}}}, map[string]string{"role": "user", "content": "target"}}
	raw := []byte(historyPayload("gpt-5.5", suffix, "media-source-anchor", false))
	body, _, err := c.prepareRoutedHistoryPolicy(raw, "gpt-5.5", true)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := buildChatPlan(body); err == nil {
		t.Fatal("media auto projection on provider switch")
	}
	p, _ := decodeObject(string(raw))
	p["momo_tool_images"] = "user-projection"
	raw, _ = json.Marshal(p)
	body, _, err = c.prepareRoutedHistoryPolicy(raw, "gpt-5.5", true)
	if err != nil {
		t.Fatal(err)
	}
	plan, err := buildChatPlan(body)
	if err != nil {
		t.Fatal(err)
	}
	wire, _ := decodeObject(string(plan.body))
	messages := wire["messages"].([]any)
	parts := obj(messages[0])["content"].([]any)
	if len(parts) != 3 || obj(parts[0])["text"] != "before" || obj(parts[2])["text"] != "after" {
		t.Fatal("historical media order")
	}
	if obj(obj(parts[1])["image_url"])["url"] != inline || obj(messages[2])["content"] != toolImageMarker("media-source-call") || !strings.Contains(string(plan.body), "tool-before") {
		t.Fatal("target media snapshot/projection lost")
	}
}

func TestProviderReplayPolicyDefaultsAndRejectedBoundaries(t *testing.T) {
	c, endpoint := routedClaudeCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		io.WriteString(w, chatSSE(choice(map[string]any{"content": "source-answer"}, "stop")))
	}))
	first := historyFinal(t, c, endpoint, historyPayload("gpt-5.5", []any{map[string]string{"role": "user", "content": "private-source"}}, "", false), false)
	payload := historyPayload("claude-sonnet-4-6", []any{map[string]string{"role": "user", "content": "target"}}, str(first["id"]), false)
	code, _, _ := request(t, c, endpoint, "/v1/responses", "POST", payload, nil)
	if code != 400 {
		t.Fatal("cross model became automatic")
	}
	for _, tc := range []struct{ path, payload, value string }{
		{"/v1/responses", payload, ""}, {"/v1/responses", payload, "unknown"}, {"/v1/responses", strings.Replace(payload, "claude-sonnet-4-6", "gpt-5.6-sol", 1), "replay-v1"}, {"/v1/responses/compact", payload, "replay-v1"}, {"/v1/chat/completions", `{"model":"gpt-5.5","messages":[{}]}`, "replay-v1"},
	} {
		code, _, _ := request(t, c, endpoint, tc.path, "POST", tc.payload, map[string]string{"X-MOMO-History": tc.value})
		if code != 400 {
			t.Fatal("policy boundary", code)
		}
	}
	req, _ := http.NewRequest("POST", endpoint+"/v1/responses", strings.NewReader(payload))
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Add("X-MOMO-History", "replay-v1")
	req.Header.Add("X-MOMO-History", "replay-v1")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 400 {
		t.Fatal("duplicate header")
	}
	c2, e2 := routedClaudeCore(t, http.HandlerFunc(func(http.ResponseWriter, *http.Request) { t.Error("foreign replay sent upstream") }))
	code, _, _ = request(t, c2, e2, "/v1/responses", "POST", payload, map[string]string{"X-MOMO-History": "replay-v1"})
	if code != 400 {
		t.Fatal("cross Core anchor accepted")
	}
	c.Stop()
	if c.Configure(Config{Endpoint: "https://mock.example", APIKey: syntheticKey}) != nil || c.Start() != nil {
		t.Fatal("default mode")
	}
	code, _, _ = request(t, c, endpoint, "/v1/responses", "POST", payload, map[string]string{"X-MOMO-History": "replay-v1"})
	if code != 400 {
		t.Fatal("passthrough policy accepted")
	}
}

func TestProviderReplayFailureDoesNotTouchOrConsumeSource(t *testing.T) {
	for _, mode := range []string{"bad-body", "unknown-tool", "signature", "expired", "overbudget", "short", "error", "flush", "cancel", "stop", "storefalse", "ok"} {
		t.Run(mode, func(t *testing.T) {
			c, _ := routedClaudeCore(t, http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
			original := []any{map[string]string{"role": "user", "content": "source"}}
			_, initial, err := c.prepareRoutedHistory([]byte(historyPayload("gpt-5.5", original, "", false)), "gpt-5.5")
			if err != nil {
				t.Fatal(err)
			}
			output := []any{map[string]any{"type": "message", "role": "assistant", "content": []any{map[string]string{"type": "output_text", "text": "source-answer"}}}, map[string]string{"type": "function_call", "call_id": "source-call", "name": "read", "namespace": "pad", "arguments": "{}"}}
			commit, err := c.historyCompletion(context.Background(), initial)("source-anchor", output)
			if err != nil {
				t.Fatal(err)
			}
			commit()
			commit, err = c.historyCompletion(context.Background(), initial)("other-anchor", output)
			if err != nil {
				t.Fatal(err)
			}
			commit()
			expires := c.history.entries["source-anchor"].expires
			suffix := []any{map[string]string{"type": "function_call_output", "call_id": "source-call", "output": "paired"}, map[string]string{"role": "user", "content": "target"}}
			p, _ := decodeObject(historyPayload("claude-sonnet-4-6", suffix, "source-anchor", false))
			switch mode {
			case "bad-body":
				p["unknown"] = true
			case "unknown-tool":
				p["tools"] = []any{}
			case "signature":
				p["input"] = append(suffix, map[string]string{"type": "reasoning", "encrypted_content": "opaque"})
			case "expired":
				entry := c.history.entries["source-anchor"]
				entry.expires = time.Now().Add(-time.Second)
				c.history.entries["source-anchor"] = entry
			case "overbudget":
				p["input"] = append(suffix, map[string]string{"role": "user", "content": strings.Repeat("x", MaxRequest)})
			case "storefalse":
				p["store"] = false
			}
			raw, _ := json.Marshal(p)
			body, seed, err := c.prepareRoutedHistoryPolicy(raw, "claude-sonnet-4-6", true)
			var plan *chatPlan
			if err == nil {
				plan, err = buildClaudePlan(body)
			}
			if includes([]string{"bad-body", "unknown-tool", "signature", "expired", "overbudget"}, mode) {
				if err == nil {
					t.Fatal("unsupported target accepted")
				}
				if mode != "expired" && !reflect.DeepEqual(c.history.order, []string{"source-anchor", "other-anchor"}) {
					t.Fatal("failed preflight touched source")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			plan.prepareCompletion = c.historyCompletion(ctx, seed)
			writer := &jsonProbeWriter{header: make(http.Header), mode: mode}
			if mode == "cancel" {
				cancel()
			}
			if mode == "stop" {
				c.Stop()
			}
			err = convertClaudeStream(ctx, writer, strings.NewReader(claudeStart()+claudeText(0, "target-answer")+claudeEnd("end_turn")), plan)
			if includes([]string{"short", "error", "flush"}, mode) && err == nil {
				t.Fatal("write failure accepted")
			}
			if mode == "ok" || mode == "storefalse" {
				if err != nil || len(c.history.order) != map[string]int{"ok": 3, "storefalse": 2}[mode] || c.history.order[1] != "source-anchor" {
					t.Fatal("success replay transaction")
				}
				if !c.history.entries["source-anchor"].expires.Equal(expires) {
					t.Fatal("source TTL renewed")
				}
			} else if mode != "stop" {
				if !reflect.DeepEqual(c.history.order, []string{"source-anchor", "other-anchor"}) || len(c.history.entries) != 2 {
					t.Fatal("failed target consumed/touched source")
				}
			}
		})
	}
}
