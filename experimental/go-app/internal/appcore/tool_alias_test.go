package appcore

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"reflect"
	"strings"
	"sync"
	"testing"
)

// Independent wire fixture: full identity digest, not a truncation of identity.
func aliasFixture(ns, name string) string {
	b, _ := json.Marshal([]string{ns, name})
	sum := sha256.Sum256(b)
	hint := (strings.Repeat("_", 16) + name)
	hint = hint[len(hint)-16:]
	return "mta_" + hint + "_" + base64.RawURLEncoding.EncodeToString(sum[:])
}
func aliasPayload(model, ns, name, kind string, stream bool) map[string]any {
	return map[string]any{"model": model, "stream": stream, "input": []any{map[string]string{"role": "user", "content": "alias-turn"}}, "tools": []any{map[string]any{"type": "namespace", "name": ns, "tools": []any{map[string]string{"type": kind, "name": name}}}}}
}
func aliasBuild(p map[string]any) (*chatPlan, error) {
	b, _ := json.Marshal(p)
	return map[string]func([]byte) (*chatPlan, error){"chat": buildChatPlan, "claude": buildClaudePlan, "gemini": buildGeminiPlan}[resolveProtocol(str(p["model"]))](b)
}
func TestLongToolAliasesDeclarationsSelectorsHistory(t *testing.T) {
	ns, name := strings.Repeat("n", 64), strings.Repeat("t", 64)
	wire := aliasFixture(ns, name)
	for _, model := range []string{"gpt-5.5", "claude-sonnet-4-6", "gemini-2.5-flash"} {
		for _, kind := range []string{"function", "custom"} {
			for _, allowed := range []bool{false, true} {
				t.Run(fmt.Sprint(model, "/", kind, "/", allowed), func(t *testing.T) {
					p := aliasPayload(model, ns, name, kind, false)
					selector := map[string]string{"type": kind, "name": name, "namespace": ns}
					p["tool_choice"] = selector
					if allowed {
						p["tool_choice"] = map[string]any{"type": "allowed_tools", "mode": "required", "tools": []any{selector}}
					}
					call := map[string]any{"type": "function_call", "name": name, "namespace": ns, "call_id": "alias_call", "arguments": "{}"}
					result := map[string]any{"type": "function_call_output", "call_id": "alias_call", "output": "paired"}
					if kind == "custom" {
						call["type"] = "custom_tool_call"
						delete(call, "arguments")
						call["input"] = "raw 中文🙂"
						result["type"] = "custom_tool_call_output"
					}
					p["input"] = append(p["input"].([]any), call, result)
					plan, err := aliasBuild(p)
					if err != nil {
						t.Fatal("valid long identity rejected", err)
					}
					if len(plan.tools) != 1 || plan.tools[wire].name != name || plan.tools[wire].namespace != ns || !wireName(wire) || len(wire) != 64 {
						t.Fatal("bounded identity mapping")
					}
					if allowed {
						if !plan.allowed[wire] {
							t.Fatal("allowed selector lost alias")
						}
					} else if plan.selected != wire {
						t.Fatal("named selector lost alias")
					}
					restored, ok := plan.restoreTool(wire)
					if !ok || restored.name != name || restored.namespace != ns {
						t.Fatal("output identity")
					}
					body, _ := decodeObject(string(plan.body))
					if got := activeSearchNames(t, model, plan.body); !reflect.DeepEqual(got, []string{wire}) {
						t.Fatal("declaration", got)
					}
					history := body["messages"]
					if resolveProtocol(model) == "gemini" {
						history = body["contents"]
					}
					h, _ := json.Marshal(history)
					if !strings.Contains(string(h), wire) || strings.Contains(string(h), ns+"__"+name) || !strings.Contains(string(h), "paired") {
						t.Fatal("history lost bounded identity/result")
					}
				})
			}
		}
	}
}
func TestLongToolAliasIdentitySecurity(t *testing.T) {
	ns, name := strings.Repeat("n", 64), strings.Repeat("t", 64)
	wire := aliasFixture(ns, name)
	for _, reverse := range []bool{false, true} {
		p := aliasPayload("gpt-5.5", ns, name, "function", false)
		defs := append(p["tools"].([]any), map[string]string{"type": "function", "name": wire})
		if reverse {
			defs[0], defs[1] = defs[1], defs[0]
		}
		p["tools"] = defs
		plan, err := aliasBuild(p)
		if err != nil {
			t.Fatal(err)
		}
		realWire := aliasFixture("", wire)
		if plan.tools[wire].namespace != ns || plan.tools[realWire].name != wire {
			t.Fatal("reserved identity shadowed alias")
		}
		for _, s := range []string{wire, realWire} {
			tool, ok := plan.restoreTool(s)
			if !ok || tool.wire != s {
				t.Fatal("exact restoration")
			}
		}
		for _, selector := range []map[string]string{{"type": "function", "name": wire, "namespace": "functions"}, {"type": "function", "name": name, "namespace": ns}} {
			p["tool_choice"] = selector
			plan, err = aliasBuild(p)
			if err != nil {
				t.Fatal(err)
			}
			want := wire
			if selector["name"] == wire {
				want = realWire
			}
			if plan.selected != want {
				t.Fatal("selector guessed wire identity")
			}
		}
	}
	p := aliasPayload("gpt-5.5", "functions", wire, "function", false)
	plan, err := aliasBuild(p)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := plan.restoreTool(wire); ok {
		t.Fatal("unregistered reserved wire restored as bare identity")
	}
	p = aliasPayload("gpt-5.5", ns, name, "function", false)
	p["tools"] = append(p["tools"].([]any), map[string]any{"type": "namespace", "name": "other", "tools": []any{map[string]string{"type": "function", "name": name}}})
	plan, err = aliasBuild(p)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := plan.restoreTool(name); ok {
		t.Fatal("ambiguous bare name guessed")
	}
	p["tool_choice"] = map[string]string{"type": "function", "name": name}
	if _, err = aliasBuild(p); err == nil {
		t.Fatal("ambiguous selector guessed")
	}
	p = aliasPayload("gpt-5.5", "a", "b__c", "function", false)
	p["tools"] = append(p["tools"].([]any), map[string]any{"type": "namespace", "name": "a__b", "tools": []any{map[string]string{"type": "function", "name": "c"}}})
	if _, err = aliasBuild(p); err == nil {
		t.Fatal("flatten collision no longer fails closed")
	}
	for _, pair := range [][2]string{{"n", strings.Repeat("t", 65)}, {strings.Repeat("n", 65), "t"}, {"中文", "t"}, {"n", "t.x"}} {
		if _, err = aliasBuild(aliasPayload("gpt-5.5", pair[0], pair[1], "function", false)); err == nil {
			t.Fatal("component validation weakened")
		}
	}
}
func TestLongToolAliasesTCPReplay(t *testing.T) {
	ns, name := strings.Repeat("n", 64), strings.Repeat("t", 64)
	wire := aliasFixture(ns, name)
	for _, model := range []string{"gpt-5.5", "claude-sonnet-4-6", "gemini-2.5-flash"} {
		for _, stream := range []bool{false, true} {
			for _, kind := range []string{"function", "custom"} {
				t.Run(fmt.Sprint(model, stream, kind), func(t *testing.T) {
					var mu sync.Mutex
					captures := [][]byte{}
					c, endpoint := routedClaudeCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
						b, _ := io.ReadAll(r.Body)
						mu.Lock()
						captures = append(captures, b)
						n := len(captures)
						mu.Unlock()
						w.Header().Set("Content-Type", "text/event-stream")
						args := "{}"
						if kind == "custom" {
							args = `{"input":"raw 中文🙂"}`
						}
						if n == 1 {
							io.WriteString(w, searchStream(model, "alias_call", wire, args))
						} else {
							switch resolveProtocol(model) {
							case "chat":
								io.WriteString(w, chatSSE(choice(map[string]any{"content": "done"}, "stop")))
							case "claude":
								io.WriteString(w, claudeStart()+claudeText(0, "done")+claudeEnd("end_turn"))
							default:
								io.WriteString(w, geminiFrame([]any{geminiText("done")}, "STOP", geminiUsageFixture()))
							}
						}
					}))
					p := aliasPayload(model, ns, name, kind, stream)
					b, _ := json.Marshal(p)
					first := historyFinal(t, c, endpoint, string(b), stream)
					output := first["output"].([]any)
					call := obj(output[0])
					if call["name"] != name || call["namespace"] != ns || call["call_id"] != "alias_call" {
						t.Fatal("canonical identity lost")
					}
					resultType := "function_call_output"
					if kind == "custom" {
						resultType = "custom_tool_call_output"
						if call["input"] != "raw 中文🙂" {
							t.Fatal("custom input")
						}
					}
					original := append([]any{}, p["input"].([]any)...)
					suffix := []any{map[string]string{"type": resultType, "call_id": "alias_call", "output": "paired"}}
					p["previous_response_id"] = first["id"]
					p["input"] = suffix
					b, _ = json.Marshal(p)
					historyFinal(t, c, endpoint, string(b), stream)
					p["input"] = append(append(original, output...), suffix...)
					b, _ = json.Marshal(p)
					historyFinal(t, c, endpoint, string(b), stream)
					mu.Lock()
					defer mu.Unlock()
					if len(captures) != 3 || string(captures[1]) != string(captures[2]) || !strings.Contains(string(captures[1]), wire) || strings.Contains(string(captures[1]), ns+"__"+name) {
						t.Fatal("full/suffix history alias changed or duplicated")
					}
				})
			}
		}
	}
}
func TestLongToolAliasClientLoading(t *testing.T) {
	ns, name := strings.Repeat("n", 64), strings.Repeat("t", 64)
	wire := aliasFixture(ns, name)
	for _, model := range []string{"gpt-5.5", "claude-sonnet-4-6", "gemini-2.5-flash"} {
		p := searchPayload(model, false)
		defs := p["tools"].([]any)
		namespace := obj(defs[1])
		namespace["name"] = ns
		obj(namespace["tools"].([]any)[0])["name"] = name
		p["input"] = []any{map[string]string{"role": "user", "content": "load"}, searchCallInput("s"), searchResult("s", searchDefs(p))}
		plan, err := aliasBuild(p)
		if err != nil {
			t.Fatal(err)
		}
		if !plan.loading.active[wire] || len(plan.tools) != 2 {
			t.Fatal("loaded alias redeclaration")
		}
		if got := activeSearchNames(t, model, plan.body); !reflect.DeepEqual(got, []string{clientSearchWire, wire}) {
			t.Fatal("active long tool", got)
		}
	}
}

func TestLongToolAliasDSMLAndBoundaries(t *testing.T) {
	ns, name := strings.Repeat("n", 64), strings.Repeat("t", 64)
	plan, err := aliasBuild(aliasPayload("gpt-5.5", ns, name, "function", false))
	if err != nil {
		t.Fatal(err)
	}
	wire := aliasFixture(ns, name)
	events, err := parseDSML(`<invoke name="`+wire+`"><parameter name="x" string="false">1</parameter></invoke>`, plan)
	if err != nil || len(events) != 1 || events[0].call.name != wire {
		t.Fatal("DSML alias", err)
	}
	for _, bad := range []string{ns + "__" + name, aliasFixture(ns, "unknown")} {
		if _, err := parseDSML(`<invoke name="`+bad+`"></invoke>`, plan); err == nil {
			t.Fatal("unknown/overlong DSML guessed")
		}
	}
	for _, n := range []int{1, 16, 61} {
		p := aliasPayload("gpt-5.5", "n", strings.Repeat("t", n), "function", false)
		plan, err := aliasBuild(p)
		if err != nil {
			t.Fatal(err)
		}
		if plan.tools["n__"+strings.Repeat("t", n)].name == "" {
			t.Fatal("short wire changed")
		}
	}
	p := aliasPayload("gpt-5.5", "n", strings.Repeat("t", 62), "function", false)
	plan, err = aliasBuild(p)
	if err != nil || plan.tools[aliasFixture("n", strings.Repeat("t", 62))].name == "" {
		t.Fatal("65-byte boundary", err)
	}
}

func TestLongToolAliasCrossProviderReplay(t *testing.T) {
	models := []string{"gpt-5.5", "claude-sonnet-4-6", "gemini-2.5-flash"}
	ns, name := strings.Repeat("n", 64), strings.Repeat("t", 64)
	wire := aliasFixture(ns, name)
	for _, source := range models {
		for _, target := range models {
			if source == target {
				continue
			}
			for _, stream := range []bool{false, true} {
				t.Run(fmt.Sprint(source, "/", target, "/", stream), func(t *testing.T) {
					var mu sync.Mutex
					captures := [][]byte{}
					c, endpoint := routedClaudeCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
						b, _ := io.ReadAll(r.Body)
						mu.Lock()
						captures = append(captures, b)
						n := len(captures)
						mu.Unlock()
						if r.Header.Get("X-MOMO-History") != "" {
							t.Error("policy forwarded")
						}
						w.Header().Set("Content-Type", "text/event-stream")
						if n == 1 {
							io.WriteString(w, searchStream(source, "alias_call", wire, "{}"))
							return
						}
						switch resolveProtocol(target) {
						case "chat":
							io.WriteString(w, chatSSE(choice(map[string]any{"content": "target-done"}, "stop")))
						case "claude":
							io.WriteString(w, claudeStart()+claudeText(0, "target-done")+claudeEnd("end_turn"))
						default:
							io.WriteString(w, geminiFrame([]any{geminiText("target-done")}, "STOP", geminiUsageFixture()))
						}
					}))
					p := aliasPayload(source, ns, name, "function", false)
					original := append([]any{}, p["input"].([]any)...)
					b, _ := json.Marshal(p)
					first := historyFinal(t, c, endpoint, string(b), false)
					p["model"], p["stream"], p["previous_response_id"] = target, stream, first["id"]
					suffix := []any{map[string]string{"type": "function_call_output", "call_id": "alias_call", "output": "target-paired"}}
					p["input"] = suffix
					b, _ = json.Marshal(p)
					code, _, _ := request(t, c, endpoint, "/v1/responses", "POST", string(b), nil)
					if code != 400 {
						t.Fatal("default switch accepted")
					}
					post := func() {
						b, _ := json.Marshal(p)
						code, data, _ := request(t, c, endpoint, "/v1/responses", "POST", string(b), map[string]string{"X-MOMO-History": "replay-v1"})
						if code != 200 {
							t.Fatal("explicit switch", code)
						}
						var final map[string]any
						if stream {
							final = responseCompletion(t, data)
						} else {
							final, _ = decodeObject(string(data))
						}
						if final["model"] != target || final["status"] != "completed" {
							t.Fatal("target completion")
						}
					}
					post()
					p["input"] = append(append(original, first["output"].([]any)...), suffix...)
					post()
					mu.Lock()
					defer mu.Unlock()
					if len(captures) != 3 || string(captures[1]) != string(captures[2]) || !strings.Contains(string(captures[1]), wire) || !strings.Contains(string(captures[1]), "target-paired") {
						t.Fatal("cross-provider bounded mapping/full dedup")
					}
					c.mu.Lock()
					defer c.mu.Unlock()
					if c.history.entries[str(first["id"])].model != source {
						t.Fatal("source anchor mutated")
					}
				})
			}
		}
	}
}
