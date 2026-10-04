package ui

import (
	"github.com/momo-api/momoapi-proxy/experimental/go-app/internal/appcore"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestStorePromptDoesNotBlockStatusOrStop(t *testing.T) {
	core, _ := appcore.New()
	defer core.Close()
	entered := make(chan struct{})
	release := make(chan struct{})
	done := make(chan struct{})
	defer func() { close(release); <-done }()
	h := HandlerWithActions("http://wails.localhost", core, Actions{SaveProfile: func(appcore.Config) error { close(entered); <-release; return nil }})
	call := func(path, body string) int {
		r := httptest.NewRequest("POST", path, strings.NewReader(body))
		r.Header.Set("Origin", "http://wails.localhost")
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w.Code
	}
	go func() {
		defer close(done)
		call("/app/configure", `{"Endpoint":"https://mock.example","APIKey":"synthetic-only","Remember":true}`)
	}()
	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("prompt not entered")
	}
	result := make(chan bool, 1)
	go func() {
		result <- call("/app/state", "") == 200 && call("/app/stop", "") == 200 && call("/app/start", "") == 409 && call("/app/quit", "") == 409
	}()
	select {
	case ok := <-result:
		if !ok {
			t.Fatal("pending action policy")
		}
	case <-time.After(time.Second):
		t.Fatal("prompt blocked control")
	}
}
