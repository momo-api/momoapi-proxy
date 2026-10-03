// Package desktopbridge is the non-secret Wails asset boundary, not a TCP server.
package desktopbridge

import (
	"context"
	"encoding/json"
	"github.com/momo-api/momoapi-proxy/experimental/go-desktop/internal/control"
	"io"
	"net/http"
)

type Caller func(context.Context, string) (control.State, error)

// Handler uses one platform's exact Wails asset origin, never a wildcard.
// Empty Origin is allowed only for top-level navigation, not demo actions.
func Handler(page, origin string, call Caller) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if origin != "http://wails.localhost" && origin != "wails://localhost" {
			http.Error(w, "invalid bridge configuration", 503)
			return
		}
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		requestOrigin := r.Header.Get("Origin")
		if requestOrigin != "" && requestOrigin != origin {
			http.Error(w, "origin denied", 403)
			return
		}
		if r.URL.RawQuery != "" || r.URL.ForceQuery || r.URL.RawPath != "" {
			http.Error(w, "query or encoded path denied", 400)
			return
		}
		method, action := "", ""
		switch r.URL.Path {
		case "/":
			method = "GET"
		case "/demo/state":
			method = "POST"
			action = "state"
		case "/demo/start":
			method = "POST"
			action = "start"
		case "/demo/stop":
			method = "POST"
			action = "stop"
		default:
			http.NotFound(w, r)
			return
		}
		if r.Method != method {
			w.Header().Set("Allow", method)
			http.Error(w, "method denied", 405)
			return
		}
		if action != "" && requestOrigin != origin {
			http.Error(w, "origin required", 403)
			return
		}
		body, err := io.ReadAll(io.LimitReader(r.Body, 2))
		if err != nil || len(body) != 0 {
			http.Error(w, "body denied", 400)
			return
		}
		if action == "" {
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			_, _ = io.WriteString(w, page)
			return
		}
		state, err := call(r.Context(), action)
		w.Header().Set("Content-Type", "application/json")
		if err != nil {
			w.WriteHeader(503)
			_ = json.NewEncoder(w).Encode(map[string]string{"error": "demo unavailable"})
			return
		}
		_ = json.NewEncoder(w).Encode(state)
	})
}
