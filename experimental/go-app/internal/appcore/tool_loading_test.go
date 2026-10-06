package appcore

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
)

func searchPayload(model string, stream bool) map[string]any {
	return mustSearchObject(`{"model":"` + model + `","stream":` + fmt.Sprint(stream) + `,"momo_tool_loading":"client-search","parallel_tool_calls":false,"input":[{"role":"user","content":"discover 中文🙂"}],"tools":[{"type":"tool_search","execution":"client","parameters":{"type":"object","properties":{"goal":{"type":"string","minLength":1}},"required":["goal"],"additionalProperties":false}},{"type":"namespace","name":"pad","tools":[{"type":"function","name":"read","defer_loading":true,"strict":true,"parameters":{"type":"object","properties":{"n":{"type":"integer","minimum":0}},"required":["n"],"additionalProperties":false}}]}]}`)
}

func mustSearchObject(s string) map[string]any {
	m, err := decodeObject(s)
	if err != nil {
		panic(err)
	}
	return m
}

func searchDefs(p map[string]any) []any { return []any{p["tools"].([]any)[1]} }

func searchCallInput(id string) map[string]any {
	return map[string]any{"type": "tool_search_call", "execution": "client", "call_id": id, "arguments": map[string]any{"goal": "read 中文🙂"}}
}

func searchResult(id string, defs []any) map[string]any {
	return map[string]any{"type": "tool_search_output", "execution": "client", "call_id": id, "tools": defs}
}

func searchStream(model, id, wire, args string) string {
	switch resolveProtocol(model) {
	case "chat":
		return chatSSE(choice(map[string]any{"tool_calls": []any{map[string]any{"index": 0, "id": id, "type": "function", "function": map[string]string{"name": wire, "arguments": args}}}}, "tool_calls"))
	case "claude":
		return claudeStart() + claudeTool(0, id, wire, args) + claudeEnd("tool_use")
	default:
		m, _ := decodeObject(args)
		return geminiFrame([]any{geminiCall(id, wire, m)}, "STOP", geminiUsageFixture())
	}
}

func buildSearchPlan(t *testing.T, p map[string]any) *chatPlan {
	t.Helper()
	b, _ := json.Marshal(p)
	plan, err := map[string]func([]byte) (*chatPlan, error){"chat": buildChatPlan, "claude": buildClaudePlan, "gemini": buildGeminiPlan}[resolveProtocol(str(p["model"]))](b)
	if err != nil {
		t.Fatal(err)
	}
	return plan
}

func activeSearchNames(t *testing.T, model string, b []byte) []string {
	t.Helper()
	m, err := decodeObject(string(b))
	if err != nil {
		t.Fatal(err)
	}
	defs, _ := m["tools"].([]any)
	if resolveProtocol(model) == "gemini" && len(defs) > 0 {
		defs = obj(defs[0])["functionDeclarations"].([]any)
	}
	names := []string{}
	for _, def := range defs {
		m := obj(def)
		if resolveProtocol(model) == "chat" {
			m = obj(m["function"])
		}
		names = append(names, str(m["name"]))
	}
	return names
}

func TestClientSearchThreeTurnHistory(t *testing.T) {
	for _, model := range []string{"gpt-5.5", "claude-sonnet-4-6", "gemini-2.5-flash"} {
		for _, stream := range []bool{false, true} {
			for _, full := range []bool{false, true} {
				t.Run(fmt.Sprint(model, "/", stream, "/", full), func(t *testing.T) {
					var mu sync.Mutex
					captures := [][]byte{}
					c, endpoint := routedClaudeCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
						b, _ := io.ReadAll(r.Body)
						mu.Lock()
						captures = append(captures, b)
						turn := len(captures)
						mu.Unlock()
						w.Header().Set("Content-Type", "text/event-stream")
						if turn == 1 {
							fmt.Fprint(w, searchStream(model, "search_one", clientSearchWire, `{"goal":"read 中文🙂"}`))
						} else if turn == 2 {
							fmt.Fprint(w, searchStream(model, "read_one", "pad__read", `{"n":9007199254740993}`))
						} else {
							switch resolveProtocol(model) {
							case "chat":
								fmt.Fprint(w, chatSSE(choice(map[string]any{"content": "done"}, "stop")))
							case "claude":
								fmt.Fprint(w, claudeStart()+claudeText(0, "done")+claudeEnd("end_turn"))
							default:
								fmt.Fprint(w, geminiFrame([]any{map[string]string{"text": "done"}}, "STOP", geminiUsageFixture()))
							}
						}
					}))
					p := searchPayload(model, stream)
					b, _ := json.Marshal(p)
					first := historyFinal(t, c, endpoint, string(b), stream)
					call := obj(first["output"].([]any)[0])
					if call["type"] != "tool_search_call" || call["call_id"] != "search_one" || call["execution"] != "client" || obj(call["arguments"])["goal"] != "read 中文🙂" || call["name"] != nil {
						t.Fatal("search identity/object arguments")
					}
					transcript := append(append([]any{}, p["input"].([]any)...), first["output"].([]any)...)
					suffix := []any{searchResult("search_one", searchDefs(p))}
					obj(suffix[0])["status"] = "completed"
					p["previous_response_id"] = first["id"]
					p["input"] = suffix
					if full {
						p["input"] = append(append([]any{}, transcript...), suffix...)
					}
					b, _ = json.Marshal(p)
					second := historyFinal(t, c, endpoint, string(b), stream)
					read := obj(second["output"].([]any)[0])
					if read["type"] != "function_call" || read["namespace"] != "pad" || read["name"] != "read" || read["call_id"] != "read_one" || read["arguments"] != `{"n":9007199254740993}` {
						t.Fatal("loaded identity/precision")
					}
					transcript = append(transcript, suffix...)
					transcript = append(transcript, second["output"].([]any)...)
					suffix = []any{map[string]string{"type": "function_call_output", "call_id": "read_one", "output": "client-result"}}
					p["previous_response_id"] = second["id"]
					p["input"] = suffix
					if full {
						p["input"] = append(append([]any{}, transcript...), suffix...)
					}
					b, _ = json.Marshal(p)
					historyFinal(t, c, endpoint, string(b), stream)
					mu.Lock()
					defer mu.Unlock()
					if len(captures) != 3 {
						t.Fatal("retry/execution")
					}
					if !reflect.DeepEqual(activeSearchNames(t, model, captures[0]), []string{clientSearchWire}) {
						t.Fatal("unloaded schema leaked")
					}
					for _, wire := range captures[1:] {
						if !reflect.DeepEqual(activeSearchNames(t, model, wire), []string{clientSearchWire, "pad__read"}) {
							t.Fatal("definition not activated")
						}
						if strings.Count(string(wire), "discover 中文🙂") != 1 || !strings.Contains(string(wire), "search_one") || !strings.Contains(string(wire), "9007199254740993") && string(wire) == string(captures[2]) {
							t.Fatal("ordered history lost/duplicated")
						}
					}
					if !strings.Contains(string(captures[2]), "client-result") {
						t.Fatal("client result lost")
					}
				})
			}
		}
	}
}

func TestClientSearchOrderedLoadingAndIdentity(t *testing.T) {
	for _, model := range []string{"gpt-5.5", "claude-sonnet-4-6", "gemini-2.5-flash"} {
		p := searchPayload(model, false)
		ordinary := mustSearchObject(`{"type":"function","name":"tool_search","parameters":{"type":"object","properties":{}}}`)
		p["tools"] = append(p["tools"].([]any), ordinary)
		plan := buildSearchPlan(t, p)
		if tool, ok := plan.restoreTool("tool_search"); !ok || tool.kind != "function" {
			t.Fatal("ordinary tool_search mistaken for builtin")
		}
		if tool, ok := plan.restoreTool(clientSearchWire); !ok || tool.kind != "tool_search" {
			t.Fatal("builtin alias lost")
		}
		p["tool_choice"] = map[string]string{"type": "tool_search"}
		if buildSearchPlan(t, p).selected != clientSearchWire {
			t.Fatal("builtin choice")
		}
		p["tool_choice"] = map[string]string{"type": "function", "name": "tool_search"}
		if buildSearchPlan(t, p).selected != "tool_search" {
			t.Fatal("ordinary choice")
		}
		delete(p, "tool_choice")
		defs := searchDefs(p)
		obj(obj(defs[0])["tools"].([]any)[0])["defer_loading"] = false
		p["tools"] = []any{p["tools"].([]any)[0]}
		call := mustSearchObject(`{"type":"function_call","name":"read","namespace":"pad","call_id":"r","arguments":"{\"n\":1}"}`)
		result := map[string]string{"type": "function_call_output", "call_id": "r", "output": "ok"}
		additional := map[string]any{"type": "additional_tools", "role": "developer", "tools": defs}
		p["input"] = []any{map[string]string{"role": "user", "content": "load"}, additional, call, result}
		buildSearchPlan(t, p)
		p["input"] = []any{map[string]string{"role": "user", "content": "load"}, call, result, additional}
		b, _ := json.Marshal(p)
		if _, err := parseRoutedRequest(b); err == nil {
			t.Fatal("future declaration validated past call")
		}
	}
}

func TestClientSearchRejectedInputsBeforeSend(t *testing.T) {
	mutations := []struct {
		name   string
		mutate func(map[string]any)
	}{
		{"missing policy", func(p map[string]any) { delete(p, "momo_tool_loading"); delete(p, "parallel_tool_calls") }},
		{"parallel missing", func(p map[string]any) { delete(p, "parallel_tool_calls") }},
		{"parallel true", func(p map[string]any) { p["parallel_tool_calls"] = true }},
		{"server", func(p map[string]any) { obj(p["tools"].([]any)[0])["execution"] = "server" }},
		{"schema keyword", func(p map[string]any) { obj(obj(p["tools"].([]any)[0])["parameters"])["$ref"] = "#/x" }},
		{"deferred chosen", func(p map[string]any) {
			p["tool_choice"] = map[string]string{"type": "function", "name": "read", "namespace": "pad"}
		}},
		{"reserved collision", func(p map[string]any) {
			p["tools"] = append(p["tools"].([]any), map[string]string{"type": "function", "name": clientSearchWire})
		}},
		{"conflicting deferred declaration", func(p map[string]any) {
			other := searchDefs(searchPayload(str(p["model"]), false))[0]
			obj(obj(other)["tools"].([]any)[0])["defer_loading"] = false
			p["tools"] = append(p["tools"].([]any), other)
		}},
		{"orphan result", func(p map[string]any) { p["input"] = []any{searchResult("s", searchDefs(p))} }},
		{"pending search", func(p map[string]any) { p["input"] = []any{searchCallInput("s")} }},
		{"string args", func(p map[string]any) {
			call := searchCallInput("s")
			call["arguments"] = "{}"
			p["input"] = []any{call, searchResult("s", searchDefs(p))}
		}},
		{"null id", func(p map[string]any) {
			call := searchCallInput("s")
			call["call_id"] = nil
			p["input"] = []any{call, searchResult("s", searchDefs(p))}
		}},
		{"long id", func(p map[string]any) {
			id := strings.Repeat("s", 65)
			p["input"] = []any{searchCallInput(id), searchResult(id, searchDefs(p))}
		}},
		{"mismatch", func(p map[string]any) { p["input"] = []any{searchCallInput("s"), searchResult("other", searchDefs(p))} }},
		{"duplicate call", func(p map[string]any) {
			p["input"] = []any{searchCallInput("s"), searchResult("s", []any{}), searchCallInput("s"), searchResult("s", []any{})}
		}},
		{"interruption", func(p map[string]any) {
			p["input"] = []any{searchCallInput("s"), map[string]string{"role": "user", "content": "interrupt"}, searchResult("s", []any{})}
		}},
		{"definition changed", func(p map[string]any) {
			defs := searchDefs(searchPayload(str(p["model"]), false))
			obj(obj(defs[0])["tools"].([]any)[0])["description"] = "changed"
			p["input"] = []any{searchCallInput("s"), searchResult("s", defs)}
		}},
		{"inactive history", func(p map[string]any) {
			p["input"] = []any{mustSearchObject(`{"type":"function_call","name":"read","namespace":"pad","call_id":"r","arguments":"{\"n\":1}"}`), map[string]string{"type": "function_call_output", "call_id": "r", "output": "x"}}
		}},
		{"deferred additional", func(p map[string]any) {
			p["input"] = []any{map[string]any{"type": "additional_tools", "role": "developer", "tools": searchDefs(p)}}
		}},
		{"strict invalid", func(p map[string]any) {
			obj(obj(obj(p["tools"].([]any)[1])["tools"].([]any)[0])["parameters"])["additionalProperties"] = true
		}},
		{"hosted loaded", func(p map[string]any) {
			p["input"] = []any{searchCallInput("s"), searchResult("s", []any{map[string]string{"type": "mcp", "server_label": "no-execution"}})}
		}},
	}
	for _, model := range []string{"gpt-5.5", "claude-sonnet-4-6", "gemini-2.5-flash"} {
		var sends atomic.Int32
		c, endpoint := routedClaudeCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { sends.Add(1) }))
		for _, tc := range mutations {
			t.Run(model+"/"+tc.name, func(t *testing.T) {
				p := searchPayload(model, false)
				tc.mutate(p)
				b, _ := json.Marshal(p)
				code, _, _ := request(t, c, endpoint, "/v1/responses", "POST", string(b), nil)
				if code != 400 {
					t.Fatal("invalid lifecycle not rejected", code)
				}
			})
		}
		if sends.Load() != 0 {
			t.Fatal("invalid loading sent upstream")
		}
	}
}

func TestClientSearchEncoderGateAndWriteBoundary(t *testing.T) {
	for _, model := range []string{"gpt-5.5", "claude-sonnet-4-6", "gemini-2.5-flash"} {
		for _, mode := range []string{"ok", "short", "error", "flush", "deadline", "incomplete"} {
			plan := buildSearchPlan(t, searchPayload(model, false))
			committed := false
			plan.prepareCompletion = func(string, []any) (func(), error) { return func() { committed = true }, nil }
			w := &jsonProbeWriter{header: make(http.Header), mode: mode}
			e, err := newRoutedResponseWriter(w, plan)
			if err != nil || e.accept(streamEvent{kind: "tool", call: streamToolCall{id: "s", name: clientSearchWire, args: `{"goal":"read"}`}}, plan) != nil {
				t.Fatal("search encoder setup")
			}
			if w.writes != 0 {
				t.Fatal("JSON premature write")
			}
			terminal := "complete"
			if mode == "incomplete" {
				terminal = "incomplete"
			}
			err = e.accept(streamEvent{kind: terminal}, plan)
			if mode == "ok" || mode == "incomplete" {
				if err != nil || committed != (mode == "ok") {
					t.Fatal("search terminal boundary")
				}
			} else if err == nil || committed {
				t.Fatal("failed search committed")
			}
		}
		for _, call := range []streamToolCall{{"", "momo__client_tool_search", `{"goal":"read"}`}, {"s", clientSearchWire, `{"goal":1}`}, {"s", clientSearchWire, `{"goal":""}`}, {"s", clientSearchWire, `{"goal":"read","extra":1}`}, {"s", "pad__read", `{"n":1}`}} {
			plan := buildSearchPlan(t, searchPayload(model, false))
			w := &jsonProbeWriter{header: make(http.Header), mode: "ok"}
			e, _ := newRoutedResponseWriter(w, plan)
			if e.accept(streamEvent{kind: "tool", call: call}, plan) == nil || len(e.output) != 0 {
				t.Fatal("invalid/inactive search output accepted")
			}
		}
		plan := buildSearchPlan(t, searchPayload(model, false))
		w := &jsonProbeWriter{header: make(http.Header), mode: "ok"}
		e, _ := newRoutedResponseWriter(w, plan)
		call := streamEvent{kind: "tool", call: streamToolCall{"s", clientSearchWire, `{"goal":"read"}`}}
		if e.accept(call, plan) != nil || e.accept(call, plan) == nil {
			t.Fatal("parallel policy not enforced")
		}
		p := searchPayload(model, false)
		p["input"] = []any{map[string]string{"role": "user", "content": "discover"}, searchCallInput("s"), searchResult("s", searchDefs(p))}
		plan = buildSearchPlan(t, p)
		for _, args := range []string{`{"n":-1}`, `{"n":1.5}`, `{"n":1,"extra":2}`, `{}`} {
			w := &jsonProbeWriter{header: make(http.Header), mode: "ok"}
			e, _ := newRoutedResponseWriter(w, plan)
			if e.accept(streamEvent{kind: "tool", call: streamToolCall{"r", "pad__read", args}}, plan) == nil {
				t.Fatal("strict output not enforced")
			}
		}
	}
}

func TestClientSearchEmptyResultsAndDefinitionBudget(t *testing.T) {
	p := searchPayload("gpt-5.5", false)
	p["input"] = []any{searchCallInput("s"), searchResult("s", []any{})}
	plan := buildSearchPlan(t, p)
	if len(activeSearchNames(t, "gpt-5.5", plan.body)) != 1 {
		t.Fatal("empty search activated deferred tool")
	}
	defs := []any{}
	for i := 0; i < 127; i++ {
		defs = append(defs, map[string]string{"type": "function", "name": fmt.Sprint("f", i)})
	}
	p["tools"] = append([]any{p["tools"].([]any)[0]}, defs...)
	p["input"] = []any{searchCallInput("s"), searchResult("s", []any{defs[0]})}
	buildSearchPlan(t, p)
	p["input"] = []any{searchCallInput("s"), searchResult("s", []any{map[string]string{"type": "function", "name": "overflow"}})}
	b, _ := json.Marshal(p)
	if _, err := parseRoutedRequest(b); err == nil {
		t.Fatal("tool budget exceeded")
	}
}

func TestNativeToolLoadingExactPassthrough(t *testing.T) {
	for _, mode := range []string{"passthrough", "momo-routing"} {
		c, endpoint, _, _ := testCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			b, _ := io.ReadAll(r.Body)
			w.Header().Set("Content-Type", "application/json")
			w.Write(b)
		}))
		c.Stop()
		if err := c.Configure(Config{Endpoint: "https://mock.example", APIKey: syntheticKey, Mode: mode}); err != nil {
			t.Fatal(err)
		}
		if err := c.Start(); err != nil {
			t.Fatal(err)
		}
		p := searchPayload("gpt-5.6-sol", false)
		delete(p, "momo_tool_loading")
		p["input"] = []any{searchCallInput("s"), searchResult("s", searchDefs(p)), map[string]any{"type": "additional_tools", "role": "developer", "tools": []any{map[string]string{"type": "mcp", "server_label": "native-only"}}}}
		b, _ := json.MarshalIndent(p, "", "  ")
		code, body, _ := request(t, c, endpoint, "/v1/responses", "POST", string(b), nil)
		if code != 200 || string(body) != string(b) {
			t.Fatal("native loading changed bytes")
		}
	}
}

func TestClientSearchActualHistoryCommitBoundary(t *testing.T) {
	for _, stream := range []bool{false, true} {
		for _, store := range []bool{false, true} {
			for _, mode := range []string{"ok", "short", "error", "flush", "deadline", "cancel", "incomplete"} {
				t.Run(fmt.Sprint(stream, "/", store, "/", mode), func(t *testing.T) {
					c, _ := routedClaudeCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
					p := searchPayload("gpt-5.5", stream)
					p["store"] = store
					b, _ := json.Marshal(p)
					prepared, seed, err := c.prepareRoutedHistory(b, "gpt-5.5")
					if err != nil {
						t.Fatal(err)
					}
					plan, err := buildChatPlan(prepared)
					if err != nil {
						t.Fatal(err)
					}
					ctx, cancel := context.WithCancel(context.Background())
					defer cancel()
					plan.prepareCompletion = c.historyCompletion(ctx, seed)
					w := &terminalHistoryWriter{jsonProbeWriter: jsonProbeWriter{header: make(http.Header), mode: "ok"}}
					var writer http.ResponseWriter = w
					if !stream {
						writer = &w.jsonProbeWriter
					}
					e, err := newRoutedResponseWriter(writer, plan)
					if err != nil || e.accept(streamEvent{kind: "tool", call: streamToolCall{"search_new", clientSearchWire, `{"goal":"read"}`}}, plan) != nil {
						t.Fatal("search write setup")
					}
					w.mode = mode
					if !stream {
						w.terminal = true
					}
					if mode == "cancel" {
						cancel()
					}
					terminal := "complete"
					if mode == "incomplete" {
						terminal = "incomplete"
					}
					err = e.accept(streamEvent{kind: terminal}, plan)
					c.mu.Lock()
					defer c.mu.Unlock()
					want := 0
					if mode == "ok" && store {
						want = 1
					}
					if len(c.history.entries) != want {
						t.Fatal("failed/cancelled/incomplete search created history")
					}
					if mode == "ok" && err != nil {
						t.Fatal(err)
					}
				})
			}
		}
	}
}

func TestClientSearchIdentityAndSelectionOutputGates(t *testing.T) {
	for _, model := range []string{"gpt-5.5", "claude-sonnet-4-6", "gemini-2.5-flash"} {
		for _, choice := range []any{"none", map[string]any{"type": "allowed_tools", "mode": "auto", "tools": []any{map[string]string{"type": "function", "name": "tool_search"}}}, map[string]string{"type": "function", "name": "tool_search"}} {
			p := searchPayload(model, false)
			p["tools"] = append(p["tools"].([]any), map[string]string{"type": "function", "name": "tool_search"})
			p["tool_choice"] = choice
			plan := buildSearchPlan(t, p)
			w := &jsonProbeWriter{header: make(http.Header), mode: "ok"}
			e, _ := newRoutedResponseWriter(w, plan)
			if e.accept(streamEvent{kind: "tool", call: streamToolCall{"search_new", clientSearchWire, `{"goal":"read"}`}}, plan) == nil {
				t.Fatal("search escaped selection")
			}
		}
		p := searchPayload(model, false)
		p["input"] = []any{map[string]string{"role": "user", "content": "discover"}, searchCallInput("s"), searchResult("s", []any{})}
		plan := buildSearchPlan(t, p)
		w := &jsonProbeWriter{header: make(http.Header), mode: "ok"}
		e, _ := newRoutedResponseWriter(w, plan)
		if e.accept(streamEvent{kind: "tool", call: streamToolCall{"s", clientSearchWire, `{"goal":"read"}`}}, plan) == nil {
			t.Fatal("historical call ID reused")
		}
		p["tool_choice"] = map[string]string{"type": "tool_search"}
		plan = buildSearchPlan(t, p)
		w = &jsonProbeWriter{header: make(http.Header), mode: "ok"}
		e, _ = newRoutedResponseWriter(w, plan)
		if e.accept(streamEvent{kind: "text", text: "not a tool"}, plan) != nil || e.accept(streamEvent{kind: "complete"}, plan) == nil {
			t.Fatal("named search text completed")
		}
	}
}

func TestClientSearchTextCallTextOrderedReplay(t *testing.T) {
	for _, model := range []string{"gpt-5.5", "claude-sonnet-4-6", "gemini-2.5-flash"} {
		p := searchPayload(model, false)
		p["input"] = []any{map[string]string{"role": "user", "content": "discover"}, map[string]string{"role": "assistant", "content": "before"}, searchCallInput("s"), map[string]string{"role": "assistant", "content": "after"}, searchResult("s", []any{})}
		b, _ := json.Marshal(p)
		ir, err := parseRoutedRequest(b)
		if err != nil {
			t.Fatal("generated text/search/text not replayable", err)
		}
		if len(ir.messages) != 3 || len(ir.messages[1].parts) != 3 || ir.messages[1].parts[0].text != "before" || ir.messages[1].parts[1].call == nil || ir.messages[1].parts[2].text != "after" {
			t.Fatal("search block order not retained")
		}
		buildSearchPlan(t, p)
	}
}

func TestClientSearchOutputHistoryBudgetAndOrdinaryIDs(t *testing.T) {
	p := searchPayload("gpt-5.5", false)
	p["tools"] = append(p["tools"].([]any), map[string]string{"type": "function", "name": "ready"})
	for _, id := range []string{"", strings.Repeat("x", 129)} {
		plan := buildSearchPlan(t, p)
		w := &jsonProbeWriter{header: make(http.Header), mode: "ok"}
		e, _ := newRoutedResponseWriter(w, plan)
		if e.accept(streamEvent{kind: "tool", call: streamToolCall{id, "ready", "{}"}}, plan) == nil {
			t.Fatal("ordinary emitted ID not replayable")
		}
	}
	plan := buildSearchPlan(t, p)
	for i := 0; i < 128; i++ {
		plan.loading.seen[fmt.Sprint(i)] = true
	}
	w := &jsonProbeWriter{header: make(http.Header), mode: "ok"}
	e, _ := newRoutedResponseWriter(w, plan)
	if e.accept(streamEvent{kind: "tool", call: streamToolCall{"fresh", clientSearchWire, `{"goal":"read"}`}}, plan) == nil {
		t.Fatal("output exceeds replay call budget")
	}
}
