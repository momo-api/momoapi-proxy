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

func probeVideoUpstream(w http.ResponseWriter, r *http.Request, data []byte) bool {
	if r.URL.Path == "/v1/models" && r.Header.Get("Accept") == "application/json" {
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"data":[{"id":"seedance-2.5"}]}`)
		return true
	}
	if r.URL.Path == "/v1/video/generations" {
		if r.Method == "POST" && string(data) == `{"aspect_ratio":"adaptive","duration":4,"model":"seedance-2.5","prompt":"video-gui-probe","resolution":"480p"}` {
			w.Header().Set("Content-Type", "application/json")
			io.WriteString(w, `{"task_id":"task_video_gui_probe","status":"submitted"}`)
			return true
		}
		if r.Method != "POST" || string(data) != `{"aspect_ratio":"adaptive","duration":4,"model":"seedance-2.5","prompt":"video-api-probe","resolution":"480p"}` {
			w.WriteHeader(400)
			return true
		}
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"task_id":"task_video_probe","status":"submitted"}`)
		return true
	}
	if r.URL.Path == "/v1/videos/task_video_probe" || r.URL.Path == "/v1/videos/task_video_gui_probe" {
		if r.Method != "GET" || len(data) != 0 {
			w.WriteHeader(400)
			return true
		}
		w.Header().Set("Content-Type", "application/json")
		id := strings.TrimPrefix(r.URL.Path, "/v1/videos/")
		json.NewEncoder(w).Encode(map[string]any{"code": 200, "data": map[string]any{"task_id": id, "status": "SUCCESS", "result_url": "https://video.example/probe.mp4", "progress": 100}})
		return true
	}
	return false
}

// API success chain through the current desktop Core and actual TCP/TLS mock;
// this is not a video UI, real model, playback or paid upstream acceptance.
func probeVideoRequests(core *appcore.Core) error {
	base, key, err := probeCredentials(core)
	if err != nil {
		return err
	}
	client := http.Client{Timeout: 4 * time.Second}
	defer client.CloseIdleConnections()
	for _, tc := range []struct{ method, path, body string }{
		{"GET", "/internal/videos/capabilities", ""},
		{"POST", "/internal/videos/generate", `{"model":"seedance-2.5","prompt":"video-api-probe"}`},
		{"GET", "/internal/videos/tasks/task_video_probe", ""},
	} {
		r, _ := http.NewRequest(tc.method, strings.TrimSuffix(base, "/v1")+tc.path, strings.NewReader(tc.body))
		r.Header.Set("Authorization", "Bearer "+key)
		r.Header.Set("Content-Type", "application/json")
		res, err := client.Do(r)
		if err != nil {
			return err
		}
		data, err := io.ReadAll(io.LimitReader(res.Body, 16385))
		res.Body.Close()
		var result map[string]any
		if err != nil || res.StatusCode != 200 || len(data) > 16384 || json.Unmarshal(data, &result) != nil || strings.Contains(string(data), probeKey) || strings.Contains(string(data), key) {
			return errors.New("video API probe")
		}
		if tc.method == "POST" && (result["task_id"] != "task_video_probe" || result["status"] != "queued" || result["terminal"] != false) {
			return errors.New("video submit probe")
		}
		if strings.Contains(tc.path, "/tasks/") && (result["status"] != "completed" || result["terminal"] != true || result["remote_url"] != "https://video.example/probe.mp4") {
			return errors.New("video completion probe")
		}
	}
	return nil
}
