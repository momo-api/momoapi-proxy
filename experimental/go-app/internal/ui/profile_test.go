package ui

import (
	"errors"
	"github.com/momo-api/momoapi-proxy/experimental/go-app/internal/appcore"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestExplicitSecureProfileActions(t *testing.T) {
	core, _ := appcore.New()
	defer core.Close()
	saved := appcore.Config{}
	saveCount, loadCount, forgetCount := 0, 0, 0
	fail := false
	h := HandlerWithActions("http://wails.localhost", core, Actions{
		SaveProfile: func(c appcore.Config) error {
			saveCount++
			if fail {
				return errors.New("synthetic backend secret")
			}
			saved = c
			return nil
		},
		LoadProfile:   func() (appcore.Config, error) { loadCount++; return saved, nil },
		ForgetProfile: func() error { forgetCount++; saved = appcore.Config{}; return nil },
	})
	call := func(path, body, origin string, want int) {
		t.Helper()
		r := httptest.NewRequest("POST", path, strings.NewReader(body))
		r.Header.Set("Origin", origin)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != want || strings.Contains(w.Body.String(), "synthetic-profile-key") || strings.Contains(w.Body.String(), "synthetic backend secret") {
			t.Fatal(path, w.Code, "unexpected status or secret leak")
		}
	}
	input := `{"Endpoint":"https://mock.example","APIKey":"synthetic-profile-key"}`
	call("/app/configure", input, "http://wails.localhost", 200)
	if saveCount != 0 {
		t.Fatal("implicit save")
	}
	remember := strings.TrimSuffix(input, "}") + ",\"Remember\":true}"
	call("/app/configure", remember, "https://evil.example", 403)
	if saveCount != 0 {
		t.Fatal("foreign save")
	}
	call("/app/configure", remember, "http://wails.localhost", 200)
	if saveCount != 1 {
		t.Fatal("save")
	}
	call("/app/load", "", "http://wails.localhost", 200)
	if loadCount != 1 {
		t.Fatal("load")
	}
	call("/app/start", "", "http://wails.localhost", 200)
	call("/app/load", "", "http://wails.localhost", 409)
	call("/app/configure", remember, "http://wails.localhost", 400)
	if saveCount != 1 || loadCount != 1 {
		t.Fatal("running store touched")
	}
	call("/app/forget", "", "https://evil.example", 403)
	call("/app/forget", "{}", "http://wails.localhost", 400)
	if forgetCount != 0 {
		t.Fatal("invalid forget")
	}
	call("/app/forget", "", "http://wails.localhost", 200)
	if forgetCount != 1 || !core.State().Running || !core.State().Configured {
		t.Fatal("forget affected current proxy")
	}
	call("/app/stop", "", "http://wails.localhost", 200)
	fail = true
	call("/app/configure", remember, "http://wails.localhost", 503)
	if !core.State().Configured {
		t.Fatal("save failure lost memory mode")
	}
}
