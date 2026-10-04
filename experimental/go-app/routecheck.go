//go:build routecheck && nogui

package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/signal"
	"sync"
	"syscall"

	"github.com/momo-api/momoapi-proxy/experimental/go-app/internal/appcore"
)

// Test-only unified upstream. Both Node and Go send real requests to THIS mock.
// Never compiled/distributed in production; no user key/profile reads.
func main() {
	var fixture struct {
		Stream string
		Status int
		Mode   string
	}
	if json.NewDecoder(io.LimitReader(os.Stdin, 1<<20)).Decode(&fixture) != nil {
		os.Exit(1)
	}
	var mu sync.Mutex
	captures := []any{}
	mock := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/capture" {
			mu.Lock()
			defer mu.Unlock()
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(captures)
			return
		}
		data, err := io.ReadAll(io.LimitReader(r.Body, appcore.MaxRequest+1))
		if err != nil || len(data) > appcore.MaxRequest || r.URL.Path != "/v1/chat/completions" || r.Method != "POST" || r.Header.Get("Authorization") != "Bearer synthetic-unified-only" {
			w.WriteHeader(400)
			return
		}
		var payload any
		if json.Unmarshal(data, &payload) != nil {
			w.WriteHeader(400)
			return
		}
		mu.Lock()
		captures = append(captures, payload)
		mu.Unlock()
		w.Header().Set("Content-Type", "text/event-stream")
		if fixture.Status != 0 && fixture.Status != 200 {
			w.WriteHeader(fixture.Status)
			io.WriteString(w, "redacted synthetic failure")
			return
		}
		for _, b := range []byte(fixture.Stream) {
			w.Write([]byte{b})
			w.(http.Flusher).Flush()
		}
	}))
	defer mock.Close()
	core, err := appcore.New()
	if err != nil {
		os.Exit(1)
	}
	defer core.Close()
	closeInjection := appcore.InstallRoutecheckMock(core, mock.URL)
	defer closeInjection()
	if fixture.Mode == "" {
		fixture.Mode = "momo-routing"
	}
	if core.Configure(appcore.Config{Endpoint: "https://mock.example", APIKey: "synthetic-unified-only", Mode: fixture.Mode}) != nil || core.Start() != nil {
		os.Exit(1)
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	err = core.Serve(ctx, func(string) {
		var local map[string]string
		json.Unmarshal([]byte(core.ConnectionJSON()), &local)
		local["mock_url"] = mock.URL
		fmt.Println(string(mustJSON(local)))
	})
	if err != nil {
		os.Exit(1)
	}
}
func mustJSON(v any) []byte { b, _ := json.Marshal(v); return b }
