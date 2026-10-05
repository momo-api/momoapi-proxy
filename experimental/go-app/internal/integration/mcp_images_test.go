package integration

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"testing"
)

func imageCall(id string, name, args string) string {
	return `{"jsonrpc":"2.0","id":` + id + `,"method":"tools/call","params":{"name":"` + name + `","arguments":` + args + `}}`
}

func TestImageMCPWhitelistConfirmationAndPrecision(t *testing.T) {
	var paths []string
	dispatch := func(ctx context.Context, path string, body []byte) ([]byte, int) {
		paths = append(paths, path)
		if path == "/internal/images/generate" && string(body) != `{"model":"chosen","prompt":"hi","n":1}` {
			t.Fatal("request changed")
		}
		return []byte(`{"images":[],"task_id":"one","terminal":false}`), 200
	}
	input := strings.Join([]string{
		`{"jsonrpc":"2.0","id":9007199254740993,"method":"initialize"}`,
		`{"jsonrpc":"2.0","method":"tools/call","params":{"name":"image_generate","arguments":{"confirmed":true,"request":{}}}}`,
		`{"jsonrpc":"2.0","id":"list","method":"tools/list"}`,
		imageCall("3", "image_capabilities", "{}"),
		imageCall("4", "image_generate", `{"confirmed":true,"request":{"model":"chosen","prompt":"hi","n":1}}`),
		imageCall("5", "image_task", `{"task_id":"one._:-1"}`),
	}, "\n") + "\n"
	var out bytes.Buffer
	if ServeImageMCP(context.Background(), strings.NewReader(input), &out, dispatch) != nil {
		t.Fatal("serve")
	}
	if strings.Join(paths, ",") != "/internal/images/capabilities,/internal/images/generate,/internal/images/tasks/one._:-1" {
		t.Fatal("dispatch/notification")
	}
	lines := strings.Split(strings.TrimSpace(out.String()), "\n")
	if len(lines) != 5 || !strings.Contains(lines[0], "9007199254740993") {
		t.Fatal("id precision")
	}
	var result struct {
		Result struct {
			Tools []struct {
				Name        string
				Annotations map[string]bool
			}
		}
	}
	if json.Unmarshal([]byte(lines[1]), &result) != nil || len(result.Result.Tools) != 4 {
		t.Fatal("tool list")
	}
	for i, name := range []string{"gateway_capabilities", "image_capabilities", "image_generate", "image_task"} {
		if result.Result.Tools[i].Name != name {
			t.Fatal("tools")
		}
	}
	if result.Result.Tools[2].Annotations["readOnlyHint"] || !result.Result.Tools[2].Annotations["destructiveHint"] || result.Result.Tools[2].Annotations["idempotentHint"] {
		t.Fatal("billing hints")
	}
	if !strings.Contains(out.String(), "NOT verified human consent") {
		t.Fatal("consent claim")
	}
	// Normal MCP stays read-only, even if callers ask for billed tools.
	out.Reset()
	if ServeMCP(strings.NewReader(imageCall("1", "image_generate", `{"confirmed":true,"request":{}}`)+"\n"), &out) != nil || !strings.Contains(out.String(), "-32602") {
		t.Fatal("read-only boundary")
	}
}

func TestImageMCPRejectsBeforeDispatch(t *testing.T) {
	fixtures := []string{
		imageCall("1", "image_generate", `{"request":{}}`), imageCall("1", "image_generate", `{"confirmed":false,"request":{}}`),
		imageCall("1", "image_generate", `{"confirmed":"true","request":{}}`), imageCall("1", "image_generate", `{"confirmed":true,"request":null}`),
		imageCall("1", "image_generate", `{"confirmed":false,"confirmed":true,"request":{}}`),
		imageCall("1", "image_generate", `{"confirmed":true,"request":{"model":"x","model":"y"}}`),
		imageCall("1", "image_generate", `{"confirmed":true,"request":{},"key":"synthetic-private"}`),
		imageCall("1", "image_capabilities", `{"endpoint":"synthetic-private"}`), imageCall("1", "image_capabilities", "null"),
		imageCall("1", "image_task", `{"task_id":"../secret"}`), imageCall("1", "image_task", `{"task_id":"a?key=synthetic-private"}`),
		imageCall("1", "image_task", `{"task_id":""}`), imageCall("1", "image_task", `{"task_id":"a","extra":1}`),
		imageCall("1", "run_shell", `{"key":"synthetic-private"}`),
		`{"jsonrpc":"2.0","id":[],"method":"tools/list"}`, `{"jsonrpc":"2.0","id":null,"method":"tools/list"}`,
		`{"jsonrpc":"2.0","id":1,"method":"tools/list","extra":true}`,
		imageCall("1", "image_generate", `{"confirmed":true,"request":`+strings.Repeat("[", 65)+"0"+strings.Repeat("]", 65)+"}"),
		"\xff", "broken", imageCall("1", "image_task", `{"task_id":"`+strings.Repeat("x", 257)+`"}`),
	}
	for _, input := range fixtures {
		var out bytes.Buffer
		err := ServeImageMCP(context.Background(), strings.NewReader(input+"\n"), &out, func(context.Context, string, []byte) ([]byte, int) { t.Fatal("invalid dispatched"); return nil, 200 })
		if err != nil || strings.Contains(out.String(), "synthetic-private") || !strings.Contains(out.String(), "error") {
			t.Fatal("invalid reflection/rejection")
		}
	}
}

type shortMCPWriter struct{}

func (shortMCPWriter) Write(b []byte) (int, error) { return len(b) - 1, nil }

type failedMCPWriter struct{}

func (failedMCPWriter) Write([]byte) (int, error) { return 0, errors.New("synthetic-private") }

func TestImageMCPOutputFailuresCancellationAndBounds(t *testing.T) {
	call := imageCall("1", "image_generate", `{"confirmed":true,"request":{}}`) + "\n"
	for _, writer := range []io.Writer{shortMCPWriter{}, failedMCPWriter{}} {
		calls := 0
		err := ServeImageMCP(context.Background(), strings.NewReader(call+call), writer, func(context.Context, string, []byte) ([]byte, int) { calls++; return []byte("{}"), 200 })
		if err == nil || calls != 1 || strings.Contains(err.Error(), "synthetic-private") {
			t.Fatal("write failure replay/reflection")
		}
	}
	for _, data := range [][]byte{[]byte("broken synthetic-private"), []byte("\xff"), []byte(strings.Repeat(" ", 16<<20) + "{}")} {
		var out bytes.Buffer
		if ServeImageMCP(context.Background(), strings.NewReader(call), &out, func(context.Context, string, []byte) ([]byte, int) { return data, 200 }) != nil || !strings.Contains(out.String(), `"isError":true`) || strings.Contains(out.String(), "synthetic-private") {
			t.Fatal("bad dispatch output")
		}
	}
	var out bytes.Buffer
	if ServeImageMCP(context.Background(), strings.NewReader(call), &out, func(context.Context, string, []byte) ([]byte, int) { return []byte("synthetic-private"), 429 }) != nil || !strings.Contains(out.String(), `"isError":true`) || strings.Contains(out.String(), "synthetic-private") {
		t.Fatal("upstream error")
	}
	ctx, cancel := context.WithCancel(context.Background())
	if ServeImageMCP(ctx, strings.NewReader(call+call), &out, func(ctx context.Context, _ string, _ []byte) ([]byte, int) { cancel(); return []byte("{}"), 200 }) != nil {
		t.Fatal("cancel")
	}
	out.Reset()
	if ServeImageMCP(context.Background(), strings.NewReader(strings.Repeat("x", ImageMCPLineLimit+3)), &out, func(context.Context, string, []byte) ([]byte, int) { t.Fatal("large dispatched"); return nil, 200 }) == nil || out.Len() != 0 {
		t.Fatal("input bound")
	}
}
