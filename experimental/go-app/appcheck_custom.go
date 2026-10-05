//go:build appcheck && !nogui

package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/momo-api/momoapi-proxy/experimental/go-app/internal/appcore"
)

const customProbeRaw = " \r\nawait tools.exec_command({cmd: \x60echo $" + "{x} 中文🙂\x60});\r\n*** Begin Patch\r\n*** End Patch\r\n "

func probeCustomUpstream(w http.ResponseWriter, r *http.Request, data []byte) bool {
	if !strings.Contains(string(data), "client-custom-probe") {
		return false
	}
	var body map[string]any
	_ = json.Unmarshal(data, &body)
	o := func(v any) map[string]any { m, _ := v.(map[string]any); return m }
	ts, _ := body["tools"].([]any)
	valid := len(ts) == 1
	var tool map[string]any
	schema := "parameters"
	switch r.URL.Path {
	case "/v1/chat/completions":
		if valid {
			tool = o(o(ts[0])["function"])
		}
		valid = valid && body["tool_choice"] == "auto" && body["stream"] == true
	case "/v1/messages":
		if valid {
			tool = o(ts[0])
		}
		schema = "input_schema"
		valid = valid && o(body["tool_choice"])["type"] == "auto" && r.Header.Get("anthropic-version") == "2023-06-01"
	case "/v1beta/models/gemini-2.5-flash:streamGenerateContent":
		if valid {
			ds, _ := o(ts[0])["functionDeclarations"].([]any)
			valid = len(ds) == 1
			if valid {
				tool = o(ds[0])
			}
		}
		valid = valid && o(o(body["toolConfig"])["functionCallingConfig"])["mode"] == "AUTO" && r.URL.RawQuery == "alt=sse"
	default:
		valid = false
	}
	name, _ := tool["name"].(string)
	parameters := o(tool[schema])
	valid = valid && (name == "pad__exec" || name == "pad__apply_patch") && parameters["additionalProperties"] == false && o(o(parameters["properties"])["input"])["type"] == "string"
	if !valid {
		w.WriteHeader(400)
		return true
	}
	args, _ := json.Marshal(map[string]string{"input": customProbeRaw})
	var response string
	switch r.URL.Path {
	case "/v1/chat/completions":
		b, _ := json.Marshal(map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]any{"tool_calls": []any{map[string]any{"index": 0, "id": "custom_probe", "type": "function", "function": map[string]string{"name": name, "arguments": string(args)}}}}, "finish_reason": "tool_calls"}}})
		response = "data: " + string(b) + "\n\ndata: [DONE]\n\n"
	case "/v1/messages":
		b, _ := json.Marshal(map[string]any{"type": "content_block_start", "index": 0, "content_block": map[string]any{"type": "tool_use", "id": "custom_probe", "name": name, "input": map[string]string{"input": customProbeRaw}}})
		response = strings.Split(claudeProbeStream, "data: {\"type\":\"content_block_start\"")[0] + "data: " + string(b) + "\n\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"tool_use\",\"stop_sequence\":null},\"usage\":{\"output_tokens\":5}}\n\ndata: {\"type\":\"message_stop\"}\n\n"
	default:
		b, _ := json.Marshal(map[string]any{"candidates": []any{map[string]any{"index": 0, "content": map[string]any{"role": "model", "parts": []any{map[string]any{"functionCall": map[string]any{"id": "custom_probe", "name": name, "args": map[string]string{"input": customProbeRaw}}}}}, "finishReason": "STOP"}}})
		response = "data: " + string(b) + "\n\ndata: {\"usageMetadata\":{\"promptTokenCount\":3,\"candidatesTokenCount\":5,\"totalTokenCount\":8}}\n\n"
	}
	w.Header().Set("Content-Type", "text/event-stream")
	io.WriteString(w, response)
	return true
}

func probeCustomRequests(core *appcore.Core) error {
	base, key, err := probeCredentials(core)
	if err != nil {
		return err
	}
	client := http.Client{Timeout: 4 * time.Second}
	defer client.CloseIdleConnections()
	for _, model := range []string{"gpt-5.5", "claude-sonnet-4-6", "gemini-2.5-flash"} {
		for _, stream := range []bool{true, false} {
			for _, name := range []string{"exec", "apply_patch"} {
				p := map[string]any{"model": model, "stream": stream, "input": []any{map[string]string{"role": "user", "content": "client-custom-probe"}}, "tools": []any{map[string]any{"type": "namespace", "name": "pad", "tools": []any{map[string]any{"type": "custom", "name": name, "format": map[string]string{"type": "text"}}}}}}
				b, _ := json.Marshal(p)
				req, _ := http.NewRequest("POST", base+"/responses", strings.NewReader(string(b)))
				req.Header.Set("Content-Type", "application/json")
				req.Header.Set("Authorization", "Bearer "+key)
				resp, err := client.Do(req)
				if err != nil {
					return err
				}
				data, err := io.ReadAll(resp.Body)
				resp.Body.Close()
				if err != nil || resp.StatusCode != 200 {
					return fmt.Errorf("custom transport probe model=%s name=%s stream=%t status=%d read=%v", model, name, stream, resp.StatusCode, err)
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
					return errors.New("custom terminal probe")
				}
				item, _ := out[0].(map[string]any)
				if item["type"] != "custom_tool_call" || item["name"] != name || item["namespace"] != "pad" || item["call_id"] != "custom_probe" || item["input"] != customProbeRaw {
					return errors.New("custom raw identity probe")
				}
			}
		}
	}
	return nil
}
