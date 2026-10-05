package appcore

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func dsmlFixture(prefix string) string {
	close := strings.Replace(prefix, "<", "</", 1)
	return "before 中文🙂" + prefix + "tool_calls>" + prefix + `invoke name="pad__read">` + prefix + `parameter name="path" string="true">  a & b < c  ` + close + "parameter>" + close + "invoke>" + prefix + `invoke name="pad__write">` + prefix + `parameter name="input">text("中文🙂")` + close + "parameter>" + close + "invoke>" + close + "tool_calls>after"
}

func TestDSMLFailuresNeverCompleteOrStoreHistory(t *testing.T) {
	valid := dsmlFixture("<")
	for _, stream := range []bool{true, false} {
		for _, tc := range []struct {
			source, finish     string
			structured, noDone bool
			choice             any
			policy             bool
		}{
			{source: valid, finish: "stop", policy: false},
			{source: valid, finish: "length", policy: true},
			{source: valid, finish: "stop", policy: true, noDone: true},
			{source: valid, finish: "stop", policy: true, structured: true},
			{source: valid, finish: "stop", policy: true, choice: "none"},
			{source: valid, finish: "stop", policy: true, choice: allowedChoice("auto", "read")},
			{source: valid, finish: "stop", policy: true, choice: map[string]any{"type": "function", "name": "read", "namespace": "pad"}},
			{source: `<invoke name="missing"></invoke>`, finish: "stop", policy: true},
			{source: `<invoke name="pad__read"><parameter name="x">open`, finish: "stop", policy: true},
			{source: strings.Repeat("x", maxRoutedRetained) + valid, finish: "stop", policy: true},
		} {
			var sends atomic.Int32
			c, endpoint := routedClaudeCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				sends.Add(1)
				w.Header().Set("Content-Type", "text/event-stream")
				fixture := dsmlStream([]string{tc.source}, tc.finish)
				if tc.structured {
					fixture = chatSSE(choice(map[string]any{"tool_calls": []any{map[string]any{"index": 0, "id": "native-call", "function": map[string]string{"name": "pad__read", "arguments": "{}"}}}}, nil)) + fixture
					fixture = strings.Replace(fixture, "data: [DONE]"+string(rune(13))+string(rune(10))+string(rune(13))+string(rune(10)), "", 1)
				}
				if tc.noDone {
					fixture = strings.ReplaceAll(fixture, "data: [DONE]", "")
				}
				io.WriteString(w, fixture)
			}))
			selector := tc.choice
			if selector == nil {
				selector = "auto"
			}
			payload := selectedPayload(t, routedPayload, selector, stream)
			headers := map[string]string{}
			if tc.policy {
				headers["X-MOMO-Tool-Text"] = "dsml-v1"
			}
			req, _ := http.NewRequest("POST", endpoint+"/v1/responses", strings.NewReader(payload))
			req.Header.Set("Authorization", "Bearer "+c.token)
			req.Header.Set("Content-Type", "application/json")
			for k, v := range headers {
				req.Header.Set(k, v)
			}
			resp, err := http.DefaultClient.Do(req)
			if err != nil {
				t.Fatal("request failed before response", err)
			}
			data, readErr := io.ReadAll(resp.Body)
			resp.Body.Close()
			if sends.Load() != 1 || strings.Contains(string(data), "response.completed") || strings.Contains(string(data), "response.incomplete") || strings.Contains(string(data), "function_call") || strings.Contains(string(data), "custom_tool_call") {
				t.Fatal("failed DSML fabricated tools/terminal or replayed")
			}
			if stream && readErr == nil || !stream && resp.StatusCode != 502 {
				t.Fatal("failure boundary")
			}
			c.mu.Lock()
			entries := len(c.history.entries)
			c.mu.Unlock()
			if entries != 0 {
				t.Fatal("failed history stored")
			}
		}
	}
}

func TestDSMLHistoryPolicyNotInherited(t *testing.T) {
	var sends atomic.Int32
	c, endpoint := routedClaudeCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		n := sends.Add(1)
		if n == 2 {
			p, _ := decodeObject(string(b))
			messages := p["messages"].([]any)
			if len(messages) < 5 || !strings.Contains(string(b), "call_dsml_") || !strings.Contains(string(b), "paired-result") || !strings.Contains(string(b), "pad__write") {
				t.Error("DSML replay lost call pairing")
			}
		}
		w.Header().Set("Content-Type", "text/event-stream")
		io.WriteString(w, dsmlStream([]string{dsmlFixture("<")}, "stop"))
	}))
	code, b, _ := request(t, c, endpoint, "/v1/responses", "POST", selectedPayload(t, routedPayload, "auto", false), map[string]string{"X-MOMO-Tool-Text": "dsml-v1"})
	if code != 200 {
		t.Fatal("initial DSML")
	}
	p, _ := decodeObject(string(b))
	suffix := []any{}
	for _, v := range p["output"].([]any) {
		m := obj(v)
		if m["type"] == "function_call" || m["type"] == "custom_tool_call" {
			kind := "function_call_output"
			if m["type"] == "custom_tool_call" {
				kind = "custom_tool_call_output"
			}
			suffix = append(suffix, map[string]any{"type": kind, "call_id": m["call_id"], "output": "paired-result"})
		}
	}
	suffix = append(suffix, map[string]string{"role": "user", "content": "continue"})
	payload := historyPayload("gpt-5.5", suffix, str(p["id"]), false)
	code, _, _ = request(t, c, endpoint, "/v1/responses", "POST", payload, nil)
	if code != 502 || sends.Load() != 2 {
		t.Fatal("DSML policy inherited")
	}
	c.mu.Lock()
	entries := len(c.history.entries)
	c.mu.Unlock()
	if entries != 1 {
		t.Fatal("failed continuation committed")
	}
}

func TestDSMLStopAndOutputFailuresNoReplay(t *testing.T) {
	for _, mode := range []string{"short", "error", "flush", "deadline"} {
		plan, _ := buildChatPlan([]byte(selectedPayload(t, routedPayload, "auto", false)))
		plan.dsml = true
		writer := &jsonProbeWriter{header: make(http.Header), mode: mode}
		if convertChatStream(context.Background(), writer, strings.NewReader(dsmlStream([]string{dsmlFixture("<")}, "stop")), plan) == nil || writer.writes > 1 {
			t.Fatal("DSML write failure")
		}
	}
	entered := make(chan struct{})
	var sends atomic.Int32
	c, endpoint := routedClaudeCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sends.Add(1)
		w.Header().Set("Content-Type", "text/event-stream")
		io.WriteString(w, strings.TrimSuffix(dsmlStream([]string{`<tool_calls><invoke name="pad__read">`}, "stop"), "data: [DONE]"+string(rune(10))+string(rune(10))))
		w.(http.Flusher).Flush()
		close(entered)
		<-r.Context().Done()
	}))
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, "POST", endpoint+"/v1/responses", strings.NewReader(routedPayload))
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-MOMO-Tool-Text", "dsml-v1")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	<-entered
	c.Stop()
	b, err := io.ReadAll(resp.Body)
	if err == nil || strings.Contains(string(b), "response.completed") || sends.Load() != 1 {
		t.Fatal("Stop fabricated completion/replayed")
	}
}
func dsmlStream(parts []string, finish string) string {
	var b strings.Builder
	for _, part := range parts {
		chunk, _ := json.Marshal(map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]any{"content": part}}}})
		fmt.Fprintln(&b, "data: "+string(chunk))
		fmt.Fprintln(&b)
	}
	chunk, _ := json.Marshal(map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]any{}, "finish_reason": finish}}})
	fmt.Fprintln(&b, "data: "+string(chunk))
	fmt.Fprintln(&b)
	fmt.Fprintln(&b, "data: [DONE]")
	fmt.Fprintln(&b)
	return b.String()
}
func TestDSMLParserStrictValuesAndIdentity(t *testing.T) {
	plan, err := buildChatPlan([]byte(routedPayload))
	if err != nil {
		t.Fatal(err)
	}
	for _, prefix := range []string{"<", "<||DSML||", "<｜｜DSML｜｜"} {
		events, err := parseDSML(dsmlFixture(prefix), plan)
		if err != nil || len(events) != 4 {
			t.Fatal("valid DSML", err)
		}
		if events[0].text != "before 中文🙂" || events[3].text != "after" {
			t.Fatal("text order")
		}
		if events[1].call.name != "pad__read" || events[2].call.name != "pad__write" || events[1].call.id == events[2].call.id || !strings.HasPrefix(events[1].call.id, "call_dsml_") {
			t.Fatal("identity")
		}
		a, _ := decodeObject(events[1].call.args)
		if a["path"] != "  a & b < c  " {
			t.Fatal("raw string trimmed/XML-decoded")
		}
		a, _ = decodeObject(events[2].call.args)
		if a["input"] != `text("中文🙂")` {
			t.Fatal("custom raw input")
		}
	}
	events, err := parseDSML(`<invoke name="pad__read"><parameter name="n" string="false">9007199254740993</parameter><parameter name="obj" string="false">{"k":[true,null]}</parameter></invoke>`, plan)
	if err != nil || !strings.Contains(events[0].call.args, "9007199254740993") {
		t.Fatal("typed JSON precision", err)
	}
	for _, source := range []string{
		`<tool_calls></tool_calls>`, `<tool_calls><invoke name="missing"></invoke></tool_calls>`,
		`<invoke name="pad__read" name="pad__write"></invoke>`, `<invoke name="pad__read" extra="1"></invoke>`,
		`<invoke name="pad__read"><parameter name="x">one</parameter><parameter name="x">two</parameter></invoke>`,
		`<invoke name="pad__read"><parameter name="x" string="FALSE">one</parameter></invoke>`,
		`<invoke name="pad__read"><parameter name="x" string="false">{"k":1,"k":2}</parameter></invoke>`,
		`<invoke name="pad__read"><parameter name="x" string="false">NaN</parameter></invoke>`,
		`<invoke name="pad__read"><parameter name="x" string="false">1,"other":2</parameter></invoke>`,
		`<invoke name="pad__write"><parameter name="raw">x</parameter></invoke>`,
		`<invoke name="pad__write"><parameter name="input" string="false">1</parameter></invoke>`,
		`<tool_calls>not-calls</tool_calls>`, `<tool_calls><invoke name="pad__read"></invoke>`,
		`<invoke name="pad__read"><parameter name="x">unterminated</invoke>`,
		`<invoke name="pad__read"><parameter name="x"><invoke name="pad__read"></invoke></parameter></invoke>`,
		`<invoke xmlns="urn:untrusted" name="pad__read"></invoke>`,
		`<parameter name="x">orphan</parameter>`, `</tool_calls>`,
		strings.Repeat(`<invoke name="pad__read"></invoke>`, 129),
		`<invoke name="pad__read"><parameter name="x" string="false">` + strings.Repeat("[", 65) + "0" + strings.Repeat("]", 65) + `</parameter></invoke>`,
	} {
		if _, err := parseDSML(source, plan); err == nil {
			t.Fatal("malformed DSML accepted")
		}
	}
}

func TestDSMLDetectorEveryRuneSplitAndOrdinaryText(t *testing.T) {
	for _, source := range []string{dsmlFixture("<"), dsmlFixture("<||DSML||"), dsmlFixture("<｜｜DSML｜｜")} {
		runes := []rune(source)
		for split := 0; split <= len(runes); split++ {
			d := dsmlText{enabled: true}
			a, err := d.push(string(runes[:split]))
			if err != nil {
				t.Fatal(err)
			}
			b, err := d.push(string(runes[split:]))
			if err != nil || !d.found {
				t.Fatal("split marker")
			}
			if a+b != "before 中文🙂" || d.body.String() != strings.TrimPrefix(source, "before 中文🙂") {
				t.Fatal("marker leaked/lost prefix")
			}
		}
	}
	for _, source := range []string{"ordinary DSML acronym 中文🙂", "literal <inv and <tool_cal", "x<｜", "a < b & c"} {
		for _, enabled := range []bool{false, true} {
			d := dsmlText{enabled: enabled}
			var visible strings.Builder
			for _, r := range source {
				s, err := d.push(string(r))
				if err != nil {
					t.Fatal("ordinary text rejected")
				}
				visible.WriteString(s)
			}
			visible.WriteString(d.pending)
			if visible.String() != source || d.found {
				t.Fatal("ordinary text changed")
			}
		}
	}
}

func TestDSMLRealTCPStreamingJSONAndPolicyBoundary(t *testing.T) {
	for _, stream := range []bool{true, false} {
		for _, prefix := range []string{"<", "<||DSML||", "<｜｜DSML｜｜"} {
			sends := 0
			source := dsmlFixture(prefix)
			parts := []string{}
			for _, r := range source {
				parts = append(parts, string(r))
			}
			c, endpoint := routedClaudeCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				sends++
				if r.Header.Get("X-MOMO-Tool-Text") != "" || r.URL.Path != "/v1/chat/completions" {
					t.Error("policy forwarded/wrong target")
				}
				io.Copy(io.Discard, r.Body)
				w.Header().Set("Content-Type", "text/event-stream")
				io.WriteString(w, dsmlStream(parts, "stop"))
			}))
			payload := selectedPayload(t, routedPayload, "auto", stream)
			code, data, h := request(t, c, endpoint, "/v1/responses", "POST", payload, map[string]string{"X-MOMO-Tool-Text": "dsml-v1"})
			if code != 200 || sends != 1 || h.Get("X-MOMO-Tool-Text") != "dsml-v1" {
				t.Fatal("DSML routing")
			}
			var result map[string]any
			if stream {
				result = responseCompletion(t, data)
			} else {
				if json.Unmarshal([]byte(data), &result) != nil {
					t.Fatal("JSON")
				}
			}
			output := result["output"].([]any)
			if len(output) != 4 {
				t.Fatal("output count")
			}
			for i, name := range map[int]string{1: "read", 2: "write"} {
				call := obj(output[i])
				if call["namespace"] != "pad" || call["name"] != name {
					t.Fatal("namespace identity")
				}
			}
			if strings.Contains(string(data), "tool_calls>") || strings.Contains(string(data), "DSML||") {
				t.Fatal("markup leaked")
			}
		}
	}
	c, endpoint := routedClaudeCore(t, http.HandlerFunc(func(http.ResponseWriter, *http.Request) { t.Error("invalid policy sent upstream") }))
	for _, tc := range []struct{ path, payload, value string }{{"/v1/responses", claudePayload, "dsml-v1"}, {"/v1/responses", geminiPayload, "dsml-v1"}, {"/v1/responses", strings.Replace(routedPayload, "gpt-5.5", "mimo-test", 1), "dsml-v1"}, {"/v1/chat/completions", `{"model":"grok","messages":[{}]}`, "dsml-v1"}, {"/v1/responses", routedPayload, "unknown"}} {
		code, _, _ := request(t, c, endpoint, tc.path, "POST", tc.payload, map[string]string{"X-MOMO-Tool-Text": tc.value})
		if code != 400 {
			t.Fatal("policy gate", code)
		}
	}
}

func TestDSMLSelectorAliasAndRawEntityBoundaries(t *testing.T) {
	for _, selector := range []any{"required", allowedChoice("required", "read"), map[string]any{"type": "function", "name": "read", "namespace": "pad"}} {
		plan, err := buildChatPlan([]byte(selectedPayload(t, routedPayload, selector, false)))
		if err != nil {
			t.Fatal(err)
		}
		events, err := parseDSML(`<invoke name="read"><parameter name="raw"> &lt; &#x41; &amp; </parameter></invoke>`, plan)
		if err != nil || len(events) != 1 {
			t.Fatal("declared unique bare alias rejected", err)
		}
		a, err := decodeObject(events[0].call.args)
		if err != nil || a["raw"] != " &lt; &#x41; &amp; " {
			t.Fatal("raw entities decoded/trimmed")
		}
		tool, ok := plan.restoreTool(events[0].call.name)
		if !ok || tool.namespace != "pad" {
			t.Fatal("bare alias namespace lost")
		}
		if _, err := parseDSML(`<invoke name="pad__write"><parameter name="input">x</parameter></invoke>`, plan); err == nil && selector != "required" {
			t.Fatal("selector boundary bypassed")
		}
	}
	plan, err := buildChatPlan([]byte(routedPayload))
	if err != nil {
		t.Fatal(err)
	}
	duplicate := plan.tools["pad__read"]
	duplicate.wire, duplicate.namespace = "other__read", "other"
	plan.tools[duplicate.wire] = duplicate
	if _, err := parseDSML(`<invoke name="read"></invoke>`, plan); err == nil {
		t.Fatal("ambiguous stripped namespace accepted")
	}
	if _, err := parseDSML(`<invoke name="pad__read"></invoke>`, plan); err != nil {
		t.Fatal("exact namespace alias rejected", err)
	}
	var params strings.Builder
	for i := 0; i < 129; i++ {
		fmt.Fprintf(&params, `<parameter name="p%d">x</parameter>`, i)
	}
	for _, source := range []string{
		`<invoke name="pad__read"><parameter name="x" other="yes">x</parameter></invoke>`,
		`<invoke name="pad__read"><parameter name="x" name="y">x</parameter></invoke>`,
		`<invoke name="pad__read"><parameter name="` + strings.Repeat("a", 257) + `">x</parameter></invoke>`,
		`<invoke name="pad__read">` + params.String() + `</invoke>`,
	} {
		if _, err := parseDSML(source, plan); err == nil {
			t.Fatal("parameter boundary bypassed")
		}
	}
}

func TestDSMLRequestPreflightBoundaries(t *testing.T) {
	c, endpoint := routedClaudeCore(t, http.HandlerFunc(func(http.ResponseWriter, *http.Request) { t.Error("invalid DSML request sent upstream") }))
	search, _ := json.Marshal(searchPayload("gpt-5.5", false))
	for _, tc := range []struct {
		method, path, payload string
		values                []string
	}{
		{"POST", "/v1/responses", routedPayload, []string{"dsml-v1", "dsml-v1"}},
		{"POST", "/v1/responses", routedPayload, []string{""}},
		{"GET", "/v1/responses", routedPayload, []string{"dsml-v1"}},
		{"POST", "/v1/responses/compact", routedPayload, []string{"dsml-v1"}},
		{"POST", "/v1/responses", `{"model":"gpt-5.5","model":"gpt-5.5","input":[]}`, []string{"dsml-v1"}},
		{"POST", "/v1/responses", string(search), []string{"dsml-v1"}},
	} {
		req, _ := http.NewRequest(tc.method, endpoint+tc.path, strings.NewReader(tc.payload))
		req.Header.Set("Authorization", "Bearer "+c.token)
		req.Header.Set("Content-Type", "application/json")
		for _, value := range tc.values {
			req.Header.Add("X-MOMO-Tool-Text", value)
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		io.Copy(io.Discard, resp.Body)
		resp.Body.Close()
		want := 400
		if tc.method == "GET" {
			want = 405 // Method gate rejects before policy parsing.
		}
		if resp.StatusCode != want {
			t.Fatal("invalid DSML preflight accepted", resp.StatusCode)
		}
	}
}
