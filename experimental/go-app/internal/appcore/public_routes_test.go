package appcore

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
)

func TestPublicRouteAliasesExactUpstream(t *testing.T) {
	for _, tc := range []struct{ path, method, canonical string }{
		{"/models", "GET", "/v1/models"},
		{"/v1/models/", "GET", "/v1/models"},
		{"/chat/completions", "POST", "/v1/chat/completions"},
		{"/v1/chat/completions///", "POST", "/v1/chat/completions"},
		{"/responses", "POST", "/v1/responses"},
		{"/v1/responses/", "POST", "/v1/responses"},
		{"/responses/compact", "POST", "/v1/responses/compact"},
		{"/v1/responses/compact///", "POST", "/v1/responses/compact"},
	} {
		t.Run(tc.path, func(t *testing.T) {
			var sends atomic.Int32
			payload := `{ "model":"gpt-5.6-sol","stream":false,"input":[{"role":"user","content":"中文"}],"unknown":true }`
			if tc.method == "GET" {
				payload = ""
			}
			if tc.canonical == "/v1/chat/completions" {
				payload = `{ "model":"gpt-5.6-sol","stream":false,"messages":[{"role":"user","content":"中文"}],"unknown":true }`
			}
			response := `{"synthetic":"exact"}`
			if tc.canonical == "/v1/responses/compact" {
				response = `{"id":"cmp_mock","object":"response.compaction","output":[{"type":"compaction","encrypted_content":"synthetic-opaque"}]}`
			}
			c, endpoint, _, _ := testCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				sends.Add(1)
				b, _ := io.ReadAll(r.Body)
				if r.URL.Path != tc.canonical || r.Method != tc.method || r.URL.RawQuery != "" || string(b) != payload {
					t.Error("alias path/method/body changed", r.URL.Path)
				}
				w.Header().Set("Content-Type", "application/json")
				io.WriteString(w, response)
			}))
			headers := map[string]string{}
			if tc.canonical == "/v1/responses/compact" {
				headers["X-MOMO-Compact"] = "native"
			}
			code, b, _ := request(t, c, endpoint, tc.path, tc.method, payload, headers)
			if code != 200 || string(b) != response || sends.Load() != 1 {
				t.Fatal("alias unavailable", code)
			}
		})
	}
}

func TestPublicRouteAliasesModelDispatch(t *testing.T) {
	for _, model := range []string{"gpt-5.5", "gpt-5.6-terra", "gpt-5.4-mini", "grok-4.5", "cursor-auto", "gpt-5.6-sol", "gpt-5.6-luna", "mimo-a", "x-sol", "x-luna", "x-responses", "claude-sonnet-4-6", "gemini-3.5-flash", "gemini-3.1-pro-preview", "muse-auto"} {
		for _, path := range []string{"/v1/responses", "/responses/"} {
			t.Run(model+path, func(t *testing.T) {
				protocol := resolveProtocol(model)
				var sends atomic.Int32
				c, endpoint := routedClaudeCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					sends.Add(1)
					b, _ := io.ReadAll(r.Body)
					var p map[string]any
					json.Unmarshal(b, &p)
					w.Header().Set("Content-Type", "text/event-stream")
					switch protocol {
					case "chat":
						if r.URL.Path != "/v1/chat/completions" || p["model"] != model || p["stream"] != true {
							t.Error("Chat dispatch")
						}
						io.WriteString(w, chatSSE(choice(map[string]any{"content": "answer"}, "stop")))
					case "claude":
						if r.URL.Path != "/v1/messages" || p["model"] != model || r.Header.Get("anthropic-version") != "2023-06-01" {
							t.Error("Claude dispatch")
						}
						io.WriteString(w, claudeStart()+claudeText(0, "answer")+claudeEnd("end_turn"))
					case "gemini":
						if r.URL.Path != "/v1beta/models/"+model+":streamGenerateContent" || r.URL.RawQuery != "alt=sse" {
							t.Error("Gemini dispatch")
						}
						io.WriteString(w, geminiFrame([]any{geminiText("answer")}, "STOP", geminiUsageFixture()))
					case "responses":
						if r.URL.Path != "/v1/responses" || p["model"] != model {
							t.Error("Responses dispatch")
						}
						io.WriteString(w, "event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\"}}\n\n")
					default:
						t.Error("excluded model sent")
					}
				}))
				payload := `{"model":"` + model + `","stream":true,"input":[{"role":"user","content":"same"}]}`
				code, b, _ := request(t, c, endpoint, path, "POST", payload, nil)
				if protocol == "muse" {
					if code != 501 || sends.Load() != 0 {
						t.Fatal("Muse migrated")
					}
					return
				}
				if code != 200 || !strings.Contains(string(b), "response.completed") || sends.Load() != 1 {
					t.Fatal("model route failed", code)
				}
			})
		}
	}
}

func TestPublicRouteAliasSecurityGates(t *testing.T) {
	c, endpoint, _, _ := testCore(t, http.HandlerFunc(func(http.ResponseWriter, *http.Request) { t.Error("denied request sent") }))
	for _, path := range []string{"/models", "/responses", "/chat/completions", "/responses/compact"} {
		for _, h := range []map[string]string{{"Authorization": ""}, {"Authorization": "Bearer wrong"}, {"Origin": "https://invalid.example"}, {"Sec-Fetch-Site": "same-origin"}} {
			want := 401
			if h["Origin"] != "" || h["Sec-Fetch-Site"] != "" {
				want = 403
			}
			if code, _, _ := request(t, c, endpoint, path, "POST", "{}", h); code != want {
				t.Fatal("alias bypasses auth/browser gate", path, code)
			}
		}
	}
	for _, tc := range []struct {
		path, method string
		status       int
	}{
		{"/models", "POST", 405}, {"/responses", "GET", 405}, {"/chat/completions", "GET", 405}, {"/responses/compact", "GET", 405},
		{"/models?x=1", "GET", 400}, {"/responses?", "POST", 400}, {"/respon%73es", "POST", 400},
		{"//responses", "POST", 404}, {"/v1/../responses", "POST", 404}, {"/responses/extra", "POST", 404},
		{"/internal/attachments/", "POST", 404},
	} {
		if code, _, _ := request(t, c, endpoint, tc.path, tc.method, "{}", nil); code != tc.status {
			t.Fatal("unsafe normalization", tc.path, code)
		}
	}
}
