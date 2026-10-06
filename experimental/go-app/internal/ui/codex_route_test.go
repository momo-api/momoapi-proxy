package ui

import (
	"context"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/momo-api/momoapi-proxy/experimental/go-app/internal/appcore"
	"github.com/momo-api/momoapi-proxy/experimental/go-app/internal/integration"
)

func TestCodexRouteBridgeRequiresPageAndExplicitConfirmation(t *testing.T) {
	c, _ := appcore.New()
	defer c.Close()
	previews, applies := 0, 0
	h := HandlerWithActions("http://wails.localhost", c, Actions{
		PreviewCodexRoute: func(ctx context.Context, o integration.CodexRouteOptions) (integration.CodexRoutePreview, error) {
			previews++
			return integration.CodexRoutePreview{Mode: o.Mode, Revision: strings.Repeat("a", 64)}, nil
		},
		ApplyCodexRoute: func(r string) (integration.CodexRoutePreview, error) {
			applies++
			return integration.CodexRoutePreview{Mode: "native", Revision: r}, nil
		},
	})
	nonce := pageCapability(t, h)
	for _, tc := range []struct {
		path, nonce, body string
		want              int
	}{
		{"preview", "", `{"mode":"native"}`, 403},
		{"preview", nonce, `{"mode":"native","mode":"direct"}`, 400},
		{"preview", nonce, `{"mode":"native","path":"private"}`, 400},
		{"preview", nonce, `{"mode":"direct","endpoint":"https://other.example"}`, 400},
		{"preview", nonce, `{"mode":"native"}`, 200},
		{"apply", nonce, `{"revision":"` + strings.Repeat("a", 64) + `","confirmed":false}`, 400},
		{"apply", nonce, `{"revision":"` + strings.Repeat("a", 64) + `","confirmed":true}`, 200},
	} {
		r := httptest.NewRequest("POST", "/app/codex-route-"+tc.path, strings.NewReader(tc.body))
		r.Header.Set("Origin", "http://wails.localhost")
		r.Header.Set("X-MOMO-Bridge", tc.nonce)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != tc.want {
			t.Fatal(tc.path, w.Code)
		}
	}
	if previews != 1 || applies != 1 {
		t.Fatal("unapproved native action")
	}
}
