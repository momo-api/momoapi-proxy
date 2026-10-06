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

func probeParallelUpstream(w http.ResponseWriter, r *http.Request, data []byte) bool {
	if !strings.Contains(string(data), "single-tool-native") {
		return false
	}
	var body map[string]any
	if json.Unmarshal(data, &body) != nil {
		w.WriteHeader(400)
		return true
	}
	asObject := func(v any) map[string]any { m, _ := v.(map[string]any); return m }
	count := 1
	if strings.Contains(string(data), "single-tool-native-two") {
		count = 2
	}
	var stream string
	switch r.URL.Path {
	case "/v1/chat/completions":
		if body["parallel_tool_calls"] != false || body["model"] != "gpt-5.5" || asObject(asObject(body["tool_choice"])["function"])["name"] != "pad__read" {
			w.WriteHeader(400)
			return true
		}
		calls := []any{map[string]any{"index": 0, "id": "single_native_0", "type": "function", "function": map[string]string{"name": "pad__read", "arguments": "{}"}}}
		if count == 2 {
			calls = append(calls, map[string]any{"index": 1, "id": "single_native_1", "type": "function", "function": map[string]string{"name": "pad__read", "arguments": "{}"}})
		}
		b, _ := json.Marshal(map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]any{"tool_calls": calls}, "finish_reason": "tool_calls"}}})
		stream = "data: " + string(b) + "\n\ndata: [DONE]\n\n"
	case "/v1/messages":
		if body["model"] != "claude-sonnet-4-6" || r.Header.Get("anthropic-version") != "2023-06-01" || asObject(body["tool_choice"])["disable_parallel_tool_use"] != true || asObject(body["tool_choice"])["name"] != "pad__read" {
			w.WriteHeader(400)
			return true
		}
		stream = strings.Split(claudeProbeStream, `data: {"type":"content_block_start"`)[0]
		for i := 0; i < count; i++ {
			b, _ := json.Marshal(map[string]any{"type": "content_block_start", "index": i, "content_block": map[string]any{"type": "tool_use", "id": []string{"single_native_0", "single_native_1"}[i], "name": "pad__read", "input": map[string]any{}}})
			stream += "data: " + string(b) + "\n\n"
			b, _ = json.Marshal(map[string]any{"type": "content_block_stop", "index": i})
			stream += "data: " + string(b) + "\n\n"
		}
		stream += `data: {"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"output_tokens":5}}` + "\n\n" + `data: {"type":"message_stop"}` + "\n\n"
	case "/v1beta/models/gemini-2.5-flash:streamGenerateContent":
		if r.URL.RawQuery != "alt=sse" || strings.Contains(string(data), "parallel") || body["model"] != nil {
			w.WriteHeader(400)
			return true
		}
		config := asObject(asObject(body["toolConfig"])["functionCallingConfig"])
		names, _ := config["allowedFunctionNames"].([]any)
		if config["mode"] != "ANY" || len(names) != 1 || names[0] != "pad__read" {
			w.WriteHeader(400)
			return true
		}
		parts := []any{}
		for i := 0; i < count; i++ {
			parts = append(parts, map[string]any{"functionCall": map[string]any{"id": []string{"single_native_0", "single_native_1"}[i], "name": "pad__read", "args": map[string]any{}}})
		}
		b, _ := json.Marshal(map[string]any{"candidates": []any{map[string]any{"index": 0, "content": map[string]any{"role": "model", "parts": parts}, "finishReason": "STOP"}}, "usageMetadata": map[string]int{"promptTokenCount": 3, "candidatesTokenCount": 5, "totalTokenCount": 8}})
		stream = "data: " + string(b) + "\n\n"
	default:
		w.WriteHeader(400)
		return true
	}
	w.Header().Set("Content-Type", "text/event-stream")
	io.WriteString(w, stream)
	return true
}

// Explicit client-policy true is preserved. Assert exact legacy request plus
// the new option, without accepting arbitrary wire differences.
func probeParallelClientUpstream(w http.ResponseWriter, r *http.Request, data []byte) bool {
	var body, want map[string]any
	if json.Unmarshal(data, &body) != nil {
		return false
	}
	stream := ""
	switch r.URL.Path {
	case "/v1/chat/completions":
		json.Unmarshal([]byte(routedProbeBody), &want)
		want["parallel_tool_calls"] = true
		stream = `data: {"choices":[{"index":0,"delta":{"content":"routed-ok"},"finish_reason":"stop"}]}` + "\n\ndata: [DONE]\n\n"
	default:
		return false
	}
	if !reflect.DeepEqual(body, want) {
		return false
	}
	w.Header().Set("Content-Type", "text/event-stream")
	io.WriteString(w, stream)
	return true
}
func probeParallelRequests(core *appcore.Core) error {

	base, key, err := probeCredentials(core)
	if err != nil {
		return err
	}
	client := http.Client{Timeout: 4 * time.Second}
	defer client.CloseIdleConnections()
	for _, model := range []string{"gpt-5.5", "claude-sonnet-4-6", "gemini-2.5-flash"} {
		for _, stream := range []bool{false, true} {
			for _, count := range []int{1, 2} {
				text := "single-tool-native"
				if count == 2 {
					text += "-two"
				}
				payload := map[string]any{"model": model, "stream": stream, "parallel_tool_calls": false, "input": []any{map[string]string{"role": "user", "content": text}}, "tools": []any{map[string]any{"type": "namespace", "name": "pad", "tools": []any{map[string]string{"type": "function", "name": "read"}}}}, "tool_choice": map[string]string{"type": "function", "name": "read", "namespace": "pad"}}
				b, _ := json.Marshal(payload)
				req, _ := http.NewRequest("POST", base+"/responses", strings.NewReader(string(b)))
				req.Header.Set("Authorization", "Bearer "+key)
				req.Header.Set("Content-Type", "application/json")
				resp, err := client.Do(req)
				if err != nil {
					return err
				}
				data, readErr := io.ReadAll(resp.Body)
				resp.Body.Close()
				if count == 1 {
					if resp.StatusCode != 200 || readErr != nil || !strings.Contains(string(data), `"name":"read"`) || !strings.Contains(string(data), `"namespace":"pad"`) || !strings.Contains(string(data), `"call_id":"single_native_0"`) || !strings.Contains(string(data), "completed") {
						return errors.New("single native success")
					}
				} else {
					if strings.Contains(string(data), "response.completed") || strings.Contains(string(data), "response.incomplete") || stream && readErr == nil || !stream && resp.StatusCode != 502 {
						return errors.New("single native rejection")
					}
				}
			}
		}
	}
	return nil
}
