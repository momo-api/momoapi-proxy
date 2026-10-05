package integration

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestVideoMCPConnectionExportAndValidation(t *testing.T) {
	for _, endpoint := range []string{"", "http://localhost:1234", "http://127.0.0.1:01", "http://127.0.0.1:0", "http://127.0.0.1:65536", "http://127.0.0.1:1/", "http://127.0.0.1:1#", "http://127.0.0.1:1?", "https://127.0.0.1:1", "http://user@127.0.0.1:1", "http://[::1]:1", "http://example.com:1"} {
		if _, err := VideoMCPConfig("preview", endpoint); err == nil {
			t.Fatal("endpoint export")
		}
		if _, _, err := NewLocalVideoDispatch(endpoint, syntheticLocalToken); err == nil {
			t.Fatal("endpoint dispatch")
		}
	}
	for _, key := range []string{"", "synthetic-not-session", strings.Repeat("g", 64), strings.ToUpper(syntheticLocalToken), syntheticLocalToken + "\n"} {
		if _, _, err := NewLocalVideoDispatch("http://127.0.0.1:1234", key); err == nil {
			t.Fatal("token")
		}
	}
	text, err := VideoMCPConfig(`C:\Program Files\MOMO\preview.exe`, "http://127.0.0.1:1234")
	var config struct {
		MCPServers map[string]struct {
			Command string
			Args    []string
			Env     any
		}
	}
	if err != nil || json.Unmarshal([]byte(text), &config) != nil {
		t.Fatal("config")
	}
	c := config.MCPServers["momo-videos-preview"]
	if c.Command != `C:\Program Files\MOMO\preview.exe` || strings.Join(c.Args, ",") != "mcp-videos-connect,--endpoint,http://127.0.0.1:1234" || c.Env != nil || strings.Contains(text, "api_key") || strings.Contains(text, syntheticLocalToken) {
		t.Fatal("export scope")
	}
}

func TestConnectedVideoMCPExactTCPNoQueriesUntilCall(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.Header.Get("Authorization") != "Bearer "+syntheticLocalToken || r.Header.Get("Origin") != "" || r.Header.Get("Sec-Fetch-Mode") != "" {
			t.Error("headers")
		}
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/internal/videos/capabilities":
			if r.Method != "GET" {
				t.Error("method")
			}
			io.WriteString(w, `{"models":[]}`)
		case "/internal/videos/generate":
			b, _ := io.ReadAll(r.Body)
			if r.Method != "POST" || string(b) != `{"model":"chosen","prompt":"hi"}` {
				t.Error("wire")
			}
			io.WriteString(w, `{"task_id":"one._:-1","images":[],"terminal":false}`)
		case "/internal/videos/tasks/one._:-1":
			if r.Method != "GET" {
				t.Error("method")
			}
			io.WriteString(w, `{"task_id":"one._:-1","images":[],"terminal":true}`)
		default:
			t.Error("arbitrary route")
		}
	}))
	defer server.Close()
	dispatch, closeClient, err := NewLocalVideoDispatch(server.URL, syntheticLocalToken)
	if err != nil {
		t.Fatal("connect")
	}
	defer closeClient()
	var out bytes.Buffer
	input := `{"jsonrpc":"2.0","id":1,"method":"initialize"}
{"jsonrpc":"2.0","id":2,"method":"tools/list"}
`
	if ServeVideoMCP(context.Background(), strings.NewReader(input), &out, dispatch) != nil || calls.Load() != 0 {
		t.Fatal("automatic query")
	}
	for _, p := range []string{"/v1/models", "/internal/images/capabilities", "/internal/images/generate", "/internal/videos/tasks/../a", "/internal/videos/tasks/a?x=1", "http://evil.example"} {
		if _, code := dispatch(context.Background(), p, nil); code != 400 {
			t.Fatal("arbitrary dispatch")
		}
	}
	input = videoCall("3", "video_capabilities", "{}") + "\n" + videoCall("4", "video_generate", `{"confirmed":true,"request":{"model":"chosen","prompt":"hi"}}`) + "\n" + videoCall("5", "video_task", `{"task_id":"one._:-1"}`) + "\n"
	if ServeVideoMCP(context.Background(), strings.NewReader(input), &out, dispatch) != nil || calls.Load() != 3 || strings.Contains(out.String(), syntheticLocalToken) {
		t.Fatal("connected stream")
	}
}

func TestConnectedVideoMCPNoRedirectRetryReflectionAndCancellation(t *testing.T) {
	var redirected, calls atomic.Int32
	target := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { redirected.Add(1) }))
	defer target.Close()
	for _, response := range []string{"redirect", "401", "429", "500", "badmime", "badjson", "badutf8", "oversize", "token"} {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			calls.Add(1)
			w.Header().Set("Content-Type", "application/json")
			switch response {
			case "redirect":
				http.Redirect(w, r, target.URL, 307)
			case "401":
				w.WriteHeader(401)
				io.WriteString(w, "synthetic-private")
			case "429":
				w.WriteHeader(429)
				io.WriteString(w, "synthetic-private")
			case "500":
				w.WriteHeader(500)
				io.WriteString(w, "synthetic-private")
			case "badmime":
				w.Header().Set("Content-Type", "text/html")
				io.WriteString(w, "synthetic-private")
			case "badjson":
				io.WriteString(w, "synthetic-private")
			case "badutf8":
				w.Write([]byte("\xff"))
			case "oversize":
				io.WriteString(w, strings.Repeat(" ", 16<<20)+"{}")
			case "token":
				io.WriteString(w, `{"task_id":"`+syntheticLocalToken+`"}`)
			}
		}))
		dispatch, closeClient, err := NewLocalVideoDispatch(server.URL, syntheticLocalToken)
		if err != nil {
			t.Fatal("connect")
		}
		data, code := dispatch(context.Background(), "/internal/videos/capabilities", nil)
		closeClient()
		server.Close()
		if code == 200 || len(data) != 0 {
			t.Fatal("reflection")
		}
	}
	if calls.Load() != 9 || redirected.Load() != 0 {
		t.Fatal("redirect/retry")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	dispatch, closeClient, err := NewLocalVideoDispatch(target.URL, syntheticLocalToken)
	if err != nil {
		t.Fatal("connect")
	}
	defer closeClient()
	if data, code := dispatch(ctx, "/internal/videos/capabilities", nil); code == 200 || len(data) != 0 || redirected.Load() != 0 {
		t.Fatal("cancel bypass")
	}
}

func TestConnectedVideoMCPPendingCancellationNoReplay(t *testing.T) {
	reached := make(chan struct{}, 1)
	release := make(chan struct{})
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		reached <- struct{}{}
		<-release
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, "{}")
	}))
	defer func() { close(release); server.Close() }()
	dispatch, closeClient, err := NewLocalVideoDispatch(server.URL, syntheticLocalToken)
	if err != nil {
		t.Fatal("connect")
	}
	defer closeClient()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan int, 1)
	go func() { _, code := dispatch(ctx, "/internal/videos/generate", []byte("{}")); done <- code }()
	select {
	case <-reached:
	case <-time.After(time.Second):
		t.Fatal("send")
	}
	cancel()
	select {
	case code := <-done:
		if code == 200 {
			t.Fatal("late success")
		}
	case <-time.After(time.Second):
		t.Fatal("pending cancel")
	}
	if calls.Load() != 1 {
		t.Fatal("replay")
	}
}
