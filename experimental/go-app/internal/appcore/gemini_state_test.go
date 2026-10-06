package appcore

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestGeminiSignedOrderedPartsSuffixAndFullReplay(t *testing.T) {
	for _, stream := range []bool{true, false} {
		t.Run(map[bool]string{true: "SSE", false: "JSON"}[stream], func(t *testing.T) {
			model := "gemini-3.1-pro-preview"
			sig := base64.StdEncoding.EncodeToString([]byte("opaque synthetic signed state 中文"))
			parts := []any{
				map[string]any{"text": " public summary \r\n", "thought": true, "thoughtSignature": sig},
				map[string]any{"text": "before", "thoughtSignature": sig, "thought": false},
				map[string]any{"functionCall": map[string]any{"id": "signed_read", "name": "pad__read", "args": map[string]any{"n": 1}}, "thoughtSignature": sig},
				map[string]any{"text": "between"},
				map[string]any{"functionCall": map[string]any{"id": "signed_write", "name": "pad__write", "args": map[string]any{"input": " raw \r\n"}}, "thoughtSignature": sig, "thought": false},
				map[string]any{"text": "", "thoughtSignature": sig},
			}
			var mu sync.Mutex
			var captures []map[string]any
			c, endpoint := routedClaudeCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				b, _ := io.ReadAll(r.Body)
				p, _ := decodeVideoObject(b)
				mu.Lock()
				captures = append(captures, p)
				n := len(captures)
				mu.Unlock()
				w.Header().Set("Content-Type", "text/event-stream")
				if n == 1 {
					io.WriteString(w, geminiFrame(parts, "STOP", geminiUsageFixture()))
				} else {
					io.WriteString(w, geminiFrame([]any{geminiText("finished")}, "STOP", geminiUsageFixture()))
				}
			}))
			input := []any{map[string]any{"role": "user", "content": "CURRENT"}}
			p := historyPayload(model, input, "", stream)
			first := historyFinal(t, c, endpoint, p, stream)
			output := first["output"].([]any)
			if len(output) != 6 || obj(output[0])["type"] != "reasoning" || !strings.Contains(string(mustJSON(output)), sig) {
				t.Fatal("signed parts/order not preserved")
			}
			suffix := []any{map[string]any{"type": "custom_tool_call_output", "call_id": "signed_write", "output": "write result"}, map[string]any{"type": "function_call_output", "call_id": "signed_read", "output": "read result"}, map[string]any{"role": "user", "content": "next"}}
			historyFinal(t, c, endpoint, historyPayload(model, suffix, str(first["id"]), stream), stream)
			full := append(append(append([]any{}, input...), output...), suffix...)
			historyFinal(t, c, endpoint, historyPayload(model, full, str(first["id"]), stream), stream)
			mu.Lock()
			saved := append([]map[string]any{}, captures...)
			mu.Unlock()
			if len(saved) != 3 || !reflect.DeepEqual(saved[1], saved[2]) {
				t.Fatal("suffix/full signed replay mismatch")
			}
			contents := saved[1]["contents"].([]any)
			wantRaw, _ := decodeObject(`{"parts":` + string(mustJSON(parts)) + `}`)
			if !reflect.DeepEqual(obj(contents[1])["parts"], wantRaw["parts"]) {
				t.Fatal("signed native part bytes/order changed", string(mustJSON(obj(contents[1])["parts"])))
			}
			for _, target := range []string{"gpt-5.5", "claude-sonnet-4-6", "gemini-3-flash-preview"} {
				code, _, _ := request(t, c, endpoint, "/v1/responses", "POST", historyPayload(target, suffix, str(first["id"]), false), map[string]string{"X-MOMO-History": "replay-v1"})
				if code != 400 {
					t.Fatal("signed cross model allowed", target, code)
				}
				code, _, _ = request(t, c, endpoint, "/v1/responses", "POST", historyPayload(target, full, "", false), nil)
				if code != 400 {
					t.Fatal("signed full transcript cross model allowed", target, code)
				}
			}
			mu.Lock()
			defer mu.Unlock()
			if len(captures) != 3 {
				t.Fatal("rejected cross-model context sent upstream")
			}
		})
	}
}

func mustJSON(v any) []byte { b, _ := json.Marshal(v); return b }

func TestGeminiSignedCallWithoutNativeIDPreservesAbsence(t *testing.T) {
	model := "gemini-2.5-flash"
	sig := base64.StdEncoding.EncodeToString([]byte("synthetic-state"))
	for _, custom := range []bool{false, true} {
		name, args := "pad__read", map[string]any{"n": 1}
		if custom {
			name, args = "pad__write", map[string]any{"input": "exact\r\n"}
		}
		native := map[string]any{"functionCall": map[string]any{"name": name, "args": args}, "thoughtSignature": sig}
		var mu sync.Mutex
		var captures []map[string]any
		c, endpoint := routedClaudeCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			b, _ := io.ReadAll(r.Body)
			p, _ := decodeVideoObject(b)
			mu.Lock()
			captures = append(captures, p)
			n := len(captures)
			mu.Unlock()
			w.Header().Set("Content-Type", "text/event-stream")
			if n == 1 {
				io.WriteString(w, geminiFrame([]any{native}, "STOP", geminiUsageFixture()))
			} else {
				io.WriteString(w, goodGeminiSSE())
			}
		}))
		first := historyFinal(t, c, endpoint, historyPayload(model, []any{map[string]any{"role": "user", "content": "first"}}, "", false), false)
		call := obj(first["output"].([]any)[0])
		if !strings.HasPrefix(str(call["call_id"]), "call_") || obj(call["momo_gemini"])["call_id_absent"] != true {
			t.Fatal("absent native ID not represented")
		}
		outputType := "function_call_output"
		if custom {
			outputType = "custom_tool_call_output"
		}
		historyFinal(t, c, endpoint, historyPayload(model, []any{map[string]any{"type": outputType, "call_id": call["call_id"], "output": "result"}}, str(first["id"]), false), false)
		mu.Lock()
		saved := append([]map[string]any{}, captures...)
		mu.Unlock()
		contents := saved[1]["contents"].([]any)
		want, _ := decodeObject(string(mustJSON(native)))
		if !reflect.DeepEqual(obj(contents[1])["parts"], []any{want}) {
			t.Fatal("fabricated native call ID changes signed Part")
		}
		result := obj(obj(contents[2])["parts"].([]any)[0])
		if _, exists := obj(result["functionResponse"])["id"]; exists {
			t.Fatal("fabricated native result ID")
		}
	}
}

func TestGeminiStateMalformedHistoryRejectedBeforeSend(t *testing.T) {
	model := "gemini-3.1-pro-preview"
	sig := base64.StdEncoding.EncodeToString([]byte("synthetic-state"))
	c, endpoint := routedClaudeCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { t.Error("invalid state sent upstream") }))
	for name, metadata := range map[string]any{
		"null": nil, "scalar": sig, "wrongModel": map[string]any{"model": "gemini-2.5-flash", "thought_signature": sig},
		"unknown":           map[string]any{"model": model, "thought_signature": sig, "verified": true},
		"wrongType":         map[string]any{"model": model, "thought_signature": 123},
		"whitespace":        map[string]any{"model": model, "thought_signature": sig + "\n"},
		"nonCanonical":      map[string]any{"model": model, "thought_signature": "Zh=="},
		"empty":             map[string]any{"model": model, "thought_signature": ""},
		"missingSignature":  map[string]any{"model": model},
		"absentFalse":       map[string]any{"model": model, "thought_signature": sig, "call_id_absent": false},
		"absentType":        map[string]any{"model": model, "thought_signature": sig, "call_id_absent": "true"},
		"thoughtFalseFalse": map[string]any{"model": model, "thought_signature": sig, "thought_false": false},
		"oversize":          map[string]any{"model": model, "thought_signature": strings.Repeat("YQ==", (256<<10)/4+1)},
	} {
		for _, kind := range []string{"text", "function", "custom"} {
			t.Run(name+"/"+kind, func(t *testing.T) {
				var state any = map[string]any{"role": "assistant", "content": []any{map[string]any{"type": "output_text", "text": "signed", "momo_gemini": metadata}}}
				input := []any{map[string]any{"role": "user", "content": "first"}, state}
				if kind != "text" {
					call := map[string]any{"type": "function_call", "name": "read", "namespace": "pad", "call_id": "signed", "arguments": "{}", "momo_gemini": metadata}
					outputType := "function_call_output"
					if kind == "custom" {
						call["type"], call["name"], call["input"] = "custom_tool_call", "write", "exact\r\n"
						delete(call, "arguments")
						outputType = "custom_tool_call_output"
					}
					input[1] = call
					input = append(input, map[string]any{"type": outputType, "call_id": "signed", "output": "result"})
				}
				input = append(input, map[string]any{"role": "user", "content": "next"})
				code, _, _ := request(t, c, endpoint, "/v1/responses", "POST", historyPayload(model, input, "", false), nil)
				if code != 400 {
					t.Fatal("invalid metadata accepted", code)
				}
			})
		}
	}
	// Duplicate metadata/escaped keys must fail before normalization erases them.
	p := historyPayload(model, []any{map[string]any{"role": "user", "content": "first"}, map[string]any{"role": "assistant", "content": []any{map[string]any{"type": "output_text", "text": "signed", "momo_gemini": map[string]any{"model": model, "thought_signature": sig}}}}, map[string]any{"role": "user", "content": "next"}}, "", false)
	for _, bad := range []string{strings.Replace(p, `"thought_signature":`, `"thought\u005fsignature":"YQ==","thought_signature":`, 1), strings.Replace(p, "signed", string([]byte{0xff}), 1)} {
		code, _, _ := request(t, c, endpoint, "/v1/responses", "POST", bad, nil)
		if code != 400 {
			t.Fatal("invalid raw state accepted", code)
		}
	}
}

func TestGeminiPublicSummaryEventsAndSignedHistoryTransactions(t *testing.T) {
	model := "gemini-3.1-pro-preview"
	sig := base64.StdEncoding.EncodeToString([]byte("synthetic-state"))
	parts := []any{map[string]any{"text": "public summary\r\n", "thought": true}, map[string]any{"text": "answer", "thoughtSignature": sig}, map[string]any{"text": "", "thoughtSignature": sig}}
	good := geminiFrame(parts, "STOP", geminiUsageFixture())
	for _, tc := range []struct {
		name, wire string
		store      bool
		success    bool
	}{
		{"success", good, true, true}, {"storeFalse", good, false, true}, {"incomplete", strings.Replace(good, "STOP", "MAX_TOKENS", 1), true, true},
		{"missingUsage", geminiFrame(parts, "STOP", nil), true, false}, {"lateError", good + "data: {\"error\":{}}\n\n", true, false}, {"truncated", strings.TrimSuffix(good, "\r\n\r\n"), true, false},
	} {
		for _, streaming := range []bool{true, false} {
			t.Run(tc.name+map[bool]string{true: "/SSE", false: "/JSON"}[streaming], func(t *testing.T) {
				c, endpoint := routedClaudeCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					w.Header().Set("Content-Type", "text/event-stream")
					io.WriteString(w, tc.wire)
				}))
				p, _ := decodeObject(historyPayload(model, []any{map[string]any{"role": "user", "content": "first"}}, "", streaming))
				p["store"] = tc.store
				req, _ := http.NewRequest("POST", endpoint+"/v1/responses", strings.NewReader(string(mustJSON(p))))
				req.Header.Set("Authorization", "Bearer "+c.token)
				req.Header.Set("Content-Type", "application/json")
				resp, err := http.DefaultClient.Do(req)
				if err != nil {
					t.Fatal(err)
				}
				b, readErr := io.ReadAll(resp.Body)
				resp.Body.Close()
				if tc.success && (resp.StatusCode != 200 || readErr != nil) {
					t.Fatal("valid response failed", resp.StatusCode, readErr)
				}
				if !tc.success && strings.Contains(string(b), "response.completed") {
					t.Fatal("failed stream completed")
				}
				if tc.success && streaming {
					delta := false
					for _, line := range strings.Split(string(b), "\n") {
						if !strings.HasPrefix(line, "data: ") {
							continue
						}
						event, _ := decodeObject(strings.TrimPrefix(line, "data: "))
						if event["type"] == "response.reasoning_summary_text.delta" && event["delta"] == "public summary\r\n" {
							delta = true
						}
						if event["type"] == "response.output_text.delta" && strings.Contains(str(event["delta"]), "summary") {
							t.Fatal("summary leaked as answer")
						}
					}
					if !delta {
						t.Fatal("no public summary SSE event")
					}
				}
				deadline := time.Now().Add(time.Second)
				for c.State().Active != 0 && time.Now().Before(deadline) {
					time.Sleep(time.Millisecond)
				}
				c.mu.Lock()
				count := len(c.history.entries)
				c.mu.Unlock()
				want := 0
				if tc.name == "success" {
					want = 1
				}
				if count != want {
					t.Fatal("history transaction", count, want)
				}
			})
		}
	}
	// Signed state uses the same success-only local terminal-write transaction.
	for _, mode := range []string{"short", "error", "flush", "ok"} {
		c, _ := routedClaudeCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
		_, seed, err := c.prepareRoutedHistory([]byte(historyPayload(model, []any{map[string]any{"role": "user", "content": "first"}}, "", false)), model)
		if err != nil {
			t.Fatal(err)
		}
		w := &jsonProbeWriter{header: make(http.Header), mode: mode}
		plan := &chatPlan{model: model, prepareCompletion: c.historyCompletion(context.Background(), seed)}
		err = convertGeminiStream(context.Background(), w, strings.NewReader(good), plan)
		if mode == "ok" {
			if err != nil || len(c.history.entries) != 1 {
				t.Fatal("success not stored")
			}
		} else if err == nil || len(c.history.entries) != 0 {
			t.Fatal("failed write stored")
		}
	}
}

func TestGeminiCheckpointProtectsStateBearingWholeTurn(t *testing.T) {
	model := "gemini-3.1-pro-preview"
	sig := base64.StdEncoding.EncodeToString([]byte("synthetic-state"))
	input := []any{map[string]any{"role": "user", "content": "old"}, map[string]any{"role": "assistant", "content": strings.Repeat("ordinary", 200)}, map[string]any{"role": "user", "content": "signed turn"}, map[string]any{"type": "reasoning", "summary": []any{map[string]any{"type": "summary_text", "text": "public"}}, "momo_gemini": map[string]any{"model": model}}, map[string]any{"role": "assistant", "content": []any{map[string]any{"type": "output_text", "text": "signed", "momo_gemini": map[string]any{"model": model, "thought_signature": sig}}}}, map[string]any{"role": "assistant", "content": strings.Repeat("interpretation", 200)}, map[string]any{"role": "user", "content": "recent"}, map[string]any{"role": "assistant", "content": "latest"}, map[string]any{"role": "user", "content": "current"}}
	p, _ := decodeObject(historyPayload(model, input, "", false))
	b := mustJSON(p)
	result, err := buildLocalCheckpoint(b)
	if err != nil {
		t.Fatal(err)
	}
	var output []any
	json.Unmarshal(mustJSON(result["output"]), &output)
	if !strings.Contains(string(mustJSON(output[1])), checkpointPrefix) {
		t.Fatal("ordinary history not omitted")
	}
	for i := 2; i < len(input); i++ {
		if !reflect.DeepEqual(output[i], input[i]) {
			t.Fatal("state-bearing turn changed", i)
		}
	}
	p["input"] = output
	if _, err := buildGeminiPlan(mustJSON(p)); err != nil {
		t.Fatal("checkpoint not replayable", err)
	}
}

func TestGeminiEmptyPartAndMetadataRetentionBound(t *testing.T) {
	model := "gemini-3.1-pro-preview"
	frame := geminiFrame([]any{map[string]any{"text": "", "thought": true}}, "", nil)
	for _, streaming := range []bool{false, true} {
		w := &jsonProbeWriter{header: make(http.Header), mode: "ok"}
		plan := &chatPlan{model: model, stream: streaming}
		err := convertGeminiStream(context.Background(), w, strings.NewReader(strings.Repeat(frame, maxHistoryItems+1)+geminiFrame(nil, "STOP", geminiUsageFixture())), plan)
		if err == nil {
			t.Fatal("unbounded empty summary accepted")
		}
	}
	for _, content := range []any{"plain", []any{map[string]any{"type": "output_text", "text": "a"}, map[string]any{"type": "output_text", "text": "b"}}} {
		a, parts, err := geminiAssistantParts(content, model)
		b, want, werr := messageParts(content, "assistant", model, &imageBudget{})
		if err != werr || a != b || !reflect.DeepEqual(parts, want) {
			t.Fatal("ordinary assistant semantics changed")
		}
	}
}

func TestGeminiSignedMalformedStreamsNeverStore(t *testing.T) {
	sig := base64.StdEncoding.EncodeToString([]byte("synthetic-state"))
	valid := map[string]any{"text": "signed", "thoughtSignature": sig}
	good := geminiFrame([]any{valid}, "STOP", geminiUsageFixture())
	for name, wire := range map[string]string{
		"signatureOnly":      geminiFrame([]any{map[string]any{"thoughtSignature": sig}}, "STOP", geminiUsageFixture()),
		"thoughtCall":        geminiFrame([]any{map[string]any{"functionCall": map[string]any{"id": "a", "name": "pad__read", "args": map[string]any{}}, "thought": true, "thoughtSignature": sig}}, "STOP", geminiUsageFixture()),
		"signatureNull":      strings.Replace(good, string(mustJSON(sig)), "null", 1),
		"duplicateSignature": strings.Replace(good, `"thoughtSignature":`, `"thoughtSignature":"YQ==","thoughtSignature":`, 1),
		"escapedDuplicate":   strings.Replace(good, `"thoughtSignature":`, `"thought\u0053ignature":"YQ==","thoughtSignature":`, 1),
		"invalidUTF8":        strings.Replace(good, "signed", string([]byte{0xff}), 1),
		"mixedPart":          geminiFrame([]any{map[string]any{"text": "signed", "functionCall": map[string]any{}, "thoughtSignature": sig}}, "STOP", geminiUsageFixture()),
		"unknownPart":        geminiFrame([]any{map[string]any{"text": "signed", "thoughtSignature": sig, "unknown": true}}, "STOP", geminiUsageFixture()),
	} {
		for _, stream := range []bool{false, true} {
			t.Run(name+map[bool]string{true: "/SSE", false: "/JSON"}[stream], func(t *testing.T) {
				c, endpoint := routedClaudeCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					w.Header().Set("Content-Type", "text/event-stream")
					io.WriteString(w, wire)
				}))
				req, _ := http.NewRequest("POST", endpoint+"/v1/responses", strings.NewReader(historyPayload("gemini-3.1-pro-preview", []any{map[string]any{"role": "user", "content": "first"}}, "", stream)))
				req.Header.Set("Authorization", "Bearer "+c.token)
				req.Header.Set("Content-Type", "application/json")
				resp, err := http.DefaultClient.Do(req)
				if err != nil {
					t.Fatal(err)
				}
				b, _ := io.ReadAll(resp.Body)
				resp.Body.Close()
				if strings.Contains(string(b), "response.completed") || strings.Contains(string(b), `"status":"completed"`) {
					t.Fatal("malformed signed state completed")
				}
				c.mu.Lock()
				count := len(c.history.entries)
				c.mu.Unlock()
				if count != 0 {
					t.Fatal("malformed signed state stored")
				}
			})
		}
	}
}

func TestGeminiSignedStopAndCancelledCompletionNeverStore(t *testing.T) {
	model := "gemini-3.1-pro-preview"
	sig := base64.StdEncoding.EncodeToString([]byte("synthetic-state"))
	entered, cancelled := make(chan struct{}), make(chan struct{})
	c, endpoint := routedClaudeCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		io.WriteString(w, geminiFrame([]any{map[string]any{"text": "signed partial", "thoughtSignature": sig}}, "", nil))
		w.(http.Flusher).Flush()
		close(entered)
		<-r.Context().Done()
		close(cancelled)
	}))
	req, _ := http.NewRequest("POST", endpoint+"/v1/responses", strings.NewReader(historyPayload(model, []any{map[string]any{"role": "user", "content": "first"}}, "", true)))
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("Content-Type", "application/json")
	client := http.Client{Timeout: 3 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	<-entered
	c.Stop()
	b, err := io.ReadAll(resp.Body)
	if err == nil || strings.Contains(string(b), "response.completed") {
		t.Fatal("Stop fabricated completion")
	}
	select {
	case <-cancelled:
	case <-time.After(time.Second):
		t.Fatal("signed upstream not cancelled")
	}
	c.mu.Lock()
	count := len(c.history.entries)
	c.mu.Unlock()
	if count != 0 {
		t.Fatal("Stop stored signed state")
	}
	// A late prepared callback after cancellation also cannot resurrect the store.
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	seed := &historySeed{model: model, store: true, generation: c.history.generation, input: []json.RawMessage{json.RawMessage(`{"role":"user","content":"first"}`)}}
	commit, err := c.historyCompletion(ctx, seed)("late-signed", []any{map[string]any{"type": "reasoning", "summary": []any{map[string]any{"type": "summary_text", "text": "public"}}, "momo_gemini": map[string]any{"model": model, "thought_signature": sig}}})
	if err != nil {
		t.Fatal(err)
	}
	commit()
	if len(c.history.entries) != 0 {
		t.Fatal("cancelled signed callback stored")
	}
}
