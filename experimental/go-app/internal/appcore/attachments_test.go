package appcore

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func registerAttachment(t *testing.T, c *Core, endpoint string, part any) attachmentMetadata {
	t.Helper()
	b, _ := json.Marshal(map[string]any{"part": part})
	status, data, _ := request(t, c, endpoint, "/internal/attachments", "POST", string(b), nil)
	var meta attachmentMetadata
	if status != 200 || json.Unmarshal(data, &meta) != nil || !validAttachmentID(meta.ID) || !meta.Expires.After(meta.Created) {
		t.Fatal("attachment registration", status)
	}
	return meta
}
func TestAttachmentRoutesAndLifecycle(t *testing.T) {
	var calls atomic.Int32
	c, endpoint, _, _ := testCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls.Add(1); t.Error("local asset contacted upstream") }))
	b, _ := json.Marshal(map[string]any{"part": filePart(false)})
	code, _, _ := request(t, c, endpoint, "/internal/attachments", "POST", string(b), nil)
	if code != 400 {
		t.Fatal("default mode", code)
	}
	c.mu.Lock()
	c.config.Mode = "momo-routing"
	c.mu.Unlock()
	for _, tc := range []struct {
		path, method, body string
		headers            map[string]string
		status             int
	}{
		{"/internal/attachments", "POST", string(b), map[string]string{"Authorization": ""}, 401},
		{"/internal/attachments", "POST", string(b), map[string]string{"Origin": "https://evil.example"}, 403},
		{"/internal/attachments", "POST", string(b), map[string]string{"Sec-Fetch-Mode": "cors"}, 403},
		{"/internal/attachments?x=1", "POST", string(b), nil, 400},
		{"/internal/attachments", "GET", "", nil, 405},
		{"/internal/attachments/../x", "GET", "", nil, 404},
		{"/internal/attachments", "POST", string(b), map[string]string{"Content-Type": "text/plain"}, 415},
		{"/internal/attachments", "POST", "{}", nil, 400},
		{"/internal/attachments", "POST", strings.Repeat("x", MaxRequest+1), nil, 413},
	} {
		code, data, _ := request(t, c, endpoint, tc.path, tc.method, tc.body, tc.headers)
		if code != tc.status || strings.Contains(string(data), syntheticKey) {
			t.Fatal(tc.path, code)
		}
	}
	m := registerAttachment(t, c, endpoint, filePart(false))
	if m.MIME != "application/pdf" || m.Name != "report.pdf" || m.Bytes < 1 {
		t.Fatal("metadata")
	}
	path := "/internal/attachments/" + m.ID
	code, data, _ := request(t, c, endpoint, path, "GET", "", nil)
	if code != 200 || strings.Contains(string(data), "file_data") || strings.Contains(string(data), "base64") {
		t.Fatal("metadata exposed data")
	}
	code, _, _ = request(t, c, endpoint, path, "GET", "{}", nil)
	if code != 400 {
		t.Fatal("get body")
	}
	code, _, _ = request(t, c, endpoint, path, "POST", "", nil)
	if code != 405 {
		t.Fatal("post id")
	}
	code, _, _ = request(t, c, endpoint, path, "DELETE", "", nil)
	if code != 200 {
		t.Fatal("delete")
	}
	code, _, _ = request(t, c, endpoint, path, "GET", "", nil)
	if code != 404 {
		t.Fatal("deleted asset")
	}
	m = registerAttachment(t, c, endpoint, filePart(false))
	c.mu.Lock()
	e := c.attachments.entries[m.ID]
	e.meta.Expires = time.Now().Add(-time.Second)
	c.attachments.entries[m.ID] = e
	c.mu.Unlock()
	code, _, _ = request(t, c, endpoint, "/internal/attachments/"+m.ID, "GET", "", nil)
	if code != 404 {
		t.Fatal("expired")
	}
	c.mu.Lock()
	if c.attachments.bytes != 0 {
		t.Error("expiry budget leak")
	}
	c.mu.Unlock()
	m = registerAttachment(t, c, endpoint, filePart(false))
	c.Stop()
	code, _, _ = request(t, c, endpoint, "/internal/attachments/"+m.ID, "GET", "", nil)
	if code != 503 {
		t.Fatal("stopped")
	}
	if c.Start() != nil {
		t.Fatal("restart")
	}
	code, _, _ = request(t, c, endpoint, "/internal/attachments/"+m.ID, "GET", "", nil)
	if code != 404 {
		t.Fatal("asset survived restart")
	}
	if calls.Load() != 0 {
		t.Fatal("upstream calls")
	}
}

func TestAttachmentPartsStrictAndBudgets(t *testing.T) {
	for _, part := range []any{
		map[string]any{"type": "input_file", "file_url": "https://files.example/report", "mime_type": "application/pdf"},
		map[string]any{"type": "input_file", "file_id": "foreign"},
		map[string]any{"type": "input_image", "image_url": "https://images.example/a"},
		map[string]any{"type": "input_file", "file_data": "data:text/plain;base64,aGk="},
		map[string]any{"type": "input_image", "image_url": "data:image/png;base64,aGk="},
		map[string]any{"type": "input_text", "text": "hi"},
	} {
		b, _ := json.Marshal(map[string]any{"part": part})
		if _, _, err := attachmentPart(b); err == nil {
			t.Fatal("accepted unsupported part")
		}
	}
	b, _ := json.Marshal(map[string]any{"part": filePart(false), "unknown": true})
	if _, _, err := attachmentPart(b); err == nil {
		t.Fatal("extra field")
	}
	c, endpoint, _, _ := testCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { t.Error("local asset upstream") }))
	c.mu.Lock()
	c.config.Mode = "momo-routing"
	c.mu.Unlock()
	ids := map[string]bool{}
	for i := 0; i < maxAttachments; i++ {
		m := registerAttachment(t, c, endpoint, filePart(false))
		if ids[m.ID] {
			t.Fatal("id collision")
		}
		ids[m.ID] = true
	}
	b, _ = json.Marshal(map[string]any{"part": filePart(false)})
	code, _, _ := request(t, c, endpoint, "/internal/attachments", "POST", string(b), nil)
	if code != 507 {
		t.Fatal("count budget", code)
	}
	c.mu.Lock()
	c.attachments.clear()
	c.attachments.bytes = maxAttachmentBytes
	c.mu.Unlock()
	code, _, _ = request(t, c, endpoint, "/internal/attachments", "POST", string(b), nil)
	if code != 507 {
		t.Fatal("byte budget", code)
	}
}

func TestAttachmentConvertedWireAndHistorySnapshot(t *testing.T) {
	for _, model := range []string{"gpt-5.5", "claude-sonnet-4-6", "gemini-2.5-flash", "gemini-3.1-flash"} {
		t.Run(model, func(t *testing.T) {
			var mu sync.Mutex
			captures := []map[string]any{}
			c, endpoint, _, _ := testCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				b, _ := io.ReadAll(r.Body)
				var p map[string]any
				_ = json.Unmarshal(b, &p)
				if strings.Contains(string(b), "att_") || r.Header.Get("X-MOMO-Attachments") != "" {
					t.Error("local reference leaked")
				}
				mu.Lock()
				captures = append(captures, p)
				mu.Unlock()
				w.Header().Set("Content-Type", "text/event-stream")
				wire := chatSSE(choice(map[string]any{"content": "answer"}, "stop"))
				if resolveProtocol(model) == "claude" {
					wire = claudeStart() + claudeText(0, "answer") + claudeEnd("end_turn")
				} else if resolveProtocol(model) == "gemini" {
					wire = geminiFrame([]any{geminiText("answer")}, "STOP", geminiUsageFixture())
				}
				_, _ = io.WriteString(w, wire)
			}))
			c.mu.Lock()
			c.config.Mode = "momo-routing"
			c.mu.Unlock()
			pdf := registerAttachment(t, c, endpoint, filePart(false))
			img := inlineFixture(t, "image/png")
			image := registerAttachment(t, c, endpoint, map[string]any{"type": "input_image", "image_url": img})
			parts := []any{map[string]any{"type": "input_text", "text": "before"}, map[string]any{"type": "momo_attachment", "asset_id": pdf.ID}, map[string]any{"type": "momo_attachment", "asset_id": image.ID}, map[string]any{"type": "input_text", "text": "after"}}
			input := []any{map[string]any{"role": "user", "content": parts}}
			p := map[string]any{"model": model, "stream": false, "input": input}
			b, _ := json.Marshal(p)
			head := map[string]string{"X-MOMO-Attachments": "inline"}
			code, _, _ := request(t, c, endpoint, "/v1/responses", "POST", string(b), nil)
			if code != 400 {
				t.Fatal("implicit reference accepted")
			}
			code, data, _ := request(t, c, endpoint, "/v1/responses", "POST", string(b), head)
			if code != 200 {
				t.Fatal("first snapshot", code, string(data))
			}
			var first map[string]any
			_ = json.Unmarshal(data, &first)
			id := str(first["id"])
			if id == "" {
				t.Fatal("anchor")
			}
			mu.Lock()
			firstWire := captures[0]
			mu.Unlock()
			inlineParts := []any{parts[0], filePart(false), map[string]any{"type": "input_image", "image_url": img}, parts[3]}
			inlineInput := []any{map[string]any{"role": "user", "content": inlineParts}}
			check, _ := json.Marshal(map[string]any{"model": model, "stream": false, "input": inlineInput})
			var plan *chatPlan
			var err error
			switch resolveProtocol(model) {
			case "chat":
				plan, err = buildChatPlan(check)
			case "claude":
				plan, err = buildClaudePlan(check)
			default:
				plan, err = buildGeminiPlan(check)
			}
			if err != nil {
				t.Fatal(err)
			}
			expected := map[string]any{}
			_ = json.Unmarshal(plan.body, &expected)
			want, _ := json.Marshal(expected)
			got, _ := json.Marshal(firstWire)
			if string(want) != string(got) {
				t.Fatal("ordered wire snapshot")
			}
			request(t, c, endpoint, "/internal/attachments/"+pdf.ID, "DELETE", "", nil)
			request(t, c, endpoint, "/internal/attachments/"+image.ID, "DELETE", "", nil)
			suffix := []any{map[string]any{"role": "user", "content": "next"}}
			p["previous_response_id"], p["input"] = id, suffix
			b, _ = json.Marshal(p)
			code, _, _ = request(t, c, endpoint, "/v1/responses", "POST", string(b), nil)
			if code != 200 {
				t.Fatal("independent history snapshot")
			}
			output, _ := first["output"].([]any)
			full := append(append(append([]any{}, inlineInput...), output...), suffix...)
			p["input"] = full
			b, _ = json.Marshal(p)
			code, _, _ = request(t, c, endpoint, "/v1/responses", "POST", string(b), nil)
			if code != 200 {
				t.Fatal("inline full replay")
			}
			mu.Lock()
			one, _ := json.Marshal(captures[1])
			two, _ := json.Marshal(captures[2])
			n := len(captures)
			mu.Unlock()
			if string(one) != string(two) || n != 3 {
				t.Fatal("full replay mismatch")
			}
			p["input"] = append(append(append([]any{}, input...), output...), suffix...)
			b, _ = json.Marshal(p)
			code, _, _ = request(t, c, endpoint, "/v1/responses", "POST", string(b), head)
			if code != 400 {
				t.Fatal("deleted full reference")
			}
			mu.Lock()
			n = len(captures)
			mu.Unlock()
			if n != 3 {
				t.Fatal("invalid reference sent upstream")
			}
		})
	}
}

func TestAttachmentExpansionLocationsAndStopGeneration(t *testing.T) {
	c, endpoint, _, _ := testCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { t.Error("invalid sent upstream") }))
	c.mu.Lock()
	c.config.Mode = "momo-routing"
	gen := c.history.generation
	c.mu.Unlock()
	m := registerAttachment(t, c, endpoint, filePart(false))
	ref := map[string]any{"type": "momo_attachment", "asset_id": m.ID}
	for _, field := range []string{"content", "output"} {
		item := map[string]any{"role": "user", "content": []any{ref}}
		if field == "output" {
			item = map[string]any{"type": "custom_tool_call_output", "call_id": "paired", "output": []any{ref}}
		}
		b, _ := json.Marshal(map[string]any{"input": []any{item}})
		out, err := c.expandAttachments(context.Background(), b, c.history.generation)
		if err != nil || !strings.Contains(string(out), "file_data") || strings.Contains(string(out), m.ID) {
			t.Fatal("allowed location")
		}
	}
	for _, item := range []any{map[string]any{"role": "assistant", "content": []any{ref}}, map[string]any{"role": "developer", "content": []any{ref}}, map[string]any{"type": "function_call", "arguments": fmt.Sprint(ref)}} {
		b, _ := json.Marshal(map[string]any{"input": []any{item}})
		out, err := c.expandAttachments(context.Background(), b, c.history.generation)
		if err != nil || !strings.Contains(string(out), m.ID) {
			t.Fatal("rewrote forbidden location")
		}
	}
	for _, bad := range []any{map[string]any{"type": "momo_attachment", "asset_id": m.ID, "filename": "x"}, map[string]any{"type": "momo_attachment", "asset_id": "att_foreign"}} {
		b, _ := json.Marshal(map[string]any{"input": []any{map[string]any{"role": "user", "content": []any{bad}}}})
		if _, err := c.expandAttachments(context.Background(), b, c.history.generation); err == nil {
			t.Fatal("bad reference")
		}
	}
	large := attachmentEntry{part: json.RawMessage(strings.Repeat("x", MaxRequest)), meta: attachmentMetadata{Expires: time.Now().Add(time.Minute)}}
	c.mu.Lock()
	c.attachments.entries[m.ID] = large
	c.mu.Unlock()
	b, _ := json.Marshal(map[string]any{"input": []any{map[string]any{"role": "user", "content": []any{ref, ref}}}})
	if _, err := c.expandAttachments(context.Background(), b, c.history.generation); err == nil {
		t.Fatal("expanded byte budget")
	}
	c.Stop()
	if c.Start() != nil {
		t.Fatal("restart")
	}
	body, _ := json.Marshal(map[string]any{"part": filePart(false)})
	r, _ := http.NewRequest("POST", "http://localhost/internal/attachments", strings.NewReader(string(body)))
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	c.attachmentRequest(context.Background(), w, r, body, Config{Mode: "momo-routing"}, gen)
	if w.Code != 503 || len(c.attachments.entries) != 0 {
		t.Fatal("late generation registration")
	}
}

func TestAttachmentHeaderNativeAndDefaultBytePreservation(t *testing.T) {
	var calls atomic.Int32
	body := `{"model":"gpt-5.6-sol","input":[{"role":"user","content":[{"type":"momo_attachment","asset_id":"foreign-provider-value"}]}],"provider_extra":true}`
	c, endpoint, _, _ := testCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		data, _ := io.ReadAll(r.Body)
		if string(data) != body || r.Header.Get("X-MOMO-Attachments") != "" {
			t.Error("native changed")
		}
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, "{}")
	}))
	for _, mode := range []string{"passthrough", "momo-routing"} {
		c.mu.Lock()
		c.config.Mode = mode
		c.mu.Unlock()
		for _, headers := range []map[string]string{{"X-MOMO-Attachments": "inline"}, {"X-MOMO-Attachments": "INLINE"}, {"X-MOMO-Attachments": "inline, inline"}} {
			code, _, _ := request(t, c, endpoint, "/v1/responses", "POST", body, headers)
			if code != 400 {
				t.Fatal("native optin policy", code)
			}
		}
		code, _, _ := request(t, c, endpoint, "/v1/responses", "POST", body, nil)
		if code != 200 {
			t.Fatal("native no policy")
		}
	}
	if calls.Load() != 2 {
		t.Fatal("native calls")
	}
	for _, path := range []string{"/v1/models", "/v1/chat/completions", "/internal/attachments"} {
		method := "POST"
		if path == "/v1/models" {
			method = "GET"
		}
		code, _, _ := request(t, c, endpoint, path, method, body, map[string]string{"X-MOMO-Attachments": "inline"})
		if code != 400 {
			t.Fatal("policy scope")
		}
	}
	r, _ := http.NewRequest("POST", "http://localhost/v1/responses", nil)
	r.Header.Add("X-MOMO-Attachments", "inline")
	r.Header.Add("X-MOMO-Attachments", "inline")
	if _, valid := attachmentInlineRequested(r); valid {
		t.Fatal("duplicate header")
	}
}

func TestAttachmentCheckpointAndPairedTools(t *testing.T) {
	for _, model := range []string{"gpt-5.5", "claude-sonnet-4-6", "gemini-2.5-flash", "gemini-3.1-flash"} {
		for _, kind := range []string{"function", "custom"} {
			t.Run(model+kind, func(t *testing.T) {
				var calls atomic.Int32
				c, endpoint, _, _ := testCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls.Add(1); t.Error("checkpoint upstream") }))
				c.mu.Lock()
				c.config.Mode = "momo-routing"
				c.mu.Unlock()
				m := registerAttachment(t, c, endpoint, filePart(false))
				ref := map[string]any{"type": "momo_attachment", "asset_id": m.ID}
				p := toolImagePayload(model, "", []any{map[string]any{"type": "input_text", "text": "before"}, ref, map[string]any{"type": "input_text", "text": "after"}}, kind == "function")
				if resolveProtocol(model) != "claude" {
					p["momo_tool_files"] = "user-projection"
				}
				p["stream"] = false
				b, _ := json.Marshal(p)
				expanded, err := c.expandAttachments(context.Background(), b, c.history.generation)
				if err != nil {
					t.Fatal(err)
				}
				var plan *chatPlan
				switch resolveProtocol(model) {
				case "chat":
					plan, err = buildChatPlan(expanded)
				case "claude":
					plan, err = buildClaudePlan(expanded)
				default:
					plan, err = buildGeminiPlan(expanded)
				}
				if err != nil || strings.Contains(string(plan.body), m.ID) || !strings.Contains(string(plan.body), strings.Split(fixturePDF, ",")[1]) {
					t.Fatal("paired tool reference")
				}
				p = checkpointPayload(model)
				items := p["input"].([]any)
				items[3] = map[string]any{"role": "user", "content": []any{map[string]any{"type": "input_text", "text": "file-turn"}, ref}}
				b, _ = json.Marshal(p)
				code, data, _ := request(t, c, endpoint, "/v1/responses/compact", "POST", string(b), map[string]string{"X-MOMO-Attachments": "inline"})
				if code != 200 || strings.Contains(string(data), m.ID) || !strings.Contains(string(data), strings.Split(fixturePDF, ",")[1]) || !strings.Contains(string(data), "tool final exact") {
					t.Fatal("checkpoint media preservation", code)
				}
				var final map[string]any
				_ = json.Unmarshal(data, &final)
				p["input"] = final["output"]
				replay, _ := json.Marshal(p)
				if _, err := parseRoutedRequest(replay); err != nil {
					t.Fatal("inline checkpoint replay", err)
				}
				if calls.Load() != 0 {
					t.Fatal("checkpoint calls")
				}
			})
		}
	}
}

func TestAttachmentAdmissionAndGenerationOwnedStore(t *testing.T) {
	c, endpoint, _, _ := testCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { t.Error("asset upstream") }))
	c.mu.Lock()
	c.config.Mode = "momo-routing"
	c.active = 4
	c.mu.Unlock()
	body, _ := json.Marshal(map[string]any{"part": filePart(false)})
	code, _, _ := request(t, c, endpoint, "/internal/attachments", "POST", string(body), nil)
	if code != 503 {
		t.Fatal("admission")
	}
	c.mu.Lock()
	c.active = 0
	c.mu.Unlock()
	m := registerAttachment(t, c, endpoint, filePart(false))
	other, _ := New()
	defer other.Close()
	other.Configure(Config{Endpoint: "https://mock.example", APIKey: syntheticKey, Mode: "momo-routing"})
	other.Start()
	input, _ := json.Marshal(map[string]any{"input": []any{map[string]any{"role": "user", "content": []any{map[string]any{"type": "momo_attachment", "asset_id": m.ID}}}}})
	if _, err := other.expandAttachments(context.Background(), input, other.history.generation); err == nil {
		t.Fatal("cross core asset")
	}
	c.Stop()
	if err := c.Configure(Config{Endpoint: "https://mock.example", APIKey: syntheticKey, Mode: "momo-routing"}); err != nil {
		t.Fatal(err)
	}
	c.mu.Lock()
	if len(c.attachments.entries) != 0 || c.attachments.bytes != 0 {
		t.Error("configure retains assets")
	}
	c.mu.Unlock()
	c.Start()
	registerAttachment(t, c, endpoint, filePart(false))
	c.Close()
	c.mu.Lock()
	if len(c.attachments.entries) != 0 || c.attachments.bytes != 0 {
		t.Error("close retains assets")
	}
	c.mu.Unlock()
}

func TestAttachmentDeliveryFailureDoesNotPretendRollback(t *testing.T) {
	for _, mode := range []string{"ok", "short", "error", "flush", "deadline", "cancel"} {
		t.Run(mode, func(t *testing.T) {
			c, _ := New()
			defer c.Close()
			c.Configure(Config{Endpoint: "https://mock.example", APIKey: syntheticKey, Mode: "momo-routing"})
			c.Start()
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			if mode == "cancel" {
				cancel()
			}
			w := &jsonProbeWriter{header: make(http.Header), mode: mode}
			r, _ := http.NewRequest("POST", "http://localhost/internal/attachments", nil)
			r.Header.Set("Content-Type", "application/json")
			body, _ := json.Marshal(map[string]any{"part": filePart(false)})
			panicked := false
			func() {
				defer func() {
					if v := recover(); v != nil {
						if !errors.Is(v.(error), http.ErrAbortHandler) {
							t.Fatal(v)
						}
						panicked = true
					}
				}()
				c.attachmentRequest(ctx, w, r, body, Config{Mode: "momo-routing"}, c.history.generation)
			}()
			if mode == "cancel" {
				if len(c.attachments.entries) != 0 {
					t.Fatal("canceled registered")
				}
				return
			}
			if len(c.attachments.entries) != 1 {
				t.Fatal("delivery failure rollback claim")
			}
			if panicked != (mode != "ok") {
				t.Fatal("delivery boundary", mode)
			}
		})
	}
}

func TestAttachmentConcurrentSnapshotsDeleteAndStopStalledUploads(t *testing.T) {
	c, endpoint, _, _ := testCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { t.Error("local asset upstream") }))
	c.mu.Lock()
	c.config.Mode = "momo-routing"
	c.mu.Unlock()
	m := registerAttachment(t, c, endpoint, filePart(false))
	body, _ := json.Marshal(map[string]any{"input": []any{map[string]any{"role": "user", "content": []any{map[string]any{"type": "momo_attachment", "asset_id": m.ID}}}}})
	var wg sync.WaitGroup
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < 50; j++ {
				out, err := c.expandAttachments(context.Background(), body, c.history.generation)
				if err == nil && (!strings.Contains(string(out), "file_data") || strings.Contains(string(out), m.ID)) {
					t.Error("torn snapshot")
				}
			}
		}()
	}
	c.mu.Lock()
	c.attachments.remove(m.ID)
	c.mu.Unlock()
	wg.Wait()
	for _, frame := range []string{"Content-Length: 100", "Transfer-Encoding: chunked"} {
		conn, err := net.DialTimeout("tcp", strings.TrimPrefix(endpoint, "http://"), time.Second)
		if err != nil {
			t.Fatal(err)
		}
		defer conn.Close()
		_ = conn.SetDeadline(time.Now().Add(4 * time.Second))
		prefix := ""
		if strings.HasPrefix(frame, "Transfer") {
			prefix = "64\r\n"
		}
		_, err = fmt.Fprintf(conn, "POST /internal/attachments HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer %s\r\nContent-Type: application/json\r\n%s\r\n\r\n%s{", c.token, frame, prefix)
		if err != nil {
			t.Fatal("asset stalled body")
		}
	}
	waitActive(t, c, 2)
	c.Stop()
	waitActive(t, c, 0)
	c.mu.Lock()
	if len(c.attachments.entries) != 0 || c.attachments.bytes != 0 {
		t.Error("late stopped upload stored")
	}
	c.mu.Unlock()
	if c.Configure(Config{Endpoint: "https://mock.example", APIKey: syntheticKey, Mode: "momo-routing"}) != nil || c.Start() != nil {
		t.Fatal("asset upload restart")
	}
	registerAttachment(t, c, endpoint, filePart(false))
}

func TestAttachmentReferencesDoNotBypassSharedMediaGates(t *testing.T) {
	c, endpoint, _, _ := testCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { t.Error("invalid refs sent upstream") }))
	c.mu.Lock()
	c.config.Mode = "momo-routing"
	c.mu.Unlock()
	pdf := registerAttachment(t, c, endpoint, filePart(false))
	image := registerAttachment(t, c, endpoint, map[string]any{"type": "input_image", "image_url": inlineFixture(t, "image/png"), "detail": "high"})
	ref := func(id string) any { return map[string]any{"type": "momo_attachment", "asset_id": id} }
	for _, tc := range []struct {
		model string
		input []any
	}{
		{"claude-sonnet-4-6", []any{map[string]any{"role": "user", "content": []any{ref(image.ID)}}}},
		{"gemini-3.1-flash", []any{map[string]any{"role": "user", "content": []any{ref(image.ID)}}}},
		{"gpt-5.5", []any{map[string]any{"role": "assistant", "content": []any{ref(pdf.ID)}}}},
		{"gpt-5.5", []any{map[string]any{"role": "developer", "content": []any{ref(pdf.ID)}}, map[string]any{"role": "user", "content": "hi"}}},
		{"gpt-5.5", []any{map[string]any{"type": "function_call_output", "call_id": "orphan", "output": []any{ref(pdf.ID)}}}},
	} {
		body, _ := json.Marshal(map[string]any{"model": tc.model, "input": tc.input})
		code, _, _ := request(t, c, endpoint, "/v1/responses", "POST", string(body), map[string]string{"X-MOMO-Attachments": "inline"})
		if code != 400 {
			t.Fatal("media/ref gate", tc.model, code)
		}
	}
	for _, tc := range []struct {
		id    string
		count int
	}{{pdf.ID, 17}, {image.ID, 33}, {pdf.ID, 49}} {
		parts := make([]any, tc.count)
		for i := range parts {
			parts[i] = ref(tc.id)
		}
		body, _ := json.Marshal(map[string]any{"model": "gpt-5.5", "input": []any{map[string]any{"role": "user", "content": parts}}})
		code, _, _ := request(t, c, endpoint, "/v1/responses", "POST", string(body), map[string]string{"X-MOMO-Attachments": "inline"})
		if code != 400 {
			t.Fatal("aggregate count", tc.count, code)
		}
	}
	c.mu.Lock()
	if len(c.history.entries) != 0 {
		t.Error("invalid refs history")
	}
	c.mu.Unlock()
}

func TestAttachmentWhitespaceCannotMakeBudgetOrderDependent(t *testing.T) {
	c, endpoint, _, _ := testCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { t.Error("local upstream") }))
	c.mu.Lock()
	c.config.Mode = "momo-routing"
	c.mu.Unlock()
	part := filePart(false)
	part["filename"] = strings.Repeat("f", 255)
	m := registerAttachment(t, c, endpoint, part)
	ref := fmt.Sprintf(`{"type":"momo_attachment","asset_id":%q}`, m.ID)
	prefix := `{"input":[{"role":"user","content":[`
	suffix := `]}]}`
	padding := strings.Repeat(" ", MaxRequest-len(prefix)-len(suffix)-len(ref)*2-2)
	for _, parts := range []string{ref + ",{" + padding + ref[1:], "{" + padding + ref[1:] + "," + ref} {
		out, err := c.expandAttachments(context.Background(), []byte(prefix+parts+suffix), c.history.generation)
		if err != nil || len(out) > 4096 {
			t.Fatal("valid expanded request rejected due reference order", err)
		}
	}
}

func TestAttachmentStaleExpansionGenerationAndAtomicFailure(t *testing.T) {
	c, endpoint, _, _ := testCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { t.Error("local upstream") }))
	c.mu.Lock()
	c.config.Mode = "momo-routing"
	oldGeneration := c.history.generation
	c.history.clear()
	c.attachments.clear()
	c.mu.Unlock()
	m := registerAttachment(t, c, endpoint, filePart(false))
	ref := map[string]any{"type": "momo_attachment", "asset_id": m.ID}
	b, _ := json.Marshal(map[string]any{"input": []any{map[string]any{"role": "user", "content": []any{ref}}}})
	if _, err := c.expandAttachments(context.Background(), b, oldGeneration); err == nil {
		t.Fatal("stale expansion crossed generation")
	}
	c.mu.Lock()
	before := c.attachments.bytes
	original := string(c.attachments.entries[m.ID].part)
	c.mu.Unlock()
	b, _ = json.Marshal(map[string]any{"input": []any{map[string]any{"role": "user", "content": []any{ref, map[string]any{"type": "momo_attachment", "asset_id": "att_" + strings.Repeat("0", 64)}}}}})
	if out, err := c.expandAttachments(context.Background(), b, c.history.generation); err == nil || out != nil {
		t.Fatal("partial failed expansion")
	}
	c.mu.Lock()
	if c.attachments.bytes != before || len(c.attachments.entries) != 1 || string(c.attachments.entries[m.ID].part) != original {
		t.Error("failed expansion mutated store")
	}
	c.mu.Unlock()
	for _, item := range []any{map[string]any{"role": "user", "type": "function_call", "content": []any{ref}}, map[string]any{"role": "assistant", "type": "function_call_output", "output": []any{ref}}} {
		b, _ := json.Marshal(map[string]any{"input": []any{item}, "instructions": "att_unchanged", "tools": []any{ref}})
		out, err := c.expandAttachments(context.Background(), b, c.history.generation)
		if err != nil || !strings.Contains(string(out), m.ID) || strings.Contains(string(out), "file_data") {
			t.Fatal("rewrote invalid item kind/role")
		}
	}
}
