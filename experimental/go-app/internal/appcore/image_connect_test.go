package appcore

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/momo-api/momoapi-proxy/experimental/go-app/internal/integration"
)

func TestConnectedImageMCPRealGatewayTLSMockSharedTasksAndStop(t *testing.T) {
	var calls atomic.Int32
	c, endpoint, _, _ := testCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.Header.Get("Authorization") != "Bearer "+syntheticKey {
			t.Error("upstream auth")
		}
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/agent/media-capabilities":
			io.WriteString(w, fixtureImageCatalog("momoapi-gpt-image-2-5-flare"))
		case "/v1/images/generations":
			io.WriteString(w, `{"task_id":"connected_one","status":"submitted"}`)
		case "/v1/tasks/connected_one":
			io.WriteString(w, `{"status":"completed","url":"https://images.example/connected.png"}`)
		default:
			t.Error("route")
		}
	}))
	dispatch, closeClient, err := integration.NewLocalImageDispatch(endpoint, c.token)
	if err != nil {
		t.Fatal("connect")
	}
	defer closeClient()
	input := `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"image_capabilities","arguments":{}}}
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"image_generate","arguments":{"confirmed":true,"request":{"model":"momoapi-gpt-image-2-5-flare","prompt":"connected mock"}}}}
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"image_task","arguments":{"task_id":"connected_one"}}}
`
	var out bytes.Buffer
	if integration.ServeImageMCP(context.Background(), strings.NewReader(input), &out, dispatch) != nil || calls.Load() != 3 || strings.Contains(out.String(), c.token) || strings.Contains(out.String(), syntheticKey) || !strings.Contains(out.String(), "https://images.example/connected.png") {
		t.Fatal("real connected TCP/TLS")
	}
	// Client EOF does not stop the gateway, and tasks are shared with the GUI/API.
	if !c.State().Running {
		t.Fatal("connector owned gateway")
	}
	_, code := c.DesktopImages(context.Background(), "/internal/images/tasks/connected_one", nil)
	if code != 200 || calls.Load() != 4 {
		t.Fatal("shared task")
	}
	c.Stop()
	if _, code := dispatch(context.Background(), "/internal/images/tasks/connected_one", nil); code == 200 || calls.Load() != 4 {
		t.Fatal("Stop bypass")
	}
	if err := c.Start(); err != nil {
		t.Fatal("restart")
	}
	if _, code := dispatch(context.Background(), "/internal/images/tasks/connected_one", nil); code == 200 || calls.Load() != 4 {
		t.Fatal("cleared task imported")
	}
}
