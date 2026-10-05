//go:build appcheck && !nogui

package main

import (
	"encoding/json"
	"errors"
	"github.com/momo-api/momoapi-proxy/experimental/go-app/internal/appcore"
	"io"
	"net/http"
	"reflect"
	"strings"
	"time"
)

const strictProbeSchema = `{"type":"object","properties":{"n":{"type":["integer","null"],"minimum":0},"s":{"type":["string","null"],"minLength":1,"maxLength":2}},"required":["n","s"],"additionalProperties":false}`

func probeStrictUpstream(w http.ResponseWriter, r *http.Request, data []byte) bool {
	if !strings.Contains(string(data), "ordinary-strict-native") {
		return false
	}
	var body, schema map[string]any
	if json.Unmarshal(data, &body) != nil || json.Unmarshal([]byte(strictProbeSchema), &schema) != nil {
		w.WriteHeader(400)
		return true
	}
	object := func(v any) map[string]any { m, _ := v.(map[string]any); return m }
	tools, _ := body["tools"].([]any)
	if len(tools) != 1 {
		w.WriteHeader(400)
		return true
	}
	d := object(tools[0])
	key := "input_schema"
	args := `{"n":null,"s":"中🙂"}`
	if strings.Contains(string(data), "ordinary-strict-native-invalid") {
		args = `{"n":-1,"s":"abc"}`
	}
	var stream string
	switch r.URL.Path {
	case "/v1/chat/completions":
		d = object(d["function"])
		key = "parameters"
		if d["strict"] != true {
			w.WriteHeader(400)
			return true
		}
		b, _ := json.Marshal(map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]any{"tool_calls": []any{map[string]any{"index": 0, "id": "strict_native", "type": "function", "function": map[string]string{"name": "pad__read", "arguments": args}}}}, "finish_reason": "tool_calls"}}})
		stream = "data: " + string(b) + "\n\ndata: [DONE]\n\n"
	case "/v1/messages":
		if d["strict"] != nil || r.Header.Get("anthropic-version") != "2023-06-01" {
			w.WriteHeader(400)
			return true
		}
		stream = strings.Split(claudeProbeStream, `data: {"type":"content_block_start"`)[0]
		stream += `data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"strict_native","name":"pad__read","input":{}}}` + "\n\n"
		b, _ := json.Marshal(map[string]any{"type": "content_block_delta", "index": 0, "delta": map[string]string{"type": "input_json_delta", "partial_json": args}})
		stream += "data: " + string(b) + "\n\n" + `data: {"type":"content_block_stop","index":0}` + "\n\n" + `data: {"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"output_tokens":5}}` + "\n\n" + `data: {"type":"message_stop"}` + "\n\n"
	case "/v1beta/models/gemini-2.5-flash:streamGenerateContent":
		declarations, _ := d["functionDeclarations"].([]any)
		if len(declarations) != 1 || r.URL.RawQuery != "alt=sse" {
			w.WriteHeader(400)
			return true
		}
		d = object(declarations[0])
		key = "parametersJsonSchema"
		if d["strict"] != nil {
			w.WriteHeader(400)
			return true
		}
		stream = `data: {"candidates":[{"index":0,"content":{"role":"model","parts":[{"functionCall":{"id":"strict_native","name":"pad__read","args":` + args + `}}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":5,"totalTokenCount":8}}` + "\n\n"
	default:
		w.WriteHeader(400)
		return true
	}
	if d["name"] != "pad__read" || !reflect.DeepEqual(d[key], schema) {
		w.WriteHeader(400)
		return true
	}
	w.Header().Set("Content-Type", "text/event-stream")
	io.WriteString(w, stream)
	return true
}
func probeStrictRequests(core *appcore.Core) error {
	base, key, err := probeCredentials(core)
	if err != nil {
		return err
	}
	client := http.Client{Timeout: 4 * time.Second}
	defer client.CloseIdleConnections()
	for _, model := range []string{"gpt-5.5", "claude-sonnet-4-6", "gemini-2.5-flash"} {
		for _, stream := range []bool{false, true} {
			for _, valid := range []bool{true, false} {
				var schema map[string]any
				json.Unmarshal([]byte(strictProbeSchema), &schema)
				text := "ordinary-strict-native"
				if !valid {
					text += "-invalid"
				}
				p := map[string]any{"model": model, "stream": stream, "input": []any{map[string]string{"role": "user", "content": text}}, "tools": []any{map[string]any{"type": "namespace", "name": "pad", "tools": []any{map[string]any{"type": "function", "name": "read", "strict": true, "parameters": schema}}}}}
				b, _ := json.Marshal(p)
				req, _ := http.NewRequest("POST", base+"/responses", strings.NewReader(string(b)))
				req.Header.Set("Authorization", "Bearer "+key)
				req.Header.Set("Content-Type", "application/json")
				resp, err := client.Do(req)
				if err != nil {
					return err
				}
				data, readErr := io.ReadAll(resp.Body)
				resp.Body.Close()
				if valid {
					if resp.StatusCode != 200 || readErr != nil || !strings.Contains(string(data), `"call_id":"strict_native"`) || !strings.Contains(string(data), `"namespace":"pad"`) || !strings.Contains(string(data), "completed") {
						return errors.New("ordinary strict native success")
					}
				} else {
					if strings.Contains(string(data), "response.completed") || strings.Contains(string(data), "response.incomplete") || stream && readErr == nil || !stream && resp.StatusCode != 502 {
						return errors.New("ordinary strict native rejection")
					}
				}
			}
		}
	}
	return nil
}
