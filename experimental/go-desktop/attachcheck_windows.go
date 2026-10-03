//go:build attachcheck && !nativecheck && windows && !nogui

package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"sync/atomic"
	"time"

	"github.com/momo-api/momoapi-proxy/experimental/go-desktop/internal/control"
	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
)

// Separate test executable. Session arrives only by private stdin; the Node
// harness owns a DIFFERENT normal serve process. Never ship this binary.
func main() {
	if len(os.Args) != 2 || (os.Args[1] != "tray" && os.Args[1] != "auto" && os.Args[1] != "graceful" && os.Args[1] != "hold") {
		fmt.Fprintln(os.Stderr, "invalid attach probe mode")
		os.Exit(1)
	}
	s, err := control.ReadSession(os.Stdin)
	_ = os.Stdin.Close()
	if err != nil || s.Endpoint == "" {
		os.Exit(1)
	}
	profile, err := os.MkdirTemp("", "momo-attachcheck-")
	if err != nil {
		os.Exit(1)
	}
	fmt.Println("PROFILE: " + profile) // Retained synthetic profile, no deletion.
	loaded, second, navigated := make(chan struct{}, 1), make(chan struct{}, 1), make(chan struct{}, 1)
	var autoVisible, hidden, reopened, shutdown, timedOut atomic.Bool
	var trayPassed atomic.Bool
	var trayOpen, menuOpen, menuQuit atomic.Int32
	classBytes := make([]byte, 16)
	if _, err = rand.Read(classBytes); err != nil {
		os.Exit(1)
	}
	className := "MOMO.attachcheck." + hex.EncodeToString(classBytes)
	done := make(chan struct{})
	watchStopped := make(chan struct{})
	workerStopped := make(chan struct{})
	var deadline time.Time
	err = desktopConfigured(s, func(options *application.Options) {
		fmt.Println("ATTACH: configured")
		options.Windows.WebviewUserDataPath = profile
		// Random test-only class isolates message discovery to our exact process.
		options.Windows.WndClass = className
		options.Logger = slog.New(slog.NewTextHandler(io.Discard, nil))
		options.Assets.DisableLogging = true
		original := options.Assets.Handler
		options.Assets.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			recorder := httptest.NewRecorder()
			original.ServeHTTP(recorder, r)
			if r.URL.Path == "/" {
				fmt.Printf("ATTACH: root %d\n", recorder.Code)
			}
			if r.URL.Path == "/demo/state" && r.Method == "POST" && r.Header.Get("Origin") == desktopOrigin() && recorder.Code == 200 {
				var state control.State
				if json.Unmarshal(recorder.Body.Bytes(), &state) == nil && state.Protocol == 1 && state.Experimental && !state.ProxyImplemented {
					fmt.Println("ATTACH: loaded")
					select {
					case loaded <- struct{}{}:
					default:
					}
				}
			}
			for name, values := range recorder.Header() {
				w.Header()[name] = values
			}
			w.WriteHeader(recorder.Code)
			_, _ = w.Write(recorder.Body.Bytes())
		})
		options.SingleInstance.ExitCode = 23
		show := options.SingleInstance.OnSecondInstanceLaunch
		options.SingleInstance.OnSecondInstanceLaunch = func(data application.SecondInstanceData) {
			show(data) // Shared normal callback ignores data completely.
			select {
			case second <- struct{}{}:
			default:
			}
		}
		options.PostShutdown = func() { shutdown.Store(true); fmt.Println("ATTACH: shutdown") }
	}, func(app *application.App, window *application.WebviewWindow) {
		deadline = time.Now().Add(25 * time.Second)
		fmt.Println("ATTACH: created")
		window.OnWindowEvent(events.Windows.WebViewNavigationCompleted, func(*application.WindowEvent) {
			select {
			case navigated <- struct{}{}:
			default:
			}
		})
		go func() {
			defer close(watchStopped)
			select {
			case <-time.After(25 * time.Second):
				timedOut.Store(true)
				app.Quit()
			case <-done:
			}
		}()
		go func() {
			defer close(workerStopped)
			select {
			case <-loaded:
			case <-done:
				return
			}
			select {
			case <-navigated:
			case <-done:
				return
			}
			if os.Args[1] == "auto" {
				if !waitVisible(window, true) {
					fmt.Println("ATTACH: auto-visible-failed")
					return
				}
				autoVisible.Store(true)
				fmt.Println("ATTACH: auto-visible")
				app.Quit()
				return
			}
			if !waitVisible(window, true) {
				fmt.Println("ATTACH: visible-failed")
				return
			}
			fmt.Println("ATTACH: visible")
			window.Close() // Actual shared hook; not a human titlebar click.
			fmt.Println("ATTACH: close-returned")
			if !waitVisible(window, false) {
				return
			}
			hidden.Store(true)
			fmt.Println("ATTACH: hidden")
			if os.Args[1] == "tray" {
				if trayNativeCheck(window, className) {
					trayPassed.Store(true)
				}
				return // Successful quit must come from the actual tray menu callback.
			}
			select {
			case <-second:
			case <-done:
				return
			}
			if !waitVisible(window, true) {
				return
			}
			if _, e := control.Call(context.Background(), s, "state"); e != nil {
				return
			}
			reopened.Store(true)
			fmt.Println("ATTACH: reopened")
			if os.Args[1] == "graceful" {
				app.Quit()
			} else {
				fmt.Println("ATTACH: holding")
			}
		}()
	}, func(action string) {
		switch action {
		case "tray-open":
			trayOpen.Add(1)
		case "menu-open":
			menuOpen.Add(1)
		case "menu-quit":
			menuQuit.Add(1)
		}
	})
	close(done)
	// Join watchdog before reading its result; wall-clock deadline also prevents
	// a delayed timer goroutine from falsely passing at the timeout boundary.
	joined := false
	workerJoined := false
	if !deadline.IsZero() {
		select {
		case <-watchStopped:
			joined = true
		case <-time.After(3 * time.Second):
		}
		select {
		case <-workerStopped:
			workerJoined = true
		case <-time.After(3 * time.Second):
		}
	}
	passedLifecycle := hidden.Load() && reopened.Load()
	if os.Args[1] == "auto" {
		passedLifecycle = autoVisible.Load()
	}
	if os.Args[1] == "tray" {
		passedLifecycle = hidden.Load() && trayPassed.Load() && trayOpen.Load() == 1 && menuOpen.Load() == 1 && menuQuit.Load() == 1
	}
	passed := err == nil && joined && workerJoined && time.Now().Before(deadline) && passedLifecycle && shutdown.Load() && !timedOut.Load()
	if !passed {
		fmt.Fprintln(os.Stderr, "attach evidence incomplete")
		os.Exit(1)
	}
	fmt.Println("ATTACH: passed")
}

func waitVisible(window *application.WebviewWindow, visible bool) bool {
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if window.IsVisible() == visible {
			return true
		}
		time.Sleep(20 * time.Millisecond)
	}
	return false
}
