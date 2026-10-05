// Package ui exposes only fixed native asset actions; never the local API token.
package ui

import (
	"bytes"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"github.com/momo-api/momoapi-proxy/experimental/go-app/internal/appcore"
	"io"
	"net/http"
	"strings"
	"sync"
	"unicode/utf8"
)

// Native actions return no credentials to the WebView. Nil disables the action.
type Actions struct {
	SaveProfile     func(appcore.Config) error
	LoadProfile     func() (appcore.Config, error)
	ForgetProfile   func() error
	CopyConnection  func() error
	Quit            func()
	CopySkill       func() error
	CopyMCPConfig   func() error
	CopyCodexConfig func() error
	// WebKit custom schemes can omit Origin or serialize it as null. Require a
	// separate unguessable page capability; never accept either by itself.
	AllowOpaqueOrigin bool
}

func Handler(origin string, core *appcore.Core) http.Handler {
	return HandlerWithActions(origin, core, Actions{})
}

func HandlerWithActions(origin string, core *appcore.Core, actions Actions) http.Handler {
	var nonce [32]byte
	_, nonceErr := rand.Read(nonce[:])
	bridgeNonce := hex.EncodeToString(nonce[:])
	page := strings.Replace(Page, "<script>", "<script>const bridgeNonce='"+bridgeNonce+"';", 1)
	var actionMu sync.Mutex
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		if nonceErr != nil || (origin != "http://wails.localhost" && origin != "wails://localhost") {
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
			_, _ = io.WriteString(w, page)
			return
		}
		o := r.Header.Get("Origin")
		opaqueAllowed := actions.AllowOpaqueOrigin && origin == "wails://localhost" && (o == "null" || o == "") && subtle.ConstantTimeCompare([]byte(r.Header.Get("X-MOMO-Bridge")), []byte(bridgeNonce)) == 1
		if r.Header.Get("Origin") != origin && !opaqueAllowed {
			http.Error(w, "origin required", 403)
			return
		}
		if r.Method != "POST" {
			http.Error(w, "method denied", 405)
			return
		}
		imageAction := r.URL.Path == "/app/images/catalog" || r.URL.Path == "/app/images/generate" || r.URL.Path == "/app/images/task"
		if imageAction && subtle.ConstantTimeCompare([]byte(r.Header.Get("X-MOMO-Bridge")), []byte(bridgeNonce)) != 1 {
			http.Error(w, "page capability required", 403)
			return
		}
		if !imageAction && r.URL.Path != "/app/state" && r.URL.Path != "/app/configure" && r.URL.Path != "/app/start" && r.URL.Path != "/app/stop" && r.URL.Path != "/app/copy" && r.URL.Path != "/app/quit" && r.URL.Path != "/app/load" && r.URL.Path != "/app/forget" && r.URL.Path != "/app/quota" && r.URL.Path != "/app/models" && r.URL.Path != "/app/skill" && r.URL.Path != "/app/mcp-config" && r.URL.Path != "/app/codex-config" {
			http.NotFound(w, r)
			return
		}
		limit := 8192
		if imageAction {
			limit = 160 << 10
		}
		data, err := io.ReadAll(io.LimitReader(r.Body, int64(limit)+1))
		if err != nil || len(data) > limit || !utf8.Valid(data) {
			http.Error(w, "body rejected", 413)
			return
		}
		// OS stores may wait for unlock. Reject overlapping mutations instead of
		// piling up handlers; status/Stop/Quit stay available while a prompt is open.
		if r.URL.Path != "/app/state" && r.URL.Path != "/app/stop" && r.URL.Path != "/app/quit" {
			if !actionMu.TryLock() {
				http.Error(w, "another native action is pending", 409)
				return
			}
			defer actionMu.Unlock()
		}
		if imageAction {
			path := "/internal/images/capabilities"
			var body []byte
			if r.URL.Path == "/app/images/catalog" {
				if len(data) != 0 {
					http.Error(w, "body denied", 400)
					return
				}
			} else {
				var input struct {
					Confirmed bool            `json:"confirmed"`
					Request   json.RawMessage `json:"request"`
					TaskID    string          `json:"task_id"`
				}
				d := json.NewDecoder(bytes.NewReader(data))
				d.DisallowUnknownFields()
				var trailing any
				if d.Decode(&input) != nil || d.Decode(&trailing) != io.EOF {
					http.Error(w, "invalid image action", 400)
					return
				}
				if r.URL.Path == "/app/images/generate" {
					if !input.Confirmed || input.TaskID != "" || len(input.Request) == 0 {
						http.Error(w, "explicit generation confirmation required", 400)
						return
					}
					path = "/internal/images/generate"
					body = input.Request
				} else {
					if input.Confirmed || input.Request != nil {
						http.Error(w, "invalid task action", 400)
						return
					}
					path = "/internal/images/tasks/" + input.TaskID
				}
			}
			data, status := core.DesktopImages(r.Context(), path, body)
			if status != 200 {
				http.Error(w, "image action rejected or unavailable; submitted upstream effects may already exist", status)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			if n, err := w.Write(data); err != nil || n != len(data) {
				panic(http.ErrAbortHandler)
			}
			return
		}
		if r.URL.Path == "/app/configure" {
			var input struct {
				appcore.Config
				Remember bool
			}
			d := json.NewDecoder(bytes.NewReader(data))
			d.DisallowUnknownFields()
			if d.Decode(&input) != nil {
				http.Error(w, "invalid configuration", 400)
				return
			}
			var trailing any
			if d.Decode(&trailing) != io.EOF {
				http.Error(w, "invalid configuration", 400)
				return
			}
			if core.Configure(input.Config) != nil {
				http.Error(w, "stop service and check HTTPS origin/key", 400)
				return
			}
			if input.Remember && (actions.SaveProfile == nil || actions.SaveProfile(input.Config) != nil) {
				http.Error(w, "configuration applied in memory; secure save failed", 503)
				return
			}
		} else {
			if len(data) != 0 {
				http.Error(w, "body denied", 400)
				return
			}
			if r.URL.Path == "/app/models" {
				models, err := core.QueryModels(r.Context())
				if err != nil {
					status := 502
					if errors.Is(err, appcore.ErrModelsUnauthorized) {
						status = 401
					}
					if errors.Is(err, appcore.ErrModelsUnsupported) {
						status = 404
					}
					if errors.Is(err, appcore.ErrModelsBusy) {
						status = 409
					}
					http.Error(w, "model catalog unavailable", status)
					return
				}
				w.Header().Set("Content-Type", "application/json")
				_ = json.NewEncoder(w).Encode(models)
				return
			}
			if r.URL.Path == "/app/quota" {
				quota, err := core.QueryTokenQuota(r.Context())
				if err != nil {
					status := 502
					if errors.Is(err, appcore.ErrQuotaUnauthorized) {
						status = 401
					}
					if errors.Is(err, appcore.ErrQuotaUnsupported) {
						status = 404
					}
					if errors.Is(err, appcore.ErrQuotaBusy) {
						status = 409
					}
					http.Error(w, "token quota unavailable", status)
					return
				}
				w.Header().Set("Content-Type", "application/json")
				_ = json.NewEncoder(w).Encode(quota)
				return
			}
			if r.URL.Path == "/app/skill" && (actions.CopySkill == nil || actions.CopySkill() != nil) {
				http.Error(w, "skill clipboard unavailable", 503)
				return
			}
			if r.URL.Path == "/app/mcp-config" && (actions.CopyMCPConfig == nil || actions.CopyMCPConfig() != nil) {
				http.Error(w, "MCP config clipboard unavailable", 503)
				return
			}
			if r.URL.Path == "/app/codex-config" && (actions.CopyCodexConfig == nil || actions.CopyCodexConfig() != nil) {
				http.Error(w, "client config clipboard unavailable", 503)
				return
			}
			if r.URL.Path == "/app/load" {
				s := core.State()
				if s.Running || s.Active != 0 || actions.LoadProfile == nil {
					http.Error(w, "stop proxy before loading profile", 409)
					return
				}
				config, err := actions.LoadProfile()
				if err != nil || core.Configure(config) != nil {
					http.Error(w, "saved profile unavailable or invalid", 503)
					return
				}
			}
			if r.URL.Path == "/app/forget" && (actions.ForgetProfile == nil || actions.ForgetProfile() != nil) {
				http.Error(w, "secure profile removal failed", 503)
				return
			}
			if r.URL.Path == "/app/start" && core.Start() != nil {
				http.Error(w, "configure upstream first", 400)
				return
			}
			if r.URL.Path == "/app/stop" {
				core.Stop()
			}
			if r.URL.Path == "/app/copy" {
				if actions.CopyConnection == nil || actions.CopyConnection() != nil {
					http.Error(w, "native clipboard unavailable", 503)
					return
				}
			}
			if r.URL.Path == "/app/quit" {
				if actions.Quit == nil {
					http.Error(w, "native quit unavailable", 503)
					return
				}
				actions.Quit()
			}
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(core.State())
	})
}
