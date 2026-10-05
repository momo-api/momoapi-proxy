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
	"github.com/momo-api/momoapi-proxy/experimental/go-app/internal/integration"
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
const routedProbeBody = `{"messages":[{"content":"hi","role":"user"}],"model":"gpt-5.5","stream":true,"stream_options":{"include_usage":true}}`
const claudeProbeRequest = `{"model":"claude-sonnet-4-6","stream":true,"input":[{"role":"user","content":"hi"}]}`
const claudeProbeBody = `{"max_tokens":12240,"messages":[{"content":[{"text":"hi","type":"text"}],"role":"user"}],"model":"claude-sonnet-4-6","stream":true}`
const geminiProbeRequest = `{"model":"gemini-2.5-flash","stream":true,"input":[{"role":"user","content":"hi"}]}`
const geminiProbeBody = `{"contents":[{"parts":[{"text":"hi"}],"role":"user"}]}`
const geminiProbeStream = `data: {"candidates":[{"index":0,"content":{"role":"model","parts":[{"text":"gemini-ok"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":5,"totalTokenCount":8}}

`
const claudeProbeStream = `data: {"type":"message_start","message":{"type":"message","role":"assistant","content":[],"stop_reason":null,"usage":{"input_tokens":3,"output_tokens":1}}}

data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":"claude-ok"}}

data: {"type":"content_block_stop","index":0}

data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":5}}

data: {"type":"message_stop"}

`

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
	var latestStep atomic.Value
	latestStep.Store("initial")
	appReady := make(chan struct{})
	pageReady := make(chan struct{}, 1)
	workerDone := make(chan struct{})
	go func() {
		defer close(workerDone)
		<-appReady
		overall := make(chan struct{})
		startup := make(chan struct{})
		overallTimer := time.AfterFunc(40*time.Second, func() { close(overall) })
		startupTimer := time.AfterFunc(25*time.Second, func() { close(startup) })
		defer overallTimer.Stop()
		defer startupTimer.Stop()
		result := awaitProbeStartup(pageReady, completed, startup, overall)
		if result == "ready" {
			startupTimer.Stop()
			actions := make(chan struct{})
			actionsTimer := time.AfterFunc(25*time.Second, func() { close(actions) })
			result = awaitProbeActions(completed, actions, overall)
			actionsTimer.Stop()
		}
		if result != "completed" {
			fmt.Println("FAIL WebView watchdog phase:", result, "stage:", latestStep.Load())
		}
		application.Get().Quit()
	}()
	err = desktopConfigured(func(options *application.Options, core *appcore.Core) {
		options.Windows.WebviewUserDataPath = profile
		origin := "wails://localhost"
		if runtime.GOOS == "windows" {
			origin = "http://wails.localhost"
		}
		var upstreamRequests, savedProfiles, loadedProfiles, quotaQueries, skillCopies, mcpCopies, codexCopies, imageMCPCopies, videoMCPCopies atomic.Int32
		var codexCatalogCopies atomic.Int32
		var stalled []net.Conn
		var savedProfile appcore.Config
		closeMock := appcore.InstallProbeMock(core, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			data, _ := io.ReadAll(io.LimitReader(r.Body, appcore.MaxRequest+1))
			if r.Header.Get("Authorization") != "Bearer "+probeKey || r.Header.Get("Cookie") != "" || r.Header.Get("Origin") != "" {
				w.WriteHeader(400)
				return
			}
			if probeNativeCompactUpstream(w, r, data) {
				upstreamRequests.Add(1)
				return
			}
			if probeProviderReplayUpstream(w, r, data) {
				upstreamRequests.Add(1)
				return
			}
			if probeToolAliasUpstream(w, r, data) {
				upstreamRequests.Add(1)
				return
			}
			if probeParallelUpstream(w, r, data) {
				upstreamRequests.Add(1)
				return
			}
			if probeStrictUpstream(w, r, data) {
				upstreamRequests.Add(1)
				return
			}
			if probeParallelClientUpstream(w, r, data) {
				upstreamRequests.Add(1)
				return
			}
			// The explicit UI model query runs before Start and retains its exact
			// mock-only catalog fixture; video catalog is queried while running.
			if core.State().Running && probeVideoUpstream(w, r, data) {
				upstreamRequests.Add(1)
				return
			}
			if probeMediaUpstream(w, r, data) {
				upstreamRequests.Add(1)
				return
			}
			if probeSearchUpstream(w, r, data) {
				upstreamRequests.Add(1)
				return
			}
			if probeDSMLUpstream(w, r, data) {
				upstreamRequests.Add(1)
				return
			}
			if probeImageUpstream(w, r, data) {
				upstreamRequests.Add(1)
				return
			}
			if probeToolImageUpstream(w, r, data) {
				upstreamRequests.Add(1)
				return
			}
			if probeFileUpstream(w, r, data) {
				upstreamRequests.Add(1)
				return
			}
			if probeCustomUpstream(w, r, data) {
				upstreamRequests.Add(1)
				return
			}
			if probeAllowedUpstream(w, r, data) {
				upstreamRequests.Add(1)
				return
			}
			if probeLimitsUpstream(w, r, data) {
				upstreamRequests.Add(1)
				return
			}
			if probeNamedUpstream(w, r, data) {
				upstreamRequests.Add(1)
				return
			}
			if probeHistoryUpstream(w, r, data) {
				upstreamRequests.Add(1)
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
					io.WriteString(w, "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"routed-ok\"},\"finish_reason\":\"stop\"}]}\n\ndata: {\"choices\":[],\"usage\":{\"prompt_tokens\":3,\"completion_tokens\":5,\"total_tokens\":8,\"prompt_tokens_details\":{\"cached_tokens\":2},\"completion_tokens_details\":{\"reasoning_tokens\":1}}}\n\ndata: [DONE]\n\n")
					return
				}
				if r.Method != "POST" || string(data) != chatRequest {
					w.WriteHeader(400)
					return
				}
				w.Header().Set("Content-Type", "text/event-stream")
				body = chatStream
			case "/v1/messages":
				if r.Method != "POST" || string(data) != claudeProbeBody || r.Header.Get("anthropic-version") != "2023-06-01" {
					w.WriteHeader(400)
					return
				}
				w.Header().Set("Content-Type", "text/event-stream")
				body = claudeProbeStream
			case "/v1beta/models/gemini-2.5-flash:streamGenerateContent":
				if r.Method != "POST" || string(data) != geminiProbeBody || r.URL.RawQuery != "alt=sse" {
					w.WriteHeader(400)
					return
				}
				w.Header().Set("Content-Type", "text/event-stream")
				body = geminiProbeStream
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
			if !passed.Load() || !proxied.Load() || savedProfiles.Load() != 1 || loadedProfiles.Load() != 1 || upstreamRequests.Load() != 173 || quotaQueries.Load() != 1 || skillCopies.Load() != 1 || mcpCopies.Load() != 1 || codexCopies.Load() != 1 || codexCatalogCopies.Load() != 1 || imageMCPCopies.Load() != 1 || videoMCPCopies.Load() != 1 || s.Running || s.Configured || s.Active != 0 || dialErr == nil {
				fmt.Println("FAIL native E2E/shutdown")
				os.Exit(1)
			}
			fmt.Println("PASS real WebView DOM buttons + native Stop polling + local TCP + TLS mock Responses/Chat/Claude/Gemini/models + routed SSE/JSON/omitted stream/usage/named and allowed tools/raw exec/apply_patch/client search/ordered user and paired tool images/PDF/registered memory snapshots/history/output limits/incomplete/local and explicit native compact (173 upstream requests; explicit converted provider replay and bounded long tool aliases/history and explicit single-tool constraint and ordinary nullable strict arguments and completed search lifecycle checkpoint/replay/paired second turn; desktop video catalog/explicit controls/confirmed generation/manual task/URL text/Stop clear + desktop image catalog/generation/task/explicit inline preview + image/video API subsets + opt-in direct and connected image/video MCP catalog/generation/task streams) + stalled upload Stop + owned shutdown")
			os.Exit(0) // test-only: macOS Run does not necessarily return
		}
		original := ui.HandlerWithActions(origin, core, ui.Actions{
			AllowOpaqueOrigin: runtime.GOOS != "windows",
			SaveProfile:       func(c appcore.Config) error { savedProfile = c; savedProfiles.Add(1); return nil },
			LoadProfile:       func() (appcore.Config, error) { loadedProfiles.Add(1); return savedProfile, nil },
			CopySkill:         func() error { skillCopies.Add(1); return nil },
			CopyMCPConfig:     func() error { mcpCopies.Add(1); return nil },
			CopyImageMCPConfig: func() error {
				text, err := integration.ImageMCPConfig("preview", core.State().LocalEndpoint)
				if err != nil || !strings.Contains(text, "mcp-images-connect") || strings.Contains(text, "api_key") {
					return errors.New("image MCP export probe")
				}
				imageMCPCopies.Add(1)
				return nil
			},
			CopyVideoMCPConfig: func() error {
				text, err := integration.VideoMCPConfig("preview", core.State().LocalEndpoint)
				if err != nil || !strings.Contains(text, "mcp-videos-connect") || strings.Contains(text, "api_key") {
					return errors.New("video MCP export probe")
				}
				videoMCPCopies.Add(1)
				return nil
			},
			CopyCodexConfig: func() error {
				text, err := integration.CodexProviderConfig(core.State().LocalEndpoint)
				if err != nil || !strings.Contains(text, "env_key = \"MOMO_LOCAL_API_KEY\"") || strings.Contains(text, "synthetic-appcheck-only") {
					return errors.New("client export probe failed")
				}
				codexCopies.Add(1)
				return nil
			},
			CopyCodexCatalog: func() error {
				text, err := integration.CodexTextToolsCatalog("gpt-5.5")
				var catalog struct{ Models []struct{ Slug string } }
				if err != nil || json.Unmarshal([]byte(text), &catalog) != nil || len(catalog.Models) != 1 || catalog.Models[0].Slug != "gpt-5.5" || strings.Contains(text, "synthetic-appcheck-only") || strings.Contains(text, "api_key") {
					return errors.New("client catalog probe failed")
				}
				codexCatalogCopies.Add(1)
				return nil
			},
		})
		close(appReady)
		options.Assets.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			switch r.URL.Path {
			case "/app/videos/catalog", "/app/videos/generate", "/app/videos/task", "/app/images/catalog", "/app/images/generate", "/app/images/task", "/app/configure", "/app/load", "/app/start", "/app/stop", "/app/codex-config", "/app/codex-catalog", "/app/skill", "/app/mcp-config", "/app/image-mcp-config", "/app/video-mcp-config", "/app/quota", "/app/models", "/check-proxy", "/check-routing", "/check-stall", "/check-native-stop", "/check-done", "/check-page-failure":
				latestStep.Store(r.URL.Path)
			}
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
			if r.URL.Path == "/check-page-ready" || r.URL.Path == "/check-proxy" || r.URL.Path == "/check-stall" || r.URL.Path == "/check-native-stop" || r.URL.Path == "/check-done" || r.URL.Path == "/check-routing" || r.URL.Path == "/check-page-failure" {
				validation := r.Clone(r.Context())
				validation.URL.Path = "/app/state"
				auth := httptest.NewRecorder()
				original.ServeHTTP(auth, validation)
				if auth.Code != 200 {
					http.Error(w, "denied", 403)
					return
				}
				if r.URL.Path == "/check-page-ready" {
					latestStep.Store("page-ready")
					select {
					case pageReady <- struct{}{}:
					default:
					}
					w.WriteHeader(204)
					return
				}
				if r.URL.Path == "/check-page-failure" {
					step := r.URL.Query().Get("step")
					known := false
					for _, candidate := range []string{"initial", "nav-videos", "video-catalog", "video-generate", "video-task", "nav-images", "image-catalog", "image-generate", "image-task", "nav-routing", "nav-settings", "diagnostics-refresh", "diagnostics-clear", "nav-overview", "nav-integrations", "skill-copy", "mcp-copy", "image-mcp-copy", "video-mcp-copy", "codex-copy", "codex-catalog-copy", "configure", "load", "quota-refresh", "models-refresh", "start", "check-proxy", "check-native-stop", "check-routing", "check-stall", "stop", "check-done"} {
						if step == candidate {
							known = true
						}
					}
					if !known {
						step = "unknown"
					}
					fmt.Println("FAIL WebView page assertion step:", step) // fixed labels only; never state/key/error text
					select {
					case completed <- struct{}{}:
					default:
					}
					w.WriteHeader(204)
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
					routeErr := probeRoutedRequest(core)
					if core.State().Mode != "momo-routing" || routeErr != nil {
						fmt.Println("FAIL routing probe:", routeErr)
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
	client := http.Client{Timeout: 4 * time.Second}
	defer client.CloseIdleConnections()
	for _, tc := range []struct{ payload, text string }{{routedProbeRequest, "routed-ok"}, {claudeProbeRequest, "claude-ok"}, {geminiProbeRequest, "gemini-ok"}} {
		for _, payload := range []string{tc.payload, strings.Replace(tc.payload, `"stream":true`, `"stream":false`, 1), strings.Replace(tc.payload, `"stream":true,`, "", 1)} {
			req, _ := http.NewRequest("POST", base+"/responses", strings.NewReader(payload))
			req.Header.Set("Authorization", "Bearer "+key)
			req.Header.Set("Content-Type", "application/json")
			response, err := client.Do(req)
			if err != nil {
				return err
			}
			data, err := io.ReadAll(response.Body)
			_ = response.Body.Close()
			if err != nil || response.StatusCode != 200 || !strings.Contains(string(data), tc.text) {
				return errors.New("routed result")
			}
			if tc.payload == routedProbeRequest && (!strings.Contains(string(data), `"input_tokens":3`) || !strings.Contains(string(data), `"output_tokens":5`) || !strings.Contains(string(data), `"total_tokens":8`) || !strings.Contains(string(data), `"cached_tokens":2`) || !strings.Contains(string(data), `"reasoning_tokens":1`)) {
				return errors.New("routed Chat usage")
			}
			if payload == tc.payload {
				if !strings.HasPrefix(response.Header.Get("Content-Type"), "text/event-stream") || !strings.Contains(string(data), "response.completed") {
					return errors.New("routed SSE result")
				}
			} else {
				var final map[string]any
				if !strings.HasPrefix(response.Header.Get("Content-Type"), "application/json") || json.Unmarshal(data, &final) != nil || final["object"] != "response" || final["status"] != "completed" || strings.Contains(string(data), "response.completed") {
					return errors.New("routed JSON result")
				}
			}
		}
	}
	return probeNamedRequests(core)
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
