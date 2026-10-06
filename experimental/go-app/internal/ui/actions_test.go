package ui

import (
	"encoding/json"
	"errors"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/momo-api/momoapi-proxy/experimental/go-app/internal/appcore"
)

func TestNativeActionsAreOriginBoundAndReturnNoToken(t *testing.T) {
	core, err := appcore.New()
	if err != nil {
		t.Fatal(err)
	}
	defer core.Close()
	var copied, quit int
	actions := Actions{CopyConnection: func() error { copied++; return nil }, Quit: func() { quit++ }}
	for _, origin := range []string{"http://wails.localhost", "wails://localhost"} {
		h := HandlerWithActions(origin, core, actions)
		for _, path := range []string{"/app/copy", "/app/quit"} {
			for _, tc := range []struct {
				method, origin, body string
				code                 int
			}{
				{"POST", "", "", 403}, {"POST", "null", "", 403},
				{"POST", "https://evil.example", "", 403}, {"GET", origin, "", 405},
				{"POST", origin, "{}", 400},
			} {
				beforeCopy, beforeQuit := copied, quit
				r := httptest.NewRequest(tc.method, path, strings.NewReader(tc.body))
				r.Header.Set("Origin", tc.origin)
				w := httptest.NewRecorder()
				h.ServeHTTP(w, r)
				if w.Code != tc.code || copied != beforeCopy || quit != beforeQuit {
					t.Fatal("denied action executed", path, w.Code)
				}
			}
			r := httptest.NewRequest("POST", path, nil)
			r.Header.Set("Origin", origin)
			w := httptest.NewRecorder()
			h.ServeHTTP(w, r)
			if w.Code != 200 || strings.Contains(w.Body.String(), "api_key") || strings.Contains(w.Body.String(), core.ConnectionJSON()) {
				t.Fatal("native action leaked credentials")
			}
		}
	}
	if copied != 2 || quit != 2 {
		t.Fatal("native actions not called")
	}
	for _, actions := range []Actions{{}, {CopyConnection: func() error { return errors.New("synthetic-clipboard-error-secret") }}} {
		r := httptest.NewRequest("POST", "/app/copy", nil)
		r.Header.Set("Origin", "http://wails.localhost")
		w := httptest.NewRecorder()
		HandlerWithActions("http://wails.localhost", core, actions).ServeHTTP(w, r)
		if w.Code != 503 || strings.Contains(w.Body.String(), "synthetic-clipboard-error-secret") {
			t.Fatal("clipboard error reflected")
		}
	}
}

func TestCodexExportClipboardFailuresAreRedactedAndNotPublic(t *testing.T) {
	c, err := appcore.New()
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	for _, actions := range []Actions{{}, {CopyCodexConfig: func() error { return errors.New("synthetic-private-clipboard-error") }}} {
		r := httptest.NewRequest("POST", "/app/codex-config", nil)
		r.Header.Set("Origin", "http://wails.localhost")
		w := httptest.NewRecorder()
		HandlerWithActions("http://wails.localhost", c, actions).ServeHTTP(w, r)
		if w.Code != 503 || strings.Contains(w.Body.String(), "synthetic-private") || strings.Contains(w.Body.String(), "api_key") {
			t.Fatal("client export error leaked or claimed success")
		}
	}
	r := httptest.NewRequest("POST", "/app/codex-config", nil)
	w := httptest.NewRecorder()
	c.Handler().ServeHTTP(w, r)
	if w.Code != 401 {
		t.Fatal("client export exposed on unauthenticated TCP")
	}
	var connection map[string]string
	if json.Unmarshal([]byte(c.ConnectionJSON()), &connection) != nil {
		t.Fatal("test connection")
	}
	r.Header.Set("Authorization", "Bearer "+connection["api_key"])
	w = httptest.NewRecorder()
	c.Handler().ServeHTTP(w, r)
	if w.Code != 404 {
		t.Fatal("client export became public TCP route")
	}
}
