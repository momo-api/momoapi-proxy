package ui

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/momo-api/momoapi-proxy/experimental/go-app/internal/appcore"
)

func TestExplicitImageSaveNativeGateNoPathOrUpstream(t *testing.T) {
	c, _ := appcore.New()
	defer c.Close()
	const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
	data, _ := base64.StdEncoding.DecodeString(png)
	calls := 0
	h := HandlerWithActions("http://wails.localhost", c, Actions{SaveImage: func(ctx context.Context, mime string, got []byte) (bool, error) {
		calls++
		if mime != "image/png" || string(got) != string(data) {
			t.Fatal("saved bytes changed")
		}
		return true, nil
	}})
	nonce := pageCapability(t, h)
	good, _ := json.Marshal(map[string]any{"confirmed": true, "mime_type": "image/png", "b64_json": png})
	for _, tc := range []struct {
		body, nonce, origin string
		code                int
	}{
		{string(good), nonce, "http://wails.localhost", 200},
		{string(good), "", "http://wails.localhost", 403},
		{string(good), nonce, "https://evil.example", 403},
		{strings.Replace(string(good), "true", "false", 1), nonce, "http://wails.localhost", 400},
		{strings.Replace(string(good), "image/png", "image/jpeg", 1), nonce, "http://wails.localhost", 400},
		{`{"confirmed":true,"mime_type":"image/png","b64_json":"AA=="}`, nonce, "http://wails.localhost", 400},
		{`{"confirmed":false,"confirmed":true,"mime_type":"image/png","b64_json":"` + png + `"}`, nonce, "http://wails.localhost", 400},
		{string(good[:len(good)-1]) + `,"path":"private.png"}`, nonce, "http://wails.localhost", 400},
		{strings.Repeat("x", appcore.MaxResponse+1), nonce, "http://wails.localhost", 413},
	} {
		r := httptest.NewRequest("POST", "/app/images/save", strings.NewReader(tc.body))
		r.Header.Set("Origin", tc.origin)
		r.Header.Set("X-MOMO-Bridge", tc.nonce)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != tc.code {
			t.Fatal("save gate", w.Code, tc.code)
		}
		if strings.Contains(w.Body.String(), png) || strings.Contains(w.Body.String(), nonce) {
			t.Fatal("save reflected input")
		}
	}
	if calls != 1 || c.State().Configured || c.State().Active != 0 {
		t.Fatal("unexpected native/save Core use")
	}
}

func TestImageSaveDeliveredOnceEvenIfResponseShort(t *testing.T) {
	c, _ := appcore.New()
	defer c.Close()
	saves := 0
	h := HandlerWithActions("http://wails.localhost", c, Actions{SaveImage: func(context.Context, string, []byte) (bool, error) { saves++; return true, nil }})
	nonce := pageCapability(t, h)
	r := httptest.NewRequest("POST", "/app/images/save", strings.NewReader(`{"confirmed":true,"mime_type":"image/png","b64_json":"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="}`))
	r.Header.Set("Origin", "http://wails.localhost")
	r.Header.Set("X-MOMO-Bridge", nonce)
	w := &diagnosticsShortWriter{header: make(http.Header)}
	defer func() {
		if recover() != http.ErrAbortHandler || saves != 1 || w.calls != 1 {
			t.Error("saved action repeated after short response")
		}
	}()
	h.ServeHTTP(w, r)
}

func TestImageSaveCancelFailureMethodsAndPublicIsolation(t *testing.T) {
	c, _ := appcore.New()
	defer c.Close()
	const body = `{"confirmed":true,"mime_type":"image/png","b64_json":"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="}`
	for _, tc := range []struct {
		fn     func(context.Context, string, []byte) (bool, error)
		code   int
		result string
	}{
		{nil, 503, ""},
		{func(context.Context, string, []byte) (bool, error) { return false, nil }, 200, `{"saved":false}`},
		{func(context.Context, string, []byte) (bool, error) {
			return false, errors.New("synthetic-private-path")
		}, 503, ""},
	} {
		h := HandlerWithActions("http://wails.localhost", c, Actions{SaveImage: tc.fn})
		nonce := pageCapability(t, h)
		for _, method := range []string{"POST", "GET"} {
			r := httptest.NewRequest(method, "/app/images/save", strings.NewReader(body))
			r.Header.Set("Origin", "http://wails.localhost")
			r.Header.Set("X-MOMO-Bridge", nonce)
			w := httptest.NewRecorder()
			h.ServeHTTP(w, r)
			want := tc.code
			if method == "GET" {
				want = 405
			}
			if w.Code != want || strings.Contains(w.Body.String(), "synthetic-private-path") || tc.result != "" && method == "POST" && w.Body.String() != tc.result {
				t.Fatal("save outcome gate")
			}
		}
	}
	var connection map[string]string
	json.Unmarshal([]byte(c.ConnectionJSON()), &connection)
	r := httptest.NewRequest("POST", "/app/images/save", strings.NewReader(body))
	r.Header.Set("Authorization", "Bearer "+connection["api_key"])
	w := httptest.NewRecorder()
	c.Handler().ServeHTTP(w, r)
	if w.Code != 404 {
		t.Fatal("public file save route")
	}
}
