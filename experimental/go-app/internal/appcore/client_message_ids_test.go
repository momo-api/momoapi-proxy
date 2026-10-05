package appcore

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
)

// Actual Codex0.156 sends typed developer/user messages with per-item IDs.
// These label input items, not remote history references; do not drop content.
func TestClientInputMessageIDsNormalizeWithoutChangingSemantics(t *testing.T) {
	for _, role := range []string{"user", "developer", "system", "assistant"} {
		item := map[string]any{"type": "message", "role": role, "id": "msg_client_synthetic", "content": []any{map[string]any{"type": "input_text", "text": "client-message"}}}
		raw, _ := json.Marshal(item)
		items, err := normalizedHistory([]json.RawMessage{raw})
		if err != nil || len(items) != 1 {
			t.Fatal("valid client message ID", role, err)
		}
		var normalized map[string]any
		if json.Unmarshal(items[0], &normalized) != nil || normalized["id"] != nil || normalized["role"] != role || normalized["type"] != "message" {
			t.Fatal("ID normalization", role)
		}
		delete(item, "id")
		want, _ := json.Marshal(item)
		if string(items[0]) != string(want) {
			t.Fatal("input content changed", role)
		}
	}
	for _, item := range []string{
		`{"type":"message","role":"tool","id":"msg","content":"hi"}`,
		`{"type":"message","role":"user","id":null,"content":"hi"}`,
		`{"type":"message","role":"user","id":"","content":"hi"}`,
		`{"type":"message","role":"user","id":12,"content":"hi"}`,
		`{"type":"message","role":"user","id":"msg","status":"completed","content":"hi"}`,
		`{"type":"item_reference","id":"msg"}`,
	} {
		if _, err := normalizedHistory([]json.RawMessage{json.RawMessage(item)}); err == nil {
			t.Fatal("unsafe metadata accepted")
		}
	}
}

func TestClientMessageIDsThreeConvertedProvidersSSEAndJSON(t *testing.T) {
	for _, tc := range []struct{ model, stream string }{
		{"gpt-5.5", chatSSE(choice(map[string]any{"content": "client-id-ok"}, "stop"))},
		{"claude-sonnet-4-6", claudeStart() + claudeText(0, "client-id-ok") + claudeEnd("end_turn")},
		{"gemini-2.5-flash", geminiFrame([]any{geminiText("client-id-ok")}, "STOP", geminiUsageFixture())},
	} {
		for _, stream := range []bool{true, false} {
			sends := 0
			c, endpoint := routedClaudeCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				sends++
				body, _ := io.ReadAll(r.Body)
				if strings.Contains(string(body), "msg_client_") || !strings.Contains(string(body), "client-user") || !strings.Contains(string(body), "client-developer") {
					t.Error("message label/content translation")
				}
				w.Header().Set("Content-Type", "text/event-stream")
				fmt.Fprint(w, tc.stream)
			}))
			input := []any{map[string]any{"type": "message", "role": "developer", "id": "msg_client_dev", "content": []any{map[string]string{"type": "input_text", "text": "client-developer"}}}, map[string]any{"type": "message", "role": "user", "id": "msg_client_user", "content": []any{map[string]string{"type": "input_text", "text": "client-user"}}}}
			p, _ := decodeObject(historyPayload(tc.model, input, "", stream))
			p["store"] = false
			raw, _ := json.Marshal(p)
			code, body, _ := request(t, c, endpoint, "/v1/responses", "POST", string(raw), nil)
			if code != 200 || sends != 1 || !strings.Contains(string(body), "client-id-ok") || !strings.Contains(string(body), "completed") {
				t.Fatal("client message ID route", tc.model, stream, code)
			}
			if len(c.history.entries) != 0 {
				t.Fatal("store:false changed")
			}
		}
	}
}
