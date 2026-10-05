package appcore

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
)

func TestToolImageParallelMultipleImagesAndFinalProjection(t *testing.T) {
	inline := inlineFixture(t, "image/png")
	parts := []any{imagePart(inline), map[string]any{"type": "input_text", "text": "between"}, imagePart(inline)}
	for _, tc := range []struct{ model, policy string }{{"gpt-5.5", "user-projection"}, {"claude-sonnet-4-6", ""}, {"gemini-2.5-flash", "user-projection"}, {"gemini-3.1-flash", ""}} {
		p := toolImagePayload(tc.model, tc.policy, parts, true)
		input := p["input"].([]any)
		obj(input[4])["output"] = parts
		// The final input is a tool result; no user message may be needed to flush it.
		p["input"] = input[:5]
		plan, err := toolImageBuild(p)
		if err != nil {
			t.Fatal(tc, err)
		}
		wire, _ := decodeObject(string(plan.body))
		switch resolveProtocol(tc.model) {
		case "chat":
			messages := wire["messages"].([]any)
			if len(messages) != 6 {
				t.Fatal("final parallel projections not flushed")
			}
			for i, id := range []string{"image_call", "text_call"} {
				if obj(messages[2+i])["tool_call_id"] != id || obj(messages[4+i])["role"] != "user" {
					t.Fatal("projection interrupted parallel results")
				}
				got := obj(messages[4+i])["content"]
				want := append([]any{map[string]any{"type": "text", "text": toolImageMarker(id)}}, chatImageParts([]routePart{{image: &routeImage{url: inline}}, {text: "between"}, {image: &routeImage{url: inline}}})...)
				if !reflect.DeepEqual(got, want) {
					t.Fatal("parallel projected images reordered")
				}
			}
		case "claude":
			messages := wire["messages"].([]any)
			results := obj(messages[2])["content"].([]any)
			if len(results) != 2 {
				t.Fatal("parallel native results split")
			}
			for i, id := range []string{"image_call", "text_call"} {
				result := obj(results[i])
				blocks := result["content"].([]any)
				if result["tool_use_id"] != id || len(blocks) != 3 || obj(blocks[0])["type"] != "image" || obj(blocks[1])["text"] != "between" || obj(blocks[2])["type"] != "image" {
					t.Fatal("parallel nested images lost identity/order")
				}
			}
		case "gemini":
			contents := wire["contents"].([]any)
			results := obj(contents[2])["parts"].([]any)
			if len(results) != 2 {
				t.Fatal("parallel Gemini results split")
			}
			for i, id := range []string{"image_call", "text_call"} {
				result := obj(obj(results[i])["functionResponse"])
				if result["id"] != id {
					t.Fatal("parallel Gemini identity lost")
				}
				if tc.policy == "" {
					want := []any{map[string]any{"image_part": json.Number("0")}, map[string]any{"text": "between"}, map[string]any{"image_part": json.Number("1")}}
					if len(result["parts"].([]any)) != 2 || !reflect.DeepEqual(obj(result["response"])["result"], want) {
						t.Fatal("per-result Gemini image index changed")
					}
				} else if len(contents) != 5 || obj(obj(contents[3+i])["parts"].([]any)[0])["text"] != toolImageMarker(id) {
					t.Fatal("Gemini final projection flush/order")
				}
			}
		}
	}
}

func TestToolImageSharedUserToolBudgetAndEscapedMarker(t *testing.T) {
	inline := inlineFixture(t, "image/png")
	for _, count := range []int{31, 32} {
		parts := make([]any, count)
		for i := range parts {
			parts[i] = imagePart(inline)
		}
		p := toolImagePayload("claude-sonnet-4-6", "", parts, false)
		obj(p["input"].([]any)[0])["content"] = []any{imagePart(inline)}
		_, err := toolImageBuild(p)
		if count == 31 && err != nil || count == 32 && !errors.Is(err, errUnsupportedImage) {
			t.Fatal("user/tool images did not share budget", count, err)
		}
	}
	id := "line\n\"quoted\"\\tail"
	p := toolImagePayload("gpt-5.5", "user-projection", []any{imagePart(inline)}, false)
	input := p["input"].([]any)
	obj(input[1])["call_id"], obj(input[2])["call_id"] = id, id
	plan, err := toolImageBuild(p)
	if err != nil {
		t.Fatal(err)
	}
	quoted, _ := json.Marshal(id)
	marker := toolImageMarker(id)
	if strings.ContainsAny(marker, "\r\n") || !strings.Contains(marker, "call_id="+string(quoted)+";") {
		t.Fatal("call ID injected marker lines")
	}
	wire, _ := decodeObject(string(plan.body))
	if obj(wire["messages"].([]any)[2])["tool_call_id"] != id {
		t.Fatal("escaped marker changed actual call identity")
	}
}

func TestToolImageProjectionPolicyNotInherited(t *testing.T) {
	for _, model := range []string{"gpt-5.5", "gemini-2.5-flash"} {
		var sends atomic.Int32
		c, endpoint := routedClaudeCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			sends.Add(1)
			w.Header().Set("Content-Type", "text/event-stream")
			wire := chatSSE(choice(map[string]any{"content": "answer"}, "stop"))
			if resolveProtocol(model) == "gemini" {
				wire = geminiFrame([]any{geminiText("answer")}, "STOP", geminiUsageFixture())
			}
			io.WriteString(w, wire)
		}))
		p := toolImagePayload(model, "user-projection", []any{imagePart(inlineFixture(t, "image/png"))}, false)
		b, _ := json.Marshal(p)
		first := historyFinal(t, c, endpoint, string(b), false)
		c.mu.Lock()
		order, size := append([]string{}, c.history.order...), c.history.bytes
		c.mu.Unlock()
		p["previous_response_id"] = first["id"]
		p["input"] = []any{map[string]any{"role": "user", "content": "NEXT"}}
		delete(p, "momo_tool_images")
		b, _ = json.Marshal(p)
		code, body, _ := request(t, c, endpoint, "/v1/responses", "POST", string(b), nil)
		if code != 400 || strings.TrimSpace(string(body)) != "unsupported_tool_image_output" {
			t.Fatal("projection policy silently inherited", model, code)
		}
		c.mu.Lock()
		if !reflect.DeepEqual(c.history.order, order) || c.history.bytes != size {
			t.Error("undeclared projection changed history")
		}
		c.mu.Unlock()
		p["momo_tool_images"] = "user-projection"
		b, _ = json.Marshal(p)
		historyFinal(t, c, endpoint, string(b), false)
		if sends.Load() != 2 {
			t.Fatal("rejected projection sent upstream")
		}
	}
}

func TestToolImageHistoryOnlyAfterDeliveredTerminal(t *testing.T) {
	testToolMediaHistoryOnlyAfterDeliveredTerminal(t, false)
}

func TestPDFHistoryOnlyAfterDeliveredTerminal(t *testing.T) {
	testToolMediaHistoryOnlyAfterDeliveredTerminal(t, true)
}

func testToolMediaHistoryOnlyAfterDeliveredTerminal(t *testing.T, pdf bool) {
	t.Helper()
	inline := inlineFixture(t, "image/png")
	for _, tc := range []struct{ model, policy string }{{"gpt-5.5", "user-projection"}, {"claude-sonnet-4-6", ""}, {"gemini-2.5-flash", "user-projection"}, {"gemini-3.1-flash", ""}} {
		for _, stream := range []bool{true, false} {
			for _, mode := range []string{"short", "error", "flush", "deadline", "cancel", "stop", "incomplete", "ok"} {
				t.Run(fmt.Sprint(tc.model, "/", stream, "/", mode), func(t *testing.T) {
					// This is a writer transaction test, not a TCP test; avoid allocating
					// 128 unused TLS servers/listeners on the bounded race CI runners.
					c, err := New()
					if err != nil {
						t.Fatal(err)
					}
					t.Cleanup(c.Close)
					if c.Configure(Config{Endpoint: "https://mock.example", APIKey: syntheticKey, Mode: "momo-routing"}) != nil || c.Start() != nil {
						t.Fatal("configure writer core")
					}
					p := toolImagePayload(tc.model, tc.policy, []any{imagePart(inline)}, true)
					mediaType := "input_image"
					if pdf {
						p = toolImagePayload(tc.model, "", []any{filePart(false)}, true)
						mediaType = "input_file"
						if resolveProtocol(tc.model) != "claude" {
							p["momo_tool_files"] = "user-projection"
						}
					}
					p["stream"] = stream
					b, _ := json.Marshal(p)
					prepared, seed, err := c.prepareRoutedHistory(b, tc.model)
					if err != nil {
						t.Fatal(err)
					}
					decoded, _ := decodeObject(string(prepared))
					plan, err := toolImageBuild(decoded)
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
					if err != nil || e.accept(streamEvent{kind: "text", text: "answer"}, plan) != nil {
						t.Fatal("writer setup")
					}
					w.mode = mode
					if mode == "cancel" {
						cancel()
					} else if mode == "stop" {
						c.Stop()
					}
					terminal := "complete"
					if mode == "incomplete" {
						terminal = "incomplete"
					}
					err = e.accept(streamEvent{kind: terminal}, plan)
					c.mu.Lock()
					defer c.mu.Unlock()
					if mode == "ok" {
						entry := c.history.entries[e.id]
						if err != nil || len(c.history.entries) != 1 || !strings.Contains(string(entry.input[3]), mediaType) || strings.Contains(string(entry.input[3]), "user-projection") {
							t.Fatal("successful original tool images not cached")
						}
					} else if len(c.history.entries) != 0 || c.history.bytes != 0 {
						t.Fatal("failed/cancelled/Stop terminal cached tool image")
					}
				})
			}
		}
	}
}

func toolImagePayload(model, policy string, parts []any, parallel bool) map[string]any {
	input := []any{map[string]any{"role": "user", "content": "inspect"}, map[string]any{"type": "function_call", "namespace": "pad", "name": "read", "call_id": "image_call", "arguments": "{}"}}
	if parallel {
		input = append(input, map[string]any{"type": "custom_tool_call", "namespace": "pad", "name": "write", "call_id": "text_call", "input": "unchanged"})
	}
	input = append(input, map[string]any{"type": "function_call_output", "call_id": "image_call", "output": parts})
	if parallel {
		input = append(input, map[string]any{"type": "custom_tool_call_output", "call_id": "text_call", "output": "plain second result"})
	}
	input = append(input, map[string]any{"role": "user", "content": "CURRENT"})
	p := map[string]any{"model": model, "stream": false, "input": input, "tools": []any{map[string]any{"type": "namespace", "name": "pad", "tools": []any{map[string]any{"type": "function", "name": "read"}, map[string]any{"type": "custom", "name": "write"}}}}}
	if policy != "" {
		p["momo_tool_images"] = policy
	}
	return p
}

func toolImageBuild(p map[string]any) (*chatPlan, error) {
	b, _ := json.Marshal(p)
	switch resolveProtocol(str(p["model"])) {
	case "claude":
		return buildClaudePlan(b)
	case "gemini":
		return buildGeminiPlan(b)
	default:
		return buildChatPlan(b)
	}
}

func TestToolImageDeclarationIdentityAndParallelGate(t *testing.T) {
	inline := inlineFixture(t, "image/png")
	for _, model := range []string{"gpt-5.5", "claude-sonnet-4-6", "gemini-2.5-flash", "gemini-3.1-flash"} {
		policy := ""
		if model == "gpt-5.5" || model == "gemini-2.5-flash" {
			policy = "user-projection"
		}
		for _, inverse := range []bool{false, true} {
			p := toolImagePayload(model, policy, []any{imagePart(inline)}, false)
			call := obj(p["input"].([]any)[1])
			if inverse {
				p["tools"] = []any{map[string]any{"type": "function", "name": "pad__read"}}
			} else {
				delete(call, "namespace")
				call["name"] = "pad__read"
			}
			if _, err := toolImageBuild(p); err == nil {
				t.Error("wire alias accepted as different declared identity", model, inverse)
			}
		}
		for _, value := range []any{"false", nil, []any{}, map[string]any{}} {
			p := toolImagePayload(model, policy, []any{imagePart(inline)}, false)
			p["parallel_tool_calls"] = value
			if _, err := toolImageBuild(p); !errors.Is(err, errRouted) {
				t.Error("invalid parallel boolean not rejected", model, value, err)
			}
		}
	}
}

func TestToolImageWireAttributionOrderAndParallelPairing(t *testing.T) {
	inline := inlineFixture(t, "image/png")
	_, data, _ := strings.Cut(inline, ",")
	parts := []any{map[string]any{"type": "input_text", "text": "before"}, imagePart(inline), map[string]any{"type": "input_text", "text": "after"}}
	for _, tc := range []struct{ model, policy string }{{"gpt-5.5", "user-projection"}, {"claude-sonnet-4-6", ""}, {"gemini-2.5-flash", "user-projection"}, {"gemini-3.1-flash", ""}} {
		p := toolImagePayload(tc.model, tc.policy, parts, true)
		plan, err := toolImageBuild(p)
		if err != nil {
			t.Fatal(err)
		}
		wire, _ := decodeObject(string(plan.body))
		if strings.Contains(string(plan.body), "momo_tool_images") {
			t.Fatal("policy leaked upstream")
		}
		switch resolveProtocol(tc.model) {
		case "chat":
			messages := wire["messages"].([]any)
			if len(messages) != 6 {
				t.Fatal("parallel projection location")
			}
			if obj(messages[2])["tool_call_id"] != "image_call" || obj(messages[3])["tool_call_id"] != "text_call" || obj(messages[4])["role"] != "user" {
				t.Fatal("projection interrupted paired results")
			}
			want := []any{map[string]any{"type": "text", "text": toolImageMarker("image_call")}, map[string]any{"type": "text", "text": "before"}, map[string]any{"type": "image_url", "image_url": map[string]any{"url": inline}}, map[string]any{"type": "text", "text": "after"}}
			if !reflect.DeepEqual(obj(messages[4])["content"], want) {
				t.Fatal("Chat projection changed order")
			}
			if obj(messages[2])["content"] != toolImageMarker("image_call") {
				t.Fatal("tool attribution missing")
			}
		case "claude":
			messages := wire["messages"].([]any)
			result := obj(obj(messages[2])["content"].([]any)[0])
			want := []any{map[string]any{"type": "text", "text": "before"}, map[string]any{"type": "image", "source": map[string]any{"type": "base64", "media_type": "image/png", "data": data}}, map[string]any{"type": "text", "text": "after"}}
			if result["tool_use_id"] != "image_call" || !reflect.DeepEqual(result["content"], want) {
				t.Fatal("Claude tool image attribution/order")
			}
			if str(obj(obj(messages[2])["content"].([]any)[1])["tool_use_id"]) != "text_call" {
				t.Fatal("second tool result lost")
			}
		case "gemini":
			contents := wire["contents"].([]any)
			responses := obj(contents[2])["parts"].([]any)
			response := obj(obj(responses[0])["functionResponse"])
			if response["id"] != "image_call" || response["name"] != "pad__read" {
				t.Fatal("Gemini result identity")
			}
			if tc.policy == "" {
				want := []any{map[string]any{"text": "before"}, map[string]any{"image_part": json.Number("0")}, map[string]any{"text": "after"}}
				if !reflect.DeepEqual(obj(response["response"])["result"], want) || !reflect.DeepEqual(response["parts"], []any{map[string]any{"inlineData": map[string]any{"mimeType": "image/png", "data": data}}}) {
					t.Fatal("Gemini native result split without ordered references")
				}
			} else {
				if response["parts"] != nil || obj(response["response"])["result"] != toolImageMarker("image_call") || len(contents) != 5 {
					t.Fatal("Gemini explicit projection framing")
				}
				projected := obj(contents[3])["parts"].([]any)
				want := []any{map[string]any{"text": toolImageMarker("image_call")}, map[string]any{"text": "before"}, map[string]any{"inline_data": map[string]any{"mime_type": "image/png", "data": data}}, map[string]any{"text": "after"}}
				if !reflect.DeepEqual(projected, want) {
					t.Fatal("Gemini projection order")
				}
				if !reflect.DeepEqual(obj(contents[4])["parts"], []any{map[string]any{"text": "CURRENT"}}) {
					t.Fatal("real user merged into untrusted tool projection")
				}
			}
		}
	}
}

func TestToolImageStrictPoliciesAndURLs(t *testing.T) {
	inline := inlineFixture(t, "image/png")
	parts := []any{imagePart(inline)}
	for _, tc := range []struct{ model, policy string }{{"gpt-5.5", ""}, {"gemini-2.5-flash", ""}, {"claude-sonnet-4-6", "user-projection"}, {"gpt-5.5", "guess"}} {
		if _, err := toolImageBuild(toolImagePayload(tc.model, tc.policy, parts, false)); !errors.Is(err, errUnsupportedToolImage) {
			t.Fatal("implicit/invalid tool image strategy accepted", tc, err)
		}
	}
	remote := []any{map[string]any{"type": "input_image", "image_url": "https://images.example/a", "mime_type": "image/png"}}
	if _, err := toolImageBuild(toolImagePayload("gemini-3.1-flash", "", remote, false)); !errors.Is(err, errUnsupportedToolImage) {
		t.Fatal("Gemini functionResponse file URI invented")
	}
	for _, tc := range []struct{ model, policy string }{{"gpt-5.5", "user-projection"}, {"gemini-2.5-flash", "user-projection"}, {"claude-sonnet-4-6", ""}} {
		if _, err := toolImageBuild(toolImagePayload(tc.model, tc.policy, remote, false)); err != nil {
			t.Fatal("explicit URL mapping rejected", err)
		}
	}
	p := toolImagePayload("claude-sonnet-4-6", "", parts, false)
	input := p["input"].([]any)
	obj(input[2])["call_id"] = "orphan"
	if _, err := toolImageBuild(p); err == nil {
		t.Fatal("orphan image result accepted")
	}
	p = toolImagePayload("claude-sonnet-4-6", "", parts, false)
	obj(p["input"].([]any)[2])["type"] = "custom_tool_call_output"
	if _, err := toolImageBuild(p); err == nil {
		t.Fatal("wrong image result kind accepted")
	}
	tooMany := []any{}
	for i := 0; i < 33; i++ {
		tooMany = append(tooMany, imagePart(inline))
	}
	if _, err := toolImageBuild(toolImagePayload("claude-sonnet-4-6", "", tooMany, false)); !errors.Is(err, errUnsupportedImage) {
		t.Fatal("tool image budget bypass")
	}
	for _, detail := range []string{"low", "high"} {
		part := imagePart(inline)
		part["detail"] = detail
		plan, err := toolImageBuild(toolImagePayload("gpt-5.5", "user-projection", []any{part}, false))
		if err != nil || !strings.Contains(string(plan.body), `"detail":"`+detail+`"`) {
			t.Fatal("projection quality erased")
		}
	}
}

func TestToolImageTCPHistoryCheckpointAndRejectTransaction(t *testing.T) {
	for _, tc := range []struct{ model, policy, wire string }{{"gpt-5.5", "user-projection", chatSSE(choice(map[string]any{"content": "answer"}, "stop"))}, {"claude-sonnet-4-6", "", claudeStart() + claudeText(0, "answer") + claudeEnd("end_turn")}, {"gemini-2.5-flash", "user-projection", geminiFrame([]any{geminiText("answer")}, "STOP", geminiUsageFixture())}, {"gemini-3.1-flash", "", geminiFrame([]any{geminiText("answer")}, "STOP", geminiUsageFixture())}} {
		for _, stream := range []bool{true, false} {
			t.Run(fmt.Sprint(tc.model, stream), func(t *testing.T) {
				var mu sync.Mutex
				captures := []string{}
				c, endpoint := routedClaudeCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					b, _ := io.ReadAll(r.Body)
					mu.Lock()
					captures = append(captures, string(b))
					mu.Unlock()
					w.Header().Set("Content-Type", "text/event-stream")
					io.WriteString(w, tc.wire)
				}))
				inline := inlineFixture(t, "image/png")
				p := toolImagePayload(tc.model, tc.policy, []any{map[string]any{"type": "input_text", "text": "before"}, imagePart(inline), map[string]any{"type": "input_text", "text": "after"}}, true)
				p["stream"] = stream
				initial := p["input"].([]any)
				b, _ := json.Marshal(p)
				first := historyFinal(t, c, endpoint, string(b), stream)
				p["previous_response_id"] = first["id"]
				suffix := []any{map[string]any{"role": "user", "content": "NEXT"}}
				p["input"] = suffix
				b, _ = json.Marshal(p)
				historyFinal(t, c, endpoint, string(b), stream)
				full := append(append(append([]any{}, initial...), first["output"].([]any)...), suffix...)
				p["input"] = full
				b, _ = json.Marshal(p)
				historyFinal(t, c, endpoint, string(b), stream)
				c.mu.Lock()
				order := append([]string{}, c.history.order...)
				size := c.history.bytes
				c.mu.Unlock()
				p["input"] = []any{map[string]any{"role": "user", "content": []any{imagePart("data:image/png;base64,secret-invalid")}}}
				b, _ = json.Marshal(p)
				code, body, _ := request(t, c, endpoint, "/v1/responses", "POST", string(b), nil)
				if code != 400 || strings.TrimSpace(string(body)) != "unsupported_image_input" {
					t.Fatal("unredacted image failure")
				}
				c.mu.Lock()
				if !reflect.DeepEqual(c.history.order, order) || c.history.bytes != size {
					t.Error("invalid image changed history")
				}
				c.mu.Unlock()
				mu.Lock()
				if len(captures) != 3 || captures[1] != captures[2] {
					t.Error("tool image history duplicates/projection moved")
				}
				mu.Unlock()
				// Explicit compact retains all tool-image state, only unrelated old text omitted.
				delete(p, "previous_response_id")
				prefix := []any{map[string]any{"role": "user", "content": "old"}, map[string]any{"role": "assistant", "content": strings.Repeat("old ordinary ", 300)}}
				retained := append(append([]any{}, initial[:len(initial)-1]...), map[string]any{"role": "assistant", "content": "image interpretation retained"}, initial[len(initial)-1])
				p["input"] = append(prefix, retained...)
				p["stream"] = false
				b, _ = json.Marshal(p)
				code, body, _ = request(t, c, endpoint, "/v1/responses/compact", "POST", string(b), nil)
				if code != 200 {
					t.Fatal("tool image compact failed")
				}
				compact, _ := decodeObject(string(body))
				out := compact["output"].([]any)
				want, _ := decodeObject(string(b))
				original := want["input"].([]any)
				if len(out) != len(original) || !reflect.DeepEqual(out[2:], original[2:]) {
					t.Fatal("compact deleted or changed protected tool image turn/interpretation")
				}
				if !strings.Contains(string(body), checkpointPrefix) {
					t.Fatal("fixture did not exercise lossy checkpoint")
				}
				p["input"] = compact["output"]
				b, _ = json.Marshal(p)
				historyFinal(t, c, endpoint, string(b), false)
				mu.Lock()
				if len(captures) != 4 {
					t.Error("compact sent upstream or replay failed")
				}
				mu.Unlock()
			})
		}
	}
}
