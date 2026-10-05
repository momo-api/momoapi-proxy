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

func probeMediaUpstream(w http.ResponseWriter, r *http.Request, data []byte) bool {
	switch r.URL.Path {
	case "/agent/media-capabilities":
		if r.Method != "GET" || len(data) != 0 {
			w.WriteHeader(400)
			return true
		}
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"models":[{"id":"momoapi-gpt-image-2-5-flare","modality":"image","available":true,"operations":["generate"],"parameters":{}}]}`)
	case "/v1/images/generations":
		if r.Method != "POST" || (string(data) != `{"model":"momoapi-gpt-image-2-5-flare","n":1,"prompt":"media-probe"}` && string(data) != `{"model":"momoapi-gpt-image-2-5-flare","n":1,"prompt":"gui-inline-probe"}`) {
			w.WriteHeader(400)
			return true
		}
		w.Header().Set("Content-Type", "application/json")
		if strings.Contains(string(data), "gui-inline-probe") {
			io.WriteString(w, `{"data":[{"b64_json":"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="}]}`)
			return true
		}
		io.WriteString(w, `{"data":[{"status":"submitted","task_id":"task_media_probe"}]}`)
	case "/v1/tasks/task_media_probe":
		if r.Method != "GET" || len(data) != 0 {
			w.WriteHeader(400)
			return true
		}
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"data":{"id":"task_media_probe","status":"completed","result":{"images":[{"url":["https://images.example/probe.png"]}]}}}`)
	default:
		return false
	}
	return true
}

func probeMediaRequests(core *appcore.Core) error {
	base, key, err := probeCredentials(core)
	if err != nil {
		return err
	}
	client := http.Client{Timeout: 4 * time.Second}
	defer client.CloseIdleConnections()
	for _, tc := range []struct{ method, path, body string }{{"GET", "/internal/images/capabilities", ""}, {"POST", "/internal/images/generate", `{"model":"momoapi-gpt-image-2-5-flare","prompt":"media-probe"}`}, {"GET", "/internal/images/tasks/task_media_probe", ""}} {
		r, _ := http.NewRequest(tc.method, strings.TrimSuffix(base, "/v1")+tc.path, strings.NewReader(tc.body))
		r.Header.Set("Authorization", "Bearer "+key)
		r.Header.Set("Content-Type", "application/json")
		response, err := client.Do(r)
		if err != nil {
			return err
		}
		data, err := io.ReadAll(io.LimitReader(response.Body, 16385))
		response.Body.Close()
		var result map[string]any
		if err != nil || response.StatusCode != 200 || len(data) > 16384 || json.Unmarshal(data, &result) != nil {
			return errors.New("media chain probe")
		}
		if tc.path == "/internal/images/generate" && (result["task_id"] != "task_media_probe" || result["terminal"] != false) {
			return errors.New("media submit probe")
		}
		if strings.Contains(tc.path, "/tasks/") && (result["terminal"] != true || !strings.Contains(string(data), "https://images.example/probe.png")) {
			return errors.New("media completion probe")
		}
	}
	return nil
}
