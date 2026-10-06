//go:build appcheck && !nogui

package main

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"reflect"
	"strings"
	"time"

	"github.com/momo-api/momoapi-proxy/experimental/go-app/internal/appcore"
)

const probeClaudeSignature = "synthetic opaque signature 中文: not Base64"

func probeClaudeFrame(typ string, fields map[string]any) string {
	fields["type"] = typ
	b, _ := json.Marshal(fields)
	return "event: " + typ + "\r\ndata: " + string(b) + "\r\n\r\n"
}
func probeClaudeStateBlocks() []any {
	return []any{map[string]any{"type": "thinking", "thinking": "public summary\r\n", "signature": probeClaudeSignature}, map[string]any{"type": "redacted_thinking", "data": "opaque ciphertext"}, map[string]any{"type": "text", "text": "answer"}, map[string]any{"type": "tool_use", "id": "signed_claude_call", "name": "read", "input": map[string]any{}}, map[string]any{"type": "thinking", "thinking": "", "signature": probeClaudeSignature}}
}
func probeClaudeStateUpstream(w http.ResponseWriter, r *http.Request, data []byte) bool {
	if r.URL.Path != "/v1/messages" || r.Method != "POST" || r.URL.RawQuery != "" {
		return false
	}
	var body map[string]any
	if json.Unmarshal(data, &body) != nil {
		return false
	}
	messages, _ := body["messages"].([]any)
	if len(messages) == 0 || !reflect.DeepEqual(messages[0], map[string]any{"role": "user", "content": []any{map[string]any{"type": "text", "text": "claude-state-native"}}}) {
		return false
	}
	if !reflect.DeepEqual(body["thinking"], map[string]any{"type": "adaptive", "display": "summarized"}) || !reflect.DeepEqual(body["output_config"], map[string]any{"effort": "high"}) {
		return false
	}
	blocks := probeClaudeStateBlocks()
	reason := "tool_use"
	if len(messages) != 1 {
		if len(messages) != 3 || !reflect.DeepEqual(messages[1], map[string]any{"role": "assistant", "content": blocks}) || !reflect.DeepEqual(messages[2], map[string]any{"role": "user", "content": []any{map[string]any{"type": "tool_result", "tool_use_id": "signed_claude_call", "content": "signed Claude result"}}}) {
			return false
		}
		blocks = []any{map[string]any{"type": "text", "text": "claude-signed-finished"}}
		reason = "end_turn"
	}
	w.Header().Set("Content-Type", "text/event-stream")
	wire := probeClaudeFrame("message_start", map[string]any{"message": map[string]any{"id": "msg_mock", "type": "message", "role": "assistant", "model": "claude-sonnet-4-6", "content": []any{}, "stop_reason": nil, "stop_sequence": nil, "usage": map[string]any{"input_tokens": 3, "output_tokens": 1}}})
	for i, value := range blocks {
		block := value.(map[string]any)
		initial := block
		if block["type"] == "thinking" {
			initial = map[string]any{"type": "thinking", "thinking": "", "signature": ""}
		}
		wire += probeClaudeFrame("content_block_start", map[string]any{"index": i, "content_block": initial})
		if block["type"] == "thinking" {
			wire += probeClaudeFrame("content_block_delta", map[string]any{"index": i, "delta": map[string]any{"type": "thinking_delta", "thinking": block["thinking"]}})
			wire += probeClaudeFrame("content_block_delta", map[string]any{"index": i, "delta": map[string]any{"type": "signature_delta", "signature": block["signature"]}})
		}
		wire += probeClaudeFrame("content_block_stop", map[string]any{"index": i})
	}
	wire += probeClaudeFrame("message_delta", map[string]any{"delta": map[string]any{"stop_reason": reason, "stop_sequence": nil}, "usage": map[string]any{"output_tokens": 5}}) + probeClaudeFrame("message_stop", map[string]any{})
	io.WriteString(w, wire)
	return true
}
func probeClaudeStateRequests(core *appcore.Core) error {
	base, key, err := probeCredentials(core)
	if err != nil {
		return err
	}
	client := http.Client{Timeout: 4 * time.Second}
	defer client.CloseIdleConnections()
	for _, stream := range []bool{false, true} {
		p := map[string]any{"model": "claude-sonnet-4-6", "stream": stream, "input": []any{map[string]any{"role": "user", "content": "claude-state-native"}}, "tools": []any{map[string]any{"type": "function", "name": "read", "parameters": map[string]any{"type": "object", "properties": map[string]any{}}}}, "momo_claude_thinking": map[string]any{"type": "adaptive", "display": "summarized"}, "reasoning": map[string]any{"effort": "high"}}
		for turn := 0; turn < 2; turn++ {
			b, _ := json.Marshal(p)
			req, _ := http.NewRequest("POST", strings.TrimSuffix(base, "/v1")+"/responses/", strings.NewReader(string(b)))
			req.Header.Set("Authorization", "Bearer "+key)
			req.Header.Set("Content-Type", "application/json")
			resp, err := client.Do(req)
			if err != nil {
				return err
			}
			data, err := io.ReadAll(resp.Body)
			resp.Body.Close()
			if err != nil || resp.StatusCode != 200 {
				return errors.New("signed Claude native response")
			}
			var final map[string]any
			if !stream {
				json.Unmarshal(data, &final)
			} else {
				for _, block := range strings.Split(string(data), "\n\n") {
					if strings.HasPrefix(block, "event: response.completed\ndata: ") {
						var event struct{ Response map[string]any }
						json.Unmarshal([]byte(strings.TrimPrefix(block, "event: response.completed\ndata: ")), &event)
						final = event.Response
					}
				}
			}
			if final["status"] != "completed" {
				return errors.New("signed Claude native completion")
			}
			if turn == 0 {
				out, _ := final["output"].([]any)
				if len(out) != 5 {
					return errors.New("signed Claude native block count")
				}
				thought, _ := out[0].(map[string]any)
				redacted, _ := out[1].(map[string]any)
				if !reflect.DeepEqual(thought["momo_claude"], map[string]any{"model": "claude-sonnet-4-6", "type": "thinking", "signature": probeClaudeSignature}) || !reflect.DeepEqual(redacted["summary"], []any{}) {
					return errors.New("signed Claude native state")
				}
				if stream {
					found := false
					for _, line := range strings.Split(string(data), "\n") {
						if !strings.HasPrefix(line, "data: ") {
							continue
						}
						var event map[string]any
						json.Unmarshal([]byte(strings.TrimPrefix(line, "data: ")), &event)
						if event["type"] == "response.reasoning_summary_text.delta" && event["delta"] == "public summary\r\n" {
							found = true
						}
						if event["type"] == "response.output_text.delta" && event["delta"] != "answer" {
							return errors.New("signed Claude summary as answer")
						}
					}
					if !found {
						return errors.New("signed Claude summary lifecycle")
					}
				}
				p["previous_response_id"] = final["id"]
				p["input"] = []any{map[string]any{"type": "function_call_output", "call_id": "signed_claude_call", "output": "signed Claude result"}}
			} else if !strings.Contains(string(data), "claude-signed-finished") {
				return errors.New("signed Claude native replay")
			}
		}
	}
	return probeGeminiThinkingRequests(core)
}
