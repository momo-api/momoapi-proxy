//go:build nativecheck && windows && !nogui

package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/momo-api/momoapi-proxy/experimental/go-desktop/internal/control"
	"github.com/momo-api/momoapi-proxy/experimental/go-desktop/internal/desktopbridge"
	"github.com/wailsapp/wails/v3/pkg/application"
)

// This separate binary has no session input or normal desktop command. It must
// never be distributed. Its owned synthetic daemon is NOT independent-product
// UI/daemon isolation evidence. No arbitrary headers, URLs or bodies are logged.
func main() {
	_ = os.Stdin.Close()
	if len(os.Args) != 1 || nativeCheck() != nil {
		fmt.Fprintln(os.Stderr, "FAIL: native-check (see fixed evidence flags or watchdog result)")
		os.Exit(1)
	}
}

func nativeCheck() error {
	profile, err := os.MkdirTemp("", "momo-nativecheck-")
	if err != nil {
		return errors.New("temporary profile unavailable")
	}
	// Intentionally retain this classified, synthetic WebView profile; no broad
	// deletion of historical/user material. The wrapper records its exact path.
	fmt.Println("PROFILE: " + profile)
	secret := make([]byte, 32)
	if _, err = rand.Read(secret); err != nil {
		return errors.New("randomness unavailable")
	}
	s := control.Session{Token: hex.EncodeToString(secret)}
	nonce := make([]byte, 16)
	if _, err = rand.Read(nonce); err != nil {
		return errors.New("randomness unavailable")
	}
	completionPath := "/nativecheck/complete/" + hex.EncodeToString(nonce)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	ready, owner := make(chan string, 1), make(chan error, 1)
	go func() { owner <- control.Serve(ctx, s.Token, func(endpoint string) { ready <- endpoint }) }()
	select {
	case s.Endpoint = <-ready:
	case <-owner:
		return errors.New("demo owner unavailable")
	case <-time.After(5 * time.Second):
		return errors.New("demo owner timed out")
	}

	var lock sync.Mutex
	step := 0
	valid := true
	complete := make(chan struct{}, 1)
	actions := []string{"state", "start", "state", "stop", "state"}
	running := []bool{false, true, true, false, false}
	// Replace only the page's initial call. The real page/strict bridge and
	// control client are used; there is no mock Origin injection on the host.
	script := `async function check(){for(const [a,v] of [['state',false],['start',true],['state',true],['stop',false],['state',false]]){const r=await fetch('/demo/'+a,{method:'POST'});if(!r.ok)throw Error('denied');const s=await r.json();if(s.Protocol!==1||s.Experimental!==true||s.ProxyImplemented!==false||s.DemoRunning!==v)throw Error('state')}await fetch('` + completionPath + `',{method:'POST'})}check().catch(()=>{document.getElementById('state').textContent='验收失败'})`
	probePage := strings.Replace(page, "call('state')</script>", script+"</script>", 1)
	bridge := desktopbridge.Handler(probePage, desktopOrigin(), func(c context.Context, action string) (control.State, error) {
		state, callErr := control.Call(c, s, action)
		lock.Lock()
		defer lock.Unlock()
		if callErr != nil || step >= len(actions) || action != actions[step] || state.DemoRunning != running[step] {
			valid = false
		} else {
			step++
		}
		return state, callErr
	})
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == completionPath {
			body, readErr := io.ReadAll(io.LimitReader(r.Body, 2))
			if r.Method != "POST" || r.Header.Get("Origin") != desktopOrigin() || r.URL.RawQuery != "" || r.URL.ForceQuery || r.URL.RawPath != "" || readErr != nil || len(body) != 0 {
				http.Error(w, "denied", 403)
				return
			}
			lock.Lock()
			passed := valid && step == len(actions)
			lock.Unlock()
			if !passed {
				http.Error(w, "sequence incomplete", 409)
				return
			}
			w.WriteHeader(204)
			select {
			case complete <- struct{}{}:
			default:
			}
			return
		}
		recorder := httptest.NewRecorder()
		bridge.ServeHTTP(recorder, r)
		if strings.HasPrefix(r.URL.Path, "/demo/") {
			classification := "other"
			if r.Header.Get("Origin") == "" {
				classification = "missing"
			}
			if r.Header.Get("Origin") == desktopOrigin() {
				classification = "expected"
			}
			method := "other"
			if r.Method == "POST" {
				method = "POST"
			}
			fmt.Printf("BRIDGE: origin=%s method=%s status=%d\n", classification, method, recorder.Code)
		}
		for name, values := range recorder.Header() {
			w.Header()[name] = values
		}
		w.WriteHeader(recorder.Code)
		_, _ = w.Write(recorder.Body.Bytes())
	})
	var lifecycle, shutdown, ownerStopped atomic.Bool
	var timedOut atomic.Bool
	app := application.New(application.Options{
		Name:    "MOMO native acceptance probe",
		Logger:  slog.New(slog.NewTextHandler(io.Discard, nil)),
		Assets:  application.AssetOptions{Handler: handler, DisableLogging: true},
		Windows: application.WindowsOptions{WebviewUserDataPath: profile, DisableQuitOnLastWindowClosed: true},
		PostShutdown: func() {
			shutdown.Store(true)
			// An already-exited owner must not be mistaken for cancellation.
			select {
			case <-owner:
				cancel()
				return
			default:
			}
			if _, e := control.Call(context.Background(), s, "state"); e != nil {
				cancel()
				return
			}
			cancel()
			select {
			case e := <-owner:
				ownerStopped.Store(e == nil)
			case <-time.After(5 * time.Second):
			}
		},
	})
	window := app.Window.NewWithOptions(application.WebviewWindowOptions{Title: "MOMO native acceptance — synthetic demo only", Width: 760, Height: 540, URL: "/"})
	closed := make(chan struct{}, 1)
	hideOnClose(window, func() {
		select {
		case closed <- struct{}{}:
		default:
		}
	})
	go func() {
		select {
		case <-complete:
			window.Close() // Framework API, NOT a human close-button click.
			select {
			case <-closed:
				if !window.IsVisible() {
					window.Show()
					state, e := control.Call(context.Background(), s, "state")
					lifecycle.Store(window.IsVisible() && e == nil && !state.DemoRunning)
				}
			case <-time.After(3 * time.Second):
			}
		case <-time.After(20 * time.Second):
			timedOut.Store(true)
		}
		app.Quit()
	}()
	err = app.Run()
	lock.Lock()
	sequence := valid && step == len(actions)
	lock.Unlock()
	pass := err == nil && sequence && lifecycle.Load() && shutdown.Load() && ownerStopped.Load() && !timedOut.Load()
	_ = json.NewEncoder(os.Stdout).Encode(map[string]bool{"NativeCheck": true, "Pass": pass, "Sequence": sequence, "FrameworkHideShow": lifecycle.Load(), "PostShutdown": shutdown.Load(), "OwnedDemoStopped": ownerStopped.Load(), "TimedOut": timedOut.Load()})
	if !pass {
		return errors.New("native acceptance incomplete")
	}
	return nil
}
