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

var claudePayload = strings.Replace(routedPayload, "gpt-5.5", "claude-sonnet-4-6", 1)

func TestClaudeAdditionalAcceptedShapes(t *testing.T) {
	for name, stream := range map[string]string{
		"initialObject": claudeStart() + claudeFrame("content_block_start", map[string]any{"index": 0, "content_block": map[string]any{"type": "tool_use", "id": "a", "name": "read", "input": map[string]any{"n": json.Number("9007199254740993")}}}) + claudeFrame("content_block_stop", map[string]any{"index": 0}) + claudeEnd("tool_use"),
		"stopSequence":  claudeStart() + claudeText(0, "done") + claudeFrame("message_delta", map[string]any{"delta": map[string]any{"stop_reason": "stop_sequence", "stop_sequence": "STOP"}, "usage": map[string]any{"output_tokens": 5}}) + claudeFrame("message_stop", map[string]any{}),
		"ping":          claudeFrame("ping", map[string]any{}) + claudeStart() + claudeText(0, "done") + claudeEnd("end_turn"),
	} {
		t.Run(name, func(t *testing.T) {
			c, endpoint := routedClaudeCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "text/event-stream")
				fmt.Fprint(w, stream)
			}))
			_, b, _ := request(t, c, endpoint, "/v1/responses", "POST", claudePayload, nil)
			responseCompletion(t, b)
		})
	}
	for _, choice := range []string{"auto", "none", "required"} {
		payload := strings.Replace(claudePayload, `"stream":true`, `"stream":true,"tool_choice":"`+choice+`"`, 1)
		plan, err := buildClaudePlan([]byte(payload))
		if err != nil {
			t.Fatal(err)
		}
		p, _ := decodeObject(string(plan.body))
		want := choice
		if want == "required" {
			want = "any"
		}
		if str(obj(p["tool_choice"])["type"]) != want {
			t.Fatal("tool choice mapping")
		}
	}
	e := &responseWriter{completed: true}
	for _, kind := range []string{"text", "tool", "complete"} {
		if e.accept(streamEvent{kind: kind}, nil) == nil {
			t.Fatal("encoder reused after completion")
		}
	}
}

func claudeFrame(typ string, fields map[string]any) string {
	fields["type"] = typ
	b, _ := json.Marshal(fields)
	return "event: " + typ + "\r\ndata: " + string(b) + "\r\n\r\n"
}
func claudeStart() string {
	return claudeFrame("message_start", map[string]any{"message": map[string]any{"id": "msg_mock", "type": "message", "role": "assistant", "model": "claude-sonnet-4-6", "content": []any{}, "stop_reason": nil, "stop_sequence": nil, "usage": map[string]any{"input_tokens": 3, "output_tokens": 1, "cache_read_input_tokens": 2, "cache_creation_input_tokens": 4}}})
}
func claudeEnd(reason string) string {
	return claudeFrame("message_delta", map[string]any{"delta": map[string]any{"stop_reason": reason, "stop_sequence": nil}, "usage": map[string]any{"output_tokens": 5}}) + claudeFrame("message_stop", map[string]any{})
}
func claudeText(index int, text string) string {
	return claudeFrame("content_block_start", map[string]any{"index": index, "content_block": map[string]any{"type": "text", "text": ""}}) + claudeFrame("content_block_delta", map[string]any{"index": index, "delta": map[string]any{"type": "text_delta", "text": text}}) + claudeFrame("content_block_stop", map[string]any{"index": index})
}
func claudeTool(index int, id, name, args string) string {
	return claudeFrame("content_block_start", map[string]any{"index": index, "content_block": map[string]any{"type": "tool_use", "id": id, "name": name, "input": map[string]any{}}}) + claudeFrame("content_block_delta", map[string]any{"index": index, "delta": map[string]any{"type": "input_json_delta", "partial_json": args}}) + claudeFrame("content_block_stop", map[string]any{"index": index})
}
func goodClaudeSSE() string {
	return claudeStart() + claudeText(0, "中文🙂") + claudeTool(1, "read_call", "pad__read", `{"n":9007199254740993}`) + claudeText(2, "after") + claudeTool(3, "write_call", "pad__write", `{"input":"text('hi')"}`) + claudeEnd("tool_use")
}
func routedClaudeCore(t *testing.T, upstream http.Handler) (*Core, string) {
	t.Helper()
	c, endpoint, _, _ := testCore(t, upstream)
	c.Stop()
	if c.Configure(Config{Endpoint: "https://mock.example", APIKey: syntheticKey, Mode: "momo-routing"}) != nil || c.Start() != nil {
		t.Fatal("configure Claude")
	}
	return c, endpoint
}
func responseCompletion(t *testing.T, data []byte) map[string]any {
	t.Helper()
	var completed map[string]any
	for _, line := range strings.Split(string(data), "\n") {
		if !strings.HasPrefix(line, "data: ") {
			continue
		}
		m, err := decodeObject(line[6:])
		if err != nil {
			t.Fatal("invalid emitted JSON")
		}
		if str(m["type"]) == "response.completed" {
			if completed != nil {
				t.Fatal("duplicate completion")
			}
			completed = obj(m["response"])
		}
	}
	if completed == nil {
		t.Fatal("missing completion")
	}
	return completed
}
func TestClaudeUnicodeToolsUsageAndSharedEncoder(t *testing.T) {
	c, endpoint := routedClaudeCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/messages" || r.Method != "POST" || r.Header.Get("anthropic-version") != "2023-06-01" || r.Header.Get("Authorization") != "Bearer "+syntheticKey || r.Header.Get("x-api-key") != "" {
			t.Error("Claude route/header")
		}
		b, _ := io.ReadAll(r.Body)
		p, err := decodeObject(string(b))
		if err != nil {
			t.Error("request JSON")
			return
		}
		if p["stream"] != true || str(p["system"]) != "Be concise." || p["max_tokens"] != json.Number("12240") || str(obj(p["tool_choice"])["type"]) != "auto" || len(p["tools"].([]any)) != 2 {
			t.Error("Claude request contract")
		}
		w.Header().Set("Content-Type", "text/event-stream")
		for _, b := range []byte(goodClaudeSSE()) {
			_, _ = w.Write([]byte{b})
			w.(http.Flusher).Flush()
		}
	}))
	code, data, _ := request(t, c, endpoint, "/v1/responses", "POST", claudePayload, nil)
	if code != 200 {
		t.Fatal("HTTP status")
	}
	result := responseCompletion(t, data)
	output := result["output"].([]any)
	if len(output) != 4 {
		t.Fatal("output order")
	}
	first, last := obj(output[0]), obj(output[2])
	if str(obj(first["content"].([]any)[0])["text"]) != "中文🙂" || str(obj(last["content"].([]any)[0])["text"]) != "after" {
		t.Fatal("text/tool/text buffer duplicated")
	}
	f, cust := obj(output[1]), obj(output[3])
	if str(f["namespace"]) != "pad" || str(f["name"]) != "read" || str(f["arguments"]) != `{"n":9007199254740993}` || str(cust["namespace"]) != "pad" || str(cust["input"]) != "text('hi')" || str(cust["type"]) != "custom_tool_call" {
		t.Fatal("namespace/large integer/custom restoration")
	}
	u := obj(result["usage"])
	if u["input_tokens"] != json.Number("9") || u["output_tokens"] != json.Number("5") || u["total_tokens"] != json.Number("14") {
		t.Fatal("usage mapping")
	}
}
func TestClaudeRequestIRHistoryAndStrictness(t *testing.T) {
	p, err := decodeObject(claudePayload)
	if err != nil {
		t.Fatal(err)
	}
	p["tool_choice"] = "required"
	p["input"] = []any{map[string]any{"role": "developer", "content": "rules"}, map[string]any{"role": "user", "content": "hi"}, map[string]any{"role": "assistant", "content": "checking"}, map[string]any{"type": "function_call", "call_id": "a", "namespace": "pad", "name": "read", "arguments": `{"n":9007199254740993}`}, map[string]any{"type": "custom_tool_call", "call_id": "b", "namespace": "pad", "name": "write", "input": "hi"}, map[string]any{"type": "custom_tool_call_output", "call_id": "b", "output": "written"}, map[string]any{"type": "function_call_output", "call_id": "a", "output": "read"}, map[string]any{"role": "user", "content": "continue"}}
	b, _ := json.Marshal(p)
	plan, err := buildClaudePlan(b)
	if err != nil {
		t.Fatal(err)
	}
	wire, _ := decodeObject(string(plan.body))
	if str(wire["system"]) != "Be concise.\n\nrules" || str(obj(wire["tool_choice"])["type"]) != "any" {
		t.Fatal("system/tool choice semantics")
	}
	messages := wire["messages"].([]any)
	if len(messages) != 3 || len(obj(messages[1])["content"].([]any)) != 3 || len(obj(messages[2])["content"].([]any)) != 3 || !strings.Contains(string(plan.body), "9007199254740993") {
		t.Fatal("paired parallel tool history")
	}
	for name, bad := range map[string]string{
		"trailingJSON": claudePayload + "{}", "thinkingModel": strings.Replace(claudePayload, "claude-sonnet-4-6", "claude-sonnet-4-6-thinking", 1),
		"effort":        strings.Replace(claudePayload, `"stream":true`, `"stream":true,"reasoning":{"effort":"high"}`, 1),
		"media":         strings.Replace(claudePayload, `"type":"input_text","text":"中文🙂"`, `"type":"input_image","image_url":"https://example.invalid"`, 1),
		"reference":     strings.Replace(claudePayload, `"instructions":"Be concise."`, `"previous_response_id":"resp_mock"`, 1),
		"invalidstream": strings.Replace(claudePayload, `"stream":true`, `"stream":null`, 1),
		"unknownOption": strings.Replace(claudePayload, `"stream":true`, `"stream":true,"max_output_tokens":4`, 1),
		"scalarArgs":    strings.Replace(string(b), `{\"n\":9007199254740993}`, `42`, 1),
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := buildClaudePlan([]byte(bad)); err == nil {
				t.Fatal("unsupported payload accepted")
			}
		})
	}
}
func TestClaudeRejectsWithoutUpstream(t *testing.T) {
	c, endpoint := routedClaudeCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { t.Error("rejected request sent") }))
	for _, p := range []string{strings.Replace(claudePayload, `"stream":true`, `"stream":null`, 1), strings.Replace(claudePayload, `"stream":true`, `"stream":true,"reasoning_effort":"high"`, 1)} {
		code, _, _ := request(t, c, endpoint, "/v1/responses", "POST", p, nil)
		if code != 400 {
			t.Fatal("must reject before upstream")
		}
	}
}
func TestClaudeMalformedStreamsAbortTCP(t *testing.T) {
	good := goodClaudeSSE()
	streams := map[string]string{
		"missingStop":   strings.TrimSuffix(good, claudeFrame("message_stop", map[string]any{})),
		"missingFinish": claudeStart() + claudeText(0, "partial") + claudeFrame("message_stop", map[string]any{}),
		"badJSON":       "data: broken\n\n", "wrongEvent": strings.Replace(good, "event: message_start", "event: message_delta", 1),
		"duplicateStart": claudeStart() + good, "wrongIndex": claudeStart() + claudeText(1, "wrong") + claudeEnd("end_turn"),
		"unfinishedBlock": claudeStart() + claudeFrame("content_block_start", map[string]any{"index": 0, "content_block": map[string]any{"type": "text", "text": "partial"}}) + claudeEnd("end_turn"),
		"duplicateID":     claudeStart() + claudeTool(0, "a", "pad__read", "{}") + claudeTool(1, "a", "pad__read", "{}") + claudeEnd("tool_use"),
		"scalarArgs":      claudeStart() + claudeTool(0, "a", "pad__read", "[]") + claudeEnd("tool_use"),
		"badCustom":       claudeStart() + claudeTool(0, "a", "pad__write", `{"input":null}`) + claudeEnd("tool_use"),
		"unknownTool":     claudeStart() + claudeTool(0, "a", "unknown", "{}") + claudeEnd("tool_use"),
		"thinking":        claudeStart() + claudeFrame("content_block_start", map[string]any{"index": 0, "content_block": map[string]any{"type": "thinking", "thinking": "secret"}}) + claudeEnd("end_turn"),
		"error":           claudeStart() + claudeFrame("error", map[string]any{"error": map[string]any{"type": "overloaded_error"}}),
		"maxTokens":       claudeStart() + claudeText(0, "partial") + claudeEnd("max_tokens"),
		"noToolsFinish":   claudeStart() + claudeText(0, "partial") + claudeEnd("tool_use"),
		"missingUsage":    strings.Replace(good, `"output_tokens":5`, `"ignored":5`, 1),
		"fractionUsage":   strings.Replace(good, `"output_tokens":5`, `"output_tokens":5.5`, 1),
		"usageOverflow":   strings.Replace(good, `"input_tokens":3`, `"input_tokens":9007199254740991`, 1),
		"oversizeEvent":   claudeStart() + claudeText(0, strings.Repeat("a", maxRoutedEvent+1)) + claudeEnd("end_turn"),
		"retainedLimit":   claudeStart() + claudeText(0, strings.Repeat("a", maxRoutedRetained/2)) + claudeText(1, strings.Repeat("b", maxRoutedRetained/2+1)) + claudeEnd("end_turn"),
		"unknownDelta":    strings.Replace(good, `"type":"text_delta"`, `"type":"text_delta","citations":[]`, 1),
	}
	for name, stream := range streams {
		t.Run(name, func(t *testing.T) {
			c, endpoint := routedClaudeCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "text/event-stream")
				fmt.Fprint(w, stream)
			}))
			req, _ := http.NewRequest("POST", endpoint+"/v1/responses", strings.NewReader(claudePayload))
			req.Header.Set("Authorization", "Bearer "+c.token)
			req.Header.Set("Content-Type", "application/json")
			client := http.Client{Timeout: 3 * time.Second}
			resp, err := client.Do(req)
			if err != nil {
				t.Fatal("must receive created before abort", err)
			}
			defer resp.Body.Close()
			b, err := io.ReadAll(resp.Body)
			if err == nil || strings.Contains(string(b), "response.completed") {
				t.Fatal("fabricated completion")
			}
		})
	}
}
func TestClaudeDefaultPassthroughUnchanged(t *testing.T) {
	stream := "data: provider-native\n\n"
	c, endpoint, _, _ := testCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		if r.URL.Path != "/v1/responses" || string(b) != claudePayload || r.Header.Get("anthropic-version") != "" {
			t.Error("default modified")
		}
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, stream)
	}))
	_, b, _ := request(t, c, endpoint, "/v1/responses", "POST", claudePayload, nil)
	if string(b) != stream {
		t.Fatal("passthrough changed")
	}
}
func TestClaudeStopCancelsUpstream(t *testing.T) {
	entered, cancelled := make(chan struct{}), make(chan struct{})
	c, endpoint := routedClaudeCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, claudeStart())
		w.(http.Flusher).Flush()
		close(entered)
		<-r.Context().Done()
		close(cancelled)
	}))
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, "POST", endpoint+"/v1/responses", strings.NewReader(claudePayload))
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	<-entered
	c.Stop()
	b, err := io.ReadAll(resp.Body)
	if err == nil || strings.Contains(string(b), "response.completed") {
		t.Fatal("Stop completed")
	}
	select {
	case <-cancelled:
	case <-time.After(time.Second):
		t.Fatal("upstream not cancelled")
	}
	deadline := time.Now().Add(time.Second)
	for c.State().Active != 0 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if c.State().Active != 0 {
		t.Fatal("admission retained")
	}
}
