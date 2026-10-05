package ui

import (
	"errors"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/momo-api/momoapi-proxy/experimental/go-app/internal/appcore"
)

func TestVideoMCPExportCapabilityRunningAndNoCredentials(t *testing.T) {
	c, _ := appcore.New()
	defer c.Close()
	copies := 0
	h := HandlerWithActions("http://wails.localhost", c, Actions{CopyVideoMCPConfig: func() error { copies++; return nil }})
	nonce := pageCapability(t, h)
	for _, tc := range []struct {
		origin, nonce, body string
		code                int
	}{{"http://wails.localhost", "", "", 403}, {"https://evil.example", nonce, "", 403}, {"http://wails.localhost", nonce, "{}", 400}, {"http://wails.localhost", nonce, "", 409}} {
		r := httptest.NewRequest("POST", "/app/video-mcp-config", strings.NewReader(tc.body))
		r.Header.Set("Origin", tc.origin)
		r.Header.Set("X-MOMO-Bridge", tc.nonce)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != tc.code {
			t.Fatal("boundary", w.Code)
		}
	}
	if copies != 0 {
		t.Fatal("unapproved export")
	}
	if c.Configure(appcore.Config{Endpoint: "https://example.com", APIKey: "synthetic-export-only"}) != nil || c.Start() != nil {
		t.Fatal("start")
	}
	r := httptest.NewRequest("POST", "/app/video-mcp-config", nil)
	r.Header.Set("Origin", "http://wails.localhost")
	r.Header.Set("X-MOMO-Bridge", nonce)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 200 || copies != 1 || strings.Contains(w.Body.String(), "synthetic-export-only") || strings.Contains(w.Body.String(), "MOMO_LOCAL_API_KEY") {
		t.Fatal("clipboard not page")
	}
	bad := HandlerWithActions("http://wails.localhost", c, Actions{CopyVideoMCPConfig: func() error { return errors.New("synthetic-private") }})
	r.Header.Set("X-MOMO-Bridge", pageCapability(t, bad))
	w = httptest.NewRecorder()
	bad.ServeHTTP(w, r)
	if w.Code != 503 || strings.Contains(w.Body.String(), "synthetic-private") {
		t.Fatal("error redaction")
	}
}

func TestVideoMCPExportOpaqueOriginRequiresOwnPageCapability(t *testing.T) {
	c, _ := appcore.New()
	defer c.Close()
	if c.Configure(appcore.Config{Endpoint: "https://example.com", APIKey: "synthetic-export-only"}) != nil || c.Start() != nil {
		t.Fatal("start")
	}
	copies := 0
	h := HandlerWithActions("wails://localhost", c, Actions{AllowOpaqueOrigin: true, CopyVideoMCPConfig: func() error { copies++; return nil }})
	nonce := pageCapability(t, h)
	for _, tc := range []struct {
		origin, nonce string
		code          int
	}{{"null", "", 403}, {"", "", 403}, {"wails://localhost", "wrong", 403}, {"https://evil.example", nonce, 403}, {"null", nonce, 200}, {"", nonce, 200}} {
		r := httptest.NewRequest("POST", "/app/video-mcp-config", nil)
		r.Header.Set("Origin", tc.origin)
		r.Header.Set("X-MOMO-Bridge", tc.nonce)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != tc.code {
			t.Fatal("opaque capability", w.Code)
		}
	}
	if copies != 2 {
		t.Fatal("export count")
	}
	other := HandlerWithActions("wails://localhost", c, Actions{AllowOpaqueOrigin: true, CopyVideoMCPConfig: func() error { copies++; return nil }})
	r := httptest.NewRequest("POST", "/app/video-mcp-config", nil)
	r.Header.Set("Origin", "null")
	r.Header.Set("X-MOMO-Bridge", nonce)
	w := httptest.NewRecorder()
	other.ServeHTTP(w, r)
	if w.Code != 403 || copies != 2 {
		t.Fatal("cross page")
	}
}
