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

func probeLimitsUpstream(w http.ResponseWriter, r *http.Request, data []byte) bool {
	var body, want map[string]any
	if json.Unmarshal(data, &body) != nil {
		return false
	}
	stream := ""
	switch r.URL.Path {
	case "/v1/chat/completions":
		json.Unmarshal([]byte(routedProbeBody), &want)
		want["max_completion_tokens"] = float64(17)
		stream = "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"limit-ok\"},\"finish_reason\":\"length\"}]}\n\ndata: [DONE]\n\n"
	case "/v1/messages":
		if r.Header.Get("anthropic-version") != "2023-06-01" {
			return false
		}
		json.Unmarshal([]byte(claudeProbeBody), &want)
		want["max_tokens"] = float64(17)
		stream = strings.ReplaceAll(strings.ReplaceAll(claudeProbeStream, "claude-ok", "limit-ok"), "end_turn", "max_tokens")
	case "/v1beta/models/gemini-2.5-flash:streamGenerateContent":
		if r.URL.RawQuery != "alt=sse" {
			return false
		}
		json.Unmarshal([]byte(geminiProbeBody), &want)
		want["generationConfig"] = map[string]any{"maxOutputTokens": float64(17)}
		stream = strings.ReplaceAll(strings.ReplaceAll(geminiProbeStream, "gemini-ok", "limit-ok"), "STOP", "MAX_TOKENS")
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

func probeLimitsRequests(core *appcore.Core) error {
	base, key, err := probeCredentials(core)
	if err != nil {
		return err
	}
	client := http.Client{Timeout: 4 * time.Second}
	defer client.CloseIdleConnections()
	for _, payload := range []string{routedProbeRequest, claudeProbeRequest, geminiProbeRequest} {
		for _, stream := range []bool{true, false} {
			var body map[string]any
			json.Unmarshal([]byte(payload), &body)
			body["stream"], body["max_output_tokens"] = stream, 17
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
			if err != nil || response.StatusCode != 200 || !strings.Contains(string(data), "limit-ok") || strings.Contains(string(data), "response.completed") {
				return errors.New("output limit result")
			}
			var final map[string]any
			if stream {
				for _, line := range strings.Split(string(data), "\n") {
					if !strings.HasPrefix(line, "data: ") {
						continue
					}
					var event map[string]any
					if json.Unmarshal([]byte(line[6:]), &event) == nil && event["type"] == "response.incomplete" {
						if final != nil {
							return errors.New("duplicate incomplete")
						}
						final, _ = event["response"].(map[string]any)
					}
				}
			} else if json.Unmarshal(data, &final) != nil {
				return errors.New("incomplete JSON")
			}
			if final == nil || final["status"] != "incomplete" || !reflect.DeepEqual(final["incomplete_details"], map[string]any{"reason": "max_output_tokens"}) {
				return errors.New("incomplete terminal")
			}
		}
	}
	return probeCompactRequests(core)
}
