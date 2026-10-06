package ui

import (
	"errors"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/momo-api/momoapi-proxy/experimental/go-app/internal/appcore"
)

func TestVideoBridgeCapabilityStrictConfirmationAndPaths(t *testing.T) {
	c, _ := appcore.New()
	defer c.Close()
	for _, origin := range []string{"http://wails.localhost", "wails://localhost"} {
		h := HandlerWithActions(origin, c, Actions{AllowOpaqueOrigin: true})
		nonce := pageCapability(t, h)
		for _, tc := range []struct {
			path, origin, nonce, body string
			code                      int
		}{
			{"catalog", origin, "", "", 403}, {"generate", origin, "wrong", `{"confirmed":true,"request":{}}`, 403}, {"task", "https://evil.example", nonce, `{"task_id":"a"}`, 403},
			{"catalog", origin, nonce, "{}", 400}, {"catalog", origin, nonce, "", 503},
			{"generate", origin, nonce, `{"confirmed":false,"confirmed":true,"request":{}}`, 400},
			{"generate", origin, nonce, `{"confirmed":true,"request":{"model":"a","model":"b"}}`, 400},
			{"generate", origin, nonce, `{"confirmed":true,"request":null}`, 400},
			{"generate", origin, nonce, `{"confirmed":true,"request":{},"extra":1}`, 400},
			{"generate", origin, nonce, `{"confirmed":true,"request":{}}`, 503},
			{"task", origin, nonce, `{"task_id":"../a"}`, 400}, {"task", origin, nonce, `{"task_id":"a","confirmed":false}`, 400}, {"task", origin, nonce, `{"task_id":"a"}`, 503},
			{"catalog", "null", nonce, "", originCode(origin)},
			{"edit", origin, nonce, "", 404}, {"generate", origin, nonce, strings.Repeat("a", (160<<10)+1), 413},
		} {
			r := httptest.NewRequest("POST", "/app/videos/"+tc.path, strings.NewReader(tc.body))
			r.Header.Set("Origin", tc.origin)
			r.Header.Set("X-MOMO-Bridge", tc.nonce)
			w := httptest.NewRecorder()
			h.ServeHTTP(w, r)
			if w.Code != tc.code {
				t.Fatal(tc.path, w.Code, tc.code)
			}
			if strings.Contains(w.Body.String(), nonce) {
				t.Fatal("capability reflection")
			}
		}
		other := HandlerWithActions(origin, c, Actions{AllowOpaqueOrigin: true})
		r := httptest.NewRequest("POST", "/app/videos/catalog", nil)
		r.Header.Set("Origin", origin)
		r.Header.Set("X-MOMO-Bridge", nonce)
		w := httptest.NewRecorder()
		other.ServeHTTP(w, r)
		if w.Code != 403 {
			t.Fatal("cross-page")
		}
	}
}

func TestVideoBridgeSharesNativeAdmissionWithoutBlockingStop(t *testing.T) {
	c, _ := appcore.New()
	defer c.Close()
	entered, release, done := make(chan struct{}), make(chan struct{}), make(chan struct{})
	h := HandlerWithActions("http://wails.localhost", c, Actions{Quit: func() {}, LoadProfile: func() (appcore.Config, error) {
		close(entered)
		<-release
		return appcore.Config{}, errors.New("synthetic lock test")
	}})
	nonce := pageCapability(t, h)
	send := func(path string) int {
		r := httptest.NewRequest("POST", path, nil)
		r.Header.Set("Origin", "http://wails.localhost")
		r.Header.Set("X-MOMO-Bridge", nonce)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w.Code
	}
	go func() { send("/app/load"); close(done) }()
	defer func() { close(release); <-done }()
	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("native action did not enter")
	}
	for _, path := range []string{"/app/videos/catalog", "/app/images/catalog"} {
		if code := send(path); code != 409 {
			t.Fatal("shared admission", path, code)
		}
	}
	for _, path := range []string{"/app/state", "/app/stop", "/app/quit"} {
		if code := send(path); code != 200 {
			t.Fatal("control unavailable", path, code)
		}
	}
}

func TestVideoBridgeJSONDepthAndDuplicateBoundaries(t *testing.T) {
	for _, bad := range []string{`{"a":{"x":1,"x":2}}`, strings.Repeat("[", 66) + "0" + strings.Repeat("]", 66), `{} {}`, `{"a":`} {
		if strictVideoAction([]byte(bad)) {
			t.Fatal("unsafe JSON accepted")
		}
	}
	if !strictVideoAction([]byte(`{"a":[{"x":1},{"x":2}]}`)) {
		t.Fatal("sibling keys are not duplicates")
	}
}
func originCode(origin string) int {
	if origin == "wails://localhost" {
		return 503
	}
	return 403
}
