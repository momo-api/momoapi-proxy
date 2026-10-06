package appcore

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"reflect"
	"strings"
	"sync"
	"testing"
)

func checkpointPayload(model string) map[string]any {
	p, _ := decodeObject(historyPayload(model, []any{
		map[string]string{"role": "developer", "content": "exact constraint 中文"},
		map[string]string{"role": "user", "content": "old task; do not re-execute"},
		map[string]string{"role": "assistant", "content": strings.Repeat("old ordinary assistant 中文🙂", 150)},
		map[string]string{"role": "user", "content": "tool trigger exact"},
		map[string]string{"role": "assistant", "content": "before tool exact"},
		map[string]string{"type": "function_call", "namespace": "pad", "name": "read", "call_id": "history_function", "arguments": `{"n":9007199254740993}`},
		map[string]string{"role": "assistant", "content": "between tools exact"},
		map[string]string{"type": "custom_tool_call", "namespace": "pad", "name": "write", "call_id": "history_custom", "input": "raw exact"},
		map[string]string{"type": "custom_tool_call_output", "call_id": "history_custom", "output": "custom exact"},
		map[string]string{"type": "function_call_output", "call_id": "history_function", "output": "function exact"},
		map[string]string{"role": "assistant", "content": strings.Repeat("tool final exact", 150)},
		map[string]string{"role": "user", "content": "CURRENT exact 中文🙂"},
	}, "", false))
	return p
}

func TestExplicitCheckpointPreservesRequiredStateAndReplay(t *testing.T) {
	for _, tc := range []struct{ model, wire string }{{"gpt-5.5", goodChatSSE()}, {"claude-sonnet-4-6", goodClaudeSSE()}, {"gemini-2.5-flash", goodGeminiSSE()}} {
		t.Run(tc.model, func(t *testing.T) {
			var mu sync.Mutex
			var captures [][]byte
			c, endpoint := routedClaudeCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				b, _ := io.ReadAll(r.Body)
				mu.Lock()
				captures = append(captures, b)
				mu.Unlock()
				w.Header().Set("Content-Type", "text/event-stream")
				io.WriteString(w, tc.wire)
			}))
			captured := func() [][]byte {
				mu.Lock()
				defer mu.Unlock()
				return append([][]byte{}, captures...)
			}
			p := checkpointPayload(tc.model)
			p["input"].([]any)[3] = map[string]any{"role": "user", "content": []any{map[string]any{"type": "input_text", "text": "tool trigger exact"}, imagePart(inlineFixture(t, "image/png")), map[string]any{"type": "input_image", "image_url": "https://images.example/a", "mime_type": "image/jpeg"}}}
			b, _ := json.Marshal(p)
			original := p["input"].([]any)
			code, data, h := request(t, c, endpoint, "/v1/responses/compact", "POST", string(b), nil)
			if code != 200 || !strings.Contains(h.Get("Content-Type"), "application/json") || len(captured()) != 0 {
				t.Fatal("local compact sent upstream or failed")
			}
			final, err := decodeObject(string(data))
			if err != nil || final["object"] != "response.compaction" || !strings.HasPrefix(str(final["id"]), "cmp_") || strings.Contains(string(data), "encrypted_content") {
				t.Fatal("invalid checkpoint result")
			}
			out := final["output"].([]any)
			if len(out) != len(original) || !strings.Contains(str(obj(out[2])["content"].([]any)[0].(map[string]any)["text"]), checkpointPrefix) {
				t.Fatal("missing explicit omission marker")
			}
			for i := range original {
				if i == 2 {
					continue
				}
				want, _ := json.Marshal(original[i])
				got, _ := json.Marshal(out[i])
				if !bytes.Equal(got, want) {
					t.Fatal("required item/order changed", i)
				}
			}
			if len(data) >= len(b) || !strings.Contains(string(data), "9007199254740993") {
				t.Fatal("checkpoint grew or lost precision")
			}
			// No hidden checkpoint state: ordinary output is explicitly replayed.
			c.mu.Lock()
			entries := len(c.history.entries)
			c.mu.Unlock()
			if entries != 0 {
				t.Fatal("compact minted anchor")
			}
			p["input"] = out
			replay, _ := json.Marshal(p)
			code, _, _ = request(t, c, endpoint, "/v1/responses", "POST", string(replay), nil)
			sent := captured()
			if code != 200 || len(sent) != 1 || !strings.Contains(string(sent[0]), "CURRENT exact") || !strings.Contains(string(sent[0]), "pad__read") || !strings.Contains(string(sent[0]), "pad__write") || !strings.Contains(string(sent[0]), "https://images.example/a") {
				t.Fatal("checkpoint replay failed")
			}
			p["previous_response_id"] = final["id"]
			unknown, _ := json.Marshal(p)
			code, _, _ = request(t, c, endpoint, "/v1/responses", "POST", string(unknown), nil)
			if code != 400 || len(captured()) != 1 {
				t.Fatal("checkpoint mistaken for history anchor")
			}
		})
	}
}

func TestCheckpointImagesRetainWholeTurnAndReplay(t *testing.T) {
	for _, model := range []string{"gpt-5.5", "claude-sonnet-4-6", "gemini-2.5-flash"} {
		p := checkpointPayload(model)
		input := p["input"].([]any)
		url := inlineFixture(t, "image/png")
		imageUser := map[string]any{"role": "user", "content": []any{map[string]any{"type": "input_text", "text": "historical image task"}, imagePart(url), map[string]any{"type": "input_image", "image_url": "https://images.example/a", "mime_type": "image/jpeg"}}}
		imageAnswer := map[string]any{"role": "assistant", "content": strings.Repeat("original image interpretation ", 150)}
		imageTurn := []any{imageUser, imageAnswer}
		input = append(append(append([]any{}, input[:3]...), imageTurn...), input[3:]...)
		p["input"] = input
		b, _ := json.Marshal(p)
		final, err := buildLocalCheckpoint(b)
		if err != nil {
			t.Fatal("image checkpoint rejected", model, err)
		}
		encoded, _ := json.Marshal(final)
		out := final["output"].([]json.RawMessage)
		if len(encoded) >= len(b) || len(out) != len(input) {
			t.Fatal("no useful image checkpoint")
		}
		for i := range input {
			if i == 2 {
				continue
			}
			got, _ := decodeObject(string(out[i]))
			want, _ := json.Marshal(input[i])
			expected, _ := decodeObject(string(want))
			if !reflect.DeepEqual(got, expected) {
				t.Fatal("image-bearing turn/other required item changed", model, i)
			}
		}
		p["input"] = out
		replay, _ := json.Marshal(p)
		ir, err := parseRoutedRequest(replay)
		if err != nil {
			t.Fatal("image checkpoint replay invalid")
		}
		images := 0
		for _, m := range ir.messages {
			for _, part := range m.parts {
				if part.image != nil {
					images++
				}
			}
		}
		if images != 2 {
			t.Fatal("checkpoint image loss")
		}
		// No benefit if every old assistant belongs to an image-bearing turn.
		p["input"] = []any{imageUser, imageAnswer, map[string]string{"role": "user", "content": "latest"}, map[string]string{"role": "assistant", "content": "latest answer"}, map[string]string{"role": "user", "content": "CURRENT"}}
		b, _ = json.Marshal(p)
		if _, err := buildLocalCheckpoint(b); err == nil {
			t.Fatal("image interpretation silently omitted")
		}
	}
}

func TestCheckpointRejectsUnknownLossAndNoBenefit(t *testing.T) {
	for _, mutate := range []func(map[string]any){
		func(p map[string]any) { p["stream"] = true },
		func(p map[string]any) { p["stream"] = nil },
		func(p map[string]any) { p["instructions"] = "unknown per-request state" },
		func(p map[string]any) { p["previous_response_id"] = "foreign" },
		func(p map[string]any) { p["max_output_tokens"] = 17 },
		func(p map[string]any) { p["model"] = "muse-auto" },
		func(p map[string]any) { p["model"] = "gpt-5.6-sol" },
		func(p map[string]any) {
			p["input"] = []any{map[string]string{"role": "user", "content": "only current"}}
		},
		func(p map[string]any) {
			p["input"] = []any{map[string]string{"role": "user", "content": "first"}, map[string]string{"role": "assistant", "content": "short"}, map[string]string{"role": "user", "content": "last"}}
		},
		func(p map[string]any) { p["input"] = p["input"].([]any)[:11] },
		func(p map[string]any) { p["input"].([]any)[5].(map[string]any)["arguments"] = "{" },
		func(p map[string]any) { p["input"].([]any)[8].(map[string]any)["call_id"] = "orphan" },
		func(p map[string]any) { p["input"].([]any)[5].(map[string]any)["encrypted_content"] = "opaque" },
		func(p map[string]any) {
			p["input"].([]any)[2].(map[string]any)["content"] = []any{map[string]string{"type": "input_image", "image_url": "https://example.invalid/image"}} // assistant images still unsupported
		},
	} {
		p := checkpointPayload("gpt-5.5")
		mutate(p)
		b, _ := json.Marshal(p)
		if _, err := buildLocalCheckpoint(b); err == nil {
			t.Fatal("unsafe/no-benefit compact accepted")
		}
	}
}

func TestCheckpointHTTPBoundariesAndCancelledWrite(t *testing.T) {
	c, endpoint := routedClaudeCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { t.Error("compact sent upstream") }))
	p := checkpointPayload("gpt-5.5")
	b, _ := json.Marshal(p)
	for _, tc := range []struct {
		method, path string
		headers      map[string]string
		status       int
	}{
		{"GET", "/v1/responses/compact", nil, 405},
		{"POST", "/v1/responses/compact?extra=1", nil, 400},
		{"POST", "/v1/responses/compact", map[string]string{"Origin": "https://foreign.invalid"}, 403},
		{"POST", "/v1/responses/compact", map[string]string{"Content-Type": "text/plain"}, 415},
		{"POST", "/v1/responses/compact", map[string]string{"Authorization": "Bearer wrong"}, 401},
	} {
		code, _, _ := request(t, c, endpoint, tc.path, tc.method, string(b), tc.headers)
		if code != tc.status {
			t.Fatal("compact boundary", tc.path, code)
		}
	}
	c.Stop()
	if c.Configure(Config{Endpoint: "https://mock.example", APIKey: syntheticKey}) != nil || c.Start() != nil {
		t.Fatal("default config")
	}
	code, _, _ := request(t, c, endpoint, "/v1/responses/compact", "POST", string(b), nil)
	if code != 501 {
		t.Fatal("compact enabled by default")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	w := &jsonProbeWriter{header: make(http.Header), mode: "ok"}
	c.localCheckpoint(ctx, w, b, Config{Mode: "momo-routing"})
	if w.header.Get("Content-Type") == "application/json; charset=utf-8" {
		t.Fatal("cancelled checkpoint wrote JSON")
	}
}

func TestCheckpointRepeatedOutputAndWriteFailures(t *testing.T) {
	p := checkpointPayload("gpt-5.5")
	b, _ := json.Marshal(p)
	final, err := buildLocalCheckpoint(b)
	if err != nil {
		t.Fatal(err)
	}
	p["input"] = final["output"]
	repeat, _ := json.Marshal(p)
	if _, err := buildLocalCheckpoint(repeat); err == nil {
		t.Fatal("recompaction nested marker or invented benefit")
	}
	c, _ := routedClaudeCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { t.Error("checkpoint upstream") }))
	for _, mode := range []string{"short", "error", "flush", "deadline", "ok"} {
		t.Run(mode, func(t *testing.T) {
			w := &jsonProbeWriter{header: make(http.Header), mode: mode}
			var recovered any
			func() {
				defer func() { recovered = recover() }()
				c.localCheckpoint(context.Background(), w, b, Config{Mode: "momo-routing"})
			}()
			if mode == "deadline" {
				if recovered != nil || w.writes != 0 || len(w.header) != 0 {
					t.Fatal("checkpoint pre-write boundary")
				}
			} else if mode == "ok" {
				if recovered != nil || w.writes != 1 {
					t.Fatal("checkpoint final write")
				}
			} else if recovered != http.ErrAbortHandler || w.writes != 1 {
				t.Fatal("checkpoint partial write did not abort")
			}
			c.mu.Lock()
			entries := len(c.history.entries)
			c.mu.Unlock()
			if entries != 0 {
				t.Fatal("checkpoint wrote hidden history")
			}
		})
	}
}

func TestCheckpointBodyAndItemBudgets(t *testing.T) {
	p := checkpointPayload("gpt-5.5")
	p["input"].([]any)[11].(map[string]any)["content"] = strings.Repeat("x", MaxRequest)
	b, _ := json.Marshal(p)
	if _, err := buildLocalCheckpoint(b); err != errCompactBudget {
		t.Fatal("oversize compact input")
	}
	c, endpoint := routedClaudeCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { t.Error("budget sent upstream") }))
	code, _, _ := request(t, c, endpoint, "/v1/responses/compact", "POST", string(b), nil)
	if code != 413 {
		t.Fatal("compact HTTP body limit")
	}
	p = checkpointPayload("gpt-5.5")
	items := []any{}
	for i := 0; i <= maxHistoryItems; i++ {
		items = append(items, map[string]string{"role": "user", "content": "required"})
	}
	p["input"] = items
	b, _ = json.Marshal(p)
	if _, err := buildLocalCheckpoint(b); err == nil {
		t.Fatal("compact item budget")
	}
}
