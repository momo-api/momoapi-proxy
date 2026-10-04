//go:build appcheck && !nogui

package main

import (
	"errors"
	"fmt"
	"github.com/momo-api/momoapi-proxy/experimental/go-app/internal/appcore"
	"github.com/momo-api/momoapi-proxy/experimental/go-app/internal/ui"
	"github.com/wailsapp/wails/v3/pkg/application"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"runtime"
	"strings"
	"sync/atomic"
	"time"
)

func main() {
	_ = os.Stdin.Close()
	if len(os.Args) != 1 || check() != nil {
		fmt.Fprintln(os.Stderr, "FAIL appcheck")
		os.Exit(1)
	}
}
func check() error {
	profile, err := os.MkdirTemp("", "momo-go-app-check-")
	if err != nil {
		return errors.New("profile")
	}
	fmt.Println("PROFILE: " + profile)
	completed := make(chan struct{}, 1)
	var passed atomic.Bool
	appReady := make(chan struct{})
	workerDone := make(chan struct{})
	go func() {
		defer close(workerDone)
		<-appReady
		select {
		case <-completed:
		case <-time.After(20 * time.Second):
		}
		application.Get().Quit()
	}()
	err = desktopConfigured(func(options *application.Options, core *appcore.Core) {
		options.Windows.WebviewUserDataPath = profile
		origin := "wails://localhost"
		if runtime.GOOS == "windows" {
			origin = "http://wails.localhost"
		}
		options.PostShutdown = func() {
			s := core.State()
			conn, dialErr := net.DialTimeout("tcp", strings.TrimPrefix(s.LocalEndpoint, "http://"), time.Second)
			if conn != nil {
				_ = conn.Close()
			}
			if !passed.Load() || s.Running || s.Configured || s.Active != 0 || dialErr == nil {
				fmt.Println("FAIL native shutdown")
				os.Exit(1)
			}
			fmt.Println("PASS real WebView bridge and owned-core shutdown")
			os.Exit(0) // macOS Run does not necessarily return; probe only.
		}
		original := ui.Handler(origin, core)
		close(appReady)
		script := `async function check(){for(const [name,body] of [['state',null],['configure',{Endpoint:'https://mock.example',APIKey:'synthetic-appcheck-only'}],['start',null],['state',null],['stop',null],['state',null]]){const r=await fetch('/app/'+name,{method:'POST',headers:body?{'content-type':'application/json'}:{},body:body?JSON.stringify(body):undefined});if(!r.ok)throw Error();const s=await r.json();if(s.Capability!=='responses-passthrough-only')throw Error();if(name==='start'&&!s.Running)throw Error();if(name==='stop'&&s.Running)throw Error()}await fetch('/check-done',{method:'POST'})}check().catch(()=>{})`
		page := strings.Replace(ui.Page, "action('state')</script>", script+"</script>", 1)
		options.Assets.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path == "/" {
				w.Header().Set("Content-Type", "text/html; charset=utf-8")
				_, _ = io.WriteString(w, page)
				return
			}
			if r.URL.Path == "/check-done" {
				if r.Method != "POST" || r.Header.Get("Origin") != origin {
					http.Error(w, "denied", 403)
					return
				}
				s := core.State()
				passed.Store(s.Configured && !s.Running && s.Active == 0)
				select {
				case completed <- struct{}{}:
				default:
				}
				w.WriteHeader(204)
				return
			}
			recorder := httptest.NewRecorder()
			original.ServeHTTP(recorder, r)
			if strings.HasPrefix(r.URL.Path, "/app/") {
				if r.Header.Get("Origin") == origin && recorder.Code == 200 {
					fmt.Println("BRIDGE: origin=expected status=200")
				} else {
					fmt.Println("BRIDGE: rejected")
				}
			}
			for k, v := range recorder.Header() {
				w.Header()[k] = v
			}
			w.WriteHeader(recorder.Code)
			_, _ = w.Write(recorder.Body.Bytes())
		})
	})
	// Quit is triggered by a test worker using the current framework app.
	<-workerDone
	if err != nil || !passed.Load() {
		return errors.New("native sequence")
	}
	return nil
}
