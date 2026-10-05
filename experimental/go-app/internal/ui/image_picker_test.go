package ui

import (
	"encoding/base64"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/momo-api/momoapi-proxy/experimental/go-app/internal/appcore"
)

func TestLocalImageReferenceValidationBeforePreview(t *testing.T) {
	c, _ := appcore.New()
	defer c.Close()
	const origin = "http://wails.localhost"
	h := HandlerWithActions(origin, c, Actions{})
	nonce := pageCapability(t, h)
	const reference = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
	body := `{"reference_images":["` + reference + `"]}`
	r := httptest.NewRequest("POST", "/app/images/validate-references", strings.NewReader(body))
	r.Header.Set("Origin", origin)
	r.Header.Set("X-MOMO-Bridge", nonce)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"width":1`) || strings.Contains(w.Body.String(), "base64") {
		t.Fatal("pure local validation missing", w.Code)
	}
}

func TestLocalReferenceBridgeAuthFramingLimitsAndNoCoreUse(t *testing.T) {
	c, _ := appcore.New()
	defer c.Close()
	origin := "http://wails.localhost"
	h := HandlerWithActions(origin, c, Actions{})
	nonce := pageCapability(t, h)
	const reference = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
	data, _ := base64.StdEncoding.DecodeString(strings.Split(reference, ",")[1])
	data = append(data, make([]byte, 200<<10)...)
	raw, _ := json.Marshal(map[string]any{"reference_images": []string{"data:image/png;base64," + base64.StdEncoding.EncodeToString(data)}})
	edit, _ := json.Marshal(map[string]any{"confirmed": true, "request": map[string]any{"model": "momoapi-gpt-image-2-5-flare", "prompt": "synthetic", "reference_images": []string{"data:image/png;base64," + base64.StdEncoding.EncodeToString(data)}}})
	if len(edit) <= 160<<10 || len(edit) > appcore.MaxRequest {
		t.Fatal("large desktop edit fixture outside intended envelope")
	}
	for _, tc := range []struct {
		origin, nonce, body, path, method string
		code                              int
	}{
		{origin, nonce, string(raw), "/app/images/validate-references", "POST", 200},
		// Unconfigured Core returns 503 only after the large confirmed envelope
		// passes the desktop gate. This is not a provider acceptance test.
		{origin, nonce, string(edit), "/app/images/edit", "POST", 503},
		{origin, nonce, strings.Replace(string(edit), `"confirmed":true`, `"confirmed":false`, 1), "/app/images/edit", "POST", 400},
		{origin, nonce, strings.Repeat(" ", appcore.MaxRequest+1), "/app/images/edit", "POST", 413},
		{origin, "", string(raw), "/app/images/validate-references", "POST", 403},
		{"https://evil.example", nonce, string(raw), "/app/images/validate-references", "POST", 403},
		{origin, nonce, `{"reference_images":[],"reference_images":[]}`, "/app/images/validate-references", "POST", 400},
		{origin, nonce, `{"reference_images":["https://images.example/a"]}`, "/app/images/validate-references", "POST", 400},
		{origin, nonce, string(raw) + "{}", "/app/images/validate-references", "POST", 400},
		{origin, nonce, string(raw), "/app/images/validate-references?x=1", "POST", 400},
		{origin, nonce, string(raw), "/app/images/validate-references", "GET", 405},
		{origin, nonce, strings.Repeat(" ", appcore.MaxRequest+1), "/app/images/validate-references", "POST", 413},
	} {
		r := httptest.NewRequest(tc.method, tc.path, strings.NewReader(tc.body))
		r.Header.Set("Origin", tc.origin)
		r.Header.Set("X-MOMO-Bridge", tc.nonce)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != tc.code {
			t.Fatal("validation gate", w.Code, tc.code)
		}
		if strings.Contains(w.Body.String(), "base64") || strings.Contains(w.Body.String(), nonce) {
			t.Fatal("reference/capability reflected")
		}
	}
	if s := c.State(); s.Configured || s.Running || s.Active != 0 {
		t.Fatal("validation touched Core lifecycle")
	}
}
