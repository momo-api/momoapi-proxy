// Package ui exposes only fixed native asset actions; never the local API token.
package ui

import (
	"bytes"
	"encoding/json"
	"github.com/momo-api/momoapi-proxy/experimental/go-app/internal/appcore"
	"io"
	"net/http"
)

func Handler(origin string, core *appcore.Core) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		if origin != "http://wails.localhost" && origin != "wails://localhost" {
			http.Error(w, "invalid origin", 503)
			return
		}
		if r.URL.RawQuery != "" || r.URL.ForceQuery || r.URL.RawPath != "" {
			http.Error(w, "invalid path", 400)
			return
		}
		if r.URL.Path == "/" && r.Method == "GET" {
			if o := r.Header.Get("Origin"); o != "" && o != origin {
				http.Error(w, "origin denied", 403)
				return
			}
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			_, _ = io.WriteString(w, Page)
			return
		}
		if r.Header.Get("Origin") != origin {
			http.Error(w, "origin required", 403)
			return
		}
		if r.Method != "POST" {
			http.Error(w, "method denied", 405)
			return
		}
		if r.URL.Path != "/app/state" && r.URL.Path != "/app/configure" && r.URL.Path != "/app/start" && r.URL.Path != "/app/stop" {
			http.NotFound(w, r)
			return
		}
		data, err := io.ReadAll(io.LimitReader(r.Body, 8193))
		if err != nil || len(data) > 8192 {
			http.Error(w, "body rejected", 413)
			return
		}
		if r.URL.Path == "/app/configure" {
			var config appcore.Config
			d := json.NewDecoder(bytes.NewReader(data))
			d.DisallowUnknownFields()
			if d.Decode(&config) != nil {
				http.Error(w, "invalid configuration", 400)
				return
			}
			var trailing any
			if d.Decode(&trailing) != io.EOF {
				http.Error(w, "invalid configuration", 400)
				return
			}
			if core.Configure(config) != nil {
				http.Error(w, "stop service and check HTTPS origin/key", 400)
				return
			}
		} else {
			if len(data) != 0 {
				http.Error(w, "body denied", 400)
				return
			}
			if r.URL.Path == "/app/start" && core.Start() != nil {
				http.Error(w, "configure upstream first", 400)
				return
			}
			if r.URL.Path == "/app/stop" {
				core.Stop()
			}
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(core.State())
	})
}
