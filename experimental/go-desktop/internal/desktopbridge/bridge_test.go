package desktopbridge

import (
	"context"
	"errors"
	"github.com/momo-api/momoapi-proxy/experimental/go-desktop/internal/control"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestBoundary(t *testing.T) {
	for _, origin := range []string{"http://wails.localhost", "wails://localhost"} {
		for _, tc := range []struct {
			method, path, origin, body string
			code                       int
			calls                      int
		}{
			{"GET", "/", "", "", 200, 0},
			{"POST", "/demo/state", origin, "", 200, 1},
			{"POST", "/demo/start", origin, "", 200, 1},
			{"POST", "/demo/stop", origin, "", 200, 1},
			{"POST", "/demo/state", "", "", 403, 0},
			{"POST", "/demo/start", "null", "", 403, 0},
			{"GET", "/demo/state", "https://evil.example", "", 403, 0},
			{"POST", "/demo/start", origin + ".evil", "", 403, 0},
			{"GET", "/demo/start", origin, "", 405, 0},
			{"POST", "/demo/start?", origin, "", 400, 0},
			{"POST", "/demo/start?x=1", origin, "", 400, 0},
			{"POST", "/demo/start", origin, strings.Repeat("x", 8192), 400, 0},
			{"POST", "/shell", origin, "", 404, 0},
		} {
			calls := 0
			h := Handler("demo", origin, func(context.Context, string) (control.State, error) {
				calls++
				return control.State{Protocol: 1, Experimental: true}, nil
			})
			req := httptest.NewRequest(tc.method, tc.path, strings.NewReader(tc.body))
			req.Header.Set("Origin", tc.origin)
			w := httptest.NewRecorder()
			h.ServeHTTP(w, req)
			if w.Code != tc.code || calls != tc.calls {
				t.Fatalf("%s %s: code=%d calls=%d", tc.method, tc.path, w.Code, calls)
			}
			if w.Header().Get("Access-Control-Allow-Origin") != "" {
				t.Fatal("unexpected CORS")
			}
		}
	}
}
func TestErrorSanitization(t *testing.T) {
	h := Handler("demo", "http://wails.localhost", func(context.Context, string) (control.State, error) {
		return control.State{}, errors.New("private-session-error")
	})
	req := httptest.NewRequest("POST", "/demo/state", nil)
	req.Header.Set("Origin", "http://wails.localhost")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != 503 || strings.Contains(w.Body.String(), "private-session-error") {
		t.Fatal("unsanitized failure")
	}
}

func TestInvalidConfiguredOriginFailsClosed(t *testing.T) {
	for _, origin := range []string{"", "https://evil.example"} {
		called := false
		h := Handler("demo", origin, func(context.Context, string) (control.State, error) { called = true; return control.State{}, nil })
		req := httptest.NewRequest("POST", "/demo/start", nil)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, req)
		if w.Code != 503 || called {
			t.Fatal("invalid configuration allowed call")
		}
	}
}
