package appcore

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

const routedPayload = `{"model":"gpt-5.5","stream":true,"instructions":"Be concise.","input":[{"role":"user","content":[{"type":"input_text","text":"中文🙂"}]}],"tools":[{"type":"namespace","name":"pad","tools":[{"type":"function","name":"read","parameters":{"type":"object","properties":{}}},{"type":"custom","name":"write"}]}]}`

func chatSSE(chunks ...any) string {
	var b strings.Builder
	for _, chunk := range chunks {
		data, _ := json.Marshal(chunk)
		fmt.Fprintf(&b, "data: %s\r\n\r\n", data)
	}
	b.WriteString("data: [DONE]\r\n\r\n")
	return b.String()
}
func choice(delta any, finish any) any {
	return map[string]any{"choices": []any{map[string]any{"index": 0, "delta": delta, "finish_reason": finish}}}
}
func goodChatSSE() string {
	return chatSSE(choice(map[string]any{"content": "中文🙂"}, nil),
		choice(map[string]any{"tool_calls": []any{map[string]any{"index": 0, "id": "call_read", "type": "function", "function": map[string]string{"name": "pad__read", "arguments": "{\"x\":"}}}}, nil),
		choice(map[string]any{"tool_calls": []any{map[string]any{"index": 0, "function": map[string]string{"arguments": "1}"}}, map[string]any{"index": 1, "id": "call_write", "type": "function", "function": map[string]string{"name": "pad__write", "arguments": "{\"input\":\"text('hi')\"}"}}}}, nil),
		choice(map[string]any{}, "tool_calls"))
}
func TestModelClassifier(t *testing.T) {
	if ValidateConfig(Config{Endpoint: "https://mock.example", APIKey: syntheticKey, Mode: "automatic"}) == nil {
		t.Fatal("unknown mode accepted")
	}
	for model, want := range map[string]string{"muse-auto": "muse", "gemini-a": "gemini", "claude-a": "claude", "mimo-a": "responses", "gpt-5.6-sol": "responses", "gpt-5.6-luna": "responses", "x-sol": "responses", "x-responses": "responses", "gpt-5.6-terra": "chat", "gpt-5.5": "chat", "GEMINI-x": "chat"} {
		if resolveProtocol(model) != want {
			t.Fatal("model classifier", model)
		}
	}
}

func TestNamespaceCollisionAndAmbiguousBareName(t *testing.T) {
	plan, err := buildChatPlan([]byte(routedPayload))
	if err != nil {
		t.Fatal(err)
	}
	plan.tools["other__read"] = chatTool{wire: "other__read", name: "read", namespace: "other", kind: "function"}
	if _, ok := plan.restoreTool("read"); ok {
		t.Fatal("ambiguous bare tool guessed")
	}
	if tool, ok := plan.restoreTool("pad__read"); !ok || tool.namespace != "pad" {
		t.Fatal("exact namespace lookup")
	}
}
func TestRoutedChatStreamNamespaceAndRequest(t *testing.T) {
	c, endpoint, _, _ := testCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/chat/completions" || r.Header.Get("Authorization") != "Bearer "+syntheticKey {
			t.Error("wrong routed target")
		}
		b, _ := io.ReadAll(r.Body)
		var body map[string]any
		_ = json.Unmarshal(b, &body)
		if body["stream"] != true || body["model"] != "gpt-5.5" || len(body["messages"].([]any)) != 2 {
			t.Error("chat translation")
		}
		w.Header().Set("Content-Type", "text/event-stream")
		// Split every UTF-8 byte, including JSON, delimiters and tool arguments.
		for _, v := range []byte(goodChatSSE()) {
			_, _ = w.Write([]byte{v})
			w.(http.Flusher).Flush()
		}
	}))
	c.Stop()
	if c.Configure(Config{Endpoint: "https://mock.example", APIKey: syntheticKey, Mode: "momo-routing"}) != nil || c.Start() != nil {
		t.Fatal("route mode")
	}
	status, b, _ := request(t, c, endpoint, "/v1/responses", "POST", routedPayload, nil)
	if status != 200 || !strings.Contains(string(b), "response.completed") || !strings.Contains(string(b), `"namespace":"pad"`) || !strings.Contains(string(b), `"name":"read"`) || !strings.Contains(string(b), `"type":"custom_tool_call"`) {
		t.Fatal("routed output contract")
	}
	if c.State().Mode != "momo-routing" {
		t.Fatal("mode state")
	}
}
func TestRoutedPayloadRejectsWithoutSending(t *testing.T) {
	bad := []string{
		strings.Replace(routedPayload, `"stream":true`, `"stream":"false"`, 1),
		strings.Replace(routedPayload, `"instructions":"Be concise."`, `"previous_response_id":"resp_private"`, 1),
		strings.Replace(routedPayload, `"type":"input_text","text":"中文🙂"`, `"type":"input_image","file_id":"unsupported_file_id"`, 1),
		strings.Replace(routedPayload, `"name":"write"`, `"name":"exec","format":{"type":"grammar","syntax":"lark","definition":"start: /.+/"}`, 1),
		strings.Replace(routedPayload, `"instructions":"Be concise."`, `"provider_unknown":true`, 1),
		strings.Replace(routedPayload, `"name":"write"`, `"name":"read"`, 1),
	}
	for _, payload := range bad {
		if _, err := buildChatPlan([]byte(payload)); err == nil {
			t.Fatal("unsupported payload silently changed")
		}
	}
	c, endpoint, _, _ := testCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { t.Error("unsupported request sent upstream") }))
	c.Stop()
	_ = c.Configure(Config{Endpoint: "https://mock.example", APIKey: syntheticKey, Mode: "momo-routing"})
	_ = c.Start()
	for _, model := range []string{"muse-auto"} {
		status, _, _ := request(t, c, endpoint, "/v1/responses", "POST", strings.Replace(routedPayload, "gpt-5.5", model, 1), nil)
		if status != 501 {
			t.Fatal("unmigrated model accepted")
		}
	}
	status, _, _ := request(t, c, endpoint, "/v1/responses", "POST", bad[0], nil)
	if status != 400 {
		t.Fatal("unsupported stream")
	}
}
func TestRoutedHistoryKindsAndTypes(t *testing.T) {
	base := `{"model":"gpt-5.5","stream":true,"tools":[{"type":"function","name":"read"},{"type":"custom","name":"write"}],"input":[{"role":"user","content":"hello"},%s]}`
	for _, history := range []string{
		`{"type":"function_call","call_id":"a","name":"read","arguments":"{}"},{"type":"custom_tool_call_output","call_id":"a","output":"done"}`,
		`{"type":"custom_tool_call","call_id":"a","name":"write","input":"hi"},{"type":"function_call_output","call_id":"a","output":"done"}`,
		`{"type":"function_call","call_id":"a","name":"read","namespace":42,"arguments":"{}"},{"type":"function_call_output","call_id":"a","output":"done"}`,
		`{"type":42,"role":"user","content":"hello"}`,
	} {
		if _, err := buildChatPlan([]byte(fmt.Sprintf(base, history))); err == nil {
			t.Fatal("invalid history type silently normalized")
		}
	}
}
func TestRoutedTruncationAndErrorsNeverComplete(t *testing.T) {
	streams := []string{
		strings.TrimSuffix(goodChatSSE(), "data: [DONE]\r\n\r\n"),
		"data: broken\n\n",
		strings.TrimSuffix(chatSSE(choice(map[string]any{"content": "partial"}, "length")), "data: [DONE]\r\n\r\n"),
		chatSSE(choice(map[string]any{"content": "partial"}, nil)),
		chatSSE(choice(map[string]any{"tool_calls": []any{map[string]any{"index": 0, "id": "a", "function": map[string]string{"name": "missing", "arguments": "{}"}}}}, "tool_calls")),
		chatSSE(choice(map[string]any{"content": strings.Repeat("a", maxRoutedEvent+1)}, "stop")),
		chatSSE(choice(map[string]any{"content": "DS"}, nil), choice(map[string]any{"content": "ML"}, "stop")),
		chatSSE(choice(map[string]any{"tool_calls": []any{map[string]any{"index": 0, "id": "a", "function": map[string]string{"name": "pad__write", "arguments": "{\"input\":null}"}}}}, "tool_calls")),
	}
	for i, stream := range streams {
		t.Run(fmt.Sprint(i), func(t *testing.T) {
			c, endpoint, _, _ := testCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "text/event-stream")
				fmt.Fprint(w, stream)
			}))
			c.Stop()
			_ = c.Configure(Config{Endpoint: "https://mock.example", APIKey: syntheticKey, Mode: "momo-routing"})
			_ = c.Start()
			req, _ := http.NewRequest("POST", endpoint+"/v1/responses", strings.NewReader(routedPayload))
			req.Header.Set("Authorization", "Bearer "+c.token)
			req.Header.Set("Content-Type", "application/json")
			resp, err := http.DefaultClient.Do(req)
			if err != nil {
				return
			}
			defer resp.Body.Close()
			b, readErr := io.ReadAll(resp.Body)
			if strings.Contains(string(b), "response.completed") || readErr == nil {
				t.Fatal("fabricated successful EOF")
			}
		})
	}
}
func TestRoutedStopCancelsUpstream(t *testing.T) {
	entered := make(chan struct{})
	c, endpoint, _, _ := testCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		io.WriteString(w, "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"a\"}}]}\n\n")
		w.(http.Flusher).Flush()
		close(entered)
		<-r.Context().Done()
	}))
	c.Stop()
	_ = c.Configure(Config{Endpoint: "https://mock.example", APIKey: syntheticKey, Mode: "momo-routing"})
	_ = c.Start()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, "POST", endpoint+"/v1/responses", strings.NewReader(routedPayload))
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal("start stream")
	}
	defer resp.Body.Close()
	<-entered
	c.Stop()
	b, err := io.ReadAll(resp.Body)
	if err == nil || strings.Contains(string(b), "response.completed") {
		t.Fatal("Stop completion")
	}
	deadline := time.Now().Add(time.Second)
	for c.State().Active != 0 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if c.State().Active != 0 {
		t.Fatal("route lease retained")
	}
}
