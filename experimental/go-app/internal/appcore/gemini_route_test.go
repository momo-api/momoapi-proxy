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

var geminiPayload = strings.Replace(routedPayload, "gpt-5.5", "gemini-2.5-flash", 1)

func TestGeminiPhysicalDisconnectAfterStop(t *testing.T) {
	c, endpoint := routedClaudeCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		stream := geminiFrame([]any{geminiText("partial")}, "STOP", geminiUsageFixture())
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Content-Length", fmt.Sprint(len(stream)+20))
		fmt.Fprint(w, stream)
	}))
	req, _ := http.NewRequest("POST", endpoint+"/v1/responses", strings.NewReader(geminiPayload))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+c.token)
	client := http.Client{Timeout: 3 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(resp.Body)
	if err == nil || strings.Contains(string(b), "response.completed") {
		t.Fatal("STOP concealed physical disconnect")
	}
}
func TestGeminiUsageAndFunctionCallBounds(t *testing.T) {
	for _, u := range []map[string]any{
		{"promptTokenCount": json.Number("3"), "candidatesTokenCount": json.Number("5"), "totalTokenCount": json.Number("8"), "cachedContentTokenCount": json.Number("4")},
		{"promptTokenCount": json.Number("3"), "candidatesTokenCount": json.Number("5"), "totalTokenCount": json.Number("8"), "thoughtsTokenCount": json.Number("1")},
		{"promptTokenCount": json.Number("3"), "candidatesTokenCount": json.Number("5"), "totalTokenCount": json.Number("9007199254740992")},
	} {
		if _, err := geminiTokenUsage(u); err == nil {
			t.Fatal("invalid usage")
		}
	}
	for name, stream := range map[string]string{
		"detailRegression": geminiFrame([]any{geminiText("a")}, "STOP", geminiUsageFixture()) + geminiFrame(nil, "", map[string]any{"promptTokenCount": 3, "candidatesTokenCount": 5, "totalTokenCount": 10, "thoughtsTokenCount": 1, "cachedContentTokenCount": 1}),
		"usageRegression":  geminiFrame([]any{geminiText("a")}, "STOP", geminiUsageFixture()) + geminiFrame(nil, "", map[string]any{"promptTokenCount": 3, "candidatesTokenCount": 4, "totalTokenCount": 9, "thoughtsTokenCount": 2}),
		"tooManyCalls": func() string {
			var b strings.Builder
			for i := 0; i < 129; i++ {
				b.WriteString(geminiFrame([]any{geminiCall(fmt.Sprint(i), "pad__read", map[string]any{})}, "", nil))
			}
			b.WriteString(geminiFrame(nil, "STOP", geminiUsageFixture()))
			return b.String()
		}(),
	} {
		t.Run(name, func(t *testing.T) {
			c, endpoint := routedClaudeCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "text/event-stream")
				fmt.Fprint(w, stream)
			}))
			req, _ := http.NewRequest("POST", endpoint+"/v1/responses", strings.NewReader(geminiPayload))
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("Authorization", "Bearer "+c.token)
			client := http.Client{Timeout: 3 * time.Second}
			resp, err := client.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			defer resp.Body.Close()
			b, err := io.ReadAll(resp.Body)
			if err == nil || strings.Contains(string(b), "response.completed") {
				t.Fatal("unbounded/invalid stream completed")
			}
		})
	}
}

const geminiPath = "/v1beta/models/gemini-2.5-flash:streamGenerateContent"

func geminiFrame(parts []any, finish string, usage map[string]any) string {
	root := map[string]any{}
	if parts != nil || finish != "" {
		c := map[string]any{"index": 0}
		if parts != nil {
			c["content"] = map[string]any{"role": "model", "parts": parts}
		}
		if finish != "" {
			c["finishReason"] = finish
		}
		root["candidates"] = []any{c}
	}
	if usage != nil {
		root["usageMetadata"] = usage
	}
	b, _ := json.Marshal(root)
	return "data: " + string(b) + "\r\n\r\n"
}
func geminiUsageFixture() map[string]any {
	return map[string]any{"promptTokenCount": 3, "candidatesTokenCount": 5, "totalTokenCount": 10, "cachedContentTokenCount": 2, "thoughtsTokenCount": 2}
}
func geminiText(s string) any { return map[string]any{"text": s} }
func geminiCall(id, name string, args any) any {
	return map[string]any{"functionCall": map[string]any{"id": id, "name": name, "args": args}}
}
func goodGeminiSSE() string {
	return geminiFrame([]any{geminiText("中文🙂"), geminiCall("a", "pad__read", map[string]any{"n": json.Number("9007199254740993")}), geminiText("after"), geminiCall("b", "pad__write", map[string]any{"input": "hello"})}, "", nil) + geminiFrame(nil, "STOP", nil) + geminiFrame(nil, "", geminiUsageFixture())
}
func TestGeminiUnicodeToolsUsageAndTarget(t *testing.T) {
	c, endpoint := routedClaudeCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" || r.URL.Path != geminiPath || r.URL.RawQuery != "alt=sse" || r.Header.Get("Authorization") != "Bearer "+syntheticKey || r.Header.Get("anthropic-version") != "" || r.Header.Get("x-goog-api-key") != "" {
			t.Error("Gemini target/auth/query")
		}
		data, _ := io.ReadAll(r.Body)
		p, err := decodeObject(string(data))
		if err != nil {
			t.Error(err)
			return
		}
		if !only(p, "contents", "systemInstruction", "tools", "toolConfig") || str(obj(obj(p["toolConfig"])["functionCallingConfig"])["mode"]) != "AUTO" || str(obj(obj(p["systemInstruction"])["parts"].([]any)[0])["text"]) != "Be concise." {
			t.Error("Gemini body")
		}
		w.Header().Set("Content-Type", "text/event-stream")
		for _, b := range []byte(goodGeminiSSE()) {
			_, _ = w.Write([]byte{b})
			w.(http.Flusher).Flush()
		}
	}))
	status, b, _ := request(t, c, endpoint, "/v1/responses", "POST", geminiPayload, nil)
	if status != 200 {
		t.Fatal("Gemini status")
	}
	r := responseCompletion(t, b)
	items := r["output"].([]any)
	if len(items) != 4 || str(obj(obj(items[0])["content"].([]any)[0])["text"]) != "中文🙂" || str(obj(obj(items[2])["content"].([]any)[0])["text"]) != "after" {
		t.Fatal("ordered text/tool/text")
	}
	f, custom := obj(items[1]), obj(items[3])
	if str(f["namespace"]) != "pad" || str(f["arguments"]) != `{"n":9007199254740993}` || str(custom["namespace"]) != "pad" || str(custom["input"]) != "hello" {
		t.Fatal("namespaces/precision/custom")
	}
	u := obj(r["usage"])
	if u["input_tokens"] != json.Number("3") || u["output_tokens"] != json.Number("5") || u["total_tokens"] != json.Number("10") || obj(u["input_tokens_details"])["cached_tokens"] != json.Number("2") || obj(u["output_tokens_details"])["reasoning_tokens"] != json.Number("2") {
		t.Fatal("usage/cache/thought count")
	}
}
func TestGeminiRequestHistoryAndChoices(t *testing.T) {
	p, _ := decodeObject(geminiPayload)
	p["input"] = []any{map[string]any{"role": "developer", "content": "rules"}, map[string]any{"role": "user", "content": "hi"}, map[string]any{"role": "assistant", "content": "checking"}, map[string]any{"type": "function_call", "name": "read", "namespace": "pad", "call_id": "a", "arguments": `{"n":9007199254740993}`}, map[string]any{"type": "custom_tool_call", "name": "write", "namespace": "pad", "call_id": "b", "input": "hello"}, map[string]any{"type": "custom_tool_call_output", "call_id": "b", "output": "written"}, map[string]any{"type": "function_call_output", "call_id": "a", "output": "read"}, map[string]any{"role": "user", "content": "continue"}}
	for _, choice := range []string{"auto", "none", "required"} {
		p["tool_choice"] = choice
		b, _ := json.Marshal(p)
		plan, err := buildGeminiPlan(b)
		if err != nil {
			t.Fatal(err)
		}
		wire, _ := decodeObject(string(plan.body))
		contents := wire["contents"].([]any)
		if len(contents) != 3 || len(obj(contents[1])["parts"].([]any)) != 3 || len(obj(contents[2])["parts"].([]any)) != 3 {
			t.Fatal("alternating history")
		}
		parts := obj(contents[1])["parts"].([]any)
		if str(obj(obj(parts[1])["functionCall"])["name"]) != "pad__read" || obj(obj(parts[1])["functionCall"])["args"].(map[string]any)["n"] != json.Number("9007199254740993") || str(obj(obj(parts[2])["functionCall"])["name"]) != "pad__write" {
			t.Fatal("tool alias history")
		}
		results := obj(contents[2])["parts"].([]any)
		if str(obj(obj(results[0])["functionResponse"])["name"]) != "pad__write" || str(obj(obj(results[1])["functionResponse"])["name"]) != "pad__read" {
			t.Fatal("paired result lookup")
		}
		if len(obj(wire["systemInstruction"])["parts"].([]any)) != 2 || str(obj(obj(wire["toolConfig"])["functionCallingConfig"])["mode"]) != map[string]string{"auto": "AUTO", "none": "NONE", "required": "ANY"}[choice] {
			t.Fatal("system/choice")
		}
	}
}
func TestGeminiRejectsBeforeSend(t *testing.T) {
	c, endpoint := routedClaudeCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { t.Error("unsupported Gemini sent upstream") }))
	for name, p := range map[string]string{
		"invalidThinking":  strings.Replace(geminiPayload, `"stream":true`, `"stream":true,"reasoning_effort":"xhigh"`, 1),
		"signedHistory":    strings.Replace(geminiPayload, `"role":"user"`, `"role":"user","thoughtSignature":"opaque"`, 1),
		"media":            strings.Replace(geminiPayload, `"type":"input_text","text":"中文🙂"`, `"type":"input_image","image_url":"https://example.invalid"`, 1),
		"reference":        strings.Replace(geminiPayload, `"instructions":"Be concise."`, `"previous_response_id":"resp_mock"`, 1),
		"invalidMaxTokens": strings.Replace(geminiPayload, `"stream":true`, `"stream":true,"max_output_tokens":0`, 1),
		"invalidstream":    strings.Replace(geminiPayload, `"stream":true`, `"stream":42`, 1),
		"unsafeModel":      strings.Replace(geminiPayload, "gemini-2.5-flash", "gemini-x/../../models?a=1", 1),
	} {
		t.Run(name, func(t *testing.T) {
			status, _, _ := request(t, c, endpoint, "/v1/responses", "POST", p, nil)
			if status != 400 {
				t.Fatal("pre-send rejection")
			}
		})
	}
}
func TestGeminiMalformedStreamsNeverComplete(t *testing.T) {
	good := goodGeminiSSE()
	base := geminiFrame([]any{geminiText("partial")}, "", nil)
	streams := map[string]string{
		"noStop":                base + geminiFrame(nil, "", geminiUsageFixture()),
		"noUsage":               base + geminiFrame(nil, "STOP", nil),
		"maxTokensPartialFrame": base + strings.TrimSuffix(geminiFrame(nil, "MAX_TOKENS", geminiUsageFixture()), "\r\n\r\n"),
		"safety":                base + geminiFrame(nil, "SAFETY", geminiUsageFixture()),
		"lateError":             good + "data: {\"error\":{\"message\":\"failed\"}}\n\n",
		"danglingAfterStop":     good + "data: {",
		"duplicateStop":         good + geminiFrame(nil, "STOP", nil),
		"lateText":              good + base,
		"scalarArgs":            geminiFrame([]any{geminiCall("a", "pad__read", []any{})}, "STOP", geminiUsageFixture()),
		"unknownTool":           geminiFrame([]any{geminiCall("a", "missing", map[string]any{})}, "STOP", geminiUsageFixture()),
		"duplicateID":           geminiFrame([]any{geminiCall("a", "pad__read", map[string]any{}), geminiCall("a", "pad__read", map[string]any{})}, "STOP", geminiUsageFixture()),
		"invalidCustom":         geminiFrame([]any{geminiCall("a", "pad__write", map[string]any{"raw": "not input"})}, "STOP", geminiUsageFixture()),
		"signature":             geminiFrame([]any{map[string]any{"functionCall": map[string]any{"name": "pad__read", "args": map[string]any{}}, "thoughtSignature": "opaque"}}, "STOP", geminiUsageFixture()),
		"thought":               geminiFrame([]any{map[string]any{"text": "invalid summary flag", "thought": "true"}}, "STOP", geminiUsageFixture()),
		"image":                 geminiFrame([]any{map[string]any{"inlineData": map[string]any{"data": "fake"}}}, "STOP", geminiUsageFixture()),
		"cumulativeArgs":        geminiFrame([]any{map[string]any{"functionCall": map[string]any{"name": "pad__read", "partialArgs": "{}"}}}, "STOP", geminiUsageFixture()),
		"blocked":               strings.Replace(good, `"index":0`, `"index":0,"safetyRatings":[{"blocked":true}]`, 1),
		"feedbackBlock":         "data: {\"promptFeedback\":{\"blockReason\":\"SAFETY\"}}\n\n" + good,
		"multipleCandidates":    strings.Replace(good, `"candidates":[`, `"candidates":[{"index":1},`, 1),
		"wrongIndex":            strings.Replace(good, `"index":0`, `"index":1`, 1),
		"badUsage":              strings.Replace(good, `"totalTokenCount":10`, `"totalTokenCount":2`, 1),
		"fraction":              strings.Replace(good, `"promptTokenCount":3`, `"promptTokenCount":3.5`, 1),
		"overflow":              strings.Replace(good, `"promptTokenCount":3`, `"promptTokenCount":9007199254740991`, 1),
		"oversize":              geminiFrame([]any{geminiText(strings.Repeat("a", maxRoutedEvent+1))}, "STOP", geminiUsageFixture()),
		"retained":              geminiFrame([]any{geminiText(strings.Repeat("a", maxRoutedRetained/2))}, "", nil) + geminiFrame([]any{geminiText(strings.Repeat("b", maxRoutedRetained/2+1))}, "STOP", geminiUsageFixture()),
		"badJSON":               "data: broken\n\n",
	}
	for name, stream := range streams {
		t.Run(name, func(t *testing.T) {
			c, endpoint := routedClaudeCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "text/event-stream")
				fmt.Fprint(w, stream)
			}))
			req, _ := http.NewRequest("POST", endpoint+"/v1/responses", strings.NewReader(geminiPayload))
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("Authorization", "Bearer "+c.token)
			client := http.Client{Timeout: 3 * time.Second}
			resp, err := client.Do(req)
			if err != nil {
				t.Fatal("created not received", err)
			}
			defer resp.Body.Close()
			b, err := io.ReadAll(resp.Body)
			if err == nil || strings.Contains(string(b), "response.completed") {
				t.Fatal("fabricated completion")
			}
		})
	}
}
func TestGeminiStopAndDefaultExact(t *testing.T) {
	entered, cancelled := make(chan struct{}), make(chan struct{})
	c, endpoint := routedClaudeCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, geminiFrame([]any{geminiText("partial")}, "", nil))
		w.(http.Flusher).Flush()
		close(entered)
		<-r.Context().Done()
		close(cancelled)
	}))
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, "POST", endpoint+"/v1/responses", strings.NewReader(geminiPayload))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+c.token)
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
		t.Fatal("lease retained")
	}
	stream := "data: provider-native\n\n"
	other, url, _, _ := testCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		if r.URL.Path != "/v1/responses" || string(b) != geminiPayload {
			t.Error("default mutated")
		}
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, stream)
	}))
	_, b, _ = request(t, other, url, "/v1/responses", "POST", geminiPayload, nil)
	if string(b) != stream {
		t.Fatal("default bytes")
	}
}
func TestGeminiGeneratedCallIDAndUsageOnlyTrailer(t *testing.T) {
	stream := geminiFrame([]any{map[string]any{"functionCall": map[string]any{"name": "read", "args": map[string]any{}}}}, "STOP", nil) + geminiFrame(nil, "", geminiUsageFixture())
	c, endpoint := routedClaudeCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, stream)
	}))
	_, b, _ := request(t, c, endpoint, "/v1/responses", "POST", geminiPayload, nil)
	r := responseCompletion(t, b)
	call := obj(r["output"].([]any)[0])
	if !strings.HasPrefix(str(call["call_id"]), "call_") || str(call["namespace"]) != "pad" {
		t.Fatal("generated ID/unique bare name")
	}
}
