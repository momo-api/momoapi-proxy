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

func probeHistoryUpstream(w http.ResponseWriter, r *http.Request, data []byte) bool {
	var body, want map[string]any
	if json.Unmarshal(data, &body) != nil {
		return false
	}
	stream := ""
	switch r.URL.Path {
	case "/v1/chat/completions":
		json.Unmarshal([]byte(routedProbeBody), &want)
		want["messages"] = []any{map[string]any{"role": "user", "content": "hi"}, map[string]any{"role": "assistant", "content": "routed-ok"}, map[string]any{"role": "user", "content": "next-history"}}
		stream = "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"history-ok\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n"
	case "/v1/messages":
		if r.Header.Get("anthropic-version") != "2023-06-01" {
			return false
		}
		json.Unmarshal([]byte(claudeProbeBody), &want)
		want["messages"] = []any{map[string]any{"role": "user", "content": []any{map[string]any{"type": "text", "text": "hi"}}}, map[string]any{"role": "assistant", "content": []any{map[string]any{"type": "text", "text": "claude-ok"}}}, map[string]any{"role": "user", "content": []any{map[string]any{"type": "text", "text": "next-history"}}}}
		stream = strings.ReplaceAll(claudeProbeStream, "claude-ok", "history-ok")
	case "/v1beta/models/gemini-2.5-flash:streamGenerateContent":
		if r.URL.RawQuery != "alt=sse" {
			return false
		}
		json.Unmarshal([]byte(geminiProbeBody), &want)
		want["contents"] = []any{map[string]any{"role": "user", "parts": []any{map[string]any{"text": "hi"}}}, map[string]any{"role": "model", "parts": []any{map[string]any{"text": "gemini-ok"}}}, map[string]any{"role": "user", "parts": []any{map[string]any{"text": "next-history"}}}}
		stream = strings.ReplaceAll(geminiProbeStream, "gemini-ok", "history-ok")
	default:
		return false
	}
	if !reflect.DeepEqual(body, want) {
		return false
	}
	w.Header().Set("Content-Type", "text/event-stream")
	io.WriteString(w, stream)
	return true
}
func probeHistoryRequests(core *appcore.Core) error {
	base, key, err := probeCredentials(core)
	if err != nil {
		return err
	}
	client := http.Client{Timeout: 4 * time.Second}
	defer client.CloseIdleConnections()
	for _, payload := range []string{routedProbeRequest, claudeProbeRequest, geminiProbeRequest} {
		var body map[string]any
		json.Unmarshal([]byte(payload), &body)
		body["stream"] = false
		for turn := 0; turn < 2; turn++ {
			b, _ := json.Marshal(body)
			req, _ := http.NewRequest("POST", base+"/responses", strings.NewReader(string(b)))
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("Authorization", "Bearer "+key)
			response, err := client.Do(req)
			if err != nil {
				return err
			}
			data, err := io.ReadAll(response.Body)
			response.Body.Close()
			var final map[string]any
			if err != nil || response.StatusCode != 200 || json.Unmarshal(data, &final) != nil || final["status"] != "completed" {
				return errors.New("history probe result")
			}
			if turn == 1 && !strings.Contains(string(data), "history-ok") {
				return errors.New("history replay missing")
			}
			id, ok := final["id"].(string)
			if !ok || id == "" {
				return errors.New("history anchor")
			}
			body["previous_response_id"] = id
			body["input"] = []any{map[string]string{"role": "user", "content": "next-history"}}
		}
	}
	return nil
}
