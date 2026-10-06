package ui

import (
	"github.com/momo-api/momoapi-proxy/experimental/go-app/internal/appcore"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestConfigureStateNoSecretsAndOrigins(t *testing.T) {
	core, err := appcore.New()
	if err != nil {
		t.Fatal(err)
	}
	defer core.Close()
	for _, origin := range []string{"http://wails.localhost", "wails://localhost"} {
		handler := Handler(origin, core)
		for _, o := range []string{"", "null", "https://evil.example"} {
			r := httptest.NewRequest("POST", "/app/state", nil)
			r.Header.Set("Origin", o)
			w := httptest.NewRecorder()
			handler.ServeHTTP(w, r)
			if w.Code != 403 {
				t.Fatal(o, w.Code)
			}
		}
		r := httptest.NewRequest("POST", "/app/configure", strings.NewReader(`{"Endpoint":"https://momoapi.us","APIKey":"synthetic-only-input"}`))
		r.Header.Set("Origin", origin)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		if w.Code != 200 || strings.Contains(w.Body.String(), "synthetic-only-input") || strings.Contains(w.Body.String(), "api_key") {
			t.Fatal("key state leak", w.Code)
		}
		if w.Header().Get("Access-Control-Allow-Origin") != "" {
			t.Fatal("CORS")
		}
		r = httptest.NewRequest("POST", "/app/state?x=1", nil)
		r.Header.Set("Origin", origin)
		w = httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		if w.Code != 400 {
			t.Fatal("query")
		}
		r = httptest.NewRequest("POST", "/app/token", nil)
		r.Header.Set("Origin", origin)
		w = httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		if w.Code != 404 {
			t.Fatal("token route")
		}
	}
	if strings.Contains(Page, "localToken") || strings.Contains(Page, "api_key") {
		t.Fatal("token exposed in page")
	}
}
