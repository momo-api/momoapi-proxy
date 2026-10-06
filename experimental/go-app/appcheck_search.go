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

const searchProbeWire = "momo__client_tool_search"

func probeSearchUpstream(w http.ResponseWriter, r *http.Request, data []byte) bool {
	if !strings.Contains(string(data), "client-search-probe") {
		return false
	}
	var body map[string]any
	_ = json.Unmarshal(data, &body)
	o := func(v any) map[string]any { m, _ := v.(map[string]any); return m }
	defs, _ := body["tools"].([]any)
	names := []string{}
	schema := "parameters"
	if strings.HasPrefix(r.URL.Path, "/v1beta/") && len(defs) == 1 {
		defs, _ = o(defs[0])["functionDeclarations"].([]any)
		schema = "parametersJsonSchema"
	}
	for _, def := range defs {
		m := o(def)
		if r.URL.Path == "/v1/chat/completions" {
			m = o(m["function"])
		}
		names = append(names, strProbe(m["name"]))
	}
	loaded := strings.Contains(string(data), "search_probe_call")
	valid := len(names) == 1 && !loaded || len(names) == 2 && loaded
	valid = valid && len(names) > 0 && names[0] == searchProbeWire
	if loaded {
		valid = valid && len(names) == 2 && names[1] == "pad__read"
	}
	if r.URL.Path == "/v1/chat/completions" {
		valid = valid && body["parallel_tool_calls"] == false
	}
	if r.URL.Path == "/v1/messages" {
		schema = "input_schema"
		valid = valid && o(body["tool_choice"])["disable_parallel_tool_use"] == true
	}
	if !loaded {
		var def map[string]any
		if len(defs) > 0 {
			def = o(defs[0])
			if r.URL.Path == "/v1/chat/completions" {
				def = o(def["function"])
			}
		}
		valid = valid && o(o(o(def[schema])["properties"])["goal"])["type"] == "string"
	}
	if !valid {
		w.WriteHeader(400)
		return true
	}
	if strings.Contains(string(data), "search-checkpoint-native") {
		if !loaded || !strings.Contains(string(data), "checkpoint old result exact") || !strings.Contains(string(data), "CURRENT checkpoint native") || !strings.Contains(string(data), "discovery interpretation") {
			w.WriteHeader(400)
			return true
		}
		if strings.Contains(string(data), "checkpoint-second-result") {
			response := "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"checkpoint-resumed\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n"
			if r.URL.Path == "/v1/messages" {
				response = claudeProbeStream
			}
			if strings.HasPrefix(r.URL.Path, "/v1beta/") {
				response = geminiProbeStream
			}
			w.Header().Set("Content-Type", "text/event-stream")
			io.WriteString(w, response)
			return true
		}
	}
	name, id, args := searchProbeWire, "search_probe_call", map[string]any{"goal": "read 中文🙂"}
	if loaded {
		name, id, args = "pad__read", "search_probe_read", map[string]any{}
	}
	var response string
	switch r.URL.Path {
	case "/v1/chat/completions":
		arg, _ := json.Marshal(args)
		b, _ := json.Marshal(map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]any{"tool_calls": []any{map[string]any{"index": 0, "id": id, "type": "function", "function": map[string]string{"name": name, "arguments": string(arg)}}}}, "finish_reason": "tool_calls"}}})
		response = "data: " + string(b) + "\n\ndata: [DONE]\n\n"
	case "/v1/messages":
		b, _ := json.Marshal(map[string]any{"type": "content_block_start", "index": 0, "content_block": map[string]any{"type": "tool_use", "id": id, "name": name, "input": args}})
		response = strings.Split(claudeProbeStream, "data: {\"type\":\"content_block_start\"")[0] + "data: " + string(b) + "\n\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"tool_use\",\"stop_sequence\":null},\"usage\":{\"output_tokens\":5}}\n\ndata: {\"type\":\"message_stop\"}\n\n"
	default:
		b, _ := json.Marshal(map[string]any{"candidates": []any{map[string]any{"index": 0, "content": map[string]any{"role": "model", "parts": []any{map[string]any{"functionCall": map[string]any{"id": id, "name": name, "args": args}}}}, "finishReason": "STOP"}}})
		response = "data: " + string(b) + "\n\ndata: {\"usageMetadata\":{\"promptTokenCount\":3,\"candidatesTokenCount\":5,\"totalTokenCount\":8}}\n\n"
	}
	w.Header().Set("Content-Type", "text/event-stream")
	io.WriteString(w, response)
	return true
}

func strProbe(v any) string { s, _ := v.(string); return s }

func probeSearchRequests(core *appcore.Core) error {
	base, key, err := probeCredentials(core)
	if err != nil {
		return err
	}
	client := http.Client{Timeout: 4 * time.Second}
	defer client.CloseIdleConnections()
	for _, model := range []string{"gpt-5.5", "claude-sonnet-4-6", "gemini-2.5-flash"} {
		for _, stream := range []bool{true, false} {
			defs := []any{map[string]any{"type": "namespace", "name": "pad", "tools": []any{map[string]any{"type": "function", "name": "read", "defer_loading": true, "strict": true, "parameters": map[string]any{"type": "object", "properties": map[string]any{}, "additionalProperties": false}}}}}
			tools := append([]any{map[string]any{"type": "tool_search", "execution": "client", "parameters": map[string]any{"type": "object", "properties": map[string]any{"goal": map[string]string{"type": "string"}}, "required": []string{"goal"}, "additionalProperties": false}}}, defs...)
			p := map[string]any{"model": model, "stream": stream, "momo_tool_loading": "client-search", "parallel_tool_calls": false, "tools": tools, "input": []any{map[string]string{"role": "user", "content": "client-search-probe"}}}
			for turn := 0; turn < 2; turn++ {
				b, _ := json.Marshal(p)
				req, _ := http.NewRequest("POST", base+"/responses", strings.NewReader(string(b)))
				req.Header.Set("Content-Type", "application/json")
				req.Header.Set("Authorization", "Bearer "+key)
				resp, err := client.Do(req)
				if err != nil {
					return err
				}
				data, readErr := io.ReadAll(resp.Body)
				resp.Body.Close()
				if readErr != nil || resp.StatusCode != 200 {
					return errors.New("search transport probe")
				}
				var final map[string]any
				if !stream {
					_ = json.Unmarshal(data, &final)
				} else {
					for _, frame := range strings.Split(string(data), "\n\n") {
						if strings.HasPrefix(frame, "event: response.completed\ndata: ") {
							var ev struct{ Response map[string]any }
							_ = json.Unmarshal([]byte(strings.TrimPrefix(frame, "event: response.completed\ndata: ")), &ev)
							final = ev.Response
						}
					}
				}
				out, _ := final["output"].([]any)
				if final["status"] != "completed" || len(out) != 1 {
					return errors.New("search terminal probe")
				}
				item, _ := out[0].(map[string]any)
				if turn == 0 {
					args, _ := item["arguments"].(map[string]any)
					if item["type"] != "tool_search_call" || item["execution"] != "client" || item["call_id"] != "search_probe_call" || args["goal"] != "read 中文🙂" {
						return errors.New("search object identity probe")
					}
					p["previous_response_id"] = final["id"]
					p["input"] = []any{map[string]any{"type": "tool_search_output", "execution": "client", "call_id": "search_probe_call", "status": "completed", "tools": defs}}
				} else if item["type"] != "function_call" || item["name"] != "read" || item["namespace"] != "pad" || item["call_id"] != "search_probe_read" {
					return errors.New("loaded search identity probe")
				}
			}
		}
	}
	return nil
}
