package ui

import (
	"bytes"
	"encoding/json"
	"net/http"
	"strings"

	"github.com/momo-api/momoapi-proxy/experimental/go-app/internal/appcore"
)

// Confirmation envelope is duplicate-free at every depth: conflicting human
// intent fields never acquire last-value-wins semantics. No arbitrary path.
func strictVideoAction(data []byte) bool {
	if !json.Valid(data) {
		return false
	}
	d := json.NewDecoder(bytes.NewReader(data))
	d.UseNumber()
	var walk func(int) bool
	walk = func(depth int) bool {
		if depth > 64 {
			return false
		}
		token, err := d.Token()
		if err != nil {
			return false
		}
		delim, ok := token.(json.Delim)
		if !ok {
			return true
		}
		switch delim {
		case '{':
			seen := map[string]bool{}
			for d.More() {
				k, err := d.Token()
				if err != nil {
					return false
				}
				s, ok := k.(string)
				if !ok || seen[s] {
					return false
				}
				seen[s] = true
				if !walk(depth + 1) {
					return false
				}
			}
		case '[':
			for d.More() {
				if !walk(depth + 1) {
					return false
				}
			}
		default:
			return false
		}
		_, err = d.Token()
		return err == nil
	}
	return walk(0)
}

func serveVideoAction(w http.ResponseWriter, r *http.Request, core *appcore.Core, data []byte) {
	path := "/internal/videos/capabilities"
	var body []byte
	if r.URL.Path == "/app/videos/catalog" {
		if len(data) != 0 {
			http.Error(w, "body denied", 400)
			return
		}
	} else {
		var m map[string]json.RawMessage
		if !strictVideoAction(data) || json.Unmarshal(data, &m) != nil || m == nil {
			http.Error(w, "invalid video action", 400)
			return
		}
		if r.URL.Path == "/app/videos/generate" {
			var confirmed bool
			var request map[string]json.RawMessage
			if len(m) != 2 || json.Unmarshal(m["confirmed"], &confirmed) != nil || !confirmed || json.Unmarshal(m["request"], &request) != nil || request == nil {
				http.Error(w, "explicit generation confirmation required", 400)
				return
			}
			path = "/internal/videos/generate"
			body = m["request"]
		} else {
			var id string
			if len(m) != 1 || json.Unmarshal(m["task_id"], &id) != nil || len(id) == 0 || len(id) > 256 || id == "." || id == ".." || strings.Trim(id, "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._:-") != "" {
				http.Error(w, "invalid task action", 400)
				return
			}
			path = "/internal/videos/tasks/" + id
		}
	}
	data, status := core.DesktopVideos(r.Context(), path, body)
	if status != 200 {
		http.Error(w, "video action rejected or unavailable; upstream effects may already exist", status)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	if n, err := w.Write(data); err != nil || n != len(data) {
		panic(http.ErrAbortHandler)
	}
}
