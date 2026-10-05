package ui

import (
	"encoding/json"
	"errors"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/momo-api/momoapi-proxy/experimental/go-app/internal/appcore"
)

func TestCodexCatalogClipboardIsExplicitPrivateAndBounded(t *testing.T) {
	c, err := appcore.New()
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	for _, origin := range []string{"http://wails.localhost", "wails://localhost"} {
		calls := 0
		h := HandlerWithActions(origin, c, Actions{AllowOpaqueOrigin: origin == "wails://localhost", CopyCodexCatalog: func() error { calls++; return nil }})
		page := httptest.NewRecorder()
		h.ServeHTTP(page, httptest.NewRequest("GET", "/", nil))
		_, rest, ok := strings.Cut(page.Body.String(), "const bridgeNonce='")
		if !ok {
			t.Fatal("missing page capability")
		}
		nonce, _, ok := strings.Cut(rest, "';")
		if !ok || len(nonce) != 64 || calls != 0 {
			t.Fatal("startup export")
		}
		for _, tc := range []struct {
			method, origin, nonce, path, body string
			code                              int
		}{
			{"POST", origin, "", "/app/codex-catalog", "", 403},
			{"POST", origin, "wrong", "/app/codex-catalog", "", 403},
			{"POST", "https://evil.example", nonce, "/app/codex-catalog", "", 403},
			{"GET", origin, nonce, "/app/codex-catalog", "", 405},
			{"POST", origin, nonce, "/app/codex-catalog?x=1", "", 400},
			{"POST", origin, nonce, "/app/codex-catalog", "{}", 400},
			{"POST", origin, nonce, "/app/codex-catalog", strings.Repeat("x", 8193), 413},
		} {
			req := httptest.NewRequest(tc.method, tc.path, strings.NewReader(tc.body))
			req.Header.Set("Origin", tc.origin)
			req.Header.Set("X-MOMO-Bridge", tc.nonce)
			out := httptest.NewRecorder()
			h.ServeHTTP(out, req)
			if out.Code != tc.code || calls != 0 {
				t.Fatal("unapproved export", out.Code, tc.code)
			}
		}
		req := httptest.NewRequest("POST", "/app/codex-catalog", nil)
		req.Header.Set("Origin", origin)
		req.Header.Set("X-MOMO-Bridge", nonce)
		out := httptest.NewRecorder()
		h.ServeHTTP(out, req)
		if out.Code != 200 || calls != 1 || strings.Contains(out.Body.String(), "api_key") || strings.Contains(out.Body.String(), "models") || strings.Contains(out.Body.String(), nonce) {
			t.Fatal("export leaked contents or did not run")
		}
		for _, actions := range []Actions{{}, {CopyCodexCatalog: func() error { return errors.New("synthetic-private") }}} {
			denied := HandlerWithActions(origin, c, actions)
			root := httptest.NewRecorder()
			denied.ServeHTTP(root, httptest.NewRequest("GET", "/", nil))
			_, rest, _ := strings.Cut(root.Body.String(), "const bridgeNonce='")
			n, _, _ := strings.Cut(rest, "';")
			req.Header.Set("X-MOMO-Bridge", n)
			out = httptest.NewRecorder()
			denied.ServeHTTP(out, req)
			if out.Code != 503 || strings.Contains(out.Body.String(), "synthetic-private") {
				t.Fatal("clipboard failure reflected or claimed success")
			}
		}
	}
	req := httptest.NewRequest("POST", "/app/codex-catalog", nil)
	out := httptest.NewRecorder()
	c.Handler().ServeHTTP(out, req)
	if out.Code != 401 {
		t.Fatal("catalog exposed on TCP")
	}
	var connection map[string]string
	if json.Unmarshal([]byte(c.ConnectionJSON()), &connection) != nil {
		t.Fatal("test connection")
	}
	req.Header.Set("Authorization", "Bearer "+connection["api_key"])
	out = httptest.NewRecorder()
	c.Handler().ServeHTTP(out, req)
	if out.Code != 404 {
		t.Fatal("catalog export became authenticated TCP API")
	}
}
