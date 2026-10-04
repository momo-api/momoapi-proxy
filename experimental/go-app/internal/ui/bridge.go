// Package ui exposes only fixed native asset actions; never the local API token.
package ui

import (
	"bytes"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"github.com/momo-api/momoapi-proxy/experimental/go-app/internal/appcore"
	"io"
	"net/http"
	"strings"
	"sync"
)

// Native actions return no credentials to the WebView. Nil disables the action.
type Actions struct {
	SaveProfile    func(appcore.Config) error
	LoadProfile    func() (appcore.Config, error)
	ForgetProfile  func() error
	CopyConnection func() error
	Quit           func()
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
		if r.URL.Path != "/app/state" && r.URL.Path != "/app/configure" && r.URL.Path != "/app/start" && r.URL.Path != "/app/stop" && r.URL.Path != "/app/copy" && r.URL.Path != "/app/quit" && r.URL.Path != "/app/load" && r.URL.Path != "/app/forget" {
			http.NotFound(w, r)
			return
		}
		data, err := io.ReadAll(io.LimitReader(r.Body, 8193))
		if err != nil || len(data) > 8192 {
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
