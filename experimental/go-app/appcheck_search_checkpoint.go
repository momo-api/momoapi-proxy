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

func probeSearchCheckpointRequests(core *appcore.Core) error {
	base, key, err := probeCredentials(core)
	if err != nil {
		return err
	}
	client := http.Client{Timeout: 4 * time.Second}
	defer client.CloseIdleConnections()
	send := func(p map[string]any, path string) (int, []byte, error) {
		b, e := json.Marshal(p)
		if e != nil {
			return 0, nil, e
		}
		req, e := http.NewRequest("POST", base+path, strings.NewReader(string(b)))
		if e != nil {
			return 0, nil, e
		}
		req.Header.Set("Authorization", "Bearer "+key)
		req.Header.Set("Content-Type", "application/json")
		resp, e := client.Do(req)
		if e != nil {
			return 0, nil, e
		}
		defer resp.Body.Close()
		data, e := io.ReadAll(resp.Body)
		return resp.StatusCode, data, e
	}
	final := func(data []byte, stream bool) map[string]any {
		var f map[string]any
		if !stream {
			json.Unmarshal(data, &f)
			return f
		}
		for _, part := range strings.Split(string(data), "\n\n") {
			if strings.HasPrefix(part, "event: response.completed\ndata: ") {
				var ev struct{ Response map[string]any }
				json.Unmarshal([]byte(strings.TrimPrefix(part, "event: response.completed\ndata: ")), &ev)
				f = ev.Response
			}
		}
		return f
	}
	for _, model := range []string{"gpt-5.5", "claude-sonnet-4-6", "gemini-2.5-flash"} {
		for _, stream := range []bool{false, true} {
			defs := []any{map[string]any{"type": "namespace", "name": "pad", "tools": []any{map[string]any{"type": "function", "name": "read", "defer_loading": true, "strict": true, "parameters": map[string]any{"type": "object", "properties": map[string]any{}, "required": []any{}, "additionalProperties": false}}}}}
			tools := append([]any{map[string]any{"type": "tool_search", "execution": "client", "parameters": map[string]any{"type": "object", "properties": map[string]any{"goal": map[string]string{"type": "string"}}, "required": []string{"goal"}, "additionalProperties": false}}}, defs...)
			items := []any{map[string]string{"role": "developer", "content": "checkpoint exact constraint"}, map[string]string{"role": "user", "content": "old task"}, map[string]string{"role": "assistant", "content": strings.Repeat("old ordinary checkpoint ", 300)}, map[string]string{"role": "user", "content": "client-search-probe search-checkpoint-native"}, map[string]string{"role": "assistant", "content": strings.Repeat("search context exact ", 100)}, map[string]any{"type": "tool_search_call", "execution": "client", "call_id": "search_probe_call", "arguments": map[string]string{"goal": "read"}}, map[string]any{"type": "tool_search_output", "execution": "client", "call_id": "search_probe_call", "tools": defs}, map[string]string{"role": "assistant", "content": strings.Repeat("discovery interpretation ", 100)}, map[string]string{"role": "user", "content": "read old"}, map[string]string{"type": "function_call", "namespace": "pad", "name": "read", "call_id": "checkpoint_old_read", "arguments": "{}"}, map[string]string{"type": "function_call_output", "call_id": "checkpoint_old_read", "output": "checkpoint old result exact"}, map[string]string{"role": "assistant", "content": strings.Repeat("tool interpretation ", 100)}, map[string]string{"role": "user", "content": "CURRENT checkpoint native"}}
			p := map[string]any{"model": model, "stream": false, "momo_tool_loading": "client-search", "parallel_tool_calls": false, "tools": tools, "input": items}
			status, data, e := send(p, "/responses/compact")
			if e != nil || status != 200 {
				return errors.New("search checkpoint native compact")
			}
			var checkpoint map[string]any
			json.Unmarshal(data, &checkpoint)
			out, _ := checkpoint["output"].([]any)
			if len(out) != len(items) || checkpoint["object"] != "response.compaction" || strings.Contains(string(data), "encrypted_content") {
				return errors.New("search checkpoint native output")
			}
			for i := range items {
				want, _ := json.Marshal(items[i])
				got, _ := json.Marshal(out[i])
				if i != 2 && string(want) != string(got) {
					return errors.New("search checkpoint native full lifecycle changed")
				}
			}
			if !strings.Contains(string(data), "MOMO explicit lossy checkpoint") {
				return errors.New("search checkpoint native disclosure")
			}
			p["input"], p["stream"] = out, stream
			status, data, e = send(p, "/responses")
			if e != nil || status != 200 {
				return errors.New("search checkpoint native replay")
			}
			first := final(data, stream)
			calls, _ := first["output"].([]any)
			if first["status"] != "completed" || len(calls) != 1 {
				return errors.New("search checkpoint native terminal")
			}
			call, _ := calls[0].(map[string]any)
			if call["namespace"] != "pad" || call["name"] != "read" || call["call_id"] != "search_probe_read" {
				return errors.New("search checkpoint native restored identity")
			}
			p["previous_response_id"] = first["id"]
			p["input"] = []any{map[string]string{"type": "function_call_output", "call_id": "search_probe_read", "output": "checkpoint-second-result"}}
			status, data, e = send(p, "/responses")
			if e != nil || status != 200 || final(data, stream)["status"] != "completed" {
				return errors.New("search checkpoint native paired second turn")
			}
			delete(p, "previous_response_id")
			p["stream"] = false
			p["input"] = items[:6]
			status, _, e = send(p, "/responses/compact")
			if e != nil || status != 422 {
				return errors.New("search checkpoint native pending accepted")
			}
		}
	}
	return nil
}
