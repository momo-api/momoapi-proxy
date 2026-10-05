package appcore

import (
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
)

const chatUsageFixture = `{"prompt_tokens":3,"completion_tokens":5,"total_tokens":8,"prompt_tokens_details":{"cached_tokens":2,"audio_tokens":0},"completion_tokens_details":{"reasoning_tokens":1,"audio_tokens":0,"accepted_prediction_tokens":0,"rejected_prediction_tokens":7}}`

func chatUsageFrame(raw string) string { return `data: {"choices":[],"usage":` + raw + "}\n\n" }
func TestChatTokenUsageValidation(t *testing.T) {
	valid := []string{chatUsageFixture, `{"prompt_tokens":0,"completion_tokens":0,"total_tokens":0}`, `{"prompt_tokens":9007199254740990,"completion_tokens":1,"total_tokens":9007199254740991,"prompt_tokens_details":null,"completion_tokens_details":{}}`}
	for _, raw := range valid {
		m, _ := decodeObject(raw)
		if _, err := chatTokenUsage(m); err != nil {
			t.Fatal("valid usage rejected")
		}
	}
	invalid := []string{`{}`, `null`,
		strings.Replace(chatUsageFixture, `"prompt_tokens":3`, `"prompt_tokens":-1`, 1),
		strings.Replace(chatUsageFixture, `"completion_tokens":5`, `"completion_tokens":5.5`, 1),
		strings.Replace(chatUsageFixture, `"total_tokens":8`, `"total_tokens":9`, 1),
		strings.Replace(chatUsageFixture, `"cached_tokens":2`, `"cached_tokens":4`, 1),
		strings.Replace(chatUsageFixture, `"reasoning_tokens":1`, `"reasoning_tokens":6`, 1),
		strings.Replace(chatUsageFixture, `"audio_tokens":0`, `"audio_tokens":"0"`, 1),
		strings.Replace(chatUsageFixture, `"cached_tokens":2`, `"private_unknown":2`, 1),
		`{"prompt_tokens":9007199254740991,"completion_tokens":1,"total_tokens":9007199254740991}`,
		`{"prompt_tokens":9007199254740992,"completion_tokens":0,"total_tokens":9007199254740992}`,
	}
	for _, raw := range invalid {
		m, _ := decodeObject(raw)
		if _, err := chatTokenUsage(m); err == nil {
			t.Fatal("invalid usage accepted")
		}
	}
}
func TestChatUsageSSEAndJSON(t *testing.T) {
	for _, payload := range []string{routedPayload, strings.Replace(routedPayload, `"stream":true`, `"stream":false`, 1)} {
		for _, beforeDone := range []string{chatUsageFrame(chatUsageFixture), chatUsageFrame(chatUsageFixture) + chatUsageFrame(chatUsageFixture)} {
			var sends atomic.Int32
			c, endpoint := routedClaudeCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				sends.Add(1)
				b, _ := io.ReadAll(r.Body)
				m, _ := decodeObject(string(b))
				if obj(m["stream_options"])["include_usage"] != true || m["stream"] != true {
					t.Error("usage request missing")
				}
				w.Header().Set("Content-Type", "text/event-stream")
				stream := strings.TrimSuffix(goodChatSSE(), "data: [DONE]\r\n\r\n") + beforeDone + "data: [DONE]\n\n"
				for _, b := range []byte(stream) {
					w.Write([]byte{b})
					w.(http.Flusher).Flush()
				}
			}))
			code, b, _ := request(t, c, endpoint, "/v1/responses", "POST", payload, nil)
			if code != 200 || sends.Load() != 1 {
				t.Fatal("status/send")
			}
			var final map[string]any
			if strings.Contains(payload, `"stream":true`) {
				final = responseCompletion(t, b)
			} else {
				final, _ = decodeObject(string(b))
			}
			u := obj(final["usage"])
			if fmt.Sprint(u["input_tokens"]) != "3" || fmt.Sprint(u["output_tokens"]) != "5" || fmt.Sprint(u["total_tokens"]) != "8" || fmt.Sprint(obj(u["input_tokens_details"])["cached_tokens"]) != "2" || fmt.Sprint(obj(u["output_tokens_details"])["reasoning_tokens"]) != "1" {
				t.Fatal("usage projection")
			}
		}
	}
}
func TestChatUsageAttachedAndIncreasing(t *testing.T) {
	first := obj(choice(map[string]any{"content": "hello"}, nil))
	u, _ := decodeObject(chatUsageFixture)
	first["usage"] = map[string]any{"prompt_tokens": 3, "completion_tokens": 1, "total_tokens": 4}
	last := obj(choice(map[string]any{}, "stop"))
	last["usage"] = u
	c, endpoint := routedClaudeCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, chatSSE(first, last))
	}))
	code, b, _ := request(t, c, endpoint, "/v1/responses", "POST", strings.Replace(routedPayload, `"stream":true`, `"stream":false`, 1), nil)
	final, _ := decodeObject(string(b))
	if code != 200 || fmt.Sprint(obj(final["usage"])["total_tokens"]) != "8" {
		t.Fatal("attached/cumulative usage")
	}
}
func TestChatUsageMalformedNeverCompletes(t *testing.T) {
	prefix := strings.TrimSuffix(goodChatSSE(), "data: [DONE]\r\n\r\n")
	valid := chatUsageFrame(chatUsageFixture)
	for name, stream := range map[string]string{
		"negative":             prefix + chatUsageFrame(strings.Replace(chatUsageFixture, `"completion_tokens":5`, `"completion_tokens":-5`, 1)) + "data: [DONE]\n\n",
		"regression":           prefix + valid + chatUsageFrame(`{"prompt_tokens":3,"completion_tokens":4,"total_tokens":7}`) + "data: [DONE]\n\n",
		"cached regression":    prefix + valid + chatUsageFrame(strings.Replace(chatUsageFixture, `"cached_tokens":2`, `"cached_tokens":1`, 1)) + "data: [DONE]\n\n",
		"reasoning regression": prefix + valid + chatUsageFrame(strings.Replace(chatUsageFixture, `"reasoning_tokens":1`, `"reasoning_tokens":0`, 1)) + "data: [DONE]\n\n",
		"usage no done":        prefix + valid,
		"usage no finish":      chatUsageFrame(chatUsageFixture) + "data: [DONE]\n\n",
		"null choices":         prefix + `data: {"choices":null,"usage":` + chatUsageFixture + "}\n\ndata: [DONE]\n\n",
		"null usage trailer":   prefix + chatUsageFrame("null") + "data: [DONE]\n\n",
		"unknown usage":        prefix + chatUsageFrame(`{"prompt_tokens":3,"completion_tokens":5,"total_tokens":8,"private":"do-not-render"}`) + "data: [DONE]\n\n",
	} {
		t.Run(name, func(t *testing.T) {
			for _, payload := range []string{routedPayload, strings.Replace(routedPayload, `"stream":true`, `"stream":false`, 1)} {
				c, endpoint := routedClaudeCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					w.Header().Set("Content-Type", "text/event-stream")
					fmt.Fprint(w, stream)
				}))
				req, _ := http.NewRequest("POST", endpoint+"/v1/responses", strings.NewReader(payload))
				req.Header.Set("Authorization", "Bearer "+c.token)
				req.Header.Set("Content-Type", "application/json")
				resp, err := http.DefaultClient.Do(req)
				if err != nil {
					if strings.Contains(payload, `"stream":false`) {
						t.Fatal("JSON failure not atomic")
					}
					continue
				}
				b, readErr := io.ReadAll(resp.Body)
				resp.Body.Close()
				if strings.Contains(string(b), "response.completed") || strings.Contains(string(b), "do-not-render") {
					t.Fatal("false completion/error leak")
				}
				if strings.Contains(payload, `"stream":false`) {
					if resp.StatusCode != 502 || readErr != nil {
						t.Fatal("JSON failure")
					}
				} else if readErr == nil {
					t.Fatal("SSE failure not aborted")
				}
			}
		})
	}
}
func TestChatUsageAbsentNotFabricated(t *testing.T) {
	c, endpoint := routedClaudeCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, goodChatSSE())
	}))
	code, b, _ := request(t, c, endpoint, "/v1/responses", "POST", strings.Replace(routedPayload, `"stream":true`, `"stream":false`, 1), nil)
	final, _ := decodeObject(string(b))
	if code != 200 || final["usage"] != nil {
		t.Fatal("fabricated usage")
	}
}
