package appcore

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

const syntheticKey = "synthetic-test-only-upstream"

func testCore(t *testing.T, upstream http.Handler) (*Core, string, context.CancelFunc, <-chan error) {
	t.Helper()
	mock := httptest.NewTLSServer(upstream)
	t.Cleanup(mock.Close)
	core, err := New()
	if err != nil {
		t.Fatal(err)
	}
	// Test-only dependency injection, no insecure endpoint flag in the product.
	core.client = mock.Client()
	core.client.Timeout = 2 * time.Second
	if err := core.Configure(Config{Endpoint: "https://mock.example", APIKey: syntheticKey}); err != nil {
		t.Fatal(err)
	}
	original := core.client.Transport
	core.client.Transport = roundTripFunc(func(r *http.Request) (*http.Response, error) {
		mapped := r.Clone(r.Context())
		mapped.URL.Host = strings.TrimPrefix(mock.URL, "https://")
		return original.RoundTrip(mapped)
	})
	if err := core.Start(); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	ready := make(chan string, 1)
	done := make(chan error, 1)
	go func() { done <- core.Serve(ctx, func(endpoint string) { ready <- endpoint }) }()
	var endpoint string
	select {
	case endpoint = <-ready:
	case <-time.After(3 * time.Second):
		t.Fatal("server startup")
	}
	t.Cleanup(func() {
		cancel()
		select {
		case <-done:
		case <-time.After(4 * time.Second):
			t.Error("server shutdown")
		}
	})
	return core, endpoint, cancel, done
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func request(t *testing.T, c *Core, endpoint, path, method, body string, extra map[string]string) (int, []byte, http.Header) {
	t.Helper()
	r, err := http.NewRequest(method, endpoint+path, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	r.Header.Set("Authorization", "Bearer "+c.token)
	r.Header.Set("Content-Type", "application/json")
	for k, v := range extra {
		r.Header.Set(k, v)
	}
	client := http.Client{Timeout: 3 * time.Second}
	response, err := client.Do(r)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	data, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	return response.StatusCode, data, response.Header
}
func TestRealListenerResponsesNamespaceAndJSON(t *testing.T) {
	payload := `{"model":"mock","stream":true,"tools":[{"type":"namespace","name":"pad","tools":[{"type":"custom","name":"write"}]}],"input":"中文🙂"}`
	stream := "event: response.output_item.added\ndata: {\"type\":\"response.output_item.added\",\"item\":{\"type\":\"custom_tool_call\",\"namespace\":\"pad\",\"name\":\"write\",\"call_id\":\"call_same\",\"input\":\"中文🙂\"},\"unknown_provider_field\":true}\r\n\r\nevent: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"output\":[{\"namespace\":\"pad\"}]}}\n\n"
	core, endpoint, _, _ := testCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+syntheticKey {
			t.Error("wrong upstream auth")
		}
		if r.Header.Get("Origin") != "" || r.Header.Get("Cookie") != "" {
			t.Error("client header forwarded")
		}
		if r.URL.Path == "/v1/models" {
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{"data": []any{map[string]string{"id": "mock"}}})
			return
		}
		got, _ := io.ReadAll(r.Body)
		if string(got) != payload {
			t.Error("request bytes modified")
		}
		w.Header().Set("Content-Type", "text/event-stream")
		for _, b := range []byte(stream) {
			_, _ = w.Write([]byte{b})
			w.(http.Flusher).Flush()
		}
	}))
	code, data, headers := request(t, core, endpoint, "/v1/responses", "POST", payload, map[string]string{"Cookie": "must-not-forward"})
	if code != 200 || string(data) != stream || headers.Get("Access-Control-Allow-Origin") != "" {
		t.Fatal(code, string(data))
	}
	code, data, _ = request(t, core, endpoint, "/v1/models", "GET", "", nil)
	if code != 200 || !bytes.Contains(data, []byte("mock")) {
		t.Fatal(code, string(data))
	}
	state, _ := json.Marshal(core.State())
	if bytes.Contains(state, []byte(syntheticKey)) || bytes.Contains(state, []byte(core.token)) {
		t.Fatal("secret state")
	}
}
func TestBoundaryAndUpstreamRedaction(t *testing.T) {
	reached := 0
	core, endpoint, _, _ := testCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		reached++
		w.Header().Set("Set-Cookie", syntheticKey)
		w.WriteHeader(429)
		_, _ = io.WriteString(w, syntheticKey)
	}))
	for _, tc := range []struct {
		path, method, body string
		headers            map[string]string
		code               int
	}{
		{"/v1/models", "GET", "", map[string]string{"Authorization": ""}, 401},
		{"/v1/models", "GET", "", map[string]string{"Origin": "http://evil.example"}, 403},
		{"/v1/models", "GET", "", map[string]string{"Sec-Fetch-Site": "same-origin"}, 403},
		{"/v1/models?x=1", "GET", "", nil, 400},
		{"/v1/unsupported", "POST", "{}", nil, 404},
		{"/v1/responses", "GET", "", nil, 405},
		{"/v1/responses", "POST", "null", nil, 400},
		{"/v1/responses", "POST", "{}", nil, 400},
		{"/v1/responses", "POST", strings.Repeat("x", MaxRequest+1), nil, 413},
	} {
		code, data, _ := request(t, core, endpoint, tc.path, tc.method, tc.body, tc.headers)
		if code != tc.code || bytes.Contains(data, []byte(syntheticKey)) || bytes.Contains(data, []byte(core.token)) {
			t.Fatal(tc.path, code)
		}
	}
	if reached != 0 {
		t.Fatal("invalid request reached upstream")
	}
	code, data, h := request(t, core, endpoint, "/v1/models", "GET", "", nil)
	if code != 429 || bytes.Contains(data, []byte(syntheticKey)) || h.Get("Set-Cookie") != "" {
		t.Fatal("upstream leak")
	}
	core.Stop()
	code, _, _ = request(t, core, endpoint, "/v1/models", "GET", "", nil)
	if code != 503 {
		t.Fatal("stop ineffective")
	}
}
func TestConfigurePublicOnlyAndStopped(t *testing.T) {
	core, err := New()
	if err != nil {
		t.Fatal(err)
	}
	defer core.Close()
	for _, endpoint := range []string{"http://momoapi.us", "https://127.0.0.1", "https://10.0.0.1", "https://[::1]", "https://100.64.0.1", "https://momoapi.us/v1", "https://user@momoapi.us", "https://momoapi.us:444", "https://momoapi.us?", "https://momoapi.us#x"} {
		if core.Configure(Config{Endpoint: endpoint, APIKey: syntheticKey}) == nil {
			t.Fatal(endpoint)
		}
	}
	for _, ip := range []string{"127.0.0.1", "169.254.169.254", "10.1.1.1", "100.64.0.1", "198.18.1.1", "192.0.2.1", "::1", "fc00::1", "2001:db8::1", "::ffff:127.0.0.1"} {
		if publicIP(net.ParseIP(ip)) {
			t.Fatal(ip)
		}
	}
	if !publicIP(net.ParseIP("1.1.1.1")) {
		t.Fatal("public blocked")
	}
	if core.Start() == nil {
		t.Fatal("unconfigured started")
	}
	if core.Configure(Config{Endpoint: "https://momoapi.us", APIKey: syntheticKey}) != nil || core.Start() != nil {
		t.Fatal("config rejected")
	}
	if core.Configure(Config{Endpoint: "https://momoapi.us", APIKey: syntheticKey}) == nil {
		t.Fatal("live reconfigure")
	}
}
func TestStopCancelsOpenStreamAndOwnListener(t *testing.T) {
	started := make(chan struct{})
	cancelled := make(chan struct{})
	core, endpoint, cancel, _ := testCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, "data: {}\n\n")
		w.(http.Flusher).Flush()
		close(started)
		select {
		case <-r.Context().Done():
			close(cancelled)
		case <-time.After(3 * time.Second):
		}
	}))
	finished := make(chan struct{})
	go func() {
		defer close(finished)
		r, _ := http.NewRequest("POST", endpoint+"/v1/responses", strings.NewReader(`{"model":"mock","stream":true}`))
		r.Header.Set("Authorization", "Bearer "+core.token)
		r.Header.Set("Content-Type", "application/json")
		response, err := http.DefaultClient.Do(r)
		if err == nil {
			_, _ = io.Copy(io.Discard, response.Body)
			_ = response.Body.Close()
		}
	}()
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("stream startup")
	}
	core.Stop()
	select {
	case <-cancelled:
	case <-time.After(time.Second):
		t.Fatal("upstream not cancelled")
	}
	select {
	case <-finished:
	case <-time.After(time.Second):
		t.Fatal("client not finished")
	}
	cancel()
	time.Sleep(30 * time.Millisecond)
	client := http.Client{Timeout: time.Second}
	if res, err := client.Get(endpoint + "/v1/models"); err == nil {
		_ = res.Body.Close()
		t.Fatal("listener survived")
	}
}
func TestJSONAndOutputLimits(t *testing.T) {
	for _, tc := range []struct {
		body string
		code int
	}{{"{\"data\":[]}", 200}, {"not json", 502}, {strings.Repeat("x", MaxResponse+1), 502}} {
		t.Run(fmt.Sprint(tc.code, len(tc.body)), func(t *testing.T) {
			core, endpoint, _, _ := testCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				_, _ = io.WriteString(w, tc.body)
			}))
			code, _, _ := request(t, core, endpoint, "/v1/models", "GET", "", nil)
			if code != tc.code {
				t.Fatal(code)
			}
		})
	}
}

func TestStreamBudgetAbortsWithoutSyntheticEvent(t *testing.T) {
	core, endpoint, _, _ := testCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		chunk := bytes.Repeat([]byte("x"), 8192)
		for i := 0; i < MaxResponse/len(chunk)+2; i++ {
			if _, err := w.Write(chunk); err != nil {
				return
			}
			w.(http.Flusher).Flush()
		}
	}))
	r, _ := http.NewRequest("POST", endpoint+"/v1/responses", strings.NewReader("{\"model\":\"mock\",\"stream\":true}"))
	r.Header.Set("Authorization", "Bearer "+core.token)
	r.Header.Set("Content-Type", "application/json")
	client := http.Client{Timeout: 3 * time.Second}
	response, err := client.Do(r)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	data, err := io.ReadAll(response.Body)
	if err == nil || len(data) > MaxResponse || bytes.Contains(data, []byte("event: error")) {
		t.Fatal("clean truncation or synthetic SSE", len(data), err)
	}
}
