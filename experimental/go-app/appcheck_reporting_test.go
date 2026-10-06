//go:build appcheck && !nogui

package main

import (
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/momo-api/momoapi-proxy/experimental/go-app/internal/appcore"
	"github.com/momo-api/momoapi-proxy/experimental/go-app/internal/ui"
)

func TestProbeFailureValidationRetainsCapabilityWithoutQuery(t *testing.T) {
	core, err := appcore.New()
	if err != nil {
		t.Fatal(err)
	}
	defer core.Stop()
	h := ui.HandlerWithActions("wails://localhost", core, ui.Actions{AllowOpaqueOrigin: true})
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("GET", "/", nil))
	page := w.Body.String()
	const prefix = "const bridgeNonce='"
	nonce := strings.Split(strings.Split(page, prefix)[1], "'")[0]
	r := httptest.NewRequest("POST", "/check-page-failure?step=quota-refresh", nil)
	r.Header.Set("X-MOMO-Bridge", nonce)
	r.Header.Set("Origin", "null")
	validation := probeValidationRequest(r)
	if validation.URL.RawQuery != "" || validation.URL.ForceQuery || validation.URL.RawPath != "" || r.URL.RawQuery == "" {
		t.Fatal("validation retained query or mutated report")
	}
	w = httptest.NewRecorder()
	h.ServeHTTP(w, validation)
	if w.Code != 200 {
		t.Fatal("authenticated failure report rejected", w.Code)
	}
	validation.Header.Set("X-MOMO-Bridge", "wrong")
	w = httptest.NewRecorder()
	h.ServeHTTP(w, validation)
	if w.Code != 403 {
		t.Fatal("failure report bypassed capability")
	}
	// Production bridge still rejects query paths, including the valid nonce.
	r.URL.Path = "/app/state"
	w = httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 400 {
		t.Fatal("production query gate changed")
	}
}

func TestProbeReportOnlyFixedLabels(t *testing.T) {
	for _, phase := range []string{"passthrough", "routing"} {
		for _, stage := range []string{"enabled", "action", "state", "render"} {
			label := phase + "-start-" + stage
			if probeFailureStep(label) != label {
				t.Fatal("missing Start diagnostic label", label)
			}
		}
	}
	for _, step := range []string{"quota-refresh", "image-preview", "image-reference-select", "image-reference-preview", "image-save", "check-routing"} {
		if probeFailureStep(step) != step {
			t.Fatal("missing known label", step)
		}
	}
	for _, step := range []string{"", "synthetic-secret-key", "quota-refresh\nprivate", "routing-start-action\nprivate", "private-start-state", "routing-start-private", strings.Repeat("x", 10000)} {
		if probeFailureStep(step) != "unknown" {
			t.Fatal("unsafe diagnostic label")
		}
	}
}
