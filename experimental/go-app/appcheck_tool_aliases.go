//go:build appcheck && !nogui

package main

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/momo-api/momoapi-proxy/experimental/go-app/internal/appcore"
)

func probeLongToolIdentity() (string, string, string) {
	ns, name := strings.Repeat("n", 64), strings.Repeat("t", 64)
	b, _ := json.Marshal([]string{ns, name})
	digest := sha256.Sum256(b)
	return ns, name, "mta_" + name[len(name)-16:] + "_" + base64.RawURLEncoding.EncodeToString(digest[:])
}
func probeToolAliasUpstream(w http.ResponseWriter, r *http.Request, data []byte) bool {
	if !strings.Contains(string(data), "long-alias-native") {
		return false
	}
	var body map[string]any
	fail := func() bool { w.WriteHeader(400); return true }
	if json.Unmarshal(data, &body) != nil {
		return fail()
	}
	asObject := func(v any) map[string]any { m, _ := v.(map[string]any); return m }
	_, _, wire := probeLongToolIdentity()
	ns, name, _ := probeLongToolIdentity()
	if len(wire) != 64 || strings.Contains(string(data), ns+"__"+name) || r.Header.Get("X-MOMO-History") != "" {
		return fail()
	}
	tools, _ := body["tools"].([]any)
	if len(tools) != 1 {
		return fail()
	}
	defs := tools
	var history []any
	var stream string
	switch r.URL.Path {
	case "/v1/chat/completions":
		if body["model"] != "gpt-5.5" || body["stream"] != true || asObject(body["stream_options"])["include_usage"] != true || asObject(asObject(tools[0])["function"])["name"] != wire {
			return fail()
		}
		history, _ = body["messages"].([]any)
		if len(history) == 1 {
			if asObject(asObject(body["tool_choice"])["function"])["name"] != wire {
				return fail()
			}
			stream = `data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_alias_native","type":"function","function":{"name":"` + wire + `","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}` + "\n\ndata: [DONE]\n\n"
		} else {
			if len(history) != 3 {
				return fail()
			}
			calls, _ := asObject(history[1])["tool_calls"].([]any)
			if len(calls) != 1 || asObject(calls[0])["id"] != "call_alias_native" || asObject(asObject(calls[0])["function"])["name"] != wire || asObject(history[2])["tool_call_id"] != "call_alias_native" || asObject(history[2])["content"] != "paired-alias-native" {
				return fail()
			}
			stream = `data: {"choices":[{"index":0,"delta":{"content":"alias-native-done"},"finish_reason":"stop"}]}` + "\n\ndata: [DONE]\n\n"
		}
	case "/v1/messages":
		if body["model"] != "claude-sonnet-4-6" || body["stream"] != true || r.Header.Get("anthropic-version") != "2023-06-01" || asObject(tools[0])["name"] != wire {
			return fail()
		}
		history, _ = body["messages"].([]any)
		if len(history) == 1 {
			if asObject(body["tool_choice"])["name"] != wire {
				return fail()
			}
			stream = strings.Split(claudeProbeStream, `data: {"type":"content_block_start"`)[0] + `data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"call_alias_native","name":"` + wire + `","input":{}}}` + "\n\n" + `data: {"type":"content_block_stop","index":0}` + "\n\n" + `data: {"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"output_tokens":5}}` + "\n\n" + `data: {"type":"message_stop"}` + "\n\n"
		} else {
			if len(history) != 3 {
				return fail()
			}
			calls, _ := asObject(history[1])["content"].([]any)
			results, _ := asObject(history[2])["content"].([]any)
			if len(calls) != 1 || len(results) != 1 || asObject(calls[0])["name"] != wire || asObject(calls[0])["id"] != "call_alias_native" || asObject(results[0])["tool_use_id"] != "call_alias_native" || asObject(results[0])["content"] != "paired-alias-native" {
				return fail()
			}
			stream = strings.ReplaceAll(claudeProbeStream, "claude-ok", "alias-native-done")
		}
	case "/v1beta/models/gemini-2.5-flash:streamGenerateContent":
		if r.URL.RawQuery != "alt=sse" || body["model"] != nil {
			return fail()
		}
		defs, _ = asObject(tools[0])["functionDeclarations"].([]any)
		if len(defs) != 1 || asObject(defs[0])["name"] != wire {
			return fail()
		}
		history, _ = body["contents"].([]any)
		if len(history) == 1 {
			names, _ := asObject(asObject(body["toolConfig"])["functionCallingConfig"])["allowedFunctionNames"].([]any)
			if len(names) != 1 || names[0] != wire {
				return fail()
			}
			stream = `data: {"candidates":[{"index":0,"content":{"role":"model","parts":[{"functionCall":{"id":"call_alias_native","name":"` + wire + `","args":{}}}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":5,"totalTokenCount":8}}` + "\n\n"
		} else {
			if len(history) != 3 {
				return fail()
			}
			calls, _ := asObject(history[1])["parts"].([]any)
			results, _ := asObject(history[2])["parts"].([]any)
			if len(calls) != 1 || len(results) != 1 || asObject(asObject(calls[0])["functionCall"])["name"] != wire || asObject(asObject(calls[0])["functionCall"])["id"] != "call_alias_native" || asObject(asObject(results[0])["functionResponse"])["id"] != "call_alias_native" || asObject(asObject(asObject(results[0])["functionResponse"])["response"])["result"] != "paired-alias-native" {
				return fail()
			}
			stream = strings.ReplaceAll(geminiProbeStream, "gemini-ok", "alias-native-done")
		}
	default:
		return fail()
	}
	if len(history) != 1 && len(history) != 3 {
		return fail()
	}
	w.Header().Set("Content-Type", "text/event-stream")
	io.WriteString(w, stream)
	return true
}
func probeToolAliasRequests(core *appcore.Core) error {
	base, key, err := probeCredentials(core)
	if err != nil {
		return err
	}
	client := http.Client{Timeout: 4 * time.Second}
	defer client.CloseIdleConnections()
	ns, name, wire := probeLongToolIdentity()
	for _, model := range []string{"gpt-5.5", "claude-sonnet-4-6", "gemini-2.5-flash"} {
		for _, stream := range []bool{false, true} {
			payload := map[string]any{"model": model, "stream": stream, "input": []any{map[string]string{"role": "user", "content": "long-alias-native"}}, "tools": []any{map[string]any{"type": "namespace", "name": ns, "tools": []any{map[string]string{"type": "function", "name": name}}}}, "tool_choice": map[string]string{"type": "function", "name": name, "namespace": ns}}
			post := func() (map[string]any, []byte, error) {
				b, _ := json.Marshal(payload)
				req, _ := http.NewRequest("POST", base+"/responses", strings.NewReader(string(b)))
				req.Header.Set("Authorization", "Bearer "+key)
				req.Header.Set("Content-Type", "application/json")
				resp, e := client.Do(req)
				if e != nil {
					return nil, nil, e
				}
				defer resp.Body.Close()
				data, e := io.ReadAll(resp.Body)
				if e != nil || resp.StatusCode != 200 {
					return nil, nil, errors.New("long alias native delivery")
				}
				var final map[string]any
				if stream {
					for _, line := range strings.Split(string(data), "\n") {
						if strings.HasPrefix(line, "data: ") {
							var event map[string]any
							if json.Unmarshal([]byte(strings.TrimPrefix(line, "data: ")), &event) == nil && event["type"] == "response.completed" {
								final, _ = event["response"].(map[string]any)
							}
						}
					}
				} else {
					json.Unmarshal(data, &final)
				}
				if final["status"] != "completed" {
					return nil, nil, errors.New("long alias native terminal")
				}
				return final, data, nil
			}
			first, data, err := post()
			if err != nil {
				return err
			}
			output, _ := first["output"].([]any)
			if len(output) != 1 {
				return errors.New("long alias native output count")
			}
			call, _ := output[0].(map[string]any)
			if call["name"] != name || call["namespace"] != ns || call["call_id"] != "call_alias_native" || strings.Contains(string(data), wire) {
				return errors.New("long alias native canonical identity")
			}
			payload["previous_response_id"] = first["id"]
			payload["input"] = []any{map[string]string{"type": "function_call_output", "call_id": "call_alias_native", "output": "paired-alias-native"}}
			payload["tool_choice"] = "auto"
			_, data, err = post()
			if err != nil {
				return err
			}
			if !strings.Contains(string(data), "alias-native-done") {
				return errors.New("long alias native history")
			}
		}
	}
	return nil
}
