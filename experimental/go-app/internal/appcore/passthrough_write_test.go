package appcore

import (
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestPassthroughWriteFailuresAbort(t *testing.T) {
	for _, stream := range []bool{false, true} {
		for _, mode := range []string{"short", "error", "flush", "deadline", "ok"} {
			t.Run(fmt.Sprint(stream, "-", mode), func(t *testing.T) {
				c, _, _, _ := testCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					if stream {
						w.Header().Set("Content-Type", "text/event-stream")
						fmt.Fprint(w, "data: exact bytes\n\n")
					} else {
						w.Header().Set("Content-Type", "application/json")
						fmt.Fprint(w, `{"exact":"中文🙂","namespace":"pad"}`)
					}
				}))
				w := &jsonProbeWriter{header: make(http.Header), mode: mode}
				r := httptest.NewRequest("POST", "/v1/responses", strings.NewReader(fmt.Sprintf(`{"model":"mock","stream":%t}`, stream)))
				r.Header.Set("Authorization", "Bearer "+c.token)
				r.Header.Set("Content-Type", "application/json")
				var aborted any
				func() { defer func() { aborted = recover() }(); c.Handler().ServeHTTP(w, r) }()
				if mode == "ok" {
					if aborted != nil || w.writes != 1 {
						t.Fatal("successful passthrough changed")
					}
				} else if aborted != http.ErrAbortHandler {
					t.Fatal("failed downstream write ended cleanly")
				}
				if mode == "deadline" && w.writes != 0 {
					t.Fatal("write without deadline")
				}
				if w.writes > 1 {
					t.Fatal("replacement error appended")
				}
			})
		}
	}
}

func TestPassthroughStopAtJSONEOFDoesNotWrite(t *testing.T) {
	c, _ := New()
	defer c.Close()
	_ = c.Configure(Config{Endpoint: "https://mock.example", APIKey: syntheticKey})
	_ = c.Start()
	c.client.Transport = roundTripFunc(func(r *http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: &stopAtEOF{Reader: strings.NewReader(`{"exact":true}`), stop: c.Stop}}, nil
	})
	w := &jsonProbeWriter{header: make(http.Header), mode: "ok"}
	r := httptest.NewRequest("POST", "/v1/responses", strings.NewReader(`{"model":"mock","stream":false}`))
	r.Header.Set("Authorization", "Bearer "+c.token)
	r.Header.Set("Content-Type", "application/json")
	var aborted any
	func() { defer func() { aborted = recover() }(); c.Handler().ServeHTTP(w, r) }()
	if aborted != http.ErrAbortHandler || w.writes != 0 || c.State().Active != 0 {
		t.Fatal("cancelled passthrough wrote JSON")
	}
}

func TestPassthroughStopWithBufferedSSEDoesNotWrite(t *testing.T) {
	c, _ := New()
	defer c.Close()
	_ = c.Configure(Config{Endpoint: "https://mock.example", APIKey: syntheticKey})
	_ = c.Start()
	c.client.Transport = roundTripFunc(func(r *http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": []string{"text/event-stream"}}, Body: &stopOnRead{stop: c.Stop}}, nil
	})
	w := &jsonProbeWriter{header: make(http.Header), mode: "ok"}
	r := httptest.NewRequest("POST", "/v1/responses", strings.NewReader(`{"model":"mock","stream":true}`))
	r.Header.Set("Authorization", "Bearer "+c.token)
	r.Header.Set("Content-Type", "application/json")
	var aborted any
	func() { defer func() { aborted = recover() }(); c.Handler().ServeHTTP(w, r) }()
	if aborted != http.ErrAbortHandler || w.writes != 0 || c.State().Active != 0 {
		t.Fatal("cancelled buffered SSE written")
	}
}

type stopOnRead struct{ stop func() }

func (r *stopOnRead) Read(b []byte) (int, error) {
	r.stop()
	return copy(b, []byte("data: do not write\n\n")), io.EOF
}
func (r *stopOnRead) Close() error { return nil }

type stopAtEOF struct {
	io.Reader
	stop func()
}

func (r *stopAtEOF) Read(b []byte) (int, error) {
	n, err := r.Reader.Read(b)
	if err == io.EOF {
		r.stop()
	}
	return n, err
}
func (r *stopAtEOF) Close() error { return nil }
