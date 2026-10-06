package appcore

import (
	"context"
	"io"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestDesktopImagesReuseContractsAdmissionAndNoSecrets(t *testing.T) {
	var calls atomic.Int32
	c, _, _, _ := testCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.Header.Get("Authorization") != "Bearer "+syntheticKey {
			t.Error("auth")
		}
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/agent/media-capabilities":
			io.WriteString(w, fixtureImageCatalog("momoapi-gpt-image-2-5-flare"))
		case "/v1/images/generations":
			io.WriteString(w, `{"task_id":"desktop_one","status":"submitted"}`)
		case "/v1/tasks/desktop_one":
			io.WriteString(w, `{"status":"completed","url":"https://images.example/result.png"}`)
		default:
			t.Error("unexpected path")
		}
	}))
	for _, tc := range []struct {
		path, body string
		code       int
	}{{"/v1/models", "", 400}, {"/internal/images/tasks/foreign", "", 404}, {"/internal/images/tasks/../a", "", 400}, {"/internal/images/capabilities", "{}", 400}, {"/internal/images/generate", `{"model":"momoapi-gpt-image-2-5-flare","prompt":"hi"}`, 409}, {"/internal/images/capabilities", "", 200}, {"/internal/images/generate", `{"model":"momoapi-gpt-image-2-5-flare","prompt":"hi"}`, 200}, {"/internal/images/tasks/desktop_one", "", 200}} {
		data, code := c.DesktopImages(context.Background(), tc.path, []byte(tc.body))
		if code != tc.code {
			t.Fatal(tc.path, code)
		}
		if strings.Contains(string(data), syntheticKey) || strings.Contains(string(data), c.token) || strings.Contains(string(data), "private-do-not-expose") {
			t.Fatal("secret")
		}
	}
	if calls.Load() != 3 {
		t.Fatal("unexpected upstream count")
	}
	c.mu.Lock()
	c.active = 4
	c.mu.Unlock()
	_, code := c.DesktopImages(context.Background(), "/internal/images/capabilities", nil)
	if code != 503 || calls.Load() != 3 {
		t.Fatal("admission bypass")
	}
	c.mu.Lock()
	c.active = 0
	c.mu.Unlock()
	c.Stop()
	_, code = c.DesktopImages(context.Background(), "/internal/images/capabilities", nil)
	if code != 503 {
		t.Fatal("Stop bypass")
	}
}

func TestDesktopImagesStopCancelsPendingGenerationAndDrain(t *testing.T) {
	reached := make(chan struct{}, 1)
	release := make(chan struct{})
	defer close(release)
	c, _, _, _ := testCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/agent/media-capabilities" {
			io.WriteString(w, fixtureImageCatalog("momoapi-gpt-image-2-5-flare"))
			return
		}
		reached <- struct{}{}
		<-release
		io.WriteString(w, `{"task_id":"late_desktop","status":"submitted"}`)
	}))
	_, code := c.DesktopImages(context.Background(), "/internal/images/capabilities", nil)
	if code != 200 {
		t.Fatal(code)
	}
	done := make(chan int, 1)
	go func() {
		_, code := c.DesktopImages(context.Background(), "/internal/images/generate", []byte(`{"model":"momoapi-gpt-image-2-5-flare","prompt":"hi"}`))
		done <- code
	}()
	select {
	case <-reached:
	case <-time.After(time.Second):
		t.Fatal("desktop did not send")
	}
	waitActive(t, c, 1)
	c.Stop()
	select {
	case code := <-done:
		if code == 200 {
			t.Fatal("late desktop success")
		}
	case <-time.After(time.Second):
		t.Fatal("Stop did not cancel desktop")
	}
	waitActive(t, c, 0)
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.images.pending != 0 || len(c.images.tasks) != 0 {
		t.Fatal("desktop state retained")
	}
}
