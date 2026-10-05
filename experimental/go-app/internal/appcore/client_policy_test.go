package appcore

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
)

func clientPolicyPayload(model string, stream bool) map[string]any {
	return map[string]any{
		"model": model, "stream": stream, "store": false,
		"input":               []any{map[string]any{"type": "message", "role": "user", "id": "msg_policy", "content": "policy-user"}},
		"client_metadata":     map[string]any{"session_id": "synthetic-private-label"},
		"prompt_cache_key":    "synthetic-private-cache",
		"include":             []any{"reasoning.encrypted_content"},
		"reasoning":           map[string]any{"summary": "auto"},
		"parallel_tool_calls": true,
	}
}

func TestExplicitClientPolicyThreeProviders(t *testing.T) {
	for _, tc := range []struct{ model, stream string }{
		{"gpt-5.5", chatSSE(choice(map[string]any{"content": "policy-ok"}, "stop"))},
		{"claude-sonnet-4-6", claudeStart() + claudeText(0, "policy-ok") + claudeEnd("end_turn")},
		{"gemini-2.5-flash", geminiFrame([]any{geminiText("policy-ok")}, "STOP", geminiUsageFixture())},
	} {
		for _, stream := range []bool{true, false} {
			sends := 0
			c, endpoint := routedClaudeCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				sends++
				b, _ := io.ReadAll(r.Body)
				if r.Header.Get("X-MOMO-Client-Policy") != "" || strings.Contains(string(b), "synthetic-private") || strings.Contains(string(b), "encrypted_content") || strings.Contains(string(b), "summary") || !strings.Contains(string(b), "policy-user") {
					t.Error("client policy leaked/changed content")
				}
				w.Header().Set("Content-Type", "text/event-stream")
				fmt.Fprint(w, tc.stream)
			}))
			raw, _ := json.Marshal(clientPolicyPayload(tc.model, stream))
			code, _, _ := request(t, c, endpoint, "/v1/responses", "POST", string(raw), nil)
			if code != 400 || sends != 0 {
				t.Fatal("default must not discard options", code, sends)
			}
			code, b, h := request(t, c, endpoint, "/v1/responses", "POST", string(raw), map[string]string{"X-MOMO-Client-Policy": "text-tools-v1"})
			if code != 200 || sends != 1 || !strings.Contains(string(b), "policy-ok") || h.Get("X-MOMO-Client-Policy") != "text-tools-v1" || len(c.history.entries) != 0 {
				t.Fatal("explicit client policy", tc.model, stream, code)
			}
		}
	}
}

func TestClientPolicyRejectsUnsafeOptionsWithoutSending(t *testing.T) {
	sends := 0
	c, endpoint := routedClaudeCore(t, http.HandlerFunc(func(http.ResponseWriter, *http.Request) { sends++ }))
	for _, mutate := range []func(map[string]any){
		func(p map[string]any) { p["include"] = nil },
		func(p map[string]any) { p["include"] = []any{"message.output_text.logprobs"} },
		func(p map[string]any) {
			p["include"] = []any{"reasoning.encrypted_content", "reasoning.encrypted_content"}
		},
		func(p map[string]any) { p["include"] = []any{map[string]any{"x": 1}} },
		func(p map[string]any) { p["prompt_cache_key"] = nil },
		func(p map[string]any) { p["prompt_cache_key"] = strings.Repeat("x", 257) },
		func(p map[string]any) { p["client_metadata"] = []any{} },
		func(p map[string]any) { p["client_metadata"] = map[string]any{"x": true} },
		func(p map[string]any) { p["client_metadata"] = map[string]any{"x": strings.Repeat("x", 1025)} },
		func(p map[string]any) { p["reasoning"] = map[string]any{"summary": "concise"} },
		func(p map[string]any) { p["reasoning"] = map[string]any{"summary": "detailed"} },
		func(p map[string]any) { p["reasoning"] = map[string]any{"summary": nil} },
		func(p map[string]any) { p["reasoning"] = map[string]any{"summary": "auto", "effort": false} },
		func(p map[string]any) { p["reasoning"] = map[string]any{} },
		func(p map[string]any) { p["prompt_cache_retention"] = "24h" },
		func(p map[string]any) { p["parallel_tool_calls"] = nil },
		func(p map[string]any) { p["parallel_tool_calls"] = "true" },
		func(p map[string]any) {
			p["tools"] = []any{map[string]any{"type": "function", "name": "run", "strict": true}}
		},
		func(p map[string]any) {
			p["input"] = []any{map[string]any{"type": "reasoning", "encrypted_content": "synthetic-signature", "summary": []any{}}}
		},
		func(p map[string]any) {
			p["input"] = []any{map[string]any{"type": "compaction", "encrypted_content": "synthetic-signature"}}
		},
		func(p map[string]any) {
			p["tools"] = []any{map[string]any{"type": "custom", "name": "edit", "format": map[string]any{"type": "grammar", "syntax": "lark", "definition": "start: /.+/"}}}
		},
	} {
		p := clientPolicyPayload("gpt-5.5", false)
		mutate(p)
		raw, _ := json.Marshal(p)
		code, b, _ := request(t, c, endpoint, "/v1/responses", "POST", string(raw), map[string]string{"X-MOMO-Client-Policy": "text-tools-v1"})
		if code != 400 || sends != 0 || strings.Contains(string(b), "synthetic-private") || strings.Contains(string(b), "synthetic-signature") {
			t.Fatal("unsafe policy accepted/leaked", code)
		}
	}
	for _, raw := range []string{
		`{"model":"gpt-5.5","input":[{"role":"user","content":"hi"}],"reasoning":{"summary":"detailed","summary":"auto"}}`,
		`{"model":"gpt-5.5","input":[{"role":"user","content":"hi"}],"client_metadata":{"x":1,"x":"ok"}}`,
	} {
		code, _, _ := request(t, c, endpoint, "/v1/responses", "POST", raw, map[string]string{"X-MOMO-Client-Policy": "text-tools-v1"})
		if code != 400 || sends != 0 {
			t.Fatal("duplicate keys bypassed policy")
		}
	}
}

func TestClientPolicyHeaderAndNativeBytes(t *testing.T) {
	for _, tc := range []struct{ path, method, value string }{
		{"/v1/responses", "POST", "text-tools-v1,text-tools-v1"},
		{"/v1/responses", "POST", ""}, {"/v1/responses", "POST", "TEXT-TOOLS-V1"},
		{"/v1/models", "GET", "text-tools-v1"}, {"/v1/responses/compact", "POST", "text-tools-v1"}, {"/v1/chat/completions", "POST", "text-tools-v1"},
	} {
		r, _ := http.NewRequest(tc.method, "http://127.0.0.1:1"+tc.path, nil)
		r.Header.Set("X-MOMO-Client-Policy", tc.value)
		if _, valid := clientPolicyRequested(r); valid {
			t.Fatal("invalid header accepted")
		}
	}
	r, _ := http.NewRequest("POST", "http://127.0.0.1:1/v1/responses", nil)
	r.Header.Add("X-MOMO-Client-Policy", "text-tools-v1")
	r.Header.Add("X-MOMO-Client-Policy", "text-tools-v1")
	if _, valid := clientPolicyRequested(r); valid {
		t.Fatal("duplicate header accepted")
	}
	for _, mode := range []string{"passthrough", "momo-routing"} {
		raw := `{ "model":"synthetic-responses", "input":[{"role":"user","content":"hi"}], "include":["reasoning.encrypted_content"],"reasoning":{"summary":"detailed"},"client_metadata":{"label":"synthetic-private"} }`
		sends := 0
		c, endpoint, _, _ := testCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			sends++
			b, _ := io.ReadAll(r.Body)
			if string(b) != raw || r.Header.Get("X-MOMO-Client-Policy") != "" {
				t.Error("native bytes/header changed")
			}
			w.Header().Set("Content-Type", "application/json")
			fmt.Fprint(w, `{"output":[]}`)
		}))
		c.Stop()
		if c.Configure(Config{Endpoint: "https://mock.example", APIKey: syntheticKey, Mode: mode}) != nil || c.Start() != nil {
			t.Fatal("config")
		}
		code, _, h := request(t, c, endpoint, "/v1/responses", "POST", raw, map[string]string{"X-MOMO-Client-Policy": "text-tools-v1"})
		if code != 200 || sends != 1 || h.Get("X-MOMO-Client-Policy") != "" {
			t.Fatal("native policy scope changed")
		}
	}
}

func TestClientPolicyPreservesEffortAndInstructions(t *testing.T) {
	p := clientPolicyPayload("gpt-5.5", false)
	delete(p, "store")
	p["instructions"] = "keep-instruction"
	p["reasoning"] = map[string]any{"effort": "high", "summary": "none"}
	raw, _ := json.Marshal(p)
	normalized, err := normalizeTextToolsClient(raw)
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	json.Unmarshal(normalized, &m)
	if obj(m["reasoning"])["effort"] != "high" || m["instructions"] != "keep-instruction" {
		t.Fatal("effort/instructions changed")
	}
	p["reasoning"] = map[string]any{"effort": "high"}
	p["include"] = []any{}
	p["client_metadata"] = map[string]any{}
	raw, _ = json.Marshal(p)
	if _, err := normalizeTextToolsClient(raw); err != nil {
		t.Fatal("empty include/metadata or effort only", err)
	}
}

func TestClientPolicyNamespaceAndSchemaPreserved(t *testing.T) {
	p := clientPolicyPayload("gpt-5.5", false)
	p["tools"] = []any{map[string]any{"type": "namespace", "name": "pad", "description": "namespace-rules", "tools": []any{map[string]any{"type": "function", "name": "read", "description": "child-rules", "strict": false, "parameters": map[string]any{"type": "object", "additionalProperties": false, "properties": map[string]any{"n": map[string]any{"type": "integer", "minimum": 0}}}}}}}
	raw, _ := json.Marshal(p)
	normalized, err := normalizeTextToolsClient(raw)
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	json.Unmarshal(normalized, &m)
	ns := obj(m["tools"].([]any)[0])
	child := obj(ns["tools"].([]any)[0])
	if ns["description"] != nil || ns["name"] != "pad" || child["description"] != "namespace-rules\n\nchild-rules" || child["strict"] != nil || obj(child["parameters"])["additionalProperties"] != false {
		t.Fatal("namespace/schema semantics changed")
	}
	for _, value := range []any{nil, 42, true} {
		obj(p["tools"].([]any)[0])["description"] = value
		raw, _ = json.Marshal(p)
		if _, err := normalizeTextToolsClient(raw); err == nil {
			t.Fatal("invalid namespace description")
		}
	}
}

func TestClientPolicyToolOutputIDsStillRequirePairing(t *testing.T) {
	for _, kind := range []string{"function", "custom"} {
		for _, valid := range []bool{true, false} {
			p := clientPolicyPayload("gpt-5.5", false)
			p["tools"] = []any{map[string]any{"type": kind, "name": "read"}}
			call := map[string]any{"type": kind + "_call", "id": "client-call", "call_id": "pair", "name": "read"}
			if kind == "custom" {
				call["type"] = "custom_tool_call"
			}
			if kind == "function" {
				call["arguments"] = "{}"
			} else {
				call["input"] = "raw"
			}
			result := map[string]any{"type": kind + "_call_output", "id": "client-output", "call_id": "pair", "output": "keep-result"}
			if kind == "custom" {
				result["type"] = "custom_tool_call_output"
			}
			if !valid {
				result["call_id"] = "foreign"
			}
			p["input"] = append(p["input"].([]any), call, result)
			sends := 0
			c, endpoint := routedClaudeCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				sends++
				b, _ := io.ReadAll(r.Body)
				if strings.Contains(string(b), "client-output") || !strings.Contains(string(b), "keep-result") || !strings.Contains(string(b), "pair") {
					t.Error("output label changed result/pair")
				}
				w.Header().Set("Content-Type", "text/event-stream")
				fmt.Fprint(w, chatSSE(choice(map[string]any{"content": "ok"}, "stop")))
			}))
			raw, _ := json.Marshal(p)
			code, _, _ := request(t, c, endpoint, "/v1/responses", "POST", string(raw), map[string]string{"X-MOMO-Client-Policy": "text-tools-v1"})
			if valid && (code != 200 || sends != 1) || !valid && (code != 400 || sends != 0) {
				t.Fatal("tool output pairing", kind, valid, code)
			}
			result["id"] = nil
			raw, _ = json.Marshal(p)
			if _, err := normalizeTextToolsClient(raw); err == nil {
				t.Fatal("invalid output ID")
			}
		}
	}
}

func TestClientPolicyNamespaceExpansionBounded(t *testing.T) {
	p := clientPolicyPayload("gpt-5.5", false)
	children := []any{}
	for i := 0; i < 129; i++ {
		children = append(children, map[string]any{"type": "function", "name": fmt.Sprintf("tool_%d", i)})
	}
	namespace := map[string]any{"type": "namespace", "name": "pad", "description": "rules", "tools": children}
	p["tools"] = []any{namespace}
	raw, _ := json.Marshal(p)
	if _, err := normalizeTextToolsClient(raw); err == nil {
		t.Fatal("too many children before expansion")
	}
	namespace["tools"] = children[:128]
	namespace["description"] = strings.Repeat("x", 8192)
	raw, _ = json.Marshal(p)
	if len(raw) > MaxRequest {
		t.Fatal("fixture already oversize")
	}
	if _, err := normalizeTextToolsClient(raw); err == nil {
		t.Fatal("description amplification exceeds request budget")
	}
}

func TestClientPolicyNotInheritedByHistory(t *testing.T) {
	sends := 0
	c, endpoint := routedClaudeCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sends++
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, chatSSE(choice(map[string]any{"content": "ok"}, "stop")))
	}))
	p := clientPolicyPayload("gpt-5.5", false)
	p["store"] = true
	raw, _ := json.Marshal(p)
	code, b, _ := request(t, c, endpoint, "/v1/responses", "POST", string(raw), map[string]string{"X-MOMO-Client-Policy": "text-tools-v1"})
	var response map[string]any
	json.Unmarshal(b, &response)
	if code != 200 || len(c.history.entries) != 1 {
		t.Fatal("first turn")
	}
	p["previous_response_id"] = response["id"]
	p["input"] = []any{map[string]any{"role": "user", "content": "next"}}
	raw, _ = json.Marshal(p)
	code, _, _ = request(t, c, endpoint, "/v1/responses", "POST", string(raw), nil)
	if code != 400 || sends != 1 || len(c.history.entries) != 1 {
		t.Fatal("history inherited lossy policy")
	}
	code, _, _ = request(t, c, endpoint, "/v1/responses", "POST", string(raw), map[string]string{"X-MOMO-Client-Policy": "text-tools-v1"})
	if code != 200 || sends != 2 {
		t.Fatal("explicit second turn")
	}
}
