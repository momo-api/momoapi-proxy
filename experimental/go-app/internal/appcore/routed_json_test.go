package appcore

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

type jsonProbeWriter struct {
	header http.Header
	writes int
	mode   string
}

func (w *jsonProbeWriter) Header() http.Header { return w.header }
func (w *jsonProbeWriter) WriteHeader(int)     {}
func (w *jsonProbeWriter) FlushError() error {
	if w.mode == "flush" {
		return io.ErrClosedPipe
	}
	return nil
}
func (w *jsonProbeWriter) SetWriteDeadline(time.Time) error {
	if w.mode == "deadline" {
		return io.ErrClosedPipe
	}
	return nil
}
func (w *jsonProbeWriter) Write(b []byte) (int, error) {
	w.writes++
	switch w.mode {
	case "short":
		return len(b) - 1, nil
	case "error":
		return 0, io.ErrClosedPipe
	}
	return len(b), nil
}
func TestRoutedJSONWriteFailureBoundary(t *testing.T) {
	for _, mode := range []string{"short", "error", "flush", "deadline", "ok"} {
		t.Run(mode, func(t *testing.T) {
			w := &jsonProbeWriter{header: make(http.Header), mode: mode}
			p := &chatPlan{model: "mock"}
			e, err := newRoutedResponseWriter(w, p)
			if err != nil || e.accept(streamEvent{kind: "text", text: "hello"}, p) != nil || w.writes != 0 || len(w.header) != 0 {
				t.Fatal("early JSON write")
			}
			err = e.accept(streamEvent{kind: "complete"}, p)
			switch mode {
			case "short", "error", "flush":
				if !errors.Is(err, errRoutedWrite) || w.writes != 1 {
					t.Fatal("partial write must abort, not replace with 502")
				}
			case "deadline":
				if err == nil || errors.Is(err, errRoutedWrite) || w.writes != 0 || len(w.header) != 0 {
					t.Fatal("pre-write failure boundary")
				}
			case "ok":
				if err != nil || w.writes != 1 {
					t.Fatal("final JSON write")
				}
			}
			if e.accept(streamEvent{kind: "complete"}, p) == nil {
				t.Fatal("terminal encoder reused")
			}
		})
	}
}

func responseSemantic(m map[string]any) string {
	delete(m, "id")
	for _, v := range m["output"].([]any) {
		delete(obj(v), "id")
	}
	b, _ := json.Marshal(m)
	return string(b)
}
func TestRoutedJSONMatchesStreaming(t *testing.T) {
	for _, tc := range []struct{ name, payload, stream, path string }{{"Chat", routedPayload, goodChatSSE(), "/v1/chat/completions"}, {"Claude", claudePayload, goodClaudeSSE(), "/v1/messages"}, {"Gemini", geminiPayload, goodGeminiSSE(), geminiPath}} {
		t.Run(tc.name, func(t *testing.T) {
			var sends atomic.Int32
			c, endpoint := routedClaudeCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				sends.Add(1)
				if r.URL.Path != tc.path {
					t.Error("upstream target")
				}
				b, _ := io.ReadAll(r.Body)
				p, _ := decodeObject(string(b))
				if tc.name != "Gemini" && p["stream"] != true {
					t.Error("single upstream streaming request")
				}
				w.Header().Set("Content-Type", "text/event-stream")
				for _, b := range []byte(tc.stream) {
					_, _ = w.Write([]byte{b})
					w.(http.Flusher).Flush()
				}
			}))
			_, data, _ := request(t, c, endpoint, "/v1/responses", "POST", tc.payload, nil)
			want := responseSemantic(responseCompletion(t, data))
			for _, payload := range []string{strings.Replace(tc.payload, `"stream":true`, `"stream":false`, 1), strings.Replace(tc.payload, `"stream":true,`, "", 1)} {
				code, b, h := request(t, c, endpoint, "/v1/responses", "POST", payload, nil)
				if code != 200 || !strings.HasPrefix(h.Get("Content-Type"), "application/json") {
					t.Fatal("JSON status/type")
				}
				p, err := decodeObject(string(b))
				if err != nil || str(p["status"]) != "completed" || str(p["object"]) != "response" || strings.Contains(string(b), "event: response.") {
					t.Fatal("not final response JSON")
				}
				if responseSemantic(p) != want {
					t.Fatal("JSON/stream semantics differ")
				}
			}
			if sends.Load() != 3 {
				t.Fatal("duplicate sends")
			}
		})
	}
}
func TestRoutedJSONFailuresAreAtomicAndRedacted(t *testing.T) {
	for _, tc := range []struct{ name, payload, stream string }{
		{"Chat EOF", routedPayload, strings.TrimSuffix(goodChatSSE(), "data: [DONE]\r\n\r\n")},
		{"Claude EOF", claudePayload, strings.TrimSuffix(goodClaudeSSE(), claudeFrame("message_stop", map[string]any{}))},
		{"Gemini late error", geminiPayload, goodGeminiSSE() + "data: {\"error\":{\"message\":\"private-upstream-detail\"}}\n\n"},
		{"Chat oversize", routedPayload, chatSSE(choice(map[string]any{"content": strings.Repeat("a", maxRoutedEvent+1)}, "stop"))},
		{"Claude invalid custom", claudePayload, claudeStart() + claudeTool(0, "a", "pad__write", `{"input":null}`) + claudeEnd("tool_use")},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var count atomic.Int32
			c, endpoint := routedClaudeCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				count.Add(1)
				w.Header().Set("Content-Type", "text/event-stream")
				fmt.Fprint(w, tc.stream)
			}))
			code, b, h := request(t, c, endpoint, "/v1/responses", "POST", strings.Replace(tc.payload, `"stream":true`, `"stream":false`, 1), nil)
			if code != 502 || strings.Contains(string(b), "completed") || strings.Contains(string(b), "event:") || strings.Contains(string(b), "private-upstream-detail") || strings.Contains(h.Get("Content-Type"), "event-stream") || len(b) > 128 || count.Load() != 1 {
				t.Fatal("partial/malformed response escaped JSON failure")
			}
		})
	}
}
func TestRoutedJSONNoEarlyWriteAndStop(t *testing.T) {
	for _, tc := range []struct{ name, payload, partial string }{
		{"Chat", routedPayload, "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"partial\"}}]}\n\n"},
		{"Claude", claudePayload, claudeStart() + claudeText(0, "partial") + claudeTool(1, "a", "pad__read", "{}")},
		{"Gemini", geminiPayload, geminiFrame([]any{geminiText("partial"), geminiCall("a", "pad__read", map[string]any{})}, "", nil)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			entered, cancelled := make(chan struct{}), make(chan struct{})
			c, endpoint := routedClaudeCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "text/event-stream")
				fmt.Fprint(w, tc.partial)
				w.(http.Flusher).Flush()
				close(entered)
				<-r.Context().Done()
				close(cancelled)
			}))
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			req, _ := http.NewRequestWithContext(ctx, "POST", endpoint+"/v1/responses", strings.NewReader(strings.Replace(tc.payload, `"stream":true`, `"stream":false`, 1)))
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("Authorization", "Bearer "+c.token)
			type result struct {
				response *http.Response
				err      error
			}
			done := make(chan result, 1)
			go func() { r, err := http.DefaultClient.Do(req); done <- result{r, err} }()
			select {
			case <-entered:
			case <-ctx.Done():
				t.Fatal("upstream not entered")
			}
			select {
			case r := <-done:
				if r.response != nil {
					r.response.Body.Close()
				}
				t.Fatal("JSON headers sent before terminal")
			case <-time.After(30 * time.Millisecond):
			}
			c.Stop()
			select {
			case <-cancelled:
			case <-time.After(time.Second):
				t.Fatal("upstream not cancelled")
			}
			select {
			case r := <-done:
				if r.err == nil {
					defer r.response.Body.Close()
					b, _ := io.ReadAll(r.response.Body)
					if r.response.StatusCode != 502 || strings.Contains(string(b), "completed") {
						t.Fatal("Stop JSON success")
					}
				}
			case <-ctx.Done():
				t.Fatal("JSON request retained")
			}
			deadline := time.Now().Add(time.Second)
			for c.State().Active != 0 && time.Now().Before(deadline) {
				time.Sleep(time.Millisecond)
			}
			if c.State().Active != 0 {
				t.Fatal("lease retained")
			}
		})
	}
}
func TestRoutedJSONNativeAndDefaultRemainExact(t *testing.T) {
	for _, tc := range []struct{ model, mode string }{{"gpt-5.6-sol", "momo-routing"}, {"gpt-5.5", ""}, {"claude-sonnet-4-6", ""}, {"gemini-2.5-flash", ""}} {
		t.Run(tc.model+tc.mode, func(t *testing.T) {
			payload := fmt.Sprintf(`{"model":%q,"stream":false,"input":[{"role":"user","content":"hi"}],"previous_response_id":"provider_anchor","store":false,"unknown":true}`, tc.model)
			native := `{"object":"response","status":"completed","unknown_provider":{"namespace":"pad"}}`
			c, endpoint, _, _ := testCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				b, _ := io.ReadAll(r.Body)
				if r.URL.Path != "/v1/responses" || string(b) != payload {
					t.Error("native/default changed")
				}
				w.Header().Set("Content-Type", "application/json")
				fmt.Fprint(w, native)
			}))
			if tc.mode != "" {
				c.Stop()
				if c.Configure(Config{Endpoint: "https://mock.example", APIKey: syntheticKey, Mode: tc.mode}) != nil || c.Start() != nil {
					t.Fatal("config")
				}
			}
			code, b, _ := request(t, c, endpoint, "/v1/responses", "POST", payload, nil)
			if code != 200 || string(b) != native {
				t.Fatal("exact JSON passthrough")
			}
		})
	}
}
func TestRoutedJSONUpstreamStatusNotRetried(t *testing.T) {
	for _, status := range []int{401, 429, 500} {
		t.Run(fmt.Sprint(status), func(t *testing.T) {
			var count atomic.Int32
			c, endpoint := routedClaudeCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				count.Add(1)
				w.WriteHeader(status)
				fmt.Fprint(w, "private-error")
			}))
			code, b, _ := request(t, c, endpoint, "/v1/responses", "POST", strings.Replace(routedPayload, `"stream":true`, `"stream":false`, 1), nil)
			if code != status || strings.Contains(string(b), "private-error") || count.Load() != 1 {
				t.Fatal("retry/error disclosure")
			}
		})
	}
}
