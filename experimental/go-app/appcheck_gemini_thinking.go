//go:build appcheck && !nogui

package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"reflect"
	"strings"
	"time"

	"github.com/momo-api/momoapi-proxy/experimental/go-app/internal/appcore"
)

func probeGeminiThinkingConfigs() []map[string]any {
	return []map[string]any{
		{"thinkingLevel": "MINIMAL", "includeThoughts": true},
		{"thinkingLevel": "LOW", "includeThoughts": false},
		{"thinkingLevel": "MEDIUM"},
		{"thinkingLevel": "HIGH"},
		{"thinkingBudget": float64(0)},
		{"thinkingBudget": float64(-1), "includeThoughts": true},
	}
}
func probeGeminiThinkingUpstream(w http.ResponseWriter, r *http.Request, data []byte) bool {
	if r.URL.Path != "/v1beta/models/"+probeGeminiStateModel+":streamGenerateContent" || r.URL.RawQuery != "alt=sse" || r.Method != "POST" {
		return false
	}
	var body map[string]any
	if json.Unmarshal(data, &body) != nil {
		return false
	}
	for i, config := range probeGeminiThinkingConfigs() {
		contents := []any{map[string]any{"role": "user", "parts": []any{map[string]any{"text": fmt.Sprintf("gemini-thinking-native-%d", i)}}}}
		if !reflect.DeepEqual(body["contents"], contents) {
			continue
		}
		if !reflect.DeepEqual(body["generationConfig"], map[string]any{"maxOutputTokens": float64(2048), "thinkingConfig": config}) {
			return false
		}
		w.Header().Set("Content-Type", "text/event-stream")
		io.WriteString(w, "data: {\"candidates\":[{\"index\":0,\"content\":{\"role\":\"model\",\"parts\":[{\"text\":\"thinking-native-accepted\"}]},\"finishReason\":\"STOP\"}],\"usageMetadata\":{\"promptTokenCount\":3,\"candidatesTokenCount\":5,\"totalTokenCount\":8}}\r\n\r\n")
		return true
	}
	return false
}
func probeGeminiThinkingRequests(core *appcore.Core) error {
	base, key, err := probeCredentials(core)
	if err != nil {
		return err
	}
	client := http.Client{Timeout: 4 * time.Second}
	defer client.CloseIdleConnections()
	for _, stream := range []bool{false, true} {
		for i, config := range probeGeminiThinkingConfigs() {
			p := map[string]any{"model": probeGeminiStateModel, "stream": stream, "input": []any{map[string]any{"role": "user", "content": fmt.Sprintf("gemini-thinking-native-%d", i)}}, "max_output_tokens": 2048, "momo_gemini_thinking": config}
			// Cover ordinary effort as well as explicit native level controls.
			if i == 3 {
				delete(p, "momo_gemini_thinking")
				p["reasoning_effort"] = "high"
			}
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
			if err != nil || resp.StatusCode != 200 || !strings.Contains(string(data), "thinking-native-accepted") || (stream && !strings.Contains(string(data), "event: response.completed")) {
				return errors.New("Gemini thinking native wire/completion")
			}
		}
	}
	return probeMediaRequests(core)
}
