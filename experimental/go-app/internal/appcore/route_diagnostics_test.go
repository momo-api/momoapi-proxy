package appcore

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"testing"
)

func TestRouteExplanationIsSelectionOnlyAndRedacted(t *testing.T) {
	for _, tc := range []struct {
		mode, model, protocol, reason string
		status                        CapabilityStatus
	}{
		{"", "synthetic-private-future", "responses", "default_passthrough", CapabilityNative},
		{"passthrough", "claude-private", "responses", "default_passthrough", CapabilityNative},
		{"momo-routing", "gpt-5.6-sol", "responses", "native_model_passthrough", CapabilityNative},
		{"momo-routing", "gpt-5.5", "chat", "explicit_strict_conversion", CapabilityTranslated},
		{"momo-routing", "synthetic-private-future", "chat", "explicit_strict_conversion", CapabilityTranslated},
		{"momo-routing", "claude-private", "claude", "explicit_strict_conversion", CapabilityTranslated},
		{"momo-routing", "gemini-private", "gemini", "explicit_strict_conversion", CapabilityTranslated},
		{"momo-routing", "muse-auto", "muse", "protocol_not_migrated", CapabilityUnsupported},
	} {
		report, err := ExplainResponsesRoute(tc.mode, tc.model)
		if err != nil || report.Schema != "momo-route-explanation-v1" || report.Scope != "offline-selection" || report.RequestValidated || report.Decision.Protocol != tc.protocol || report.Decision.Reason != tc.reason || report.Decision.Status != tc.status || report.Decision.UpstreamStatus != CapabilityUnverified {
			t.Fatal("selection contract")
		}
		b, _ := json.Marshal(report)
		if strings.Contains(string(b), tc.model) {
			t.Fatal("model reflected")
		}
	}
	for _, model := range []string{"", strings.Repeat("x", 257), "private\n", " private", string([]byte{0xff})} {
		if _, err := ExplainResponsesRoute("momo-routing", model); err == nil || strings.Contains(err.Error(), "private") {
			t.Fatal("invalid model accepted/leaked")
		}
	}
	if _, err := ExplainResponsesRoute("private-mode", "gpt-5.5"); err == nil || strings.Contains(err.Error(), "private") {
		t.Fatal("invalid mode accepted/leaked")
	}
}

func routeCount(t *testing.T, r RouteDiagnostics, protocol string) RouteDiagnosticCounts {
	t.Helper()
	for _, row := range r.Routes {
		if row.Protocol == protocol {
			return row
		}
	}
	t.Fatal("missing fixed row")
	return RouteDiagnosticCounts{}
}
func TestRouteDiagnosticsCountPreflightNotInference(t *testing.T) {
	c, endpoint := routedClaudeCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Deliberately reject upstream: local accepted is NOT inference success.
		http.Error(w, "synthetic-upstream-private", 429)
	}))
	if status, _, _ := request(t, c, endpoint, "/v1/responses", "POST", routedPayload, nil); status != 429 {
		t.Fatal("upstream rejection")
	}
	bad := strings.Replace(routedPayload, `"stream":true`, `"stream":true,"private-field":"private-value"`, 1)
	if status, _, _ := request(t, c, endpoint, "/v1/responses", "POST", bad, nil); status != 400 {
		t.Fatal("preflight reject")
	}
	native := strings.Replace(routedPayload, "gpt-5.5", "gpt-5.6-sol", 1)
	request(t, c, endpoint, "/v1/responses", "POST", native, nil)
	request(t, c, endpoint, "/v1/responses", "POST", strings.Replace(routedPayload, "gpt-5.5", "muse-auto", 1), nil)
	// Earlier JSON/policy/history rejection is outside strict-preflight scope.
	request(t, c, endpoint, "/v1/responses", "POST", "{}", nil)
	request(t, c, endpoint, "/v1/responses", "POST", "{", nil)
	request(t, c, endpoint, "/v1/responses", "POST", routedPayload, map[string]string{"X-MOMO-History": "invalid"})
	request(t, c, endpoint, "/v1/responses", "POST", strings.Replace(routedPayload, `"stream":true`, `"stream":true,"previous_response_id":"missing"`, 1), nil)
	report := c.Diagnostics().Routing
	chat := routeCount(t, report, "chat")
	responses := routeCount(t, report, "responses")
	muse := routeCount(t, report, "muse")
	if chat.PreflightAccepted != 1 || chat.PreflightRejected != 1 || responses.NativeSelected != 1 || muse.PreflightRejected != 1 {
		t.Fatal("counter scope")
	}
	var evaluations uint64
	for _, row := range report.Routes {
		evaluations += row.NativeSelected + row.PreflightAccepted + row.PreflightRejected
	}
	if evaluations != 4 {
		t.Fatal("earlier rejection counted")
	}
	b, _ := json.Marshal(report)
	for _, s := range []string{syntheticKey, "private-field", "private-value", "mock.example", "gpt-5.5", "gpt-5.6-sol"} {
		if strings.Contains(string(b), s) {
			t.Fatal("route diagnostics leaked")
		}
	}
	c.Stop()
	if routeCount(t, c.Diagnostics().Routing, "chat").PreflightAccepted != 0 {
		t.Fatal("Stop retained counters")
	}
}

func TestRouteDiagnosticsGenerationSaturationAndConcurrentSnapshot(t *testing.T) {
	c, err := New()
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	_ = c.Configure(Config{Endpoint: "https://mock.example", APIKey: syntheticKey})
	_ = c.Start()
	c.mu.Lock()
	generation := c.routeGeneration
	c.mu.Unlock()
	d := RouteDecision{Protocol: "chat", Status: CapabilityTranslated}
	var wg sync.WaitGroup
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < 100; j++ {
				c.recordRoutePreflight(generation, d, nil)
				_ = c.Diagnostics()
			}
		}()
	}
	wg.Wait()
	if routeCount(t, c.Diagnostics().Routing, "chat").PreflightAccepted != 400 {
		t.Fatal("concurrent count")
	}
	c.Stop()
	_ = c.Start()
	c.recordRoutePreflight(generation, d, nil)
	if routeCount(t, c.Diagnostics().Routing, "chat").PreflightAccepted != 0 {
		t.Fatal("late old generation counted")
	}
	n := maxRouteDiagnosticCount
	incrementRouteCount(&n)
	if n != maxRouteDiagnosticCount {
		t.Fatal("counter overflow")
	}
	c.mu.Lock()
	generation = c.routeGeneration
	c.mu.Unlock()
	c.recordRoutePreflight(generation, RouteDecision{Protocol: "private-model", Status: CapabilityNative}, fmt.Errorf("private-error"))
	c.recordRoutePreflight(generation, RouteDecision{Protocol: "unclassified", Status: CapabilityUnsupported}, errRouteNotMigrated)
	if routeCount(t, c.Diagnostics().Routing, "unclassified").PreflightRejected != 1 {
		t.Fatal("fixed unclassified bucket")
	}
	if len(c.Diagnostics().Routing.Routes) != routeDiagnosticSlots {
		t.Fatal("unbounded protocol rows")
	}
	if routeCount(t, OfflineDiagnostics().Routing, "chat").PreflightAccepted != 0 {
		t.Fatal("offline borrowed running stats")
	}
	if OfflineDiagnostics().Routing.Scope != "offline-process" {
		t.Fatal("offline counter scope")
	}
}

func TestRouteDiagnosticsDetachedResetAndIndependentEpoch(t *testing.T) {
	c, err := New()
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	config := Config{Endpoint: "https://mock.example", APIKey: syntheticKey}
	if c.Configure(config) != nil || c.Start() != nil {
		t.Fatal("configure")
	}
	c.mu.Lock()
	generation := c.routeGeneration
	c.history.clear() // history maintenance must not invalidate route counters
	c.mu.Unlock()
	d := RouteDecision{Protocol: "responses", Status: CapabilityNative}
	c.recordRoutePreflight(generation, d, nil)
	snapshot := c.Diagnostics().Routing
	if routeCount(t, snapshot, "responses").NativeSelected != 1 {
		t.Fatal("history coupled epoch")
	}
	snapshot.Routes[0].Protocol = "private-mutated"
	snapshot.Routes[0].NativeSelected = 900
	if routeCount(t, c.Diagnostics().Routing, "responses").NativeSelected != 1 {
		t.Fatal("shared snapshot")
	}
	c.Stop()
	c.mu.Lock()
	c.routeCounts[0].native = 3
	c.mu.Unlock()
	if c.Configure(config) != nil || c.Start() != nil {
		t.Fatal("reconfigure")
	}
	c.recordRoutePreflight(generation, d, nil)
	if routeCount(t, c.Diagnostics().Routing, "responses").NativeSelected != 0 {
		t.Fatal("configure/late reset")
	}
	c.mu.Lock()
	generation = c.routeGeneration
	c.mu.Unlock()
	c.recordRoutePreflight(generation, d, nil)
	c.Close()
	c.recordRoutePreflight(generation, d, nil)
	if routeCount(t, c.Diagnostics().Routing, "responses").NativeSelected != 0 {
		t.Fatal("Close/late reset")
	}
}
