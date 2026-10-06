package appcore

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"reflect"
	"strings"
	"testing"
	"time"
)

func seedHistoryPair(t *testing.T, c *Core) ([]string, int, time.Time) {
	t.Helper()
	seed := &historySeed{model: "gpt-5.5", input: []json.RawMessage{json.RawMessage(`{"role":"user","content":"first"}`)}, generation: c.history.generation, store: true}
	output := []any{map[string]any{"type": "message", "role": "assistant", "content": "answer"}}
	for _, id := range []string{"older", "newer"} {
		commit, err := c.historyCompletion(context.Background(), seed)(id, output)
		if err != nil {
			t.Fatal(err)
		}
		commit()
	}
	return append([]string{}, c.history.order...), c.history.bytes, c.history.entries["older"].expires
}

func TestHistoryPreparationAndInvalidContinuationDoNotPromoteLRU(t *testing.T) {
	c, endpoint := routedClaudeCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { t.Error("invalid continuation sent upstream") }))
	order, size, expiry := seedHistoryPair(t, c)
	payload := historyPayload("gpt-5.5", []any{map[string]string{"role": "user", "content": "second"}}, "older", false)
	if _, _, err := c.prepareRoutedHistory([]byte(payload), "gpt-5.5"); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(c.history.order, order) || c.history.bytes != size {
		t.Fatal("prepare mutated LRU before success")
	}
	p, _ := decodeObject(payload)
	p["unknown_option"] = true
	b, _ := json.Marshal(p)
	code, _, _ := request(t, c, endpoint, "/v1/responses", "POST", string(b), nil)
	if code != 400 || !reflect.DeepEqual(c.history.order, order) || c.history.bytes != size || c.history.entries["older"].expires != expiry {
		t.Fatal("rejected request changed LRU/bytes/expiry")
	}
}

func TestHistoryPromotionOnlyAfterSuccessfulTerminal(t *testing.T) {
	for _, stream := range []bool{true, false} {
		for _, store := range []bool{true, false} {
			for _, mode := range []string{"short", "error", "flush", "deadline", "cancel", "incomplete", "ok"} {
				t.Run(fmt.Sprint(stream, "/", store, "/", mode), func(t *testing.T) {
					c, _ := routedClaudeCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
					order, size, expiry := seedHistoryPair(t, c)
					p, _ := decodeObject(historyPayload("gpt-5.5", []any{map[string]string{"role": "user", "content": "second"}}, "older", stream))
					p["store"] = store
					b, _ := json.Marshal(p)
					_, seed, err := c.prepareRoutedHistory(b, "gpt-5.5")
					if err != nil {
						t.Fatal(err)
					}
					ctx, cancel := context.WithCancel(context.Background())
					defer cancel()
					// Deadline failure is attached to the terminal, not response.created.
					w := &terminalHistoryWriter{jsonProbeWriter: jsonProbeWriter{header: make(http.Header), mode: "ok"}}
					var writer http.ResponseWriter = w
					if !stream {
						writer = &w.jsonProbeWriter
					}
					plan := &chatPlan{model: "gpt-5.5", stream: stream, prepareCompletion: c.historyCompletion(ctx, seed)}
					e, err := newRoutedResponseWriter(writer, plan)
					if err != nil || e.accept(streamEvent{kind: "text", text: "done"}, plan) != nil {
						t.Fatal("writer setup")
					}
					w.mode = mode
					if !stream {
						w.terminal = true
					} // final JSON uses no SSE event name
					if mode == "cancel" {
						cancel()
					}
					terminal := "complete"
					if mode == "incomplete" {
						terminal = "incomplete"
					}
					err = e.accept(streamEvent{kind: terminal}, plan)
					c.mu.Lock()
					defer c.mu.Unlock()
					if mode == "ok" {
						want := []string{"newer", "older"}
						if store {
							want = append(want, e.id)
						}
						if err != nil || !reflect.DeepEqual(c.history.order, want) || c.history.entries["older"].expires != expiry {
							t.Fatal("successful terminal promotion or absolute TTL")
						}
					} else if !reflect.DeepEqual(c.history.order, order) || c.history.bytes != size || c.history.entries["older"].expires != expiry {
						t.Fatal("failed/cancelled/incomplete response mutated LRU")
					}
				})
			}
		}
	}
}

func TestHistoryFailedUpstreamDoesNotPromoteLRU(t *testing.T) {
	for _, mode := range []string{"429", "truncated", "incomplete"} {
		for _, stream := range []bool{true, false} {
			c, endpoint := routedClaudeCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if mode == "429" {
					w.WriteHeader(429)
					return
				}
				w.Header().Set("Content-Type", "text/event-stream")
				if mode == "incomplete" {
					fmt.Fprint(w, chatSSE(choice(map[string]any{"content": "partial"}, "length")))
				} else {
					fmt.Fprint(w, "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"partial\"},\"finish_reason\":\"stop\"}]}\n\n")
				}
			}))
			order, size, expiry := seedHistoryPair(t, c)
			payload := historyPayload("gpt-5.5", []any{map[string]string{"role": "user", "content": "second"}}, "older", stream)
			req, _ := http.NewRequest("POST", endpoint+"/v1/responses", strings.NewReader(payload))
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("Authorization", "Bearer "+c.token)
			resp, err := http.DefaultClient.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			body, readErr := io.ReadAll(resp.Body)
			resp.Body.Close()
			if mode == "429" && resp.StatusCode != 429 || mode == "truncated" && stream && readErr == nil || mode == "truncated" && !stream && resp.StatusCode != 502 || mode == "incomplete" && (resp.StatusCode != 200 || readErr != nil || !strings.Contains(string(body), "incomplete")) {
				t.Fatal("failure fixture did not reach expected boundary")
			}
			c.mu.Lock()
			if !reflect.DeepEqual(c.history.order, order) || c.history.bytes != size || c.history.entries["older"].expires != expiry {
				t.Fatal("upstream failed/incomplete mutated LRU")
			}
			c.mu.Unlock()
		}
	}
}

func TestHistorySuccessTouchNeverResurrectsMissingOrExpiredAnchor(t *testing.T) {
	for _, mode := range []string{"evicted", "expired", "generation"} {
		for _, store := range []bool{true, false} {
			c, _ := routedClaudeCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
			seedHistoryPair(t, c)
			p, _ := decodeObject(historyPayload("gpt-5.5", []any{map[string]string{"role": "user", "content": "second"}}, "older", false))
			p["store"] = store
			b, _ := json.Marshal(p)
			_, seed, err := c.prepareRoutedHistory(b, "gpt-5.5")
			if err != nil {
				t.Fatal(err)
			}
			commit, err := c.historyCompletion(context.Background(), seed)("current", []any{map[string]string{"type": "message", "role": "assistant", "content": "answer"}})
			if err != nil {
				t.Fatal(err)
			}
			c.mu.Lock()
			switch mode {
			case "evicted":
				c.history.remove("older")
			case "expired":
				entry := c.history.entries["older"]
				entry.expires = time.Now().Add(-time.Second)
				c.history.entries["older"] = entry
			case "generation":
				c.history.clear()
			}
			c.mu.Unlock()
			commit()
			if _, ok := c.history.entries["older"]; ok {
				t.Fatal("LRU touch resurrected missing/expired/invalidated anchor")
			}
			if _, ok := c.history.entries["current"]; ok != (store && mode != "generation") {
				t.Fatal("in-flight commit ownership")
			}
		}
	}
}
