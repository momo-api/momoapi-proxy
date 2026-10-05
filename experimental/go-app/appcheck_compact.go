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
	return nil
}
