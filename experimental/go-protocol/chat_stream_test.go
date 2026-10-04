package protocol

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

type fragmentReader struct {
	data []byte
	step int
}

func (r *fragmentReader) Read(p []byte) (int, error) {
	if len(r.data) == 0 {
		return 0, io.EOF
	}
	n := r.step
	if n > len(p) {
		n = len(p)
	}
	if n > len(r.data) {
		n = len(r.data)
	}
	copy(p, r.data[:n])
	r.data = r.data[n:]
	return n, nil
}
func frame(delta string, finish string) string {
	return "data: {\"choices\":[{\"index\":0,\"delta\":" + delta + ",\"finish_reason\":" + finish + "}]}\n\n"
}
func validStream() string {
	return frame("{\"tool_calls\":[{\"index\":0,\"id\":\"c\",\"type\":\"function\",\"function\":{\"name\":\"read\",\"arguments\":\"{\\\"q\\\":\\\"中文🙂\\\"}\"}}]}", "null") + frame("{}", "\"tool_calls\"") + "data: [DONE]\n\n"
}

func TestChatEveryByteSplit(t *testing.T) {
	for _, nl := range []string{"\n", "\r\n", "\r"} {
		for step := 1; step <= 17; step++ {
			stream := strings.ReplaceAll(": comment\n\n"+validStream(), "\n", nl)
			out, err := ConvertChat(Request{Tools: []Tool{{Type: "function", Name: "read"}}}, &fragmentReader{[]byte(stream), step})
			if err != nil || !bytes.Contains(out, []byte("中文🙂")) {
				t.Fatal(nl, step, err)
			}
		}
	}
}
func TestSSEMultiline(t *testing.T) {
	var payloads []string
	err := StreamSSE(&fragmentReader{[]byte(": comment\r\ndata: {\r\ndata: \"x\":1}\r\n\r\n"), 1}, func(s string) error { payloads = append(payloads, s); return nil })
	if err != nil || len(payloads) != 1 || payloads[0] != "{\n\"x\":1}" {
		t.Fatal(payloads, err)
	}
}
func TestChatRejectZeroOutput(t *testing.T) {
	valid := validStream()
	cases := []string{
		strings.ReplaceAll(valid, "data: [DONE]\n\n", ""),
		strings.TrimSuffix(valid, "\n"),
		strings.ReplaceAll(valid, "\"tool_calls\"}", "\"length\"}"),
		strings.ReplaceAll(valid, "\"name\":\"read\"", "\"name\":\"unknown\""),
		"data: not-json\n\n" + valid,
		valid + frame("{}", "null"),
		"data: [DONE]\n\n",
		strings.ReplaceAll(valid, "\"index\":0", "\"index\":-1"),
		strings.ReplaceAll(valid, "\"id\":\"c\"", "\"id\":\"\""),
		strings.ReplaceAll(valid, "\"type\":\"function\",", ""),
		strings.ReplaceAll(valid, "\"arguments\":\"", "\"arguments\":\"invalid"),
		":" + strings.Repeat("x", MaxEvent) + "\n\n" + valid,
		strings.Repeat(":\n\n", MaxFrames+1) + valid,
		string([]byte{0xff}) + "\n\n" + valid,
	}
	for i, s := range cases {
		out, err := ConvertChat(Request{Tools: []Tool{{Type: "function", Name: "read"}}}, strings.NewReader(s))
		if err == nil || len(out) != 0 {
			t.Fatal(i, err)
		}
	}
	for _, limit := range []int{MaxEvent, MaxInput} {
		err := StreamSSE(strings.NewReader(strings.Repeat(":\n\n", limit/3+1)), func(string) error { return nil })
		if err == nil {
			t.Fatal("limit", limit)
		}
	}
	sentinel := errors.New("read failure")
	if err := StreamSSE(errorReader{sentinel}, func(string) error { return nil }); !errors.Is(err, sentinel) {
		t.Fatal(err)
	}
}

func TestIdentityAndCustomEnvelopeRejections(t *testing.T) {
	req := Request{Tools: []Tool{{Type: "custom", Name: "write"}, {Type: "function", Name: "read"}}}
	for _, input := range []string{"  text(1)  ", "echo mock"} {
		args, _ := json.Marshal(map[string]string{"input": input})
		fragment, _ := json.Marshal(map[string]any{"tool_calls": []any{map[string]any{"index": 0, "id": "a", "type": "function", "function": map[string]any{"name": "write", "arguments": string(args)}}}})
		stream := frame(string(fragment), "null") + frame("{}", "\"tool_calls\"") + "data: [DONE]\n\n"
		if out, err := ConvertChat(req, strings.NewReader(stream)); err == nil || len(out) != 0 {
			t.Fatal("noncanonical input", input)
		}
	}
	for _, delta := range []string{
		"{\"tool_calls\":[{\"index\":0,\"id\":\"c\",\"type\":\"function\",\"function\":{\"name\":\"read\",\"arguments\":\"{}\"}},{\"index\":1,\"id\":\"c\",\"type\":\"function\",\"function\":{\"name\":\"read\",\"arguments\":\"{}\"}}]}",
		"{\"tool_calls\":[{\"index\":0,\"id\":\"c\",\"type\":\"function\",\"function\":{\"name\":\"read\",\"arguments\":\"{}\"}},{\"index\":0,\"id\":\"d\"}]}",
	} {
		stream := frame(delta, "null") + frame("{}", "\"tool_calls\"") + "data: [DONE]\n\n"
		if out, err := ConvertChat(req, strings.NewReader(stream)); err == nil || len(out) != 0 {
			t.Fatal("identity accepted")
		}
	}
}

func TestMockCancellationDuringStream(t *testing.T) {
	started := make(chan struct{})
	closed := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("X-Momo-Mock-Capability", r.Header.Get("X-Momo-Mock-Capability"))
		w.WriteHeader(200)
		_, _ = io.WriteString(w, "data: ")
		w.(http.Flusher).Flush()
		close(started)
		select {
		case <-r.Context().Done():
		case <-time.After(4 * time.Second):
		}
		close(closed)
	}))
	defer server.Close()
	data, _ := json.Marshal(MockSession{Endpoint: server.URL, Capability: strings.Repeat("a", 64)})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { <-started; cancel() }()
	if out, err := RunMock(ctx, data); err == nil || len(out) != 0 {
		t.Fatal("midstream cancellation")
	}
	select {
	case <-closed:
	case <-time.After(time.Second):
		t.Fatal("upstream not cancelled")
	}
}

type errorReader struct{ err error }

func (r errorReader) Read([]byte) (int, error) { return 0, r.err }

func TestChatInterleavedOrder(t *testing.T) {
	first := frame("{\"tool_calls\":[{\"index\":7,\"id\":\"a\",\"type\":\"function\",\"function\":{\"name\":\"re\",\"arguments\":\"{\"}},{\"index\":2,\"id\":\"b\",\"type\":\"function\",\"function\":{\"name\":\"read\",\"arguments\":\"{}\"}}]}", "null")
	second := frame("{\"tool_calls\":[{\"index\":7,\"function\":{\"name\":\"ad\",\"arguments\":\"}\"}}]}", "null")
	out, err := ConvertChat(Request{Tools: []Tool{{Type: "function", Name: "read"}}}, strings.NewReader(first+second+frame("{}", "\"tool_calls\"")+"data: [DONE]\n\n"))
	if err != nil || bytes.Index(out, []byte("\"call_id\":\"a\"")) > bytes.Index(out, []byte("\"call_id\":\"b\"")) {
		t.Fatal(err, string(out))
	}
}

func TestMockRedirectAndCancellation(t *testing.T) {
	reached := false
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { reached = true }))
	defer target.Close()
	redirect := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, target.URL, http.StatusFound) }))
	defer redirect.Close()
	data, _ := json.Marshal(MockSession{Endpoint: redirect.URL, Capability: strings.Repeat("a", 64), Request: Request{}})
	if out, err := RunMock(context.Background(), data); err == nil || len(out) != 0 || reached {
		t.Fatal("redirect followed")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if out, err := RunMock(ctx, data); err == nil || len(out) != 0 {
		t.Fatal("cancel ignored")
	}
	for _, endpoint := range []string{"http://localhost:12345", "https://127.0.0.1:12345", "http://127.0.0.1:12345/path", "http://127.0.0.1:12345?x=1", "http://user@127.0.0.1:12345"} {
		b := []byte(fmt.Sprintf("{\"endpoint\":%q,\"request\":{}}", endpoint))
		if out, err := RunMock(ctx, b); err == nil || len(out) != 0 {
			t.Fatal(endpoint)
		}
	}
}

func FuzzChat(f *testing.F) {
	f.Add([]byte(validStream()))
	f.Add([]byte("data: [DONE]\n\n"))
	f.Fuzz(func(t *testing.T, data []byte) {
		if len(data) > MaxInput+1 {
			return
		}
		out, err := ConvertChat(Request{Tools: []Tool{{Type: "function", Name: "read"}}}, bytes.NewReader(data))
		if err != nil && len(out) != 0 {
			t.Fatal("partial output")
		}
	})
}
