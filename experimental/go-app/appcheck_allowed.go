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

func probeAllowedUpstream(w http.ResponseWriter, r *http.Request, data []byte) bool {
	if !strings.Contains(string(data), "allowed-probe") {
		return false
	}
	var body map[string]any
	_ = json.Unmarshal(data, &body)
	o := func(v any) map[string]any { m, _ := v.(map[string]any); return m }
	ts, _ := body["tools"].([]any)
	valid := len(ts) == 1
	response := ""
	switch r.URL.Path {
	case "/v1/chat/completions":
		valid = valid && o(o(ts[0])["function"])["name"] == "pad__read" && body["tool_choice"] == "required" && o(body["stream_options"])["include_usage"] == true
		response = "data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"allowed_call\",\"type\":\"function\",\"function\":{\"name\":\"pad__read\",\"arguments\":\"{}\"}}]},\"finish_reason\":\"tool_calls\"}]}\n\ndata: [DONE]\n\n"
	case "/v1/messages":
		valid = valid && o(ts[0])["name"] == "pad__read" && o(body["tool_choice"])["type"] == "any" && r.Header.Get("anthropic-version") == "2023-06-01"
		response = strings.Split(claudeProbeStream, "data: {\"type\":\"content_block_start\"")[0] + "data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"tool_use\",\"id\":\"allowed_call\",\"name\":\"pad__read\",\"input\":{}}}\n\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"tool_use\",\"stop_sequence\":null},\"usage\":{\"output_tokens\":5}}\n\ndata: {\"type\":\"message_stop\"}\n\n"
	case "/v1beta/models/gemini-2.5-flash:streamGenerateContent":
		if valid {
			ds, _ := o(ts[0])["functionDeclarations"].([]any)
			valid = len(ds) == 1 && o(ds[0])["name"] == "pad__read"
		}
		valid = valid && o(o(body["toolConfig"])["functionCallingConfig"])["mode"] == "ANY" && r.URL.RawQuery == "alt=sse"
		response = "data: {\"candidates\":[{\"index\":0,\"content\":{\"role\":\"model\",\"parts\":[{\"functionCall\":{\"id\":\"allowed_call\",\"name\":\"pad__read\",\"args\":{}}}]},\"finishReason\":\"STOP\"}],\"usageMetadata\":{\"promptTokenCount\":3,\"candidatesTokenCount\":5,\"totalTokenCount\":8}}\n\n"
	default:
		valid = false
	}
	if !valid {
		w.WriteHeader(400)
		return true
	}
	w.Header().Set("Content-Type", "text/event-stream")
	io.WriteString(w, response)
	return true
}

func probeAllowedRequests(core *appcore.Core) error {
	base, key, err := probeCredentials(core)
	if err != nil {
		return err
	}
	client := http.Client{Timeout: 4 * time.Second}
	defer client.CloseIdleConnections()
	for _, model := range []string{"gpt-5.5", "claude-sonnet-4-6", "gemini-2.5-flash"} {
		for _, stream := range []bool{true, false} {
			p := map[string]any{"model": model, "stream": stream, "input": []any{map[string]string{"role": "user", "content": "allowed-probe"}}, "tools": []any{map[string]any{"type": "namespace", "name": "pad", "tools": []any{map[string]string{"type": "function", "name": "read"}, map[string]string{"type": "custom", "name": "write"}}}}, "tool_choice": map[string]any{"type": "allowed_tools", "mode": "required", "tools": []any{map[string]string{"type": "function", "name": "read", "namespace": "pad"}}}}
			b, _ := json.Marshal(p)
			req, _ := http.NewRequest("POST", strings.TrimSuffix(base, "/v1")+"/responses///", strings.NewReader(string(b)))
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("Authorization", "Bearer "+key)
			resp, err := client.Do(req)
			if err != nil {
				return err
			}
			data, err := io.ReadAll(resp.Body)
			resp.Body.Close()
			if err != nil || resp.StatusCode != 200 || !strings.Contains(string(data), "allowed_call") || !strings.Contains(string(data), `"namespace":"pad"`) {
				return errors.New("allowed tools probe")
			}
			if stream {
				if !strings.Contains(string(data), "response.completed") {
					return errors.New("allowed SSE terminal")
				}
			} else {
				var final map[string]any
				if json.Unmarshal(data, &final) != nil || final["status"] != "completed" {
					return errors.New("allowed JSON terminal")
				}
			}
		}
	}
	return nil
}
