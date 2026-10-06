package appcore

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/momo-api/momoapi-proxy/experimental/go-app/internal/integration"
)

func TestImageMCPRealCoreTLSMockCatalogGenerateTaskNoSecrets(t *testing.T) {
	var calls atomic.Int32
	c, _, _, _ := testCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.Header.Get("Authorization") != "Bearer "+syntheticKey {
			t.Error("auth")
		}
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/agent/media-capabilities":
			io.WriteString(w, fixtureImageCatalog("momoapi-gpt-image-2-5-flare"))
		case "/v1/images/generations":
			var body map[string]any
			if r.Method != "POST" || json.NewDecoder(r.Body).Decode(&body) != nil || body["model"] != "momoapi-gpt-image-2-5-flare" || body["prompt"] != "MCP mock" || body["n"] != float64(1) || len(body) != 3 {
				t.Error("wire")
			}
			io.WriteString(w, `{"task_id":"mcp_one","status":"submitted"}`)
		case "/v1/tasks/mcp_one":
			io.WriteString(w, `{"status":"completed","url":"https://images.example/result.png"}`)
		default:
			t.Error("unexpected request")
		}
	}))
	request := func(id int, name, args string) string {
		b, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": id, "method": "tools/call", "params": map[string]any{"name": name, "arguments": json.RawMessage(args)}})
		return string(b) + "\n"
	}
	input := request(1, "image_generate", `{"confirmed":true,"request":{"model":"momoapi-gpt-image-2-5-flare","prompt":"MCP mock"}}`) + request(2, "image_task", `{"task_id":"foreign"}`) + request(3, "image_capabilities", "{}") + request(4, "image_generate", `{"confirmed":false,"request":{}}`) + request(5, "image_generate", `{"confirmed":true,"request":{"model":"momoapi-gpt-image-2-5-flare","prompt":"MCP mock"}}`) + request(6, "image_task", `{"task_id":"mcp_one"}`)
	var out bytes.Buffer
	if integration.ServeImageMCP(context.Background(), strings.NewReader(input), &out, c.DesktopImages) != nil || calls.Load() != 3 {
		t.Fatal("MCP real upstream count")
	}
	if strings.Contains(out.String(), syntheticKey) || strings.Contains(out.String(), c.token) || !strings.Contains(out.String(), "https://images.example/result.png") {
		t.Fatal("output")
	}
	lines := strings.Split(strings.TrimSpace(out.String()), "\n")
	if len(lines) != 6 || !strings.Contains(lines[0], `"isError":true`) || !strings.Contains(lines[1], `"isError":true`) || !strings.Contains(lines[3], "-32602") || strings.Contains(lines[4], `"isError":true`) {
		t.Fatal("result contract")
	}
	c.Stop()
	out.Reset()
	if integration.ServeImageMCP(context.Background(), strings.NewReader(request(7, "image_capabilities", "{}")), &out, c.DesktopImages) != nil || calls.Load() != 3 || !strings.Contains(out.String(), `"isError":true`) {
		t.Fatal("Stop bypass")
	}
}

func TestImageMCPCancelPendingOneSendNoLateTask(t *testing.T) {
	reached := make(chan struct{}, 1)
	release := make(chan struct{})
	defer close(release)
	var calls atomic.Int32
	c, _, _, _ := testCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/agent/media-capabilities" {
			io.WriteString(w, fixtureImageCatalog("momoapi-gpt-image-2-5-flare"))
			return
		}
		reached <- struct{}{}
		<-release
		io.WriteString(w, `{"task_id":"late_mcp","status":"submitted"}`)
	}))
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	input := `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"image_capabilities","arguments":{}}}
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"image_generate","arguments":{"confirmed":true,"request":{"model":"momoapi-gpt-image-2-5-flare","prompt":"pending"}}}}
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"image_capabilities","arguments":{}}}
`
	var out bytes.Buffer
	done := make(chan error, 1)
	go func() { done <- integration.ServeImageMCP(ctx, strings.NewReader(input), &out, c.DesktopImages) }()
	select {
	case <-reached:
	case <-time.After(time.Second):
		t.Fatal("send")
	}
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal("cancel error")
		}
	case <-time.After(time.Second):
		t.Fatal("cancel drain")
	}
	if calls.Load() != 2 || strings.Count(out.String(), "\n") != 1 {
		t.Fatal("late result/replay")
	}
	waitActive(t, c, 0)
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.images.tasks) != 0 || c.images.pending != 0 {
		t.Fatal("late publish")
	}
}
