package appcore

import (
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestChatPassthroughExactJSONAndSSE(t *testing.T) {
	payload := `{"model":"mock","messages":[{"role":"user","content":[{"type":"text","text":"中文🙂"}]}],"tools":[{"type":"function","function":{"name":"write","parameters":{"type":"object"}}}],"provider_extra":{"namespace":"pad"}}`
	response := `{"choices":[{"message":{"role":"assistant","tool_calls":[{"id":"call_same","type":"function","function":{"name":"write","arguments":"{}"},"namespace":"pad"}]},"finish_reason":"tool_calls"}],"usage":{"total_tokens":5},"provider_extra":true}`
	stream := "data: {\"choices\":[{\"delta\":{\"content\":\"中文🙂\"}}],\"provider_extra\":true}\r\n\r\ndata: [DONE]\n\n"
	for _, streaming := range []bool{false, true} {
		t.Run(map[bool]string{false: "json", true: "sse"}[streaming], func(t *testing.T) {
			body := payload
			want := response
			if streaming {
				body = strings.TrimSuffix(payload, "}") + ",\"stream\":true}"
				want = stream
			}
			core, endpoint, _, _ := testCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				data, _ := io.ReadAll(r.Body)
				if r.URL.Path != "/v1/chat/completions" || string(data) != body || r.Header.Get("Authorization") != "Bearer "+syntheticKey {
					t.Error("chat request changed")
				}
				if streaming {
					w.Header().Set("Content-Type", "text/event-stream")
				} else {
					w.Header().Set("Content-Type", "application/json")
				}
				for _, b := range []byte(want) {
					_, _ = w.Write([]byte{b})
					w.(http.Flusher).Flush()
				}
			}))
			code, data, _ := request(t, core, endpoint, "/v1/chat/completions", "POST", body, nil)
			if code != 200 || string(data) != want {
				t.Fatal("chat response changed", code)
			}
		})
	}
}

func TestChatBoundary(t *testing.T) {
	core, endpoint, _, _ := testCore(t, http.HandlerFunc(func(http.ResponseWriter, *http.Request) { t.Error("invalid chat reached upstream") }))
	for _, body := range []string{`{"model":"mock"}`, `{"model":"mock","messages":null}`, `{"model":"mock","messages":[]}`, `{"model":"mock","messages":{}}`, `{"model":"mock","messages":[{}],"stream":"true"}`} {
		code, _, _ := request(t, core, endpoint, "/v1/chat/completions", "POST", body, nil)
		if code != 400 {
			t.Fatal("invalid chat admitted", code)
		}
	}
	code, _, _ := request(t, core, endpoint, "/v1/chat/completions", "GET", "", nil)
	if code != 405 {
		t.Fatal("chat method", code)
	}
}
