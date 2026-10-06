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

const probeGeminiStateModel = "gemini-3.1-pro-preview"
const probeGeminiStateSignature = "c3ludGhldGljLXN0YXRl"

func probeGeminiStateParts() []any {
	return []any{map[string]any{"text": "public summary\r\n", "thought": true, "thoughtSignature": probeGeminiStateSignature}, map[string]any{"text": "signed answer", "thoughtSignature": probeGeminiStateSignature}, map[string]any{"functionCall": map[string]any{"id": "signed_native_call", "name": "read", "args": map[string]any{}}, "thoughtSignature": probeGeminiStateSignature}, map[string]any{"text": "", "thoughtSignature": probeGeminiStateSignature}}
}
func probeGeminiStateUpstream(w http.ResponseWriter, r *http.Request, data []byte) bool {
	if r.URL.Path != "/v1beta/models/"+probeGeminiStateModel+":streamGenerateContent" || r.URL.RawQuery != "alt=sse" || r.Method != "POST" {
		return false
	}
	var body map[string]any
	if json.Unmarshal(data, &body) != nil {
		return false
	}
	contents, _ := body["contents"].([]any)
	if len(contents) == 0 {
		return false
	}
	first, _ := contents[0].(map[string]any)
	if !reflect.DeepEqual(first, map[string]any{"role": "user", "parts": []any{map[string]any{"text": "gemini-state-native"}}}) {
		return false
	}
	parts := probeGeminiStateParts()
	if len(contents) != 1 {
		if len(contents) != 3 {
			return false
		}
		model, _ := contents[1].(map[string]any)
		result, _ := contents[2].(map[string]any)
		if !reflect.DeepEqual(model, map[string]any{"role": "model", "parts": parts}) || !reflect.DeepEqual(result, map[string]any{"role": "user", "parts": []any{map[string]any{"functionResponse": map[string]any{"id": "signed_native_call", "name": "read", "response": map[string]any{"result": "signed native result"}}}}}) {
			return false
		}
		parts = []any{map[string]any{"text": "signed-native-finished"}}
	}
	w.Header().Set("Content-Type", "text/event-stream")
	frame := map[string]any{"candidates": []any{map[string]any{"index": 0, "content": map[string]any{"role": "model", "parts": parts}, "finishReason": "STOP"}}, "usageMetadata": map[string]any{"promptTokenCount": 3, "candidatesTokenCount": 5, "totalTokenCount": 8}}
	b, _ := json.Marshal(frame)
	io.WriteString(w, "data: "+string(b)+"\r\n\r\n")
	return true
}

func probeGeminiStateRequests(core *appcore.Core) error {
	base, key, err := probeCredentials(core)
	if err != nil {
		return err
	}
	client := http.Client{Timeout: 4 * time.Second}
	defer client.CloseIdleConnections()
	for _, stream := range []bool{false, true} {
		p := map[string]any{"model": probeGeminiStateModel, "stream": stream, "input": []any{map[string]any{"role": "user", "content": "gemini-state-native"}}, "tools": []any{map[string]any{"type": "function", "name": "read", "parameters": map[string]any{"type": "object", "properties": map[string]any{}}}}}
		for turn := 0; turn < 2; turn++ {
			b, _ := json.Marshal(p)
			req, _ := http.NewRequest("POST", base+"/responses", strings.NewReader(string(b)))
			req.Header.Set("Authorization", "Bearer "+key)
			req.Header.Set("Content-Type", "application/json")
			resp, err := client.Do(req)
			if err != nil {
				return err
			}
			data, err := io.ReadAll(resp.Body)
			resp.Body.Close()
			if err != nil || resp.StatusCode != 200 {
				return errors.New("signed Gemini native response")
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
				return errors.New("signed Gemini native completion")
			}
			if turn == 0 {
				out, _ := final["output"].([]any)
				if len(out) != 4 {
					return errors.New("signed Gemini native part count")
				}
				thought, _ := out[0].(map[string]any)
				call, _ := out[2].(map[string]any)
				if thought["type"] != "reasoning" || !reflect.DeepEqual(call["momo_gemini"], map[string]any{"model": probeGeminiStateModel, "thought_signature": probeGeminiStateSignature}) {
					return errors.New("signed Gemini native state")
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
						if event["type"] == "response.output_text.delta" && event["delta"] == "public summary\r\n" {
							return errors.New("signed Gemini native summary as answer")
						}
					}
					if !found {
						return errors.New("signed Gemini native summary event")
					}
				}
				p["previous_response_id"] = final["id"]
				p["input"] = []any{map[string]any{"type": "function_call_output", "call_id": "signed_native_call", "output": "signed native result"}}
			} else if !strings.Contains(string(data), "signed-native-finished") {
				return errors.New("signed Gemini native replay")
			}
		}
	}
	return probeClaudeStateRequests(core)
}
