//go:build appcheck && !nogui

package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"runtime"
	"strings"
	"sync/atomic"
	"time"

	"github.com/momo-api/momoapi-proxy/experimental/go-app/internal/appcore"
	"github.com/momo-api/momoapi-proxy/experimental/go-app/internal/ui"
	"github.com/wailsapp/wails/v3/pkg/application"
)

const probeKey = "synthetic-appcheck-only"
const responsesRequest = `{"model":"mock","stream":true,"tools":[{"type":"namespace","name":"pad","tools":[{"type":"custom","name":"write"}]}],"input":"中文🙂","unknown_provider_field":true}`
const chatRequest = `{"model":"mock","stream":true,"messages":[{"role":"user","content":"中文🙂"}],"provider_extra":{"namespace":"pad"}}`
const responsesStream = "event: response.output_item.added\ndata: {\"item\":{\"namespace\":\"pad\",\"input\":\"中文🙂\"},\"unknown_provider_field\":true}\r\n\r\nevent: response.completed\ndata: {\"response\":{\"output\":[{\"namespace\":\"pad\"}]}}\n\n"
const chatStream = "data: {\"choices\":[{\"delta\":{\"content\":\"中文🙂\"}}],\"provider_extra\":true}\r\n\r\ndata: [DONE]\n\n"
const modelsResponse = `{"data":[{"id":"mock"}]}`
const routedProbeRequest = `{"model":"gpt-5.5","stream":true,"input":[{"role":"user","content":"hi"}]}`
const routedProbeBody = `{"messages":[{"content":"hi","role":"user"}],"model":"gpt-5.5","stream":true}`

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
	var passed, proxied atomic.Bool
	appReady := make(chan struct{})
	workerDone := make(chan struct{})
	go func() {
		defer close(workerDone)
		<-appReady
		select {
		case <-completed:
		case <-time.After(25 * time.Second):
		}
		application.Get().Quit()
	}()
	err = desktopConfigured(func(options *application.Options, core *appcore.Core) {
		options.Windows.WebviewUserDataPath = profile
		origin := "wails://localhost"
		if runtime.GOOS == "windows" {
			origin = "http://wails.localhost"
		}
		var upstreamRequests, savedProfiles, loadedProfiles, quotaQueries, skillCopies, mcpCopies atomic.Int32
		var stalled []net.Conn
		var savedProfile appcore.Config
		closeMock := appcore.InstallProbeMock(core, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			data, _ := io.ReadAll(io.LimitReader(r.Body, appcore.MaxRequest+1))
			if r.Header.Get("Authorization") != "Bearer "+probeKey || r.Header.Get("Cookie") != "" || r.Header.Get("Origin") != "" {
				w.WriteHeader(400)
				return
			}
			var body string
			switch r.URL.Path {
			case "/api/usage/token/":
				if r.Method != "GET" || len(data) != 0 {
					w.WriteHeader(400)
					return
				}
				quotaQueries.Add(1)
				w.Header().Set("Content-Type", "application/json")
				_, _ = io.WriteString(w, `{"code":true,"data":{"object":"token_usage","total_available":12345,"total_used":55,"total_granted":12400,"unlimited_quota":false,"expires_at":0,"name":"private-do-not-render"}}`)
				return
			case "/v1/models":
				if r.Method != "GET" || len(data) != 0 {
					w.WriteHeader(400)
					return
				}
				w.Header().Set("Content-Type", "application/json")
				body = modelsResponse
			case "/v1/responses":
				if r.Method != "POST" || string(data) != responsesRequest {
					w.WriteHeader(400)
					return
				}
				w.Header().Set("Content-Type", "text/event-stream")
				body = responsesStream
			case "/v1/chat/completions":
				if string(data) == routedProbeBody && r.Method == "POST" {
					upstreamRequests.Add(1)
					w.Header().Set("Content-Type", "text/event-stream")
					io.WriteString(w, "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"routed-ok\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n")
					return
				}
				if r.Method != "POST" || string(data) != chatRequest {
					w.WriteHeader(400)
					return
				}
				w.Header().Set("Content-Type", "text/event-stream")
				body = chatStream
			default:
				w.WriteHeader(404)
				return
			}
			upstreamRequests.Add(1)
			for _, b := range []byte(body) {
				_, _ = w.Write([]byte{b})
				w.(http.Flusher).Flush()
			}
		}))
		options.PostShutdown = func() {
			for _, conn := range stalled {
				_ = conn.Close()
			}
			s := core.State()
			conn, dialErr := net.DialTimeout("tcp", strings.TrimPrefix(s.LocalEndpoint, "http://"), time.Second)
			if conn != nil {
				_ = conn.Close()
			}
			closeMock()
			if !passed.Load() || !proxied.Load() || savedProfiles.Load() != 1 || loadedProfiles.Load() != 1 || upstreamRequests.Load() != 4 || quotaQueries.Load() != 1 || skillCopies.Load() != 1 || mcpCopies.Load() != 1 || s.Running || s.Configured || s.Active != 0 || dialErr == nil {
				fmt.Println("FAIL native E2E/shutdown")
				os.Exit(1)
			}
			fmt.Println("PASS real WebView DOM buttons + native Stop polling + local TCP + TLS mock Responses/Chat/models + stalled upload Stop + owned shutdown")
			os.Exit(0) // test-only: macOS Run does not necessarily return
		}
		original := ui.HandlerWithActions(origin, core, ui.Actions{
			AllowOpaqueOrigin: runtime.GOOS != "windows",
			SaveProfile:       func(c appcore.Config) error { savedProfile = c; savedProfiles.Add(1); return nil },
			LoadProfile:       func() (appcore.Config, error) { loadedProfiles.Add(1); return savedProfile, nil },
			CopySkill:         func() error { skillCopies.Add(1); return nil },
			CopyMCPConfig:     func() error { mcpCopies.Add(1); return nil },
		})
		close(appReady)
		options.Assets.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path == "/" {
				recorder := httptest.NewRecorder()
				original.ServeHTTP(recorder, r)
				if recorder.Code != 200 {
					w.WriteHeader(recorder.Code)
					return
				}
				page := strings.Replace(recorder.Body.String(), "</script>", pageProbeScript+"</script>", 1)
				w.Header().Set("Content-Type", "text/html; charset=utf-8")
				_, _ = io.WriteString(w, page)
				return
			}
			if r.URL.Path == "/check-proxy" || r.URL.Path == "/check-stall" || r.URL.Path == "/check-native-stop" || r.URL.Path == "/check-done" || r.URL.Path == "/check-routing" {
				validation := r.Clone(r.Context())
				validation.URL.Path = "/app/state"
				auth := httptest.NewRecorder()
				original.ServeHTTP(auth, validation)
				if auth.Code != 200 {
					http.Error(w, "denied", 403)
					return
				}
				if r.URL.Path == "/check-proxy" {
					if !core.State().Running || probeLocalRequests(core) != nil {
						http.Error(w, "probe failed", 500)
						return
					}
					proxied.Store(true)
					fmt.Println("PROXY: exact Responses/Chat SSE + models over authenticated local TCP and TLS mock")
				} else if r.URL.Path == "/check-routing" {
					if core.State().Mode != "momo-routing" || probeRoutedRequest(core) != nil {
						http.Error(w, "route check failed", 500)
						return
					}
				} else if r.URL.Path == "/check-native-stop" {
					core.Stop() // same native operation used by tray; page polling must notice it
				} else if r.URL.Path == "/check-stall" {
					var err error
					stalled, err = probeStalledUploads(core)
					if err != nil {
						http.Error(w, "upload probe failed", 500)
						return
					}
				} else {
					deadline := time.Now().Add(time.Second)
					for core.State().Active != 0 && time.Now().Before(deadline) {
						time.Sleep(5 * time.Millisecond)
					}
					s := core.State()
					if !proxied.Load() || !s.Configured || s.Running || s.Active != 0 || probeStopped(core) != nil {
						http.Error(w, "probe stop failed", 500)
						return
					}
					passed.Store(true)
					select {
					case completed <- struct{}{}:
					default:
					}
				}
				w.WriteHeader(204)
				return
			}
			recorder := httptest.NewRecorder()
			original.ServeHTTP(recorder, r)
			if strings.HasPrefix(r.URL.Path, "/app/") {
				fmt.Printf("BRIDGE: status=%d\n", recorder.Code)
			}
			for k, v := range recorder.Header() {
				w.Header()[k] = v
			}
			w.WriteHeader(recorder.Code)
			_, _ = w.Write(recorder.Body.Bytes())
		})
	})
	<-workerDone
	if err != nil || !passed.Load() {
		return errors.New("native sequence")
	}
	return nil
}

func probeStalledUploads(core *appcore.Core) ([]net.Conn, error) {
	base, key, err := probeCredentials(core)
	if err != nil {
		return nil, err
	}
	var conns []net.Conn
	for _, framing := range []string{"Content-Length: 100", "Transfer-Encoding: chunked"} {
		conn, err := net.DialTimeout("tcp", strings.TrimSuffix(strings.TrimPrefix(base, "http://"), "/v1"), time.Second)
		if err != nil {
			return conns, errors.New("upload connection failed")
		}
		conns = append(conns, conn)
		_ = conn.SetWriteDeadline(time.Now().Add(time.Second))
		prefix := ""
		if strings.HasPrefix(framing, "Transfer-Encoding") {
			prefix = "64\r\n"
		}
		_, err = fmt.Fprintf(conn, "POST /v1/responses HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer %s\r\nContent-Type: application/json\r\n%s\r\n\r\n%s{", key, framing, prefix)
		if err != nil {
			return conns, errors.New("upload write failed")
		}
	}
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if core.State().Active == len(conns) {
			return conns, nil
		}
		time.Sleep(5 * time.Millisecond)
	}
	return conns, errors.New("upload admission failed")
}

func probeCredentials(core *appcore.Core) (string, string, error) {
	var c struct {
		URL string `json:"base_url"`
		Key string `json:"api_key"`
	}
	if json.Unmarshal([]byte(core.ConnectionJSON()), &c) != nil || c.URL == "" || c.Key == "" {
		return "", "", errors.New("connection")
	}
	return c.URL, c.Key, nil
}
func probeLocalRequests(core *appcore.Core) error {
	base, key, err := probeCredentials(core)
	if err != nil {
		return err
	}
	client := &http.Client{Timeout: 4 * time.Second}
	defer client.CloseIdleConnections()
	for _, tc := range []struct{ path, method, body, want string }{
		{"/models", "GET", "", modelsResponse}, {"/responses", "POST", responsesRequest, responsesStream}, {"/chat/completions", "POST", chatRequest, chatStream},
	} {
		r, _ := http.NewRequest(tc.method, base+tc.path, strings.NewReader(tc.body))
		r.Header.Set("Authorization", "Bearer "+key)
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Cookie", "synthetic-client-cookie")
		response, err := client.Do(r)
		if err != nil {
			return errors.New("local proxy request")
		}
		data, readErr := io.ReadAll(io.LimitReader(response.Body, 65537))
		_ = response.Body.Close()
		if readErr != nil || response.StatusCode != 200 || string(data) != tc.want {
			return errors.New("proxy bytes mismatch")
		}
	}
	return nil
}

func probeRoutedRequest(core *appcore.Core) error {
	base, key, err := probeCredentials(core)
	if err != nil {
		return err
	}
	req, _ := http.NewRequest("POST", base+"/responses", strings.NewReader(routedProbeRequest))
	req.Header.Set("Authorization", "Bearer "+key)
	req.Header.Set("Content-Type", "application/json")
	client := http.Client{Timeout: 4 * time.Second}
	defer client.CloseIdleConnections()
	response, err := client.Do(req)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	data, err := io.ReadAll(response.Body)
	if err != nil || response.StatusCode != 200 || !strings.Contains(string(data), "response.completed") || !strings.Contains(string(data), "routed-ok") {
		return errors.New("routed result")
	}
	return nil
}
func probeStopped(core *appcore.Core) error {
	base, key, err := probeCredentials(core)
	if err != nil {
		return err
	}
	r, _ := http.NewRequest("GET", base+"/models", nil)
	r.Header.Set("Authorization", "Bearer "+key)
	client := &http.Client{Timeout: time.Second}
	defer client.CloseIdleConnections()
	response, err := client.Do(r)
	if err != nil {
		return errors.New("stopped listener")
	}
	_ = response.Body.Close()
	if response.StatusCode != 503 {
		return errors.New("stop ineffective")
	}
	return nil
}
