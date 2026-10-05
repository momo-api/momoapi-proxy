package appcore

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

const nativeCompactFixture = ` { "id":"cmp_synthetic", "object":"response.compaction", "created_at":1, "output":[{"type":"compaction","encrypted_content":"opaque-synthetic-not-a-real-envelope","id":"item_synthetic"}],"unknown":{"n":9007199254740993,"text":"中文🙂"} } `
const nativeCompactInput = ` { "model":"gpt-5.6-sol", "input":[{"role":"user","content":"compact 中文🙂"}],"instructions":"retain constraints","stream":false,"unknown":{"n":9007199254740993} } `

func TestExplicitNativeCompactExactRequestResponseAndReplay(t *testing.T) {
	for _, mode := range []string{"passthrough", "momo-routing"} {
		var sends atomic.Int32
		c, endpoint, _, _ := testCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			n := sends.Add(1)
			b, _ := io.ReadAll(r.Body)
			if r.Header.Get("X-MOMO-Compact") != "" {
				t.Error("private policy leaked")
			}
			w.Header().Set("Content-Type", "application/json")
			if n == 1 {
				if r.URL.Path != "/v1/responses/compact" || string(b) != nativeCompactInput {
					t.Error("compact request changed")
				}
				io.WriteString(w, nativeCompactFixture)
			} else {
				if r.URL.Path != "/v1/responses" {
					t.Error("replay path")
				}
				w.Write(b)
			}
		}))
		c.Stop()
		if c.Configure(Config{Endpoint: "https://mock.example", APIKey: syntheticKey, Mode: mode}) != nil || c.Start() != nil {
			t.Fatal("configure")
		}
		code, body, _ := request(t, c, endpoint, "/v1/responses/compact", "POST", nativeCompactInput, map[string]string{"X-MOMO-Compact": "native"})
		if code != 200 || string(body) != nativeCompactFixture {
			t.Fatal("native envelope modified", code)
		}
		p, _ := decodeObject(string(body))
		replay, _ := json.Marshal(map[string]any{"model": "gpt-5.6-sol", "input": p["output"], "store": false})
		code, body, _ = request(t, c, endpoint, "/v1/responses", "POST", string(replay), nil)
		if code != 200 || string(body) != string(replay) || sends.Load() != 2 {
			t.Fatal("opaque replay altered or fallback")
		}
		c.mu.Lock()
		defer c.mu.Unlock()
		if len(c.history.entries) != 0 {
			t.Fatal("native compaction wrote local state")
		}
	}
}

func TestNativeCompactExplicitGate(t *testing.T) {
	var sends atomic.Int32
	c, endpoint := routedClaudeCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { sends.Add(1) }))
	for _, tc := range []struct {
		path, body, header string
		status             int
	}{
		{"/v1/responses/compact", nativeCompactInput, "", 422},
		{"/v1/responses/compact", nativeCompactInput, "auto", 400},
		{"/v1/responses/compact", strings.Replace(nativeCompactInput, "gpt-5.6-sol", "gpt-5.5", 1), "native", 422},
		{"/v1/responses/compact", strings.Replace(nativeCompactInput, "false", "true", 1), "native", 400},
		{"/v1/responses", nativeCompactInput, "native", 400},
	} {
		headers := map[string]string{}
		if tc.header != "" {
			headers["X-MOMO-Compact"] = tc.header
		}
		code, _, _ := request(t, c, endpoint, tc.path, "POST", tc.body, headers)
		if code != tc.status {
			t.Fatal("native gate", code, tc.status)
		}
	}
	if sends.Load() != 0 {
		t.Fatal("implicit compact upstream send")
	}
	for _, model := range []string{"gpt-5.5", "claude-sonnet-4-6", "gemini-2.5-flash"} {
		p := mustSearchObject(`{"model":"` + model + `","input":[{"type":"compaction","encrypted_content":"opaque-synthetic"}]}`)
		b, _ := json.Marshal(p)
		code, _, _ := request(t, c, endpoint, "/v1/responses", "POST", string(b), nil)
		if code != 400 {
			t.Fatal("opaque foreign provider state accepted")
		}
	}
}

func TestNativeCompactBadUpstreamNoFallback(t *testing.T) {
	for _, tc := range []struct {
		name, body, typ string
		status          int
	}{
		{"invalid JSON", "{", "application/json", 200},
		{"wrong object", `{"object":"response","output":[]}`, "application/json", 200},
		{"missing output", `{"object":"response.compaction"}`, "application/json", 200},
		{"empty output", `{"object":"response.compaction","output":[]}`, "application/json", 200},
		{"bad item", `{"object":"response.compaction","output":[1]}`, "application/json", 200},
		{"empty opaque", `{"object":"response.compaction","output":[{"type":"compaction","encrypted_content":""}]}`, "application/json", 200},
		{"wrong media", nativeCompactFixture, "text/event-stream", 200},
		{"too big", strings.Repeat(" ", MaxResponse+1), "application/json", 200},
		{"401", "private-synthetic", "application/json", 401},
		{"429", "private-synthetic", "application/json", 429},
		{"404", "private-synthetic", "application/json", 404},
		{"501", "private-synthetic", "application/json", 501},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var sends atomic.Int32
			c, endpoint := routedClaudeCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				sends.Add(1)
				w.Header().Set("Content-Type", tc.typ)
				w.WriteHeader(tc.status)
				fmt.Fprint(w, tc.body)
			}))
			code, body, _ := request(t, c, endpoint, "/v1/responses/compact", "POST", nativeCompactInput, map[string]string{"X-MOMO-Compact": "native"})
			want := 502
			if tc.status >= 400 {
				want = tc.status
			}
			if code != want || sends.Load() != 1 || strings.Contains(string(body), "private-synthetic") {
				t.Fatal("native failure leaked/retried", code)
			}
		})
	}
}

func TestNativeCompactDuplicatePolicyHeader(t *testing.T) {
	for _, values := range [][]string{{"native", "native"}, {"native, native"}, {""}} {
		r, _ := http.NewRequest("POST", "http://127.0.0.1/v1/responses/compact", nil)
		for _, value := range values {
			r.Header.Add("X-MOMO-Compact", value)
		}
		if _, ok := nativeCompactRequested(r); ok {
			t.Fatal("ambiguous policy header accepted")
		}
	}
}

func TestNativeCompactStopCancelsWithoutPartialJSON(t *testing.T) {
	entered, cancelled := make(chan struct{}), make(chan struct{})
	c, endpoint := routedClaudeCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"object":"response.compaction","output":[`)
		w.(http.Flusher).Flush()
		close(entered)
		<-r.Context().Done()
		close(cancelled)
	}))
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	done := make(chan []byte, 1)
	go func() {
		req, _ := http.NewRequestWithContext(ctx, "POST", endpoint+"/v1/responses/compact", strings.NewReader(nativeCompactInput))
		req.Header.Set("Authorization", "Bearer "+c.token)
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-MOMO-Compact", "native")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			done <- nil
			return
		}
		b, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		done <- b
	}()
	select {
	case <-entered:
	case <-ctx.Done():
		t.Fatal("native compact never entered")
	}
	c.Stop()
	select {
	case <-cancelled:
	case <-ctx.Done():
		t.Fatal("native upstream not cancelled")
	}
	select {
	case b := <-done:
		if strings.Contains(string(b), "response.compaction") {
			t.Fatal("partial native JSON leaked")
		}
	case <-ctx.Done():
		t.Fatal("native local request not cancelled")
	}
}
