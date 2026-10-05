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
	"strings"
	"sync"
	"syscall"

	"github.com/momo-api/momoapi-proxy/experimental/go-app/internal/appcore"
)

// Test-only unified upstream. Both Node and Go send real requests to THIS mock.
// Never compiled/distributed in production; no user key/profile reads.
func main() {
	var fixture struct {
		Stream       string
		Streams      []string
		Paths        []string
		Status       int
		Mode         string
		Path         string
		Search       bool
		JSON         bool
		Image        bool
		ImageCatalog string
		Video        bool
	}
	if json.NewDecoder(io.LimitReader(os.Stdin, 1<<20)).Decode(&fixture) != nil {
		os.Exit(1)
	}
	var mu sync.Mutex
	if fixture.Path == "" {
		fixture.Path = "/v1/chat/completions"
	}
	captures := []any{}
	mock := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/capture" {
			mu.Lock()
			defer mu.Unlock()
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(captures)
			return
		}
		if fixture.Image && r.Method == "GET" && r.URL.Path == "/agent/media-capabilities" && r.Header.Get("Authorization") == "Bearer synthetic-unified-only" {
			w.Header().Set("Content-Type", "application/json")
			io.WriteString(w, fixture.ImageCatalog)
			return
		}
		if fixture.Video && r.Method == "GET" && r.Header.Get("Authorization") == "Bearer synthetic-unified-only" {
			w.Header().Set("Content-Type", "application/json")
			if r.URL.Path == "/agent/media-capabilities" {
				io.WriteString(w, `{"models":[]}`)
				return
			}
			if r.URL.Path == "/v1/models" {
				io.WriteString(w, `{"data":[{"id":"MiniMax-H3-Max"},{"id":"seedance-2.5"}]}`)
				return
			}
			if r.URL.Path == "/v1/videos/task_video_shared" {
				mu.Lock()
				captures = append(captures, map[string]any{"task_path": r.URL.Path})
				mu.Unlock()
				io.WriteString(w, `{"code":200,"data":{"task_id":"task_video_shared","status":"SUCCESS","result_url":"https://video.example/result.mp4","progress":100}}`)
				return
			}
		}
		if fixture.Image && r.Method == "GET" && strings.HasPrefix(r.URL.Path, "/v1/tasks/") && r.Header.Get("Authorization") == "Bearer synthetic-unified-only" {
			mu.Lock()
			captures = append(captures, map[string]any{"task_path": r.URL.Path})
			mu.Unlock()
			w.Header().Set("Content-Type", "application/json")
			io.WriteString(w, `{"data":{"id":"task_shared","status":"completed","result":{"images":[{"url":["https://images.example/generated.png"]}]}}}`)
			return
		}
		data, err := io.ReadAll(io.LimitReader(r.Body, appcore.MaxRequest+1))
		mu.Lock()
		nextIndex := len(captures)
		mu.Unlock()
		expectedPath := fixture.Path
		if len(fixture.Paths) > 0 {
			if nextIndex >= len(fixture.Paths) {
				w.WriteHeader(400)
				return
			}
			expectedPath = fixture.Paths[nextIndex]
		}
		if err != nil || len(data) > appcore.MaxRequest || r.URL.Path != expectedPath || r.Method != "POST" || r.Header.Get("Authorization") != "Bearer synthetic-unified-only" || expectedPath == "/v1/messages" && r.Header.Get("anthropic-version") != "2023-06-01" || r.Header.Get("X-MOMO-History") != "" {
			w.WriteHeader(400)
			return
		}
		var payload any
		if strings.HasPrefix(expectedPath, "/v1beta/models/") && r.URL.RawQuery != "alt=sse" {
			w.WriteHeader(400)
			return
		}
		if json.Unmarshal(data, &payload) != nil {
			w.WriteHeader(400)
			return
		}
		mu.Lock()
		captures = append(captures, payload)
		responseIndex := len(captures) - 1
		mu.Unlock()
		w.Header().Set("Content-Type", "text/event-stream")
		if fixture.JSON {
			w.Header().Set("Content-Type", "application/json")
		}
		if fixture.Status != 0 && fixture.Status != 200 {
			w.WriteHeader(fixture.Status)
			io.WriteString(w, "redacted synthetic failure")
			return
		}
		response := fixture.Stream
		if len(fixture.Streams) > 0 {
			if responseIndex >= len(fixture.Streams) {
				w.WriteHeader(500)
				return
			}
			response = fixture.Streams[responseIndex]
		}
		if fixture.Search && strings.Contains(string(data), "momo__client_tool_search") {
			response = strings.ReplaceAll(response, `"name":"tool_search"`, `"name":"momo__client_tool_search"`)
		}
		for _, b := range []byte(response) {
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
