package appcore

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func historyPayload(model string, input []any, previous string, stream bool) string {
	p := map[string]any{"model": model, "input": input, "stream": stream, "tools": []any{map[string]any{"type": "namespace", "name": "pad", "tools": []any{map[string]any{"type": "function", "name": "read"}, map[string]any{"type": "custom", "name": "write"}}}}}
	if previous != "" {
		p["previous_response_id"] = previous
	}
	b, _ := json.Marshal(p)
	return string(b)
}
func historyFinal(t *testing.T, c *Core, endpoint, payload string, stream bool) map[string]any {
	t.Helper()
	code, b, _ := request(t, c, endpoint, "/v1/responses", "POST", payload, nil)
	if code != 200 {
		t.Fatal("history request", code)
	}
	if stream {
		return responseCompletion(t, b)
	}
	p, err := decodeObject(string(b))
	if err != nil || p["status"] != "completed" {
		t.Fatal("history JSON")
	}
	return p
}
func TestRoutedHistoryTextSuffixAndFullReplay(t *testing.T) {
	for _, tc := range []struct{ model, path, upstream string }{{"gpt-5.5", "/v1/chat/completions", chatSSE(choice(map[string]any{"content": "hello"}, "stop"))}, {"claude-sonnet-4-6", "/v1/messages", claudeStart() + claudeText(0, "hello") + claudeEnd("end_turn")}, {"gemini-2.5-flash", geminiPath, geminiFrame([]any{geminiText("hello")}, "STOP", geminiUsageFixture())}} {
		for _, stream := range []bool{true, false} {
			t.Run(fmt.Sprint(tc.model, "/", stream), func(t *testing.T) {
				var mu sync.Mutex
				var captures []string
				c, endpoint := routedClaudeCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					b, _ := io.ReadAll(r.Body)
					if r.URL.Path != tc.path || strings.Contains(string(b), "previous_response_id") || strings.Contains(string(b), `"store"`) {
						t.Error("history leaked upstream")
					}
					mu.Lock()
					captures = append(captures, string(b))
					mu.Unlock()
					w.Header().Set("Content-Type", "text/event-stream")
					fmt.Fprint(w, tc.upstream)
				}))
				initial := []any{map[string]string{"role": "user", "content": "first"}}
				final := historyFinal(t, c, endpoint, historyPayload(tc.model, initial, "", stream), stream)
				id := str(final["id"])
				suffix := []any{map[string]string{"role": "user", "content": "second"}}
				next := historyFinal(t, c, endpoint, historyPayload(tc.model, suffix, id, stream), stream)
				full := append(append([]any{}, initial...), final["output"].([]any)...)
				full = append(full, suffix...)
				historyFinal(t, c, endpoint, historyPayload(tc.model, full, id, stream), stream)
				third := []any{map[string]string{"role": "user", "content": "third"}}
				historyFinal(t, c, endpoint, historyPayload(tc.model, third, str(next["id"]), stream), stream)
				mu.Lock()
				defer mu.Unlock()
				if len(captures) != 4 || captures[1] != captures[2] || strings.Count(captures[1], "first") != 1 || strings.Count(captures[1], "second") != 1 || strings.Count(captures[3], "first") != 1 || strings.Count(captures[3], "second") != 1 || strings.Count(captures[3], "third") != 1 {
					t.Fatal("suffix/full replay duplicated or lost history")
				}
				c.mu.Lock()
				defer c.mu.Unlock()
				if len(c.history.entries) != 4 || c.history.bytes == 0 {
					t.Fatal("completed history not stored")
				}
			})
		}
	}
}
func TestRoutedHistoryParallelToolsAndBranching(t *testing.T) {
	for _, tc := range []struct{ model, upstream string }{{"gpt-5.5", goodChatSSE()}, {"claude-sonnet-4-6", goodClaudeSSE()}, {"gemini-2.5-flash", goodGeminiSSE()}} {
		t.Run(tc.model, func(t *testing.T) {
			var sends atomic.Int32
			var mu sync.Mutex
			var captured []string
			c, endpoint := routedClaudeCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				n := sends.Add(1)
				b, _ := io.ReadAll(r.Body)
				if n > 1 {
					mu.Lock()
					captured = append(captured, string(b))
					mu.Unlock()
				}
				w.Header().Set("Content-Type", "text/event-stream")
				if n == 1 {
					fmt.Fprint(w, tc.upstream)
				} else {
					switch tc.model {
					case "gpt-5.5":
						fmt.Fprint(w, chatSSE(choice(map[string]any{"content": "done"}, "stop")))
					case "claude-sonnet-4-6":
						fmt.Fprint(w, claudeStart()+claudeText(0, "done")+claudeEnd("end_turn"))
					default:
						fmt.Fprint(w, geminiFrame([]any{geminiText("done")}, "STOP", geminiUsageFixture()))
					}
				}
			}))
			first := historyFinal(t, c, endpoint, historyPayload(tc.model, []any{map[string]string{"role": "user", "content": "first"}}, "", false), false)
			results := []any{}
			for _, v := range first["output"].([]any) {
				call := obj(v)
				if call["type"] == "function_call" {
					results = append(results, map[string]any{"type": "function_call_output", "call_id": call["call_id"], "output": "read-result"})
				}
				if call["type"] == "custom_tool_call" {
					results = append(results, map[string]any{"type": "custom_tool_call_output", "call_id": call["call_id"], "output": "write-result"})
				}
			}
			if len(results) != 2 {
				t.Fatal("parallel calls")
			}
			results[0], results[1] = results[1], results[0]
			results = append(results, map[string]string{"role": "user", "content": "continue"})
			// A known anchor is immutable; independent branches do not consume it.
			for i := 0; i < 2; i++ {
				historyFinal(t, c, endpoint, historyPayload(tc.model, results, str(first["id"]), false), false)
			}
			if sends.Load() != 3 {
				t.Fatal("duplicate send")
			}
			mu.Lock()
			defer mu.Unlock()
			if captured[0] != captured[1] || !strings.Contains(captured[0], "pad__read") || !strings.Contains(captured[0], "pad__write") || !strings.Contains(captured[0], "read-result") || !strings.Contains(captured[0], "write-result") {
				t.Fatal("paired aliases/results")
			}
			if tc.model != "gpt-5.5" {
				p, err := decodeObject(captured[0])
				if err != nil {
					t.Fatal(err)
				}
				var parts []any
				if tc.model == "claude-sonnet-4-6" {
					parts = obj(p["messages"].([]any)[1])["content"].([]any)
				} else {
					parts = obj(p["contents"].([]any)[1])["parts"].([]any)
				}
				if len(parts) != 4 || obj(parts[0])["text"] != "中文🙂" || obj(parts[2])["text"] != "after" {
					t.Fatal("assistant block order lost in actual continuation request")
				}
				if tc.model == "claude-sonnet-4-6" {
					if obj(parts[1])["name"] != "pad__read" || obj(parts[3])["name"] != "pad__write" {
						t.Fatal("Claude ordered calls")
					}
				} else if obj(obj(parts[1])["functionCall"])["name"] != "pad__read" || obj(obj(parts[3])["functionCall"])["name"] != "pad__write" {
					t.Fatal("Gemini ordered calls")
				}
			}
		})
	}
}
func TestRoutedHistoryPrivacyLifetimeAndStoreFalse(t *testing.T) {
	var sends atomic.Int32
	c, endpoint := routedClaudeCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sends.Add(1)
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, chatSSE(choice(map[string]any{"content": "private-history-text"}, "stop")))
	}))
	payload := historyPayload("gpt-5.5", []any{map[string]string{"role": "user", "content": "private-prompt"}}, "", false)
	final := historyFinal(t, c, endpoint, payload, false)
	id := str(final["id"])
	c2, e2 := routedClaudeCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { t.Error("foreign history sent") }))
	suffix := []any{map[string]string{"role": "user", "content": "next"}}
	code, b, _ := request(t, c2, e2, "/v1/responses", "POST", historyPayload("gpt-5.5", suffix, id, false), nil)
	if code != 400 || strings.Contains(string(b), "private-") {
		t.Fatal("foreign anchor")
	}
	code, _, _ = request(t, c, endpoint, "/v1/responses", "POST", historyPayload("claude-sonnet-4-6", suffix, id, false), nil)
	if code != 400 || sends.Load() != 1 {
		t.Fatal("model scope")
	}
	p, _ := decodeObject(payload)
	p["store"] = false
	raw, _ := json.Marshal(p)
	unstored := historyFinal(t, c, endpoint, string(raw), false)
	code, _, _ = request(t, c, endpoint, "/v1/responses", "POST", historyPayload("gpt-5.5", suffix, str(unstored["id"]), false), nil)
	if code != 400 {
		t.Fatal("store false anchor")
	}
	c.mu.Lock()
	entry := c.history.entries[id]
	entry.expires = time.Now().Add(-time.Second)
	c.history.entries[id] = entry
	c.mu.Unlock()
	code, _, _ = request(t, c, endpoint, "/v1/responses", "POST", historyPayload("gpt-5.5", suffix, id, false), nil)
	if code != 400 {
		t.Fatal("expired anchor")
	}
	final = historyFinal(t, c, endpoint, payload, false)
	c.Stop()
	if c.Start() != nil {
		t.Fatal("start")
	}
	code, _, _ = request(t, c, endpoint, "/v1/responses", "POST", historyPayload("gpt-5.5", suffix, str(final["id"]), false), nil)
	if code != 400 {
		t.Fatal("Stop retained history")
	}
	exported, _ := json.Marshal(c.State())
	if strings.Contains(string(exported), "private-") || strings.Contains(c.ConnectionJSON(), "private-") {
		t.Fatal("history export")
	}
}
func TestRoutedHistoryBudgetsAndGeneration(t *testing.T) {
	c, _ := routedClaudeCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	seed := &historySeed{model: "gpt-5.5", input: []json.RawMessage{json.RawMessage(`{"role":"user","content":"hi"}`)}, generation: c.history.generation, store: true}
	output := []any{map[string]any{"type": "message", "role": "assistant", "status": "completed", "id": "msg_mock", "content": []any{map[string]string{"type": "output_text", "text": "done"}}}}
	for i := 0; i < maxHistoryEntries+1; i++ {
		commit, err := c.historyCompletion(context.Background(), seed)(fmt.Sprint(i), output)
		if err != nil {
			t.Fatal(err)
		}
		commit()
	}
	if len(c.history.entries) != maxHistoryEntries || c.history.entries["0"].model != "" {
		t.Fatal("LRU count")
	}
	commit, err := c.historyCompletion(context.Background(), seed)("late", output)
	if err != nil {
		t.Fatal(err)
	}
	c.Stop()
	c.Start()
	commit()
	if len(c.history.entries) != 0 || c.history.bytes != 0 {
		t.Fatal("late generation commit")
	}
	seed.generation = c.history.generation
	output[0].(map[string]any)["content"] = []any{map[string]string{"type": "output_text", "text": strings.Repeat("a", 200000)}}
	for i := 0; i < 60; i++ {
		commit, err := c.historyCompletion(context.Background(), seed)(fmt.Sprint(i), output)
		if err != nil {
			t.Fatal(err)
		}
		commit()
	}
	if c.history.bytes > maxHistoryBytes || len(c.history.entries) >= 60 {
		t.Fatal("global history bytes")
	}
	output[0].(map[string]any)["content"] = []any{map[string]string{"type": "output_text", "text": strings.Repeat("a", MaxRequest)}}
	if _, err := c.historyCompletion(context.Background(), seed)("big", output); err == nil {
		t.Fatal("oversized transcript")
	}
}
func TestRoutedHistoryFailureDoesNotCommit(t *testing.T) {
	for _, stream := range []bool{true, false} {
		c, endpoint := routedClaudeCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "text/event-stream")
			fmt.Fprint(w, "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"private-partial\"},\"finish_reason\":\"stop\"}]}\n\n")
		}))
		req, _ := http.NewRequest("POST", endpoint+"/v1/responses", strings.NewReader(historyPayload("gpt-5.5", []any{map[string]string{"role": "user", "content": "hi"}}, "", stream)))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer "+c.token)
		resp, err := http.DefaultClient.Do(req)
		if err == nil {
			io.Copy(io.Discard, resp.Body)
			resp.Body.Close()
		}
		deadline := time.Now().Add(time.Second)
		for c.State().Active != 0 && time.Now().Before(deadline) {
			time.Sleep(time.Millisecond)
		}
		c.mu.Lock()
		if len(c.history.entries) != 0 || c.history.bytes != 0 {
			t.Fatal("failed stream committed")
		}
		c.mu.Unlock()
	}
	// Short/failed final JSON writes never mint anchors; no replacement 502 after write.
	for _, mode := range []string{"short", "error", "flush", "ok"} {
		c, _ := routedClaudeCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
		_, seed, err := c.prepareRoutedHistory([]byte(historyPayload("gpt-5.5", []any{map[string]string{"role": "user", "content": "hi"}}, "", false)), "gpt-5.5")
		if err != nil {
			t.Fatal(err)
		}
		w := &jsonProbeWriter{header: make(http.Header), mode: mode}
		p := &chatPlan{model: "gpt-5.5", prepareCompletion: c.historyCompletion(context.Background(), seed)}
		e, err := newRoutedResponseWriter(w, p)
		if err != nil {
			t.Fatal(err)
		}
		e.accept(streamEvent{kind: "text", text: "done"}, p)
		err = e.accept(streamEvent{kind: "complete"}, p)
		if mode == "ok" {
			if err != nil || len(c.history.entries) != 1 {
				t.Fatal("successful write not committed")
			}
		} else {
			if err == nil || len(c.history.entries) != 0 {
				t.Fatal("failed write committed")
			}
		}
	}
}
func TestRoutedHistoryConcurrentBranches(t *testing.T) {
	c, endpoint := routedClaudeCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, chatSSE(choice(map[string]any{"content": "done"}, "stop")))
	}))
	first := historyFinal(t, c, endpoint, historyPayload("gpt-5.5", []any{map[string]string{"role": "user", "content": "hi"}}, "", false), false)
	var wg sync.WaitGroup
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			historyFinal(t, c, endpoint, historyPayload("gpt-5.5", []any{map[string]string{"role": "user", "content": fmt.Sprint(i)}}, str(first["id"]), false), false)
		}(i)
	}
	wg.Wait()
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.history.entries) != 5 {
		t.Fatal("branch isolation")
	}
}

func TestRoutedHistoryStoreFalseContinuesExistingAnchor(t *testing.T) {
	var sends atomic.Int32
	c, endpoint := routedClaudeCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		if sends.Add(1) == 2 && (!strings.Contains(string(b), "original-turn") || !strings.Contains(string(b), "next-turn")) {
			t.Error("store false did not replay existing anchor")
		}
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, chatSSE(choice(map[string]any{"content": "answer"}, "stop")))
	}))
	first := historyFinal(t, c, endpoint, historyPayload("gpt-5.5", []any{map[string]string{"role": "user", "content": "original-turn"}}, "", false), false)
	p, _ := decodeObject(historyPayload("gpt-5.5", []any{map[string]string{"role": "user", "content": "next-turn"}}, str(first["id"]), false))
	p["store"] = false
	raw, _ := json.Marshal(p)
	next := historyFinal(t, c, endpoint, string(raw), false)
	c.mu.Lock()
	_, old := c.history.entries[str(first["id"])]
	_, added := c.history.entries[str(next["id"])]
	count := len(c.history.entries)
	c.mu.Unlock()
	if !old || added || count != 1 || sends.Load() != 2 {
		t.Fatal("store false consumed old or minted new anchor")
	}
}

func TestRoutedHistoryMalformedMetadataBeforeUpstream(t *testing.T) {
	c, endpoint := routedClaudeCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { t.Error("invalid metadata sent upstream") }))
	base, _ := decodeObject(historyPayload("gpt-5.5", []any{map[string]string{"role": "user", "content": "hi"}}, "", false))
	for field, values := range map[string][]any{
		"store":                {nil, "false", 0, []any{}},
		"previous_response_id": {nil, "", 1, strings.Repeat("a", 129)},
	} {
		for _, value := range values {
			base[field] = value
			raw, _ := json.Marshal(base)
			code, b, _ := request(t, c, endpoint, "/v1/responses", "POST", string(raw), nil)
			if code != 400 || len(b) > 128 {
				t.Fatal("metadata validation")
			}
		}
		delete(base, field)
	}
	items := make([]json.RawMessage, maxHistoryItems+1)
	for i := range items {
		items[i] = json.RawMessage(`{"role":"user","content":"hi"}`)
	}
	if _, err := normalizedHistory(items); err == nil {
		t.Fatal("history item limit")
	}
}

func TestRoutedHistoryConfigureInvalidatesGeneration(t *testing.T) {
	c, err := New()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(c.Close)
	if c.Configure(Config{Endpoint: "https://mock.example", APIKey: syntheticKey}) != nil {
		t.Fatal("config")
	}
	c.history.entries = map[string]historyEntry{"old": {model: "gpt-5.5", bytes: 3}}
	c.history.order, c.history.bytes = []string{"old"}, 3
	generation := c.history.generation
	if c.Configure(Config{Endpoint: "http://invalid.example", APIKey: syntheticKey}) == nil || len(c.history.entries) != 1 || c.history.generation != generation {
		t.Fatal("rejected config mutated history")
	}
	if c.Configure(Config{Endpoint: "https://another.example", APIKey: "synthetic-replacement-only"}) != nil || len(c.history.entries) != 0 || c.history.bytes != 0 || c.history.generation == generation {
		t.Fatal("new upstream/key retained history")
	}
}

func TestRoutedHistoryBudgetFailureBeforeCompletion(t *testing.T) {
	// Each request/output fits its own budget; their stored transcript does not.
	for _, stream := range []bool{false, true} {
		c, endpoint := routedClaudeCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "text/event-stream")
			fmt.Fprint(w, chatSSE(choice(map[string]any{"content": strings.Repeat("b", 300000)}, "stop")))
		}))
		p, _ := decodeObject(historyPayload("gpt-5.5", []any{map[string]string{"role": "user", "content": strings.Repeat("a", 800000)}}, "", stream))
		for _, store := range []bool{true, false} {
			p["store"] = store
			raw, _ := json.Marshal(p)
			req, _ := http.NewRequest("POST", endpoint+"/v1/responses", strings.NewReader(string(raw)))
			req.Header.Set("Authorization", "Bearer "+c.token)
			req.Header.Set("Content-Type", "application/json")
			resp, err := http.DefaultClient.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			b, readErr := io.ReadAll(resp.Body)
			resp.Body.Close()
			if store {
				if strings.Contains(string(b), "response.completed") || !stream && (resp.StatusCode != 502 || readErr != nil || strings.Contains(string(b), "completed")) || stream && readErr == nil {
					t.Fatal("oversized history reported success")
				}
			} else if readErr != nil || resp.StatusCode != 200 || !strings.Contains(string(b), "completed") {
				t.Fatal("store false unnecessarily limited by cache")
			}
			c.mu.Lock()
			count, size := len(c.history.entries), c.history.bytes
			c.mu.Unlock()
			if count != 0 || size != 0 {
				t.Fatal("oversized/unstored transcript cached")
			}
		}
	}
}

type terminalHistoryWriter struct {
	jsonProbeWriter
	terminal bool
}

func (w *terminalHistoryWriter) Write(b []byte) (int, error) {
	if strings.Contains(string(b), "event: response.completed\n") {
		w.terminal = true
		return w.jsonProbeWriter.Write(b)
	}
	return len(b), nil
}
func (w *terminalHistoryWriter) FlushError() error {
	if w.terminal {
		return w.jsonProbeWriter.FlushError()
	}
	return nil
}
func TestRoutedHistorySSETerminalWriteAndCancellation(t *testing.T) {
	for _, mode := range []string{"short", "error", "flush", "ok", "cancel"} {
		t.Run(mode, func(t *testing.T) {
			c, _ := routedClaudeCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
			_, seed, err := c.prepareRoutedHistory([]byte(historyPayload("gpt-5.5", []any{map[string]string{"role": "user", "content": "hi"}}, "", true)), "gpt-5.5")
			if err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			w := &terminalHistoryWriter{jsonProbeWriter: jsonProbeWriter{header: make(http.Header), mode: mode}}
			p := &chatPlan{stream: true, model: "gpt-5.5", prepareCompletion: c.historyCompletion(ctx, seed)}
			e, err := newRoutedResponseWriter(w, p)
			if err != nil || e.accept(streamEvent{kind: "text", text: "done"}, p) != nil {
				t.Fatal("preterminal write")
			}
			if mode == "cancel" {
				cancel()
			}
			err = e.accept(streamEvent{kind: "complete"}, p)
			if mode == "ok" {
				if err != nil || len(c.history.entries) != 1 {
					t.Fatal("success not cached")
				}
			} else if len(c.history.entries) != 0 || mode != "cancel" && err == nil {
				t.Fatal("failed/cancelled terminal cached")
			}
		})
	}
}
