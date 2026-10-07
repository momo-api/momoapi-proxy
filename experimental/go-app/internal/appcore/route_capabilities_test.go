package appcore

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func TestRouteCapabilitySnapshotIsDetachedAndHonest(t *testing.T) {
	matrix := RouteCapabilities()
	if matrix.Schema != "momo-route-capabilities-v1" || matrix.Scope != "local-adapter" || len(matrix.Routes) != 5 {
		t.Fatal("matrix shape")
	}
	for _, entry := range matrix.Routes {
		if entry.UpstreamStatus != CapabilityUnverified {
			t.Fatal("adapter matrix claimed provider conformance")
		}
	}
	matrix.Routes[0].Protocol = "tampered"
	matrix.Routes[0].Capabilities.Namespace.Status = CapabilityLossy
	if RouteCapabilities().Routes[0].Protocol == "tampered" {
		t.Fatal("caller mutated registry")
	}
	if RouteCapabilities().Routes[0].Capabilities.Namespace.Status != CapabilityUnverified {
		t.Fatal("nested capability mutated registry")
	}
	native := RouteCapabilities().Routes[0].Capabilities
	if native.RequestBytes.Status != CapabilityNative || native.UnknownExtensions.Status != CapabilityNative || native.TextToolsSubset.Status != CapabilityUnverified || native.AllowedTools.Status != CapabilityUnverified {
		t.Fatal("native semantic claim")
	}
	for _, entry := range RouteCapabilities().Routes {
		if entry.Status == CapabilityTranslated && (entry.Capabilities.UnknownExtensions.Status != CapabilityUnsupported || entry.Capabilities.AllowedTools.Status != CapabilityTranslated) {
			t.Fatal("overbroad conversion claim")
		}
	}
	data, err := json.Marshal(RouteCapabilities())
	if err != nil || bytes.Contains(data, []byte(syntheticKey)) || bytes.Contains(data, []byte("mock.example")) {
		t.Fatal("matrix leaked state")
	}
}

func TestRouteRegistryInvariantsAndErrorRedaction(t *testing.T) {
	seen := map[string]bool{}
	for _, adapter := range responseRouteAdapters() {
		cap := adapter.capability
		if cap.Protocol == "" || seen[cap.Protocol] {
			t.Fatal("duplicate protocol")
		}
		seen[cap.Protocol] = true
		if cap.Status == CapabilityTranslated && (adapter.build == nil || adapter.convert == nil || cap.UpstreamPath == "") {
			t.Fatal("unbound translated route")
		}
		if cap.Protocol == "muse" && (cap.Status != CapabilityUnsupported || adapter.build != nil || adapter.convert != nil || cap.UpstreamPath != "") {
			t.Fatal("Muse enabled")
		}
	}
	if routedCapabilityLabel() != "partial-momo-responses-chat-claude-gemini-routing" {
		t.Fatal("legacy State label changed")
	}
	adapter, _ := responseRouteAdapter("gemini")
	if adapter.targetPath("gemini-a/b?x=1") != "/v1beta/models/gemini-a%2Fb%3Fx=1:streamGenerateContent?alt=sse" {
		t.Fatal("model path/query injection")
	}
	for _, tc := range []struct {
		err    error
		code   string
		status int
	}{
		{errors.New("private-model private-tool private-namespace secret-key"), "unsupported_routed_payload", 400},
		{fmt.Errorf("private-parser: %w", errUnsupportedToolFormat), "unsupported_tool_format", 400},
		{errRouteNotMigrated, "route_protocol_not_migrated", 501},
	} {
		w := httptest.NewRecorder()
		routePreflightError(w, tc.err)
		if w.Code != tc.status || w.Header().Get("X-MOMO-Route-Error") != tc.code || strings.Contains(w.Body.String(), "private") || strings.Contains(w.Body.String(), "secret-key") {
			t.Fatal("error leaked or unstable code")
		}
	}
}

func TestRoutePreflightBuildOnceAndClosedStates(t *testing.T) {
	calls := 0
	adapter := routeAdapter{capability: routeCapability("chat", CapabilityTranslated, "test", "/v1/chat/completions"),
		build:   func([]byte) (*chatPlan, error) { calls++; return &chatPlan{model: "test-model"}, nil },
		convert: func(context.Context, http.ResponseWriter, io.Reader, *chatPlan) error { return nil },
	}
	if _, _, err := preflightAdapter(adapter, "test-model", nil); err != nil || calls != 1 {
		t.Fatal("build count")
	}
	if decision, err := adapterDecision(adapter); err != nil || decision.Status != CapabilityTranslated || calls != 1 {
		t.Fatal("selection invoked builder")
	}
	for _, state := range []CapabilityStatus{CapabilityUnsupported, CapabilityUnverified, CapabilityLossy, "future-state"} {
		adapter.capability.Status = state
		if _, plan, err := preflightAdapter(adapter, "test-model", nil); err == nil || plan != nil || calls != 1 {
			t.Fatal("closed state called builder")
		}
	}
	adapter.capability.Status = CapabilityTranslated
	adapter.convert = nil
	if _, _, err := preflightAdapter(adapter, "test-model", nil); err == nil || calls != 1 {
		t.Fatal("missing converter passed preflight")
	}
	if decision, err := adapterDecision(adapter); err == nil || decision.Status != CapabilityUnsupported || decision.Reason != "protocol_not_migrated" {
		t.Fatal("unbound selection claimed translation")
	}
}

func TestRouteRegistryEndToEndJSONAndSSE(t *testing.T) {
	for _, tc := range []struct{ protocol, payload, path, stream string }{
		{"chat", routedPayload, "/v1/chat/completions", goodChatSSE()},
		{"claude", claudePayload, "/v1/messages", goodClaudeSSE()},
		{"gemini", geminiPayload, "/v1beta/models/gemini-2.5-flash:streamGenerateContent", goodGeminiSSE()},
	} {
		for _, stream := range []bool{false, true} {
			t.Run(fmt.Sprint(tc.protocol, "/", stream), func(t *testing.T) {
				var sends atomic.Int32
				c, endpoint := routedClaudeCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					sends.Add(1)
					if r.URL.Path != tc.path || tc.protocol == "gemini" && r.URL.RawQuery != "alt=sse" {
						t.Error("registry target")
					}
					w.Header().Set("Content-Type", "text/event-stream")
					fmt.Fprint(w, tc.stream)
				}))
				payload := strings.Replace(tc.payload, `"stream":true`, fmt.Sprint(`"stream":`, stream), 1)
				status, b, h := request(t, c, endpoint, "/v1/responses", "POST", payload, nil)
				if status != 200 || sends.Load() != 1 || !bytes.Contains(b, []byte(`"namespace":"pad"`)) {
					t.Fatal("registry end-to-end")
				}
				if stream {
					if !strings.Contains(h.Get("Content-Type"), "text/event-stream") || !bytes.Contains(b, []byte("response.completed")) {
						t.Fatal("SSE output")
					}
				} else {
					if !json.Valid(b) || !strings.Contains(h.Get("Content-Type"), "application/json") {
						t.Fatal("JSON output")
					}
				}
			})
		}
	}
}

func TestRouteRegistryNativeBytesAreExact(t *testing.T) {
	for _, tc := range []struct{ mode, model string }{{"", "future-model"}, {"passthrough", "future-model"}, {"momo-routing", "gpt-5.6-sol"}} {
		for _, stream := range []bool{false, true} {
			payload := fmt.Sprintf(`{ "model":%q, "stream":%t, "input":"opaque", "future": {"nested":1} }`, tc.model, stream)
			c, endpoint, _, _ := testCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				b, _ := io.ReadAll(r.Body)
				if string(b) != payload || r.URL.Path != "/v1/responses" {
					t.Error("native body changed")
				}
				if stream {
					w.Header().Set("Content-Type", "text/event-stream")
					fmt.Fprint(w, "data: opaque\n\n")
				} else {
					w.Header().Set("Content-Type", "application/json")
					fmt.Fprint(w, `{"opaque":true}`)
				}
			}))
			c.Stop()
			_ = c.Configure(Config{Endpoint: "https://mock.example", APIKey: syntheticKey, Mode: tc.mode})
			_ = c.Start()
			status, _, _ := request(t, c, endpoint, "/v1/responses", "POST", payload, nil)
			if status != 200 {
				t.Fatal("native path rejected")
			}
			if routeCount(t, c.Diagnostics().Routing, "responses").NativeSelected != 1 {
				t.Fatal("native selection not counted")
			}
		}
	}
}

func TestRoutePreflightPreservesNativeAndValidatesConversion(t *testing.T) {
	for _, mode := range []string{"", "passthrough", "momo-routing"} {
		model := "gpt-5.6-sol"
		if mode != "momo-routing" {
			model = "unknown-future-model"
		}
		body := []byte(`{ "model":"` + model + `", "input":"opaque", "future_private": {"x": 1} }`)
		decision, plan, err := preflightResponses(mode, model, body)
		if err != nil || plan != nil || decision.Status != CapabilityNative {
			t.Fatal("native entered conversion")
		}
		if decision.UpstreamStatus != CapabilityUnverified {
			t.Fatal("native claimed provider support")
		}
	}
	for _, tc := range []struct{ payload, protocol string }{{routedPayload, "chat"}, {claudePayload, "claude"}, {geminiPayload, "gemini"}} {
		p, _ := decodeObject(tc.payload)
		p["tool_choice"] = allowedChoice("auto", "read")
		body, _ := json.Marshal(p)
		decision, plan, err := preflightResponses("momo-routing", str(p["model"]), body)
		if err != nil || plan == nil || decision.Protocol != tc.protocol || decision.Status != CapabilityTranslated || len(plan.allowed) != 1 || len(plan.tools) != 2 {
			t.Fatal("strict plan/allowed gate")
		}
		tool, ok := plan.restoreTool("pad__read")
		if !ok || tool.namespace != "pad" || tool.name != "read" {
			t.Fatal("tool identity")
		}
		p["future_private"] = "must-not-leak"
		body, _ = json.Marshal(p)
		_, plan, err = preflightResponses("momo-routing", str(p["model"]), body)
		if err == nil || plan != nil || strings.Contains(err.Error(), "must-not-leak") {
			t.Fatal("unknown conversion accepted/leaked")
		}
	}
}

func TestRoutePreflightRejectionIsBeforeNetwork(t *testing.T) {
	var sends atomic.Int32
	c, endpoint := routedClaudeCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sends.Add(1)
		t.Error("rejected preflight sent upstream")
	}))
	for _, model := range []string{"gpt-5.5", "claude-sonnet-4-6", "gemini-2.5-flash", "muse-auto"} {
		payload := strings.Replace(routedPayload, "gpt-5.5", model, 1)
		if model != "muse-auto" {
			payload = strings.Replace(payload, `"stream":true`, `"stream":true,"future_private":"do-not-echo"`, 1)
		}
		status, body, headers := request(t, c, endpoint, "/v1/responses", "POST", payload, nil)
		want := 400
		if model == "muse-auto" {
			want = 501
		}
		if status != want || headers.Get("X-MOMO-Route-Error") == "" || strings.Contains(string(body), "do-not-echo") {
			t.Fatal("preflight rejection contract")
		}
	}
	if sends.Load() != 0 {
		t.Fatal("preflight network side effect")
	}
	c.mu.Lock()
	entries := len(c.history.entries)
	c.mu.Unlock()
	if entries != 0 {
		t.Fatal("rejected preflight committed history")
	}
}
