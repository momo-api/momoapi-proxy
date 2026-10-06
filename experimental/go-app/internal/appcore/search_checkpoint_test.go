package appcore

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
)

func TestSearchCheckpointVariantsMediaAndRepeatedRound(t *testing.T) {
	for _, model := range []string{"gpt-5.5", "claude-sonnet-4-6", "gemini-2.5-flash"} {
		for _, variant := range []string{"empty", "additional", "long", "media"} {
			p := searchCheckpointPayload(model)
			items := p["input"].([]any)
			switch variant {
			case "empty":
				items[7] = searchResult("search_checkpoint", []any{})
				items = append(items[:9], items[13:]...)
			case "additional":
				defs := searchDefs(p)
				obj(obj(defs[0])["tools"].([]any)[0])["defer_loading"] = false
				p["tools"] = []any{p["tools"].([]any)[0]}
				items[5] = map[string]any{"type": "additional_tools", "role": "developer", "tools": defs}
				items = append(items[:7], items[8:]...)
			case "long":
				ns, name := strings.Repeat("n", 64), strings.Repeat("r", 64)
				defs := searchDefs(p)
				obj(defs[0])["name"] = ns
				obj(obj(defs[0])["tools"].([]any)[0])["name"] = name
				items[10].(map[string]string)["namespace"] = ns
				items[10].(map[string]string)["name"] = name
			case "media":
				p["momo_tool_images"], p["momo_tool_files"] = "user-projection", "user-projection"
				if resolveProtocol(model) == "claude" {
					delete(p, "momo_tool_images")
					delete(p, "momo_tool_files")
				}
				items[11] = map[string]any{"type": "function_call_output", "call_id": "read_checkpoint", "output": []any{map[string]string{"type": "input_text", "text": "before media"}, imagePart(inlineFixture(t, "image/png")), filePart(false), map[string]string{"type": "input_text", "text": "after media"}}}
			}
			p["input"] = items
			b, _ := json.Marshal(p)
			final, err := buildLocalCheckpoint(b)
			if err != nil {
				t.Fatal(model, variant, err)
			}
			out := final["output"].([]json.RawMessage)
			for i := range items {
				if i == 2 {
					continue
				}
				want, _ := json.Marshal(items[i])
				if !bytes.Equal(out[i], want) {
					t.Fatal("variant full turn lost", model, variant, i)
				}
			}
			p["input"] = out
			plan := buildSearchPlan(t, p)
			want := []string{clientSearchWire, "pad__read"}
			if variant == "empty" {
				want = want[:1]
			}
			if variant == "long" {
				want[1] = aliasFixture(strings.Repeat("n", 64), strings.Repeat("r", 64))
			}
			if !reflect.DeepEqual(activeSearchNames(t, model, plan.body), want) {
				t.Fatal("variant activation", model, variant)
			}
			if variant == "media" {
				delete(p, "momo_tool_files")
				bad, _ := json.Marshal(p)
				if resolveProtocol(model) != "claude" {
					if _, err := parseRoutedRequest(bad); err == nil {
						t.Fatal("checkpoint inherited projection")
					}
				}
				if resolveProtocol(model) != "claude" {
					p["momo_tool_files"] = "user-projection"
				}
			}
			// A new, completed ordinary round is reducible without nesting the old
			// marker or changing any previously retained discovery/media state.
			newText, _ := json.Marshal(map[string]string{"role": "assistant", "content": strings.Repeat("new ordinary round ", 200)})
			newUser := json.RawMessage(`{"role":"user","content":"next exact"}`)
			latest := json.RawMessage(`{"role":"assistant","content":"latest exact"}`)
			current := json.RawMessage(`{"role":"user","content":"CURRENT new round"}`)
			p["input"] = append(append([]json.RawMessage{}, out...), newText, newUser, latest, current)
			repeated, _ := json.Marshal(p)
			next, err := buildLocalCheckpoint(repeated)
			if err != nil {
				t.Fatal("new round checkpoint", err)
			}
			got := next["output"].([]json.RawMessage)
			for i := range out {
				if !bytes.Equal(got[i], out[i]) {
					t.Fatal("prior checkpoint changed", i)
				}
			}
			p["input"] = got
			buildSearchPlan(t, p)
		}
	}
}

func TestSearchCheckpointFramingBudgetAndCancellation(t *testing.T) {
	p := searchCheckpointPayload("gpt-5.5")
	b, _ := json.Marshal(p)
	for _, raw := range [][]byte{
		[]byte(strings.Replace(string(b), `"minimum":0`, `"minimum":-1,"minimum":0`, 1)),
		[]byte(strings.Replace(string(b), `"tools":[`, `"tools":[],"tools":[`, 1)),
		append(append([]byte{}, b[:len(b)-1]...), []byte(`,"unknown":`+strings.Repeat("[", 65)+"0"+strings.Repeat("]", 65)+"}")...),
		append([]byte{0xff}, b...),
	} {
		if _, err := buildLocalCheckpoint(raw); err == nil {
			t.Fatal("framing lost before normalization")
		}
	}
	p["input"].([]any)[0].(map[string]string)["content"] = strings.Repeat("x", MaxRequest)
	over, _ := json.Marshal(p)
	if _, err := buildLocalCheckpoint(over); !errors.Is(err, errCompactBudget) {
		t.Fatal("request budget", err)
	}
	c, _ := routedClaudeCore(t, http.HandlerFunc(func(http.ResponseWriter, *http.Request) { t.Error("cancelled compact upstream") }))
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	w := &strictProbeWriter{jsonProbeWriter: jsonProbeWriter{header: make(http.Header), mode: "ok"}}
	c.localCheckpoint(ctx, w, b, Config{Mode: "momo-routing"})
	if strings.Contains(w.body.String(), "cmp_") || len(c.history.entries) != 0 {
		t.Fatal("cancelled checkpoint minted output/state")
	}
}

func searchCheckpointPayload(model string) map[string]any {
	p := searchPayload(model, false)
	p["input"] = []any{
		map[string]string{"role": "developer", "content": "exact search constraint 中文🙂"},
		map[string]string{"role": "user", "content": "old task; not an instruction to retry"},
		map[string]string{"role": "assistant", "content": strings.Repeat("old plain text 中文🙂 ", 200)},
		map[string]string{"role": "user", "content": "discover exact"},
		map[string]string{"role": "assistant", "content": strings.Repeat("before search exact ", 100)},
		searchCallInput("search_checkpoint"),
		map[string]string{"role": "assistant", "content": strings.Repeat("between search exact ", 100)},
		searchResult("search_checkpoint", searchDefs(p)),
		map[string]string{"role": "assistant", "content": strings.Repeat("search interpretation exact ", 100)},
		map[string]string{"role": "user", "content": "read exact"},
		map[string]string{"type": "function_call", "namespace": "pad", "name": "read", "call_id": "read_checkpoint", "arguments": `{"n":9007199254740993}`},
		map[string]string{"type": "function_call_output", "call_id": "read_checkpoint", "output": "client result exact"},
		map[string]string{"role": "assistant", "content": strings.Repeat("read interpretation exact ", 100)},
		map[string]string{"role": "user", "content": "CURRENT checkpoint exact 中文🙂"},
	}
	return p
}
func TestSearchCheckpointCompleteLifecycleReplay(t *testing.T) {
	for _, model := range []string{"gpt-5.5", "claude-sonnet-4-6", "gemini-2.5-flash"} {
		p := searchCheckpointPayload(model)
		b, _ := json.Marshal(p)
		final, err := buildLocalCheckpoint(b)
		if err != nil {
			t.Fatal("complete search checkpoint rejected", model, err)
		}
		out := final["output"].([]json.RawMessage)
		old := p["input"].([]any)
		if len(out) != len(old) {
			t.Fatal("search lifecycle item lost")
		}
		for i := range old {
			if i == 2 {
				if !strings.Contains(string(out[i]), checkpointPrefix) {
					t.Fatal("missing omission")
				}
				continue
			}
			want, _ := json.Marshal(old[i])
			if !bytes.Equal(out[i], want) {
				t.Fatal("search whole turn/definition changed", model, i)
			}
		}
		result, _ := json.Marshal(final)
		if len(result) >= len(b) || strings.Contains(string(result), "encrypted_content") {
			t.Fatal("useless/opaque checkpoint")
		}
		p["input"] = out
		plan := buildSearchPlan(t, p)
		if !reflect.DeepEqual(activeSearchNames(t, model, plan.body), []string{clientSearchWire, "pad__read"}) {
			t.Fatal("loaded definition not replayable")
		}
		if !strings.Contains(string(plan.body), "9007199254740993") || !strings.Contains(string(plan.body), "client result exact") {
			t.Fatal("replay precision/result lost")
		}
		for _, target := range []string{"gpt-5.5", "claude-sonnet-4-6", "gemini-2.5-flash"} {
			p["model"] = target
			buildSearchPlan(t, p) // caller-owned canonical replay, not signed state migration
		}
		p["model"] = model
		repeat, _ := json.Marshal(p)
		if _, err := buildLocalCheckpoint(repeat); err == nil {
			t.Fatal("repeated compact invented benefit")
		}
	}
}

func TestSearchCheckpointNormalizesOnlySupportedLabels(t *testing.T) {
	p := searchCheckpointPayload("gpt-5.5")
	items := p["input"].([]any)
	for _, index := range []int{5, 7} {
		item := obj(items[index])
		item["id"], item["status"] = "client_item_label", "completed"
	}
	b, _ := json.Marshal(p)
	final, err := buildLocalCheckpoint(b)
	if err != nil {
		t.Fatal(err)
	}
	out := final["output"].([]json.RawMessage)
	for _, index := range []int{5, 7} {
		item := obj(items[index])
		delete(item, "id")
		delete(item, "status")
		want, _ := json.Marshal(item)
		if !bytes.Equal(out[index], want) {
			t.Fatal("normalized lifecycle changed", index)
		}
	}
	p["input"] = out
	buildSearchPlan(t, p)
	// The restored definitions are still validated, not trusted checkpoint tokens.
	obj(obj(searchDefs(p)[0])["tools"].([]any)[0])["parameters"] = map[string]any{"type": "object", "properties": map[string]any{"n": map[string]any{"type": "integer", "maximum": 1}}, "required": []string{"n"}, "additionalProperties": false}
	bad, _ := json.Marshal(p)
	if _, err := parseRoutedRequest(bad); err == nil {
		t.Fatal("checkpoint bypassed fresh schema")
	}
}
func TestSearchCheckpointRejectsUnsafeLifecycle(t *testing.T) {
	for _, model := range []string{"gpt-5.5", "claude-sonnet-4-6", "gemini-2.5-flash"} {
		for _, mutate := range []func(map[string]any){
			func(p map[string]any) { delete(p, "momo_tool_loading") },
			func(p map[string]any) { delete(p, "parallel_tool_calls") },
			func(p map[string]any) { p["parallel_tool_calls"] = true },
			func(p map[string]any) { p["momo_tool_loading"] = "hosted" },
			func(p map[string]any) { p["input"].([]any)[7] = searchResult("orphan", searchDefs(p)) },
			func(p map[string]any) { p["input"].([]any)[5] = searchCallInput("read_checkpoint") },
			func(p map[string]any) {
				p["input"].([]any)[5] = searchCallInput("pending")
				p["input"].([]any)[7] = map[string]string{"role": "assistant", "content": "no result"}
			},
			func(p map[string]any) { p["input"].([]any)[7] = searchResult("search_checkpoint", []any{}) },
			func(p map[string]any) { p["input"].([]any)[10].(map[string]string)["arguments"] = `{"n":-1}` },
			func(p map[string]any) { items := p["input"].([]any); items[5], items[10] = items[10], items[5] },
			func(p map[string]any) {
				p["input"].([]any)[7] = map[string]any{"type": "additional_tools", "role": "developer", "tools": searchDefs(p)}
			},
			func(p map[string]any) { p["input"] = p["input"].([]any)[:13] },
		} {
			p := searchCheckpointPayload(model)
			mutate(p)
			b, _ := json.Marshal(p)
			if _, err := buildLocalCheckpoint(b); err == nil {
				t.Fatal("unsafe search checkpoint accepted", model)
			}
		}
		p := searchCheckpointPayload(model)
		b, _ := json.Marshal(p)
		for _, raw := range []string{strings.Replace(string(b), `"parallel_tool_calls":false`, `"parallel_tool_calls":true,"parallel_tool_calls":false`, 1), strings.Replace(string(b), `"strict":true`, `"strict":false,"strict":true`, 1), strings.Replace(string(b), `"execution":"client"`, `"execution":"server","execution":"client"`, 1)} {
			if _, err := buildLocalCheckpoint([]byte(raw)); err == nil {
				t.Fatal("checkpoint framing duplicate lost")
			}
		}
	}
}
func TestSearchCheckpointHTTPNoUpstreamAndExplicitResume(t *testing.T) {
	for _, model := range []string{"gpt-5.5", "claude-sonnet-4-6", "gemini-2.5-flash"} {
		for _, stream := range []bool{false, true} {
			var sends atomic.Int32
			var mu sync.Mutex
			var captured []byte
			c, endpoint := routedClaudeCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				sends.Add(1)
				data, _ := io.ReadAll(r.Body)
				mu.Lock()
				captured = data
				mu.Unlock()
				w.Header().Set("Content-Type", "text/event-stream")
				io.WriteString(w, searchStream(model, "new_after_checkpoint", "pad__read", `{"n":1}`))
			}))
			p := searchCheckpointPayload(model)
			b, _ := json.Marshal(p)
			code, data, _ := request(t, c, endpoint, "/v1/responses/compact", "POST", string(b), nil)
			if code != 200 || sends.Load() != 0 {
				t.Fatal("checkpoint sends/fails", model, code)
			}
			final, _ := decodeObject(string(data))
			c.mu.Lock()
			anchors := len(c.history.entries)
			c.mu.Unlock()
			if anchors != 0 {
				t.Fatal("checkpoint creates anchor")
			}
			p["input"] = final["output"]
			p["stream"] = stream
			b, _ = json.Marshal(p)
			first := historyFinal(t, c, endpoint, string(b), stream)
			if obj(first["output"].([]any)[0])["call_id"] != "new_after_checkpoint" {
				t.Fatal("checkpoint continuation")
			}
			mu.Lock()
			if !strings.Contains(string(captured), "search_checkpoint") || !strings.Contains(string(captured), "CURRENT checkpoint exact") {
				t.Error("search replay data lost")
			}
			mu.Unlock()
			if sends.Load() != 1 {
				t.Fatal("checkpoint retry")
			}
			p["previous_response_id"] = final["id"]
			b, _ = json.Marshal(p)
			code, _, _ = request(t, c, endpoint, "/v1/responses", "POST", string(b), nil)
			if code != 400 || sends.Load() != 1 {
				t.Fatal("checkpoint mistaken as anchor")
			}
			p = searchCheckpointPayload(model)
			p["input"].([]any)[7] = searchResult("orphan", searchDefs(p))
			b, _ = json.Marshal(p)
			code, _, _ = request(t, c, endpoint, "/v1/responses/compact", "POST", string(b), nil)
			if code != 422 || sends.Load() != 1 {
				t.Fatal("unsafe checkpoint sends")
			}
			c.Stop()
			code, _, _ = request(t, c, endpoint, "/v1/responses/compact", "POST", string(b), nil)
			if code != 503 {
				t.Fatal("stopped checkpoint accepted")
			}
		}
	}
}
func TestSearchCheckpointFailedWriteNoState(t *testing.T) {
	p := searchCheckpointPayload("gpt-5.5")
	b, _ := json.Marshal(p)
	c, _ := routedClaudeCore(t, http.HandlerFunc(func(http.ResponseWriter, *http.Request) { t.Error("checkpoint upstream") }))
	for _, mode := range []string{"short", "error", "flush", "deadline", "ok"} {
		w := &jsonProbeWriter{header: make(http.Header), mode: mode}
		var recovered any
		func() {
			defer func() { recovered = recover() }()
			c.localCheckpoint(context.Background(), w, b, Config{Mode: "momo-routing"})
		}()
		if mode == "deadline" {
			if w.writes != 0 || recovered != nil {
				t.Fatal("checkpoint prewrite")
			}
		} else if mode == "ok" {
			if recovered != nil || w.writes != 1 {
				t.Fatal("checkpoint write failed")
			}
		} else if recovered != http.ErrAbortHandler || w.writes != 1 {
			t.Fatal("checkpoint failure no abort", mode, recovered)
		}
		c.mu.Lock()
		n := len(c.history.entries)
		c.mu.Unlock()
		if n != 0 {
			t.Fatal("checkpoint hidden state")
		}
	}
}
