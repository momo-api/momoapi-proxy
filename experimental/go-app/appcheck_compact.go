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

func probeCompactRequests(core *appcore.Core) error {
	base, key, err := probeCredentials(core)
	if err != nil {
		return err
	}
	client := http.Client{Timeout: 4 * time.Second}
	defer client.CloseIdleConnections()
	for _, model := range []string{"gpt-5.5", "claude-sonnet-4-6", "gemini-2.5-flash"} {
		input := []any{map[string]any{"role": "developer", "content": "exact constraint"}, map[string]any{"role": "user", "content": "old"}, map[string]any{"role": "assistant", "content": strings.Repeat("old-text ", 400)}, map[string]any{"role": "user", "content": "recent"}, map[string]any{"role": "assistant", "content": "latest"}, map[string]any{"role": "user", "content": "CURRENT 中文🙂"}}
		input[3] = map[string]any{"role": "user", "content": []any{map[string]any{"type": "input_text", "text": "recent"}, map[string]any{"type": "input_image", "image_url": probeImageURL}, map[string]any{"type": "input_image", "image_url": "https://images.example.invalid/a", "mime_type": "image/jpeg"}}}
		b, _ := json.Marshal(map[string]any{"model": model, "input": input, "stream": false})
		req, _ := http.NewRequest("POST", base+"/responses/compact", strings.NewReader(string(b)))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer "+key)
		response, err := client.Do(req)
		if err != nil {
			return err
		}
		data, err := io.ReadAll(response.Body)
		response.Body.Close()
		var final map[string]any
		if err != nil || response.StatusCode != 200 || json.Unmarshal(data, &final) != nil || final["object"] != "response.compaction" || strings.Contains(string(data), "encrypted_content") || len(data) >= len(b) {
			return errors.New("compact probe result")
		}
		out, _ := final["output"].([]any)
		if len(out) != len(input) || !strings.Contains(string(data), "MOMO explicit lossy checkpoint") {
			return errors.New("compact marker")
		}
		for i := range input {
			if i != 2 && !reflect.DeepEqual(out[i], input[i]) {
				return errors.New("compact required item changed")
			}
		}
	}
	if err := probeNativeCompactRequests(core); err != nil {
		return err
	}
	if err := probeSearchCheckpointRequests(core); err != nil {
		return err
	}
	return probeImageRequests(core)
}

const nativeCompactProbeJSON = ` {"id":"cmp_native_mock","object":"response.compaction","created_at":1,"output":[{"type":"compaction","id":"native_item","encrypted_content":"opaque-synthetic-not-a-real-envelope"}],"unknown":"中文🙂"} `

func probeNativeCompactUpstream(w http.ResponseWriter, r *http.Request, data []byte) bool {
	if !strings.Contains(string(data), "native-compact-probe") {
		return false
	}
	valid := r.URL.Path == "/v1/responses/compact" && r.Header.Get("X-MOMO-Compact") == "" && r.Method == "POST"
	if !valid {
		w.WriteHeader(400)
		return true
	}
	w.Header().Set("Content-Type", "application/json")
	io.WriteString(w, nativeCompactProbeJSON)
	return true
}

func probeNativeCompactRequests(core *appcore.Core) error {
	base, key, err := probeCredentials(core)
	if err != nil {
		return err
	}
	client := http.Client{Timeout: 4 * time.Second}
	defer client.CloseIdleConnections()
	req, _ := http.NewRequest("POST", base+"/responses/compact", strings.NewReader(` {"model":"gpt-5.6-sol","input":[{"role":"user","content":"native-compact-probe"}],"unknown":"中文🙂"} `))
	req.Header.Set("Authorization", "Bearer "+key)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-MOMO-Compact", "native")
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	data, err := io.ReadAll(resp.Body)
	resp.Body.Close()
	if err != nil || resp.StatusCode != 200 || string(data) != nativeCompactProbeJSON {
		return errors.New("native compact exact envelope probe")
	}
	return nil
}
