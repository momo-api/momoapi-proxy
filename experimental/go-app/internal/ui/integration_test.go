package ui

import (
	"github.com/momo-api/momoapi-proxy/experimental/go-app/internal/appcore"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestExplicitIntegrationAndQuotaBoundary(t *testing.T) {
	c, _ := appcore.New()
	defer c.Close()
	skill, mcp := 0, 0
	h := HandlerWithActions("http://wails.localhost", c, Actions{
		CopySkill: func() error { skill++; return nil }, CopyMCPConfig: func() error { mcp++; return nil },
	})
	for _, path := range []string{"/app/skill", "/app/mcp-config", "/app/quota"} {
		for _, tc := range []struct {
			origin, body string
			want         int
		}{{"https://evil.example", "", 403}, {"null", "", 403}, {"", "", 403}, {"http://wails.localhost", "{}", 400}} {
			req := httptest.NewRequest("POST", path, strings.NewReader(tc.body))
			req.Header.Set("Origin", tc.origin)
			w := httptest.NewRecorder()
			h.ServeHTTP(w, req)
			if w.Code != tc.want {
				t.Fatal("export/query boundary", path, w.Code)
			}
		}
	}
	if skill != 0 || mcp != 0 {
		t.Fatal("unapproved export")
	}
	for _, path := range []string{"/app/skill", "/app/mcp-config"} {
		req := httptest.NewRequest("POST", path, nil)
		req.Header.Set("Origin", "http://wails.localhost")
		w := httptest.NewRecorder()
		h.ServeHTTP(w, req)
		if w.Code != 200 || strings.Contains(w.Body.String(), "api_key") {
			t.Fatal("export")
		}
	}
	if skill != 1 || mcp != 1 {
		t.Fatal("missing explicit export")
	}
	req := httptest.NewRequest("POST", "/app/quota", nil)
	req.Header.Set("Origin", "http://wails.localhost")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != 502 {
		t.Fatal("unconfigured query accepted")
	}
	// These actions must not become public local TCP APIs.
	req = httptest.NewRequest("POST", "/app/quota", nil)
	w = httptest.NewRecorder()
	c.Handler().ServeHTTP(w, req)
	if w.Code != 401 {
		t.Fatal("TCP account route exposed")
	}
}
