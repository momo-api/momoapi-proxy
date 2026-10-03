package control

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

var demoToken = strings.Repeat("01234567"+"89abcdef", 4) // Synthetic fixture, not a credential.

func TestSessionValidation(t *testing.T) {
	for _, input := range []string{`{}`, `{"Token":"bad"}`, `{"Token":"` + demoToken + `","Endpoint":"https://127.0.0.1:80"}`, `{"Token":"` + demoToken + `","Endpoint":"http://example.com:80"}`, `{"Token":"` + demoToken + `","Endpoint":"http://127.0.0.1:80/?secret=1"}`, `{"Token":"` + demoToken + `","Extra":true}`, `{"Token":"` + demoToken + `"} {}`} {
		if _, err := ReadSession(strings.NewReader(input)); err == nil {
			t.Fatal("accepted invalid session")
		}
	}
	if _, err := ReadSession(strings.NewReader(`{"Token":"` + demoToken + `"}`)); err != nil {
		t.Fatal(err)
	}
}
func TestControlBoundary(t *testing.T) {
	for _, tc := range []struct {
		method, path, auth, origin, body string
		code                             int
	}{
		{"GET", "/control/v1/state", "", "", "", 401},
		{"GET", "/control/v1/state", "Bearer wrong", "", "", 401},
		{"GET", "/control/v1/state", "Bearer " + demoToken, "https://evil.example", "", 403},
		{"GET", "/v1/responses", "Bearer " + demoToken, "", "", 404},
		{"POST", "/control/v1/state", "Bearer " + demoToken, "", "", 405},
		{"POST", "/control/v1/demo/start", "Bearer " + demoToken, "", strings.Repeat("x", 8192), 400},
		{"GET", "/control/v1/state?x=1", "Bearer " + demoToken, "", "", 400},
	} {
		r := httptest.NewRequest(tc.method, tc.path, strings.NewReader(tc.body))
		r.Header.Set("Authorization", tc.auth)
		r.Header.Set("Origin", tc.origin)
		w := httptest.NewRecorder()
		Handler(demoToken).ServeHTTP(w, r)
		if w.Code != tc.code {
			t.Fatalf("%s: %d", tc.path, w.Code)
		}
		if strings.Contains(w.Body.String(), demoToken) || w.Header().Get("Access-Control-Allow-Origin") != "" {
			t.Fatal("secret or CORS leak")
		}
	}
}
func TestDemoRoundtripAndNoSecret(t *testing.T) {
	server := httptest.NewServer(Handler(demoToken))
	defer server.Close()
	s := Session{server.URL, demoToken}
	for _, step := range []struct {
		action  string
		running bool
	}{{"state", false}, {"start", true}, {"state", true}, {"stop", false}} {
		state, err := Call(context.Background(), s, step.action)
		if err != nil || state.DemoRunning != step.running || state.ProxyImplemented {
			t.Fatalf("action %s: %v %v", step.action, state, err)
		}
		b, _ := json.Marshal(state)
		if strings.Contains(string(b), demoToken) {
			t.Fatal("secret exposed")
		}
	}
}
func TestNoRedirectAndProtocolMismatch(t *testing.T) {
	for _, handler := range []http.HandlerFunc{func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, "http://example.com", 302) }, func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, `{"Protocol":99}`) }} {
		server := httptest.NewServer(handler)
		_, err := Call(context.Background(), Session{server.URL, demoToken}, "state")
		server.Close()
		if err == nil {
			t.Fatal("accepted redirect or incompatible server")
		}
	}
}
func TestCancellationStopsOwnedListener(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	ready := make(chan string, 1)
	done := make(chan error, 1)
	go func() { done <- Serve(ctx, demoToken, func(endpoint string) { ready <- endpoint }) }()
	endpoint := <-ready
	if _, err := Call(context.Background(), Session{endpoint, demoToken}, "state"); err != nil {
		t.Fatal(err)
	}
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("shutdown timeout")
	}
}

func TestSessionCannotHideOversizedTrailingInput(t *testing.T) {
	input := `{"Token":"` + demoToken + `"}` + strings.Repeat(" ", 5000)
	if _, err := ReadSession(strings.NewReader(input)); err == nil {
		t.Fatal("accepted oversized whitespace")
	}
	for _, endpoint := range []string{"http://127.0.0.1:0", "http://127.0.0.1:65536", "http://127.0.0.1:80?"} {
		b, _ := json.Marshal(Session{endpoint, demoToken})
		if _, err := ReadSession(strings.NewReader(string(b))); err == nil {
			t.Fatal("accepted invalid endpoint")
		}
	}
}

func TestResponseContractStrictness(t *testing.T) {
	valid := `{"Protocol":1,"Experimental":true,"ProxyImplemented":false,"DemoRunning":false}`
	for _, tc := range []struct{ body, kind string }{
		{valid + " {}", "application/json"},
		{valid + strings.Repeat(" ", 5000), "application/json"},
		{valid, "text/plain"},
		{`{"Protocol":1,"Experimental":true}`, "application/json"},
		{valid[:len(valid)-1] + `,"Protocol":1}`, "application/json"},
		{valid[:len(valid)-1] + `,"Extra":true}`, "application/json"},
		{`{"Protocol":99,"Experimental":true}`, "application/json"},
	} {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", tc.kind)
			_, _ = io.WriteString(w, tc.body)
		}))
		_, err := Call(context.Background(), Session{server.URL, demoToken}, "state")
		server.Close()
		if err == nil {
			t.Fatal("accepted invalid response contract")
		}
	}
}

func TestBrowserHeadersAndEmptyQueryDenied(t *testing.T) {
	for _, tc := range []struct{ path, header, value, body string }{
		{"/control/v1/state", "Origin", "null", ""},
		{"/control/v1/state", "Sec-Fetch-Site", "same-origin", ""},
		{"/control/v1/state", "Sec-Fetch-Mode", "navigate", ""},
		{"/control/v1/state?", "", "", ""},
		{"/control/v1/state", "", "", "x"},
	} {
		req := httptest.NewRequest("GET", tc.path, strings.NewReader(tc.body))
		req.Header.Set("Authorization", "Bearer "+demoToken)
		if tc.header != "" {
			req.Header.Set(tc.header, tc.value)
		}
		w := httptest.NewRecorder()
		Handler(demoToken).ServeHTTP(w, req)
		if w.Code < 400 {
			t.Fatal("accepted browser/query/body input")
		}
	}
}
