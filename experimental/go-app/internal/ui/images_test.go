package ui

import (
	"github.com/momo-api/momoapi-proxy/experimental/go-app/internal/appcore"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func pageCapability(t *testing.T, h http.Handler) string {
	t.Helper()
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("GET", "/", nil))
	_, rest, ok := strings.Cut(w.Body.String(), "const bridgeNonce='")
	if !ok {
		t.Fatal("page capability")
	}
	nonce, _, ok := strings.Cut(rest, "';")
	if !ok || len(nonce) != 64 {
		t.Fatal("invalid capability")
	}
	return nonce
}

func TestImageDesktopBridgeRequiresPageCapabilityConfirmationAndExactActions(t *testing.T) {
	c, _ := appcore.New()
	defer c.Close()
	for _, origin := range []string{"http://wails.localhost", "wails://localhost"} {
		h := HandlerWithActions(origin, c, Actions{AllowOpaqueOrigin: true})
		nonce := pageCapability(t, h)
		for _, tc := range []struct {
			path, origin, nonce, body string
			code                      int
		}{
			{"/app/images/catalog", origin, "", "", 403}, {"/app/images/generate", origin, "wrong", `{"confirmed":true,"request":{}}`, 403}, {"/app/images/task", "https://evil.example", nonce, `{"task_id":"a"}`, 403},
			{"/app/images/catalog", origin, nonce, "{}", 400}, {"/app/images/catalog", origin, nonce, "", 503},
			{"/app/images/generate", origin, nonce, `{"request":{}}`, 400}, {"/app/images/generate", origin, nonce, `{"confirmed":false,"request":{}}`, 400}, {"/app/images/generate", origin, nonce, `{"confirmed":true,"request":{},"extra":1}`, 400}, {"/app/images/generate", origin, nonce, `{"confirmed":true,"request":{}}{}`, 400}, {"/app/images/generate", origin, nonce, `{"confirmed":true,"request":{}}`, 503},
			{"/app/images/task", origin, nonce, `{"task_id":"../a"}`, 400}, {"/app/images/task", origin, nonce, `{"task_id":"a","confirmed":true}`, 400}, {"/app/images/task", origin, nonce, `{"task_id":"a","request":{}}`, 400}, {"/app/images/task", origin, nonce, `{"task_id":"a"}`, 503}, {"/app/images/edit", origin, nonce, "", 400},
			{"/app/images/edit", origin, "", `{"confirmed":true,"request":{}}`, 403},
			{"/app/images/edit", origin, nonce, `{"confirmed":true,"request":{}}`, 503},
			{"/app/images/edit", origin, nonce, `{"confirmed":false,"confirmed":true,"request":{}}`, 400},
			{"/app/images/edit", origin, nonce, `{"confirmed":true,"request":{"model":"a","model":"b"}}`, 400},
			{"/app/images/generate", origin, nonce, strings.Repeat("a", (160<<10)+1), 413}, {"/app/images/generate", origin, nonce, "\xff", 413}, {"/app/images/catalog?x=1", origin, nonce, "", 400},
		} {
			r := httptest.NewRequest("POST", tc.path, strings.NewReader(tc.body))
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
		r := httptest.NewRequest("POST", "/app/images/catalog", nil)
		r.Header.Set("Origin", origin)
		r.Header.Set("X-MOMO-Bridge", nonce)
		w := httptest.NewRecorder()
		other.ServeHTTP(w, r)
		if w.Code != 403 {
			t.Fatal("cross-handler capability")
		}
	}
}
