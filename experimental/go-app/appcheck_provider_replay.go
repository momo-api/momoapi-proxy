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

func probeProviderReplayUpstream(w http.ResponseWriter, r *http.Request, data []byte) bool {
	var body map[string]any
	if json.Unmarshal(data, &body) != nil || !strings.Contains(string(data), "provider-replay-native") {
		return false
	}
	if r.Header.Get("X-MOMO-History") != "" {
		w.WriteHeader(400)
		return true
	}
	var stream string
	asObject := func(v any) map[string]any { m, _ := v.(map[string]any); return m }
	switch r.URL.Path {
	case "/v1/chat/completions":
		messages, _ := body["messages"].([]any)
		if len(messages) != 1 || asObject(messages[0])["content"] != "provider-replay-native" || body["model"] != "gpt-5.5" {
			w.WriteHeader(400)
			return true
		}
		stream = `data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_replay_native","type":"function","function":{"name":"pad__read","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}` + string(rune(10)) + string(rune(10)) + "data: [DONE]" + string(rune(10)) + string(rune(10))
	case "/v1/messages":
		messages, _ := body["messages"].([]any)
		if len(messages) != 3 || r.Header.Get("anthropic-version") != "2023-06-01" || body["model"] != "claude-sonnet-4-6" {
			w.WriteHeader(400)
			return true
		}
		calls, _ := asObject(messages[1])["content"].([]any)
		results, _ := asObject(messages[2])["content"].([]any)
		if len(calls) != 1 || len(results) != 2 || asObject(calls[0])["id"] != "call_replay_native" || asObject(calls[0])["name"] != "pad__read" || asObject(results[0])["tool_use_id"] != "call_replay_native" || asObject(results[0])["content"] != "paired-native-result" || asObject(results[1])["text"] != "target-native-turn" {
			w.WriteHeader(400)
			return true
		}
		stream = strings.ReplaceAll(claudeProbeStream, "claude-ok", "replay-native-ok")
	case "/v1beta/models/gemini-2.5-flash:streamGenerateContent":
		contents, _ := body["contents"].([]any)
		if len(contents) != 3 || r.URL.RawQuery != "alt=sse" || body["model"] != nil {
			w.WriteHeader(400)
			return true
		}
		calls, _ := asObject(contents[1])["parts"].([]any)
		results, _ := asObject(contents[2])["parts"].([]any)
		if len(calls) != 1 || len(results) != 2 || asObject(asObject(calls[0])["functionCall"])["id"] != "call_replay_native" || asObject(asObject(calls[0])["functionCall"])["name"] != "pad__read" || asObject(asObject(results[0])["functionResponse"])["id"] != "call_replay_native" || asObject(asObject(asObject(results[0])["functionResponse"])["response"])["result"] != "paired-native-result" || asObject(results[1])["text"] != "target-native-turn" {
			w.WriteHeader(400)
			return true
		}
		stream = strings.ReplaceAll(geminiProbeStream, "gemini-ok", "replay-native-ok")
	default:
		w.WriteHeader(400)
		return true
	}
	w.Header().Set("Content-Type", "text/event-stream")
	io.WriteString(w, stream)
	return true
}
func probeProviderReplayRequests(core *appcore.Core) error {
	base, key, err := probeCredentials(core)
	if err != nil {
		return err
	}
	client := http.Client{Timeout: 4 * time.Second}
	defer client.CloseIdleConnections()
	for _, streaming := range []bool{true, false} {
		payload := map[string]any{"model": "gpt-5.5", "stream": false, "input": []any{map[string]string{"role": "user", "content": "provider-replay-native"}}, "tools": []any{map[string]any{"type": "namespace", "name": "pad", "tools": []any{map[string]string{"type": "function", "name": "read"}}}}}
		post := func(policy bool) ([]byte, error) {
			b, _ := json.Marshal(payload)
			req, _ := http.NewRequest("POST", base+"/responses", strings.NewReader(string(b)))
			req.Header.Set("Authorization", "Bearer "+key)
			req.Header.Set("Content-Type", "application/json")
			if policy {
				req.Header.Set("X-MOMO-History", "replay-v1")
			}
			resp, err := client.Do(req)
			if err != nil {
				return nil, err
			}
			defer resp.Body.Close()
			data, err := io.ReadAll(resp.Body)
			if err != nil || resp.StatusCode != 200 || policy && resp.Header.Get("X-MOMO-History") != "replay-v1" {
				return nil, errors.New("provider replay native delivery")
			}
			return data, nil
		}
		first, err := post(false)
		if err != nil {
			return err
		}
		var response map[string]any
		if json.Unmarshal(first, &response) != nil {
			return errors.New("provider replay source JSON")
		}
		id, _ := response["id"].(string)
		output, _ := response["output"].([]any)
		if id == "" || len(output) != 1 {
			return errors.New("provider replay source output")
		}
		call, _ := output[0].(map[string]any)
		if call["namespace"] != "pad" || call["name"] != "read" || call["call_id"] != "call_replay_native" {
			return errors.New("provider replay source identity")
		}
		payload["previous_response_id"], payload["stream"] = id, streaming
		payload["input"] = []any{map[string]string{"type": "function_call_output", "call_id": "call_replay_native", "output": "paired-native-result"}, map[string]string{"role": "user", "content": "target-native-turn"}}
		for _, target := range []string{"claude-sonnet-4-6", "gemini-2.5-flash"} {
			payload["model"] = target
			data, err := post(true)
			if err != nil {
				return err
			}
			if !strings.Contains(string(data), "replay-native-ok") || !strings.Contains(string(data), "completed") {
				return errors.New("provider replay target terminal")
			}
		}
	}
	return nil
}
