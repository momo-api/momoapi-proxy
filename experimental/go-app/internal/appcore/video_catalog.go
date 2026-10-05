package appcore

import (
	"encoding/json"
	"time"
)

const videoCatalogTTL = 5 * time.Minute
const videoTaskTTL = 30 * time.Minute
const maxVideoTasks = 64

type videoSession struct {
	profiles   map[string]videoProfile
	checked    time.Time
	tasks      map[string]videoTask
	pending    int
	refreshing bool
}

type videoTask struct{ expires time.Time }

func (s *videoSession) clear() { *s = videoSession{} }
func (s *videoSession) expire(now time.Time) {
	for id, task := range s.tasks {
		if !now.Before(task.expires) {
			delete(s.tasks, id)
		}
	}
}

type videoProfile struct {
	ID                string   `json:"id"`
	Available         bool     `json:"available"`
	Operations        []string `json:"operations"`
	Durations         []int    `json:"durations"`
	Resolutions       []string `json:"resolutions"`
	Ratios            []string `json:"aspect_ratios"`
	MaxReferences     int      `json:"max_reference_images"`
	Availability      string   `json:"availability"`
	ProtocolStatus    string   `json:"protocol_status"`
	defaultDuration   int
	defaultResolution string
	defaultRatio      string
}

// Exact APIMart JSON routes supported by the existing Node implementation.
// Token-scoped /v1/models authorizes availability only, not these static controls
// or successful inference. No old Adobe route, arbitrary catalog endpoints,
// automatic preference/model substitution, pricing or billed capability probe.
func videoBaseProfile(id string) (videoProfile, bool) {
	p := videoProfile{ID: id, Operations: []string{"generate", "image_to_video", "style_reference"}, Availability: "token_model_list", ProtocolStatus: "document_adapter_validated_not_live_verified"}
	low, high := 0, 0
	switch id {
	case "MiniMax-H3-Max":
		low, high = 5, 15
		p.defaultDuration = 5
		p.defaultResolution = "768P"
		p.MaxReferences = 9
		p.Resolutions = []string{"480P", "768P", "1080P"}
		p.Ratios = []string{"21:9", "16:9", "4:3", "1:1", "3:4", "9:16", "adaptive"}
	case "seedance-2.5":
		low, high = 4, 30
		p.defaultDuration = 4
		p.defaultResolution = "480p"
		p.defaultRatio = "adaptive"
		p.MaxReferences = 30
		p.Resolutions = []string{"480p", "720p", "1080p"}
		p.Ratios = []string{"16:9", "4:3", "1:1", "3:4", "9:16", "21:9", "adaptive"}
	default:
		return p, false
	}
	for n := low; n <= high; n++ {
		p.Durations = append(p.Durations, n)
	}
	return p, true
}

func parseVideoCatalog(data []byte) (map[string]videoProfile, error) {
	p, err := decodeVideoObject(data)
	if err != nil {
		return nil, errVideo
	}
	rows, ok := p["data"].([]any)
	if !ok || len(rows) > 4096 {
		return nil, errVideo
	}
	profiles := map[string]videoProfile{}
	seen := map[string]bool{}
	for _, v := range rows {
		row := obj(v)
		id, ok := row["id"].(string)
		if row == nil || !ok || id == "" || len(id) > 256 || seen[id] {
			return nil, errVideo
		}
		seen[id] = true
		if profile, known := videoBaseProfile(id); known {
			profile.Available = true
			profiles[id] = profile
		}
	}
	return profiles, nil
}

func publicVideoCatalog(profiles map[string]videoProfile, checked time.Time) any {
	models := []videoProfile{}
	for _, id := range []string{"MiniMax-H3-Max", "seedance-2.5"} {
		if p, ok := profiles[id]; ok {
			models = append(models, p)
		}
	}
	return map[string]any{"version": 1, "models": models, "checked_at": checked.UTC().Format(time.RFC3339Nano), "expires_at": checked.Add(videoCatalogTTL).UTC().Format(time.RFC3339Nano), "controls_source": "documented Node APIMart adapter; model-list availability is not advanced-control or live inference proof", "storage": "delegated public HTTPS URL text; no fetch/download/playback/authenticated content URL", "limits": map[string]any{"request_bytes": MaxRequest, "response_bytes": MaxResponse, "active": 4, "generate_timeout_seconds": 60, "task_timeout_seconds": 60, "max_session_tasks": maxVideoTasks, "task_ttl_seconds": int(videoTaskTTL.Seconds())}}
}

func videoRoute(path, method string) (bool, bool) {
	if path == "/internal/videos/capabilities" {
		return true, method == "GET"
	}
	if path == "/internal/videos/generate" {
		return true, method == "POST"
	}
	if len(path) > len("/internal/videos/tasks/") && path[:len("/internal/videos/tasks/")] == "/internal/videos/tasks/" && validImageTaskID(path[len("/internal/videos/tasks/"):]) {
		return true, method == "GET"
	}
	return false, false
}

func videoInteger(v any) (int, error) {
	n, ok := v.(json.Number)
	if !ok {
		return 0, errVideo
	}
	i, err := n.Int64()
	if err != nil || i < 0 || i > 1048576 {
		return 0, errVideo
	}
	return int(i), nil
}
