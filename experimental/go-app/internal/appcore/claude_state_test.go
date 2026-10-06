package appcore

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
)

type claudeCaptureWriter struct {
	jsonProbeWriter
	body bytes.Buffer
}

func (w *claudeCaptureWriter) Write(b []byte) (int, error) { return w.body.Write(b) }

func claudeThinkingFixture(index int, text, signature string) string {
	return claudeFrame("content_block_start", map[string]any{"index": index, "content_block": map[string]any{"type": "thinking", "thinking": "", "signature": ""}}) + claudeFrame("content_block_delta", map[string]any{"index": index, "delta": map[string]any{"type": "thinking_delta", "thinking": text}}) + claudeFrame("content_block_delta", map[string]any{"index": index, "delta": map[string]any{"type": "signature_delta", "signature": signature}}) + claudeFrame("content_block_stop", map[string]any{"index": index})
}
func claudeRedactedFixture(index int, data string) string {
	return claudeFrame("content_block_start", map[string]any{"index": index, "content_block": map[string]any{"type": "redacted_thinking", "data": data}}) + claudeFrame("content_block_stop", map[string]any{"index": index})
}
func TestClaudeThinkingSignedOrderedSuffixFullReplay(t *testing.T) {
	model := "claude-sonnet-4-6"
	signature := "opaque synthetic signature: not necessarily Base64 中文"
	data := "opaque redacted ciphertext: not prose"
	wire := claudeStart() + claudeThinkingFixture(0, " public summary \r\n", signature) + claudeRedactedFixture(1, data) + claudeText(2, "before") + claudeTool(3, "read_signed", "pad__read", `{"n":1}`) + claudeThinkingFixture(4, "", signature) + claudeTool(5, "write_signed", "pad__write", `{"input":" raw \r\n"}`) + claudeEnd("tool_use")
	for _, stream := range []bool{false, true} {
		t.Run(map[bool]string{true: "SSE", false: "JSON"}[stream], func(t *testing.T) {
			var mu sync.Mutex
			var captures []map[string]any
			c, endpoint := routedClaudeCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				b, _ := io.ReadAll(r.Body)
				p, _ := decodeVideoObject(b)
				mu.Lock()
				captures = append(captures, p)
				n := len(captures)
				mu.Unlock()
				w.Header().Set("Content-Type", "text/event-stream")
				if n == 1 {
					io.WriteString(w, wire)
				} else {
					io.WriteString(w, goodClaudeSSE())
				}
			}))
			input := []any{map[string]any{"role": "user", "content": "first"}}
			p, _ := decodeObject(historyPayload(model, input, "", stream))
			p["momo_claude_thinking"] = map[string]any{"type": "adaptive", "display": "summarized"}
			first := historyFinal(t, c, endpoint, string(mustJSON(p)), stream)
			output := first["output"].([]any)
			if len(output) != 6 || obj(output[0])["type"] != "reasoning" || obj(output[1])["type"] != "reasoning" || len(obj(output[1])["summary"].([]any)) != 0 {
				t.Fatal("thinking/redacted order lost")
			}
			suffix := []any{map[string]any{"type": "custom_tool_call_output", "call_id": "write_signed", "output": "written"}, map[string]any{"type": "function_call_output", "call_id": "read_signed", "output": "read"}}
			p["previous_response_id"] = first["id"]
			p["input"] = suffix
			historyFinal(t, c, endpoint, string(mustJSON(p)), stream)
			full := append(append(append([]any{}, input...), output...), suffix...)
			p["input"] = full
			historyFinal(t, c, endpoint, string(mustJSON(p)), stream)
			delete(p, "previous_response_id")
			historyFinal(t, c, endpoint, string(mustJSON(p)), stream)
			mu.Lock()
			saved := append([]map[string]any{}, captures...)
			mu.Unlock()
			if len(saved) != 4 || !reflect.DeepEqual(saved[1], saved[2]) || !reflect.DeepEqual(saved[1], saved[3]) {
				t.Fatal("signed suffix/full mismatch")
			}
			want := []any{map[string]any{"type": "thinking", "thinking": " public summary \r\n", "signature": signature}, map[string]any{"type": "redacted_thinking", "data": data}, map[string]any{"type": "text", "text": "before"}, map[string]any{"type": "tool_use", "id": "read_signed", "name": "pad__read", "input": map[string]any{"n": json.Number("1")}}, map[string]any{"type": "thinking", "thinking": "", "signature": signature}, map[string]any{"type": "tool_use", "id": "write_signed", "name": "pad__write", "input": map[string]any{"input": " raw \r\n"}}}
			if !reflect.DeepEqual(obj(saved[1]["messages"].([]any)[1])["content"], want) {
				t.Fatal("native thinking blocks changed", string(mustJSON(saved[1])))
			}
			for _, target := range []string{"gpt-5.5", "gemini-3.1-pro-preview", "claude-opus-4-6"} {
				for _, items := range [][]any{suffix, full} {
					q, _ := decodeObject(historyPayload(target, items, str(first["id"]), false))
					code, _, _ := request(t, c, endpoint, "/v1/responses", "POST", string(mustJSON(q)), map[string]string{"X-MOMO-History": "replay-v1"})
					if code != 400 {
						t.Fatal("signed foreign model accepted", target, code)
					}
				}
				q, _ := decodeObject(historyPayload(target, full, "", false))
				code, _, _ := request(t, c, endpoint, "/v1/responses", "POST", string(mustJSON(q)), map[string]string{"X-MOMO-History": "replay-v1"})
				if code != 400 {
					t.Fatal("unanchored foreign state accepted", target, code)
				}
			}
			mu.Lock()
			defer mu.Unlock()
			if len(captures) != 4 {
				t.Fatal("rejected context sent")
			}
		})
	}
}

func TestClaudeThinkingControls(t *testing.T) {
	for _, tc := range []struct {
		name, mode, effort string
		budget, max        int
		want               bool
	}{
		{"adaptive", "adaptive", "", 0, 0, true},
		{"adaptiveEffort", "adaptive", "xhigh", 0, 10000, true},
		{"manual", "enabled", "", 1024, 1025, true},
		{"disabled", "disabled", "", 0, 0, true},
		{"noClamp", "enabled", "", 1024, 1024, false},
		{"small", "enabled", "", 1023, 4000, false},
		{"manualEffort", "enabled", "high", 1024, 4000, false},
		{"disabledEffort", "disabled", "high", 0, 0, false},
		{"adaptiveUnsupported", "adaptive", "ultra", 0, 0, false},
		{"unknown", "unknown", "", 0, 0, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			p, _ := decodeObject(claudePayload)
			m := map[string]any{"type": tc.mode}
			if tc.budget != 0 {
				m["budget_tokens"] = tc.budget
			}
			p["momo_claude_thinking"] = m
			if tc.effort != "" {
				p["reasoning"] = map[string]any{"effort": tc.effort}
			}
			if tc.max != 0 {
				p["max_output_tokens"] = tc.max
			}
			plan, err := buildClaudePlan(mustJSON(p))
			if !tc.want {
				if err == nil {
					t.Fatal("invalid thinking accepted")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			wire, _ := decodeVideoObject(plan.body)
			if string(mustJSON(wire["thinking"])) != string(mustJSON(m)) {
				t.Fatal("native control changed")
			}
			if tc.effort != "" && obj(wire["output_config"])["effort"] != tc.effort {
				t.Fatal("effort missing")
			}
		})
	}
	for _, changes := range []map[string]any{
		{"momo_claude_thinking": nil},
		{"momo_claude_thinking": map[string]any{"type": "adaptive", "display": nil}},
		{"momo_claude_thinking": map[string]any{"type": "adaptive", "budget_tokens": 1024}},
		{"momo_claude_thinking": map[string]any{"type": "disabled", "display": "omitted"}},
		{"tool_choice": "required"},
		{"tool_choice": map[string]any{"type": "function", "namespace": "pad", "name": "read"}},
		{"reasoning_effort": "low", "model_reasoning_effort": "high"},
		{"reasoning_effort": "", "reasoning": map[string]any{"effort": "high"}, "model_reasoning_effort": "low"},
		{"model": "gpt-5.5"},
		{"model": "claude-sonnet-4-6-thinking"},
	} {
		p, _ := decodeObject(claudePayload)
		p["momo_claude_thinking"] = map[string]any{"type": "adaptive"}
		for k, v := range changes {
			p[k] = v
		}
		if _, err := buildClaudePlan(mustJSON(p)); err == nil {
			t.Fatal("invalid controls accepted", string(mustJSON(changes)))
		}
	}
}

func TestClaudeSignedMalformedAndHistoryTransactions(t *testing.T) {
	block := claudeThinkingFixture(0, "public summary", "synthetic opaque signature")
	good := claudeStart() + block + claudeRedactedFixture(1, "opaque ciphertext") + claudeText(2, "answer") + claudeEnd("end_turn")
	sign := claudeFrame("content_block_delta", map[string]any{"index": 0, "delta": map[string]any{"type": "signature_delta", "signature": "synthetic opaque signature"}})
	stop := claudeFrame("content_block_stop", map[string]any{"index": 0})
	for name, wire := range map[string]string{
		"missingSignature":        strings.Replace(good, sign, "", 1),
		"returnedModelMismatch":   strings.Replace(good, "claude-sonnet-4-6", "claude-opus-4-6", 1),
		"duplicateSignatureDelta": strings.Replace(good, sign, sign+sign, 1),
		"lateThinking":            strings.Replace(good, sign, sign+claudeFrame("content_block_delta", map[string]any{"index": 0, "delta": map[string]any{"type": "thinking_delta", "thinking": "late"}}), 1),
		"duplicateKey":            strings.Replace(good, `"signature":"synthetic`, `"signature":"x","signature":"synthetic`, 1),
		"escapedDuplicate":        strings.Replace(good, `"signature":"synthetic`, `"sign\u0061ture":"x","signature":"synthetic`, 1),
		"invalidUTF8":             strings.Replace(good, "public summary", string([]byte{0xff}), 1),
		"nullSignature":           strings.Replace(good, `"signature":"synthetic opaque signature"`, `"signature":null`, 1),
		"loneSurrogate":           strings.Replace(good, `"signature":"synthetic opaque signature"`, `"signature":"\ud800"`, 1),
		"emptySignature":          strings.Replace(good, "synthetic opaque signature", "", 1),
		"oversizeSignature":       strings.Replace(good, "synthetic opaque signature", strings.Repeat("a", (256<<10)+1), 1),
		"emptyRedacted":           strings.Replace(good, "opaque ciphertext", "", 1),
		"oversizeRedacted":        strings.Replace(good, "opaque ciphertext", strings.Repeat("a", (256<<10)+1), 1),
		"redactedDelta":           strings.Replace(good, claudeRedactedFixture(1, "opaque ciphertext"), strings.Replace(claudeRedactedFixture(1, "opaque ciphertext"), claudeFrame("content_block_stop", map[string]any{"index": 1}), claudeFrame("content_block_delta", map[string]any{"index": 1, "delta": map[string]any{"type": "thinking_delta", "thinking": "not readable"}})+claudeFrame("content_block_stop", map[string]any{"index": 1}), 1), 1),
		"lateError":               good + claudeFrame("error", map[string]any{"error": map[string]any{}}),
		"latePing":                good + claudeFrame("ping", map[string]any{}),
		"duplicateStop":           good + claudeFrame("message_stop", map[string]any{}),
		"truncated":               strings.TrimSuffix(good, "\r\n\r\n"),
		"unclosed":                strings.Replace(good, stop, "", 1),
		"initialState":            strings.Replace(good, `"thinking":""`, `"thinking":"initial"`, 1),
	} {
		for _, stream := range []bool{false, true} {
			t.Run(name+map[bool]string{true: "/SSE", false: "/JSON"}[stream], func(t *testing.T) {
				c, endpoint := routedClaudeCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					w.Header().Set("Content-Type", "text/event-stream")
					io.WriteString(w, wire)
				}))
				req, _ := http.NewRequest("POST", endpoint+"/v1/responses", strings.NewReader(historyPayload("claude-sonnet-4-6", []any{map[string]any{"role": "user", "content": "first"}}, "", stream)))
				req.Header.Set("Authorization", "Bearer "+c.token)
				req.Header.Set("Content-Type", "application/json")
				resp, err := http.DefaultClient.Do(req)
				if err != nil {
					t.Fatal(err)
				}
				b, _ := io.ReadAll(resp.Body) // malformed SSE deliberately aborts physical TCP
				resp.Body.Close()
				if strings.Contains(string(b), "response.completed") || !stream && strings.Contains(string(b), `"status":"completed"`) {
					t.Fatal("invalid signed stream completed")
				}
				c.mu.Lock()
				n := len(c.history.entries)
				c.mu.Unlock()
				if n != 0 {
					t.Fatal("invalid signed stream stored")
				}
			})
		}
	}
	for _, stream := range []bool{false, true} {
		for _, kind := range []string{"success", "incomplete", "storeFalse"} {
			t.Run(kind+map[bool]string{true: "/SSE", false: "/JSON"}[stream], func(t *testing.T) {
				wire := good
				if kind == "incomplete" {
					wire = strings.Replace(wire, "end_turn", "max_tokens", 1)
				}
				c, endpoint := routedClaudeCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					w.Header().Set("Content-Type", "text/event-stream")
					io.WriteString(w, wire)
				}))
				p, _ := decodeObject(historyPayload("claude-sonnet-4-6", []any{map[string]any{"role": "user", "content": "first"}}, "", stream))
				if kind == "storeFalse" {
					p["store"] = false
				}
				code, b, _ := request(t, c, endpoint, "/v1/responses", "POST", string(mustJSON(p)), nil)
				if code != 200 {
					t.Fatal("valid signed failed", code)
				}
				if stream {
					if !strings.Contains(string(b), "response.reasoning_summary_text.delta") || strings.Contains(string(b), `"delta":"opaque ciphertext"`) {
						t.Fatal("summary/redacted lifecycle")
					}
					for _, line := range strings.Split(string(b), "\n") {
						if strings.HasPrefix(line, "data: ") {
							ev, _ := decodeObject(strings.TrimPrefix(line, "data: "))
							if ev["type"] == "response.output_text.delta" && ev["delta"] != "answer" {
								t.Fatal("summary mixed with answer")
							}
						}
					}
				}
				deadline := time.Now().Add(time.Second)
				for c.State().Active != 0 && time.Now().Before(deadline) {
					time.Sleep(time.Millisecond)
				}
				c.mu.Lock()
				n := len(c.history.entries)
				c.mu.Unlock()
				want := 0
				if kind == "success" {
					want = 1
				}
				if n != want {
					t.Fatal("transaction", n, want)
				}
			})
		}
	}
	for _, mode := range []string{"short", "error", "flush", "ok"} {
		c, _ := routedClaudeCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
		_, seed, err := c.prepareRoutedHistory([]byte(historyPayload("claude-sonnet-4-6", []any{map[string]any{"role": "user", "content": "first"}}, "", false)), "claude-sonnet-4-6")
		if err != nil {
			t.Fatal(err)
		}
		w := &jsonProbeWriter{header: make(http.Header), mode: mode}
		plan := &chatPlan{model: "claude-sonnet-4-6", prepareCompletion: c.historyCompletion(context.Background(), seed)}
		err = convertClaudeStream(context.Background(), w, strings.NewReader(good), plan)
		if mode == "ok" {
			if err != nil || len(c.history.entries) != 1 {
				t.Fatal("success not stored", err)
			}
		} else if err == nil || len(c.history.entries) != 0 {
			t.Fatal("failed write stored")
		}
	}
}

func TestClaudeStateHistoryShapeAndCompact(t *testing.T) {
	model := "claude-sonnet-4-6"
	state := map[string]any{"model": model, "type": "thinking", "signature": "opaque 中文"}
	item := map[string]any{"type": "reasoning", "summary": []any{map[string]any{"type": "summary_text", "text": "public"}}, "momo_claude": state}
	for _, mutate := range []func(map[string]any){
		func(m map[string]any) { obj(m["momo_claude"])["model"] = "claude-opus-4-6" },
		func(m map[string]any) { obj(m["momo_claude"])["signature"] = nil },
		func(m map[string]any) { obj(m["momo_claude"])["data"] = "extraneous" },
		func(m map[string]any) { obj(m["momo_claude"])["type"] = "redacted_thinking" },
		func(m map[string]any) { m["summary"] = []any{} },
		func(m map[string]any) { m["momo_gemini"] = map[string]any{"model": model} },
	} {
		m, _ := decodeVideoObject(mustJSON(item))
		mutate(m)
		p, _ := decodeObject(historyPayload(model, []any{map[string]any{"role": "user", "content": "first"}, m}, "", false))
		if _, err := buildClaudePlan(mustJSON(p)); err == nil {
			t.Fatal("invalid canonical state accepted")
		}
	}
	input := []any{map[string]any{"role": "user", "content": "old"}, map[string]any{"role": "assistant", "content": strings.Repeat("ordinary", 200)}, map[string]any{"role": "user", "content": "signed"}, item, map[string]any{"role": "assistant", "content": strings.Repeat("interpretation", 200)}, map[string]any{"role": "user", "content": "recent"}, map[string]any{"role": "assistant", "content": "latest"}, map[string]any{"role": "user", "content": "current"}}
	p, _ := decodeObject(historyPayload(model, input, "", false))
	result, err := buildLocalCheckpoint(mustJSON(p))
	if err != nil {
		t.Fatal(err)
	}
	var output []any
	json.Unmarshal(mustJSON(result["output"]), &output)
	if !strings.Contains(string(mustJSON(output[1])), checkpointPrefix) {
		t.Fatal("not compacted")
	}
	for i := 2; i < len(input); i++ {
		if !reflect.DeepEqual(output[i], input[i]) {
			t.Fatal("state turn changed", i)
		}
	}
	p["input"] = output
	if _, err := buildClaudePlan(mustJSON(p)); err != nil {
		t.Fatal("not replayable", err)
	}
}

func TestClaudeSignedRetentionAndCancelledCompletion(t *testing.T) {
	good := claudeStart() + claudeThinkingFixture(0, "public", "opaque") + claudeEnd("end_turn")
	for _, wire := range []string{
		claudeStart() + claudeThinkingFixture(0, strings.Repeat("t", 600<<10), strings.Repeat("s", 256<<10)) + claudeThinkingFixture(1, strings.Repeat("t", 200<<10), "opaque") + claudeEnd("end_turn"),
		func() string {
			wire := claudeStart()
			for i := 0; i < 129; i++ {
				wire += claudeThinkingFixture(i, "", "opaque")
			}
			return wire + claudeEnd("end_turn")
		}(),
	} {
		w := &jsonProbeWriter{header: make(http.Header), mode: "ok"}
		if convertClaudeStream(context.Background(), w, strings.NewReader(wire), &chatPlan{model: "claude-sonnet-4-6"}) == nil {
			t.Fatal("unbounded state accepted")
		}
	}
	entered, cancelled := make(chan struct{}), make(chan struct{})
	c, endpoint := routedClaudeCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		io.WriteString(w, claudeStart()+claudeThinkingFixture(0, "partial", "opaque"))
		w.(http.Flusher).Flush()
		close(entered)
		<-r.Context().Done()
		close(cancelled)
	}))
	req, _ := http.NewRequest("POST", endpoint+"/v1/responses", strings.NewReader(historyPayload("claude-sonnet-4-6", []any{map[string]any{"role": "user", "content": "first"}}, "", true)))
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("Content-Type", "application/json")
	client := http.Client{Timeout: 3 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	<-entered
	c.Stop()
	b, err := io.ReadAll(resp.Body)
	if err == nil || strings.Contains(string(b), "response.completed") {
		t.Fatal("Stop fabricated completion")
	}
	select {
	case <-cancelled:
	case <-time.After(time.Second):
		t.Fatal("upstream not cancelled")
	}
	c.mu.Lock()
	n := len(c.history.entries)
	c.mu.Unlock()
	if n != 0 {
		t.Fatal("Stop stored state")
	}
	for _, action := range []string{"cancel", "stop"} {
		c, _ := routedClaudeCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		_, seed, err := c.prepareRoutedHistory([]byte(historyPayload("claude-sonnet-4-6", []any{map[string]any{"role": "user", "content": "first"}}, "", false)), "claude-sonnet-4-6")
		if err != nil {
			t.Fatal(err)
		}
		prepare := c.historyCompletion(ctx, seed)
		plan := &chatPlan{model: "claude-sonnet-4-6", prepareCompletion: func(id string, out []any) (func(), error) {
			commit, err := prepare(id, out)
			if action == "cancel" {
				cancel()
			} else {
				c.Stop()
			}
			return commit, err
		}}
		convertClaudeStream(ctx, &jsonProbeWriter{header: make(http.Header), mode: "ok"}, strings.NewReader(good), plan)
		if len(c.history.entries) != 0 {
			t.Fatal("cancel/stop stored")
		}
	}
}

func TestClaudeOpaqueUnicodeAndThinkingUsage(t *testing.T) {
	for _, raw := range []string{`{"s":"\ud800"}`, `{"s":"\udfff"}`, `{"s":"\ud800x"}`, `{"s":"\ud800\u0041"}`} {
		if validClaudeUnicode([]byte(raw)) {
			t.Fatal("lossy surrogate accepted")
		}
		p := strings.Replace(claudePayload, `"model":"claude-sonnet-4-6"`, `"model":"claude-sonnet-4-6","momo_claude_thinking":{"type":"adaptive","display":`+strings.TrimPrefix(strings.TrimSuffix(raw, "}"), `{"s":`)+"}", 1)
		if _, err := buildClaudePlan([]byte(p)); err == nil {
			t.Fatal("surrogate request accepted")
		}
	}
	for _, raw := range []string{`{"s":"\ud83d\ude42"}`, `{"s":"\\ud800"}`, `{"s":"中文🙂"}`, `{"s":"\ufffd"}`} {
		if !validClaudeUnicode([]byte(raw)) {
			t.Fatal("valid unicode rejected", raw)
		}
	}
	good := claudeStart() + claudeThinkingFixture(0, "public", "opaque") + claudeText(1, "answer") + claudeEnd("end_turn")
	for _, value := range []any{map[string]any{"thinking_tokens": 2}, map[string]any{"thinking_tokens": 6}, map[string]any{"thinking_tokens": nil}, map[string]any{"thinking_tokens": -1}, map[string]any{"thinking_tokens": 2, "unknown": true}, nil} {
		wire := strings.Replace(good, `"output_tokens":5`, `"output_tokens":5,"output_tokens_details":`+string(mustJSON(value)), 1)
		w := &claudeCaptureWriter{jsonProbeWriter: jsonProbeWriter{header: make(http.Header), mode: "ok"}}
		err := convertClaudeStream(context.Background(), w, strings.NewReader(wire), &chatPlan{model: "claude-sonnet-4-6"})
		if obj(value)["thinking_tokens"] == 2 && len(obj(value)) == 1 {
			if err != nil {
				t.Fatal(err)
			}
			response, _ := decodeObject(w.body.String())
			if obj(obj(response["usage"])["output_tokens_details"])["reasoning_tokens"] != json.Number("2") {
				t.Fatal("thinking usage missing")
			}
		} else if err == nil {
			t.Fatal("invalid thinking usage accepted")
		}
	}
}

type claudeBrokenEOF struct{}

func (claudeBrokenEOF) Read([]byte) (int, error) { return 0, io.ErrUnexpectedEOF }

func TestClaudeSignedEOFPrivacyTTLAndBudget(t *testing.T) {
	model := "claude-sonnet-4-6"
	good := claudeStart() + claudeThinkingFixture(0, "public", "synthetic-private-opaque") + claudeRedactedFixture(1, "synthetic-private-ciphertext") + claudeEnd("end_turn")
	w := &jsonProbeWriter{header: make(http.Header), mode: "ok"}
	if convertClaudeStream(context.Background(), w, io.MultiReader(strings.NewReader(good), claudeBrokenEOF{}), &chatPlan{model: model}) == nil || w.writes != 0 {
		t.Fatal("broken EOF completed")
	}
	c, endpoint := routedClaudeCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		io.WriteString(w, good)
	}))
	first := historyFinal(t, c, endpoint, historyPayload(model, []any{map[string]any{"role": "user", "content": "first"}}, "", false), false)
	if strings.Contains(string(mustJSON(c.State())), "synthetic-private") || strings.Contains(c.ConnectionJSON(), "synthetic-private") {
		t.Fatal("state exported")
	}
	suffix := []any{map[string]any{"role": "user", "content": "next"}}
	c.mu.Lock()
	entry := c.history.entries[str(first["id"])]
	entry.expires = time.Now().Add(-time.Second)
	c.history.entries[str(first["id"])] = entry
	c.mu.Unlock()
	code, _, _ := request(t, c, endpoint, "/v1/responses", "POST", historyPayload(model, suffix, str(first["id"]), false), nil)
	if code != 400 {
		t.Fatal("expired signed anchor accepted")
	}
	// Each reply fits retained1MiB, but input+output must ALSO fit history1MiB.
	large := claudeStart() + claudeThinkingFixture(0, strings.Repeat("p", 400<<10), strings.Repeat("s", 200<<10)) + claudeEnd("end_turn")
	c2, e2 := routedClaudeCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		io.WriteString(w, large)
	}))
	code, _, _ = request(t, c2, e2, "/v1/responses", "POST", historyPayload(model, []any{map[string]any{"role": "user", "content": strings.Repeat("u", 500<<10)}}, "", false), nil)
	if code != 502 {
		t.Fatal("history budget ignored", code)
	}
	c2.mu.Lock()
	n := len(c2.history.entries)
	c2.mu.Unlock()
	if n != 0 {
		t.Fatal("overbudget state stored")
	}
}
