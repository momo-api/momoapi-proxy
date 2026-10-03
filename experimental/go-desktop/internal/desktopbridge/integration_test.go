package desktopbridge

import (
	"context"
	"encoding/json"
	"github.com/momo-api/momoapi-proxy/experimental/go-desktop/internal/control"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestBridgeDetachDoesNotStopForegroundOwner(t *testing.T) {
	token := strings.Repeat("abcdef01", 8) // synthetic session
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	ready := make(chan string, 1)
	done := make(chan error, 1)
	go func() { done <- control.Serve(ctx, token, func(endpoint string) { ready <- endpoint }) }()
	var endpoint string
	select {
	case endpoint = <-ready:
	case <-time.After(5 * time.Second):
		t.Fatal("readiness timeout")
	}
	session := control.Session{Endpoint: endpoint, Token: token}
	func() {
		h := Handler("demo", "http://wails.localhost", func(ctx context.Context, action string) (control.State, error) {
			return control.Call(ctx, session, action)
		})
		req := httptest.NewRequest("POST", "/demo/start", nil)
		req.Header.Set("Origin", "http://wails.localhost")
		w := httptest.NewRecorder()
		h.ServeHTTP(w, req)
		var state control.State
		if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &state) != nil || !state.DemoRunning {
			t.Fatal("bridge roundtrip failed")
		}
	}() // bridge/client lifetime ends; owner remains separately controlled
	state, err := control.Call(context.Background(), session, "state")
	if err != nil || !state.DemoRunning {
		t.Fatal("owner interrupted by detached bridge")
	}
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("owner shutdown timeout")
	}
}
