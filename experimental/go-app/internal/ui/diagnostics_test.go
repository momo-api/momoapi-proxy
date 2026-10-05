package ui

import (
	"encoding/json"
	"github.com/momo-api/momoapi-proxy/experimental/go-app/internal/appcore"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestDiagnosticsNativeGateRedactionAndNoPublicRoute(t *testing.T) {
	c, err := appcore.New()
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if c.Configure(appcore.Config{Endpoint: "https://synthetic-private-host.example", APIKey: "synthetic-private-diag-key"}) != nil {
		t.Fatal("configure")
	}
	for _, origin := range []string{"http://wails.localhost", "wails://localhost"} {
		h := HandlerWithActions(origin, c, Actions{AllowOpaqueOrigin: true})
		page := httptest.NewRecorder()
		h.ServeHTTP(page, httptest.NewRequest("GET", "/", nil))
		_, rest, _ := strings.Cut(page.Body.String(), "const bridgeNonce='")
		nonce, _, _ := strings.Cut(rest, "';")
		for _, tc := range []struct {
			method, origin, nonce, path, body string
			code                              int
		}{
			{"POST", origin, "", "/app/diagnostics", "", 403},
			{"POST", origin, "wrong", "/app/diagnostics", "", 403},
			{"POST", "https://evil.example", nonce, "/app/diagnostics", "", 403},
			{"GET", origin, nonce, "/app/diagnostics", "", 405},
			{"POST", origin, nonce, "/app/diagnostics?x=1", "", 400},
			{"POST", origin, nonce, "/app/diagnostics", "{}", 400},
			{"POST", origin, nonce, "/app/diagnostics", strings.Repeat("x", 8193), 413},
			{"POST", origin, nonce, "/app/diagnostics", "", 200},
		} {
			req := httptest.NewRequest(tc.method, tc.path, strings.NewReader(tc.body))
			req.Header.Set("Origin", tc.origin)
			req.Header.Set("X-MOMO-Bridge", tc.nonce)
			out := httptest.NewRecorder()
			h.ServeHTTP(out, req)
			if out.Code != tc.code {
				t.Fatal("diagnostic gate", out.Code, tc.code)
			}
			for _, secret := range []string{"synthetic-private-host", "synthetic-private-diag-key", nonce, "Endpoint", "api_key"} {
				if strings.Contains(out.Body.String(), secret) {
					t.Fatal("report leaked private content")
				}
			}
			if tc.code == 200 {
				var r appcore.DiagnosticReport
				if json.Unmarshal(out.Body.Bytes(), &r) != nil || r.Scope != "current-core" || !r.Gateway.Configured || r.VerifiedUpstream {
					t.Fatal("report scope")
				}
			}
		}
	}
	var connection map[string]string
	json.Unmarshal([]byte(c.ConnectionJSON()), &connection)
	for _, auth := range []bool{false, true} {
		req := httptest.NewRequest("POST", "/app/diagnostics", nil)
		if auth {
			req.Header.Set("Authorization", "Bearer "+connection["api_key"])
		}
		out := httptest.NewRecorder()
		c.Handler().ServeHTTP(out, req)
		want := 401
		if auth {
			want = 404
		}
		if out.Code != want {
			t.Fatal("public diagnostic route")
		}
	}
}

func TestDiagnosticsShortWriteAbortsWithoutRetry(t *testing.T) {
	c, _ := appcore.New()
	defer c.Close()
	h := Handler("http://wails.localhost", c)
	page := httptest.NewRecorder()
	h.ServeHTTP(page, httptest.NewRequest("GET", "/", nil))
	_, rest, _ := strings.Cut(page.Body.String(), "const bridgeNonce='")
	nonce, _, _ := strings.Cut(rest, "';")
	req := httptest.NewRequest("POST", "/app/diagnostics", nil)
	req.Header.Set("Origin", "http://wails.localhost")
	req.Header.Set("X-MOMO-Bridge", nonce)
	w := &diagnosticsShortWriter{header: make(http.Header)}
	defer func() {
		if recover() != http.ErrAbortHandler || w.calls != 1 {
			t.Error("short diagnostic delivery retry/success")
		}
	}()
	h.ServeHTTP(w, req)
}

type diagnosticsShortWriter struct {
	header http.Header
	calls  int
}

func (w *diagnosticsShortWriter) Header() http.Header         { return w.header }
func (w *diagnosticsShortWriter) WriteHeader(int)             {}
func (w *diagnosticsShortWriter) Write(b []byte) (int, error) { w.calls++; return len(b) - 1, nil }
