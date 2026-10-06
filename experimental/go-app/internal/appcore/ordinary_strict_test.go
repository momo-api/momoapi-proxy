package appcore

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type strictProbeWriter struct {
	jsonProbeWriter
	body strings.Builder
}

func TestOrdinaryStrictAliasChoicesAndNativeDefault(t *testing.T) {
	for _, model := range []string{"gpt-5.5", "claude-sonnet-4-6", "gemini-2.5-flash"} {
		ns, name := strings.Repeat("n", 64), strings.Repeat("t", 64)
		p := ordinaryStrictPayload(model, false)
		obj(p["tools"].([]any)[0])["name"] = ns
		ordinaryStrictTool(p)["name"] = name
		for _, choice := range []any{map[string]string{"type": "function", "namespace": ns, "name": name}, map[string]any{"type": "allowed_tools", "mode": "required", "tools": []any{map[string]string{"type": "function", "namespace": ns, "name": name}}}} {
			p["tool_choice"] = choice
			plan, err := aliasBuild(p)
			if err != nil {
				t.Fatal(err)
			}
			wire := aliasFixture(ns, name)
			if plan.constraints[wire] == nil {
				t.Fatal("strict constraint keyed by wrong alias")
			}
			w := &strictProbeWriter{jsonProbeWriter: jsonProbeWriter{header: make(http.Header), mode: "ok"}}
			e, err := newRoutedResponseWriter(w, plan)
			if err != nil || e.accept(streamEvent{kind: "tool", call: streamToolCall{id: "long", name: wire, args: `{"n":null,"s":null,"nest":null}`}}, plan) != nil || e.accept(streamEvent{kind: "complete"}, plan) != nil {
				t.Fatal("strict long selector rejected")
			}
			m, _ := decodeObject(w.body.String())
			call := obj(m["output"].([]any)[0])
			if call["name"] != name || call["namespace"] != ns {
				t.Fatal("strict long identity lost")
			}
		}
		p = ordinaryStrictPayload(model, false)
		p["tool_choice"] = "none"
		plan, err := aliasBuild(p)
		if err != nil {
			t.Fatal(err)
		}
		e, err := newRoutedResponseWriter(&strictProbeWriter{jsonProbeWriter: jsonProbeWriter{header: make(http.Header), mode: "ok"}}, plan)
		if err != nil || e.accept(streamEvent{kind: "tool", call: streamToolCall{id: "none", name: "pad__read", args: `{"n":null,"s":null,"nest":null}`}}, plan) == nil {
			t.Fatal("strict bypasses none")
		}
		p = ordinaryStrictPayload(model, false)
		delete(ordinaryStrictTool(p), "strict")
		plan, err = aliasBuild(p)
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(string(plan.body), `"strict"`) {
			t.Fatal("absent strict invented")
		}
	}
	var captured string
	var mu sync.Mutex
	c, endpoint, _, _ := testCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		data, _ := io.ReadAll(r.Body)
		mu.Lock()
		captured = string(data)
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"ok":true}`)
	}))
	// Unsupported strict schema/duplicate fields deliberately bypass local IR in default mode.
	b := ` {"model":"gpt-5.5","input":[{"role":"user","content":"default"}],"tools":[{"type":"function","name":"f","strict":false,"strict":true,"parameters":{"type":"string","pattern":".*"}}]} `
	code, _, _ := request(t, c, endpoint, "/v1/responses", "POST", b, nil)
	mu.Lock()
	defer mu.Unlock()
	if code != 200 || captured != b {
		t.Fatal("default native bytes changed", code)
	}
}

func TestOrdinaryStrictDuplicatePreflightBeforeHistory(t *testing.T) {
	var sends atomic.Int32
	c, endpoint := routedClaudeCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { sends.Add(1) }))
	for _, model := range []string{"gpt-5.5", "claude-sonnet-4-6", "gemini-2.5-flash"} {
		p := ordinaryStrictPayload(model, false)
		p["store"] = false
		b, _ := json.Marshal(p)
		for _, raw := range []string{strings.Replace(string(b), `"strict":true`, `"strict":false,"strict":true`, 1), strings.Replace(string(b), `"minimum":0`, `"minimum":-1,"minimum":0`, 1), strings.Replace(string(b), `"additionalProperties":false`, `"additionalProperties":true,"additionalProperties":false`, 1)} {
			code, _, _ := request(t, c, endpoint, "/v1/responses", "POST", raw, nil)
			if code != 400 || sends.Load() != 0 {
				t.Fatal("duplicate lost to history normalization", code)
			}
		}
	}
}

func TestOrdinaryStrictDSMLAndStop(t *testing.T) {
	for _, stream := range []bool{false, true} {
		for _, valid := range []bool{true, false} {
			value := "1"
			if !valid {
				value = "-1"
			}
			source := `<tool_calls><invoke name="pad__read"><parameter name="n" string="false">` + value + `</parameter><parameter name="s" string="true">a</parameter><parameter name="nest" string="false">null</parameter></invoke></tool_calls>`
			var sends atomic.Int32
			c, endpoint := routedClaudeCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				sends.Add(1)
				w.Header().Set("Content-Type", "text/event-stream")
				io.WriteString(w, chatSSE(choice(map[string]any{"content": source}, "stop")))
			}))
			b, _ := json.Marshal(ordinaryStrictPayload("gpt-5.5", stream))
			req, _ := http.NewRequest("POST", endpoint+"/v1/responses", strings.NewReader(string(b)))
			req.Header.Set("Authorization", "Bearer "+c.token)
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("X-MOMO-Tool-Text", "dsml-v1")
			resp, err := http.DefaultClient.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			data, readErr := io.ReadAll(resp.Body)
			resp.Body.Close()
			c.mu.Lock()
			anchors := len(c.history.entries)
			c.mu.Unlock()
			if sends.Load() != 1 {
				t.Fatal("DSML retry")
			}
			if valid {
				if resp.StatusCode != 200 || readErr != nil || !strings.Contains(string(data), "completed") {
					t.Fatal("strict DSML rejected", resp.StatusCode, string(data))
				}
			} else {
				if anchors != 0 || strings.Contains(string(data), "response.completed") || !stream && resp.StatusCode != 502 || stream && readErr == nil {
					t.Fatal("DSML strict bypass", resp.StatusCode, string(data))
				}
			}
		}
	}
	full := strictTestStream("gpt-5.5", `{"n":null,"s":null,"nest":null}`)
	stalled := strings.TrimSuffix(full, "data: [DONE]\r\n\r\n")
	if stalled == full || strings.Contains(stalled, "[DONE]") {
		t.Fatal("stalled fixture")
	}
	entered := make(chan struct{})
	var sends atomic.Int32
	c, endpoint := routedClaudeCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sends.Add(1)
		w.Header().Set("Content-Type", "text/event-stream")
		io.WriteString(w, stalled)
		w.(http.Flusher).Flush()
		close(entered)
		<-r.Context().Done()
	}))
	b, _ := json.Marshal(ordinaryStrictPayload("gpt-5.5", true))
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, "POST", endpoint+"/v1/responses", strings.NewReader(string(b)))
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	<-entered
	c.Stop()
	data, readErr := io.ReadAll(resp.Body)
	c.mu.Lock()
	defer c.mu.Unlock()
	if readErr == nil || strings.Contains(string(data), "response.completed") || sends.Load() != 1 || len(c.history.entries) != 0 {
		t.Fatal("strict Stop completed/retried/anchored", readErr)
	}
}

func TestOrdinaryStrictReplayAndPerTurnConstraints(t *testing.T) {
	models := []string{"gpt-5.5", "claude-sonnet-4-6", "gemini-2.5-flash"}
	for _, source := range models {
		for _, target := range models {
			var mu sync.Mutex
			captures := [][]byte{}
			c, endpoint := routedClaudeCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				b, _ := io.ReadAll(r.Body)
				mu.Lock()
				captures = append(captures, b)
				n := len(captures)
				mu.Unlock()
				w.Header().Set("Content-Type", "text/event-stream")
				model := target
				if n == 1 {
					model = source
				}
				io.WriteString(w, strictTestStream(model, `{"n":null,"s":null,"nest":null}`))
			}))
			p := ordinaryStrictPayload(source, false)
			b, _ := json.Marshal(p)
			first := historyFinal(t, c, endpoint, string(b), false)
			suffix := []any{map[string]string{"type": "function_call_output", "call_id": "strict_call", "output": "paired-strict-result"}, map[string]string{"role": "user", "content": "continue-strict"}}
			p = ordinaryStrictPayload(target, false)
			p["previous_response_id"] = first["id"]
			p["input"] = suffix
			p["store"] = false
			headers := map[string]string{}
			if source != target {
				headers["X-MOMO-History"] = "replay-v1"
			}
			b, _ = json.Marshal(p)
			code, data, _ := request(t, c, endpoint, "/v1/responses", "POST", string(b), headers)
			if code != 200 {
				t.Fatal("strict suffix replay", source, target, code, string(data))
			}
			full := append([]any{}, ordinaryStrictPayload(source, false)["input"].([]any)...)
			full = append(full, first["output"].([]any)...)
			full = append(full, suffix...)
			p["input"] = full
			b, _ = json.Marshal(p)
			code, _, _ = request(t, c, endpoint, "/v1/responses", "POST", string(b), headers)
			if code != 200 {
				t.Fatal("strict full replay", source, target, code)
			}
			mu.Lock()
			if len(captures) != 3 || string(captures[1]) != string(captures[2]) || !strings.Contains(string(captures[1]), "paired-strict-result") {
				t.Error("strict full/suffix not exact")
			}
			mu.Unlock()
			// A stricter current declaration revalidates past calls before another send.
			ordinaryStrictTool(p)["parameters"] = mustSearchObject(`{"type":"object","properties":{"n":{"type":"integer"},"s":{"type":"string"},"nest":{"type":"object","properties":{},"required":[],"additionalProperties":false}},"required":["n","s","nest"],"additionalProperties":false}`)
			p["input"] = suffix
			b, _ = json.Marshal(p)
			code, _, _ = request(t, c, endpoint, "/v1/responses", "POST", string(b), headers)
			mu.Lock()
			count := len(captures)
			mu.Unlock()
			if code != 400 || count != 3 {
				t.Fatal("strict history schema revalidation bypass", code, count)
			}
			// strict:false is request-scoped; old anchors do not impose old constraints.
			ordinaryStrictTool(p)["strict"] = false
			b, _ = json.Marshal(p)
			code, _, _ = request(t, c, endpoint, "/v1/responses", "POST", string(b), headers)
			if code != 200 {
				t.Fatal("strict option inherited from anchor", code)
			}
		}
	}
}

func (w *strictProbeWriter) Write(b []byte) (int, error) {
	n, err := w.jsonProbeWriter.Write(b)
	w.body.Write(b[:n])
	return n, err
}

func ordinaryStrictPayload(model string, stream bool) map[string]any {
	p := aliasPayload(model, "pad", "read", "function", stream)
	children := obj(p["tools"].([]any)[0])["tools"].([]any)
	tool := map[string]any{"type": "function", "name": "read"}
	children[0] = tool
	tool["strict"] = true
	tool["parameters"] = mustSearchObject(`{"type":"object","properties":{"n":{"type":["integer","null"],"minimum":0},"s":{"type":["string","null"],"minLength":1,"maxLength":2},"nest":{"type":["object","null"],"properties":{"ok":{"type":"boolean"}},"required":["ok"],"additionalProperties":false}},"required":["n","s","nest"],"additionalProperties":false}`)
	return p
}
func ordinaryStrictTool(p map[string]any) map[string]any {
	return obj(obj(p["tools"].([]any)[0])["tools"].([]any)[0])
}
func TestOrdinaryStrictIndependentProtocolMapping(t *testing.T) {
	for _, model := range []string{"gpt-5.5", "claude-sonnet-4-6", "gemini-2.5-flash"} {
		for _, strict := range []bool{true, false} {
			p := ordinaryStrictPayload(model, false)
			ordinaryStrictTool(p)["strict"] = strict
			plan, err := aliasBuild(p)
			if err != nil {
				t.Fatal("ordinary strict must not require loading", model, strict, err)
			}
			body, _ := decodeObject(string(plan.body))
			defs := body["tools"].([]any)
			declaration := obj(defs[0])
			schemaKey := "input_schema"
			switch resolveProtocol(model) {
			case "chat":
				declaration = obj(declaration["function"])
				schemaKey = "parameters"
				if declaration["strict"] != strict {
					t.Fatal("explicit Chat strict lost")
				}
			case "gemini":
				declaration = obj(declaration["functionDeclarations"].([]any)[0])
				schemaKey = "parametersJsonSchema"
			}
			if resolveProtocol(model) != "chat" && declaration["strict"] != nil {
				t.Fatal("undocumented provider strict invented")
			}
			if !reflect.DeepEqual(declaration[schemaKey], ordinaryStrictTool(p)["parameters"]) {
				t.Fatal("schema changed")
			}
			if plan.loading != nil {
				t.Fatal("strict must not activate loading or single-call")
			}
		}
	}
}
func TestOrdinaryStrictGeneratedArgumentsAndHistory(t *testing.T) {
	good := `{"n":9007199254740993,"s":"中🙂","nest":{"ok":true}}`
	for _, model := range []string{"gpt-5.5", "claude-sonnet-4-6", "gemini-2.5-flash"} {
		for _, stream := range []bool{true, false} {
			for _, args := range []string{good, `{"n":null,"s":null,"nest":null}`, `{"n":-1,"s":"a","nest":null}`, `{"n":1.5,"s":"a","nest":null}`, `{"n":1,"s":"","nest":null}`, `{"n":1,"s":"abc","nest":null}`, `{"n":1,"s":"a","nest":{"ok":true,"extra":1}}`, `{"n":1,"s":"a"}`, `{"n":1,"s":"a","nest":null,"extra":1}`} {
				p := ordinaryStrictPayload(model, stream)
				plan, err := aliasBuild(p)
				if err != nil {
					t.Fatal(err)
				}
				w := &strictProbeWriter{jsonProbeWriter: jsonProbeWriter{header: make(http.Header), mode: "ok"}}
				var committed bool
				plan.prepareCompletion = func(string, []any) (func(), error) { return func() { committed = true }, nil }
				switch resolveProtocol(model) {
				case "chat":
					err = convertChatStream(context.Background(), w, strings.NewReader(searchStream(model, "strict_call", "pad__read", args)), plan)
				case "claude":
					err = convertClaudeStream(context.Background(), w, strings.NewReader(searchStream(model, "strict_call", "pad__read", args)), plan)
				default:
					err = convertGeminiStream(context.Background(), w, strings.NewReader(searchStream(model, "strict_call", "pad__read", args)), plan)
				}
				valid := args == good || strings.Contains(args, `"n":null`)
				if valid {
					if err != nil || !committed || !strings.Contains(w.body.String(), "strict_call") {
						t.Fatal("valid strict args rejected", model, stream, err)
					}
				} else if err == nil || committed || strings.Contains(w.body.String(), "response.completed") {
					t.Fatal("invalid strict output accepted", model, args)
				}
				p["input"] = []any{map[string]string{"role": "user", "content": "history"}, map[string]string{"type": "function_call", "call_id": "strict_history", "namespace": "pad", "name": "read", "arguments": args}, map[string]string{"type": "function_call_output", "call_id": "strict_history", "output": "done"}}
				_, err = aliasBuild(p)
				if (err == nil) != valid {
					t.Fatal("historical strict not enforced", model, args, err)
				}
			}
		}
	}
}
func TestOrdinaryStrictPreflightNoSendAndNativeBytes(t *testing.T) {
	var sends atomic.Int32
	var captured string
	var mu sync.Mutex
	c, endpoint := routedClaudeCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		data, _ := io.ReadAll(r.Body)
		mu.Lock()
		captured = string(data)
		mu.Unlock()
		sends.Add(1)
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"native":true}`)
	}))
	for _, strict := range []any{nil, "true", 1} {
		p := ordinaryStrictPayload("gpt-5.5", false)
		ordinaryStrictTool(p)["strict"] = strict
		b, _ := json.Marshal(p)
		code, _, _ := request(t, c, endpoint, "/v1/responses", "POST", string(b), nil)
		if code != 400 || sends.Load() != 0 {
			t.Fatal("invalid strict sent", code)
		}
	}
	for _, schema := range []string{`{"type":"object","properties":{"x":{"type":"string","pattern":".*"}},"required":["x"],"additionalProperties":false}`, `{"type":"object","properties":{"x":{"type":"string"}},"required":[],"additionalProperties":false}`, `{"type":"object","properties":{},"additionalProperties":true}`} {
		p := ordinaryStrictPayload("gpt-5.5", false)
		ordinaryStrictTool(p)["parameters"] = mustSearchObject(schema)
		b, _ := json.Marshal(p)
		code, _, _ := request(t, c, endpoint, "/v1/responses", "POST", string(b), nil)
		if code != 400 || sends.Load() != 0 {
			t.Fatal("unsupported strict schema sent", code)
		}
	}
	p := ordinaryStrictPayload("gpt-5.6-sol", false)
	b, _ := json.Marshal(p)
	code, _, _ := request(t, c, endpoint, "/v1/responses", "POST", string(b), nil)
	mu.Lock()
	defer mu.Unlock()
	if code != 200 || sends.Load() != 1 || captured != string(b) {
		t.Fatal("native strict blocked", code)
	}
}

func strictTestStream(model, args string) string {
	if resolveProtocol(model) != "gemini" {
		return searchStream(model, "strict_call", "pad__read", args)
	}
	// Do not parse/reserialize the test argument: that hides duplicate keys.
	return strings.Replace(searchStream(model, "strict_call", "pad__read", "{}"), `"args":{}`, `"args":`+args, 1)
}

func TestOrdinaryStrictFramingAndFalse(t *testing.T) {
	for _, model := range []string{"gpt-5.5", "claude-sonnet-4-6", "gemini-2.5-flash"} {
		for _, stream := range []bool{false, true} {
			for _, args := range []string{`{"n":-1,"n":1,"s":"a","nest":null}`, `{"n":1,"s":"a","nest":{"ok":false,"ok":true}}`, `{"n":1,"s":"a","nest":` + strings.Repeat("[", 65) + "0" + strings.Repeat("]", 65) + "}"} {
				p := ordinaryStrictPayload(model, stream)
				plan, err := aliasBuild(p)
				if err != nil {
					t.Fatal(err)
				}
				w := &strictProbeWriter{jsonProbeWriter: jsonProbeWriter{header: make(http.Header), mode: "ok"}}
				convert := map[string]func(context.Context, http.ResponseWriter, io.Reader, *chatPlan) error{"chat": convertChatStream, "claude": convertClaudeStream, "gemini": convertGeminiStream}[resolveProtocol(model)]
				if convert(context.Background(), w, strings.NewReader(strictTestStream(model, args)), plan) == nil || strings.Contains(w.body.String(), "response.completed") {
					t.Fatal("strict framing bypass", model, args)
				}
				p["input"] = []any{map[string]string{"type": "function_call", "name": "read", "namespace": "pad", "call_id": "bad_history", "arguments": args}, map[string]string{"type": "function_call_output", "call_id": "bad_history", "output": "done"}}
				if _, err := aliasBuild(p); err == nil {
					t.Fatal("historical framing bypass", model)
				}
			}
			for _, flag := range []any{false, nil} {
				p := ordinaryStrictPayload(model, stream)
				if flag == nil {
					delete(ordinaryStrictTool(p), "strict")
				} else {
					ordinaryStrictTool(p)["strict"] = flag
				}
				plan, err := aliasBuild(p)
				if err != nil || len(plan.constraints) != 0 {
					t.Fatal("false/absent imposes strict", err)
				}
				e, err := newRoutedResponseWriter(&strictProbeWriter{jsonProbeWriter: jsonProbeWriter{header: make(http.Header), mode: "ok"}}, plan)
				if err != nil || e.accept(streamEvent{kind: "tool", call: streamToolCall{id: "non_strict", name: "pad__read", args: "{}"}}, plan) != nil {
					t.Fatal("non-strict value rejected")
				}
			}
			plan, err := aliasBuild(ordinaryStrictPayload(model, stream))
			if err != nil {
				t.Fatal(err)
			}
			for _, frame := range []string{string([]byte{0xff}), `{"x":1,"x":2}`, `{"x":` + strings.Repeat("[", 65) + "0" + strings.Repeat("]", 65) + "}"} {
				if _, err := plan.decodeFrame(frame); err == nil {
					t.Fatal("strict frame accepted", model)
				}
			}
			badUTF := `{"n":1,"s":"` + string([]byte{0xff}) + `","nest":null}`
			e, err := newRoutedResponseWriter(&strictProbeWriter{jsonProbeWriter: jsonProbeWriter{header: make(http.Header), mode: "ok"}}, plan)
			if err != nil || e.accept(streamEvent{kind: "tool", call: streamToolCall{id: "utf", name: "pad__read", args: badUTF}}, plan) == nil {
				t.Fatal("strict UTF8 argument accepted")
			}
		}
		p := ordinaryStrictPayload(model, false)
		b, _ := json.Marshal(p)
		duplicate := strings.Replace(string(b), `"strict":true`, `"strict":false,"strict":true`, 1)
		if _, err := parseRoutedRequest([]byte(duplicate)); err == nil {
			t.Fatal("duplicate strict accepted")
		}
	}
}

func TestOrdinaryStrictNullableSchemaBranches(t *testing.T) {
	for _, tc := range []struct{ schema, valid, invalid string }{
		{`{"type":["number","null"],"minimum":0,"maximum":2}`, `{"v":1.5}`, `{"v":3}`},
		{`{"type":["integer","null"],"minimum":0}`, `{"v":9007199254740993}`, `{"v":1.5}`},
		{`{"type":["string","null"],"minLength":1,"maxLength":2}`, `{"v":"中🙂"}`, `{"v":"abc"}`},
		{`{"type":["boolean","null"]}`, `{"v":true}`, `{"v":0}`},
		{`{"type":["array","null"],"items":{"type":["integer","null"]},"minItems":1,"maxItems":2}`, `{"v":[null,1]}`, `{"v":[]}`},
		{`{"type":["object","null"],"properties":{"x":{"type":"boolean"}},"required":["x"],"additionalProperties":false}`, `{"v":{"x":true}}`, `{"v":{"x":true,"y":false}}`},
		{`{"type":["string","integer","null"],"minLength":1,"minimum":0,"enum":["ok",1,null]}`, `{"v":1.0}`, `{"v":2}`},
	} {
		s := mustSearchObject(tc.schema)
		if validateSearchSchema(s) != nil || validateStrictSchema(s) != nil {
			t.Fatal("valid union rejected", tc.schema)
		}
		for _, text := range []string{tc.valid, `{"v":null}`} {
			if validateSearchValue(s, mustSearchObject(text)["v"]) != nil {
				t.Fatal("union valid value rejected", tc.schema, text)
			}
		}
		if validateSearchValue(s, mustSearchObject(tc.invalid)["v"]) == nil {
			t.Fatal("union bound ignored", tc.schema)
		}
	}
	for _, raw := range []string{
		`{"type":["object","null"],"properties":{"x":{"type":"string"}},"additionalProperties":false}`,
		`{"type":["array","null"],"items":{"type":["object","null"],"properties":{},"additionalProperties":true}}`,
	} {
		s := mustSearchObject(raw)
		if validateSearchSchema(s) != nil || validateStrictSchema(s) == nil {
			t.Fatal("nested strict union object bypass", raw)
		}
	}
}

func TestOrdinaryStrictWriteFailureAndMultiple(t *testing.T) {
	for _, model := range []string{"gpt-5.5", "claude-sonnet-4-6", "gemini-2.5-flash"} {
		for _, mode := range []string{"short", "error", "flush", "deadline"} {
			plan, err := aliasBuild(ordinaryStrictPayload(model, false))
			if err != nil {
				t.Fatal(err)
			}
			committed := false
			plan.prepareCompletion = func(string, []any) (func(), error) { return func() { committed = true }, nil }
			w := &strictProbeWriter{jsonProbeWriter: jsonProbeWriter{header: make(http.Header), mode: mode}}
			convert := map[string]func(context.Context, http.ResponseWriter, io.Reader, *chatPlan) error{"chat": convertChatStream, "claude": convertClaudeStream, "gemini": convertGeminiStream}[resolveProtocol(model)]
			if convert(context.Background(), w, strings.NewReader(strictTestStream(model, `{"n":null,"s":null,"nest":null}`)), plan) == nil || committed || w.writes > 1 {
				t.Fatal("strict failed write committed/retried", model, mode)
			}
		}
		for _, stream := range []bool{false, true} {
			for _, terminal := range []string{"complete", "incomplete"} {
				p := ordinaryStrictPayload(model, stream)
				p["parallel_tool_calls"] = true
				plan, err := aliasBuild(p)
				if err != nil {
					t.Fatal(err)
				}
				w := &strictProbeWriter{jsonProbeWriter: jsonProbeWriter{header: make(http.Header), mode: "ok"}}
				e, err := newRoutedResponseWriter(w, plan)
				if err != nil {
					t.Fatal(err)
				}
				for _, id := range []string{"one", "two"} {
					if e.accept(streamEvent{kind: "tool", call: streamToolCall{id: id, name: "pad__read", args: `{"n":null,"s":null,"nest":null}`}}, plan) != nil {
						t.Fatal("strict coupled to single-call")
					}
				}
				if e.accept(streamEvent{kind: terminal}, plan) != nil {
					t.Fatal("strict terminal rejected")
				}
			}
		}
	}
}

func TestOrdinaryStrictRejectedTCPNoHistoryOrRetry(t *testing.T) {
	for _, model := range []string{"gpt-5.5", "claude-sonnet-4-6", "gemini-2.5-flash"} {
		for _, stream := range []bool{false, true} {
			var sends atomic.Int32
			c, endpoint := routedClaudeCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				sends.Add(1)
				w.Header().Set("Content-Type", "text/event-stream")
				io.WriteString(w, strictTestStream(model, `{"n":-1,"s":"a","nest":null}`))
			}))
			b, _ := json.Marshal(ordinaryStrictPayload(model, stream))
			req, _ := http.NewRequest("POST", endpoint+"/v1/responses", strings.NewReader(string(b)))
			req.Header.Set("Authorization", "Bearer "+c.token)
			req.Header.Set("Content-Type", "application/json")
			client := http.Client{Timeout: 3 * time.Second}
			resp, err := client.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			data, readErr := io.ReadAll(resp.Body)
			resp.Body.Close()
			client.CloseIdleConnections()
			c.mu.Lock()
			anchors := len(c.history.entries)
			c.mu.Unlock()
			if sends.Load() != 1 || anchors != 0 || strings.Contains(string(data), "response.completed") || strings.Contains(string(data), "response.incomplete") || !stream && resp.StatusCode != 502 || stream && readErr == nil {
				t.Fatal("strict failure accepted/retried", model, stream, resp.StatusCode, readErr, anchors)
			}
		}
	}
}
