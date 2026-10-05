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

const probeImageURL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="

func probeImageUpstream(w http.ResponseWriter, r *http.Request, data []byte) bool {
	if !strings.Contains(string(data), "image-input-probe") {
		return false
	}
	var body map[string]any
	_ = json.Unmarshal(data, &body)
	o := func(v any) map[string]any { m, _ := v.(map[string]any); return m }
	var parts []any
	var want []any
	var response string
	text := map[string]any{"type": "text", "text": "image-input-probe"}
	after := map[string]any{"type": "text", "text": "after-image"}
	switch r.URL.Path {
	case "/v1/chat/completions":
		messages, _ := body["messages"].([]any)
		if len(messages) == 1 {
			parts, _ = o(messages[0])["content"].([]any)
		}
		want = []any{text, map[string]any{"type": "image_url", "image_url": map[string]any{"url": probeImageURL, "detail": "auto"}}, after, map[string]any{"type": "image_url", "image_url": map[string]any{"url": "https://images.example.invalid/a", "detail": "auto"}}}
		response = "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"image-input-ok\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n"
	case "/v1/messages":
		messages, _ := body["messages"].([]any)
		if len(messages) == 1 {
			parts, _ = o(messages[0])["content"].([]any)
		}
		want = []any{text, map[string]any{"type": "image", "source": map[string]any{"type": "base64", "media_type": "image/png", "data": strings.Split(probeImageURL, ",")[1]}}, after, map[string]any{"type": "image", "source": map[string]any{"type": "url", "url": "https://images.example.invalid/a"}}}
		response = strings.ReplaceAll(claudeProbeStream, "claude-ok", "image-input-ok")
	default:
		contents, _ := body["contents"].([]any)
		if len(contents) == 1 {
			parts, _ = o(contents[0])["parts"].([]any)
		}
		want = []any{map[string]any{"text": "image-input-probe"}, map[string]any{"inline_data": map[string]any{"mime_type": "image/png", "data": strings.Split(probeImageURL, ",")[1]}}, map[string]any{"text": "after-image"}, map[string]any{"fileData": map[string]any{"mimeType": "image/jpeg", "fileUri": "https://images.example.invalid/a"}}}
		response = strings.ReplaceAll(geminiProbeStream, "gemini-ok", "image-input-ok")
	}
	if !reflect.DeepEqual(parts, want) {
		w.WriteHeader(400)
		return true
	}
	w.Header().Set("Content-Type", "text/event-stream")
	io.WriteString(w, response)
	return true
}

func probeImageRequests(core *appcore.Core) error {
	base, key, err := probeCredentials(core)
	if err != nil {
		return err
	}
	client := http.Client{Timeout: 4 * time.Second}
	defer client.CloseIdleConnections()
	for _, model := range []string{"gpt-5.5", "claude-sonnet-4-6", "gemini-2.5-flash"} {
		for _, stream := range []bool{true, false} {
			parts := []any{map[string]any{"type": "input_text", "text": "image-input-probe"}, map[string]any{"type": "input_image", "image_url": probeImageURL, "detail": "auto"}, map[string]any{"type": "input_text", "text": "after-image"}, map[string]any{"type": "input_image", "image_url": "https://images.example.invalid/a", "mime_type": "image/jpeg", "detail": "auto"}}
			b, _ := json.Marshal(map[string]any{"model": model, "stream": stream, "input": []any{map[string]any{"role": "user", "content": parts}}})
			req, _ := http.NewRequest("POST", base+"/responses", strings.NewReader(string(b)))
			req.Header.Set("Authorization", "Bearer "+key)
			req.Header.Set("Content-Type", "application/json")
			resp, err := client.Do(req)
			if err != nil {
				return err
			}
			data, err := io.ReadAll(resp.Body)
			resp.Body.Close()
			if err != nil || resp.StatusCode != 200 || !strings.Contains(string(data), "image-input-ok") {
				return errors.New("ordered image probe")
			}
			if stream {
				if !strings.Contains(string(data), "response.completed") {
					return errors.New("image SSE probe")
				}
			} else {
				var final map[string]any
				if json.Unmarshal(data, &final) != nil || final["status"] != "completed" {
					return errors.New("image JSON probe")
				}
			}
		}
	}
	return nil
}
