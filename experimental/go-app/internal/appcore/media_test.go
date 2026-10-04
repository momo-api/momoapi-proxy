package appcore

import (
	"io"
	"net/http"
	"testing"
)

func TestExactMediaTypesAndBooleanStream(t *testing.T) {
	for _, path := range []string{"/v1/responses", "/v1/chat/completions"} {
		t.Run(path, func(t *testing.T) {
			core, endpoint, _, _ := testCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json; charset=utf-8")
				_, _ = io.WriteString(w, "{}")
			}))
			body := `{"model":"mock","messages":[{"role":"user","content":"test"}]}`
			for _, typ := range []string{"application/json-evil", "application/json; charset=", "text/plain", ""} {
				code, _, _ := request(t, core, endpoint, path, "POST", body, map[string]string{"Content-Type": typ})
				if code != 415 {
					t.Fatal("request media type", code)
				}
			}
			code, _, _ := request(t, core, endpoint, path, "POST", body, map[string]string{"Content-Type": "Application/JSON; charset=utf-8"})
			if code != 200 {
				t.Fatal("valid media type", code)
			}
			code, _, _ = request(t, core, endpoint, path, "POST", body[:len(body)-1]+",\"stream\":null}", nil)
			if code != 400 {
				t.Fatal("null stream", code)
			}
		})
	}
	for _, tc := range []struct {
		typ, body string
		stream    bool
	}{
		{"application/json-evil", "{}", false}, {"application/json; charset=", "{}", false},
		{"text/event-stream-evil", "data: {}\n\n", true}, {"text/event-stream; charset=", "data: {}\n\n", true},
	} {
		t.Run(tc.typ, func(t *testing.T) {
			core, endpoint, _, _ := testCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", tc.typ)
				_, _ = io.WriteString(w, tc.body)
			}))
			body := `{"model":"mock","stream":false}`
			if tc.stream {
				body = `{"model":"mock","stream":true}`
			}
			code, _, _ := request(t, core, endpoint, "/v1/responses", "POST", body, nil)
			if code != 502 {
				t.Fatal("upstream media type", code)
			}
		})
	}
}
