//go:build appcheck && !nogui

package main

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/momo-api/momoapi-proxy/experimental/go-app/internal/appcore"
)

func probeNamedUpstream(w http.ResponseWriter, r *http.Request, data []byte) bool {
	var body map[string]any
	if json.Unmarshal(data, &body) != nil {
		return false
	}
	asObject := func(v any) map[string]any { m, _ := v.(map[string]any); return m }
	valid := false
	stream := ""
	switch r.URL.Path {
	case "/v1/chat/completions":
		valid = body["model"] == "gpt-5.5" && asObject(asObject(body["tool_choice"])["function"])["name"] == "pad__read" && asObject(body["tool_choice"])["type"] == "function" && body["stream"] == true && asObject(body["stream_options"])["include_usage"] == true
		stream = `data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_probe","type":"function","function":{"name":"pad__read","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}

data: [DONE]

`
	case "/v1/messages":
		valid = body["model"] == "claude-sonnet-4-6" && asObject(body["tool_choice"])["name"] == "pad__read" && asObject(body["tool_choice"])["type"] == "tool" && body["stream"] == true && r.Header.Get("anthropic-version") == "2023-06-01"
		stream = strings.Split(claudeProbeStream, "data: {\"type\":\"content_block_start\"")[0] + `data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"call_probe","name":"pad__read","input":{}}}

data: {"type":"content_block_stop","index":0}

data: {"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"output_tokens":5}}

data: {"type":"message_stop"}

`
	case "/v1beta/models/gemini-2.5-flash:streamGenerateContent":
		config := asObject(asObject(body["toolConfig"])["functionCallingConfig"])
		names, _ := config["allowedFunctionNames"].([]any)
		valid = config["mode"] == "ANY" && len(names) == 1 && names[0] == "pad__read" && r.URL.RawQuery == "alt=sse"
		stream = `data: {"candidates":[{"index":0,"content":{"role":"model","parts":[{"functionCall":{"id":"call_probe","name":"pad__read","args":{}}}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":5,"totalTokenCount":8}}

`
	}
	if !valid {
		return false
	}
	w.Header().Set("Content-Type", "text/event-stream")
	io.WriteString(w, stream)
	return true
}
func probeNamedRequests(core *appcore.Core) error {
	base, key, err := probeCredentials(core)
	if err != nil {
		return err
	}
	client := http.Client{Timeout: 4 * time.Second}
	defer client.CloseIdleConnections()
	for _, model := range []string{"gpt-5.5", "claude-sonnet-4-6", "gemini-2.5-flash"} {
		for _, stream := range []bool{true, false} {
			payload := map[string]any{"model": model, "stream": stream, "input": []any{map[string]string{"role": "user", "content": "hi"}}, "tools": []any{map[string]any{"type": "namespace", "name": "pad", "tools": []any{map[string]string{"type": "function", "name": "read"}}}}, "tool_choice": map[string]string{"type": "function", "name": "read", "namespace": "pad"}}
			b, _ := json.Marshal(payload)
			req, _ := http.NewRequest("POST", base+"/responses", strings.NewReader(string(b)))
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("Authorization", "Bearer "+key)
			response, err := client.Do(req)
			if err != nil {
				return err
			}
			data, err := io.ReadAll(response.Body)
			response.Body.Close()
			if err != nil || response.StatusCode != 200 || !strings.Contains(string(data), `"namespace":"pad"`) || !strings.Contains(string(data), `"name":"read"`) || !strings.Contains(string(data), `"call_id":"call_probe"`) {
				return errors.New("named routing probe")
			}
			if stream {
				if !strings.Contains(string(data), "response.completed") {
					return errors.New("named SSE")
				}
			} else {
				var final map[string]any
				if json.Unmarshal(data, &final) != nil || final["status"] != "completed" {
					return errors.New("named JSON")
				}
			}
		}
	}
	if err := probeAllowedRequests(core); err != nil {
		return err
	}
	if err := probeCustomRequests(core); err != nil {
		return err
	}
	if err := probeSearchRequests(core); err != nil {
		return err
	}
	if err := probeDSMLRequests(core); err != nil {
		return err
	}
	if err := probeProviderReplayRequests(core); err != nil {
		return err
	}
	return probeHistoryRequests(core)
}
