package ui

import (
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/momo-api/momoapi-proxy/experimental/go-app/internal/appcore"
)

func TestOpaqueWebKitOriginRequiresPerHandlerCapability(t *testing.T) {
	core, err := appcore.New()
	if err != nil {
		t.Fatal(err)
	}
	defer core.Close()
	h := HandlerWithActions("wails://localhost", core, Actions{AllowOpaqueOrigin: true})
	page := httptest.NewRecorder()
	h.ServeHTTP(page, httptest.NewRequest("GET", "/", nil))
	_, rest, ok := strings.Cut(page.Body.String(), "const bridgeNonce='")
	if !ok {
		t.Fatal("missing page capability")
	}
	nonce, _, ok := strings.Cut(rest, "';")
	if !ok || len(nonce) != 64 {
		t.Fatal("invalid capability")
	}
	other := HandlerWithActions("wails://localhost", core, Actions{AllowOpaqueOrigin: true})
	for _, tc := range []struct {
		origin, nonce string
		code          int
	}{
		{"null", "", 403}, {"null", "wrong", 403}, {"", "", 403}, {"", nonce, 200},
		{"https://evil.example", nonce, 403}, {"null", nonce, 200},
	} {
		r := httptest.NewRequest("POST", "/app/state", nil)
		r.Header.Set("Origin", tc.origin)
		r.Header.Set("X-MOMO-Bridge", tc.nonce)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != tc.code {
			t.Fatal("opaque policy", w.Code, tc.code)
		}
		if tc.code == 200 {
			if strings.Contains(w.Body.String(), nonce) || strings.Contains(w.Body.String(), "api_key") {
				t.Fatal("state leaked capability")
			}
			w = httptest.NewRecorder()
			other.ServeHTTP(w, r)
			if w.Code != 403 {
				t.Fatal("cross-instance capability accepted")
			}
		}
	}
	// No cross-origin root read: the capability is not a CORS service.
	r := httptest.NewRequest("GET", "/", nil)
	r.Header.Set("Origin", "https://evil.example")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 403 || strings.Contains(w.Body.String(), nonce) {
		t.Fatal("root capability disclosed")
	}
}
