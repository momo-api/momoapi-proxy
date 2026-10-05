package integration

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"strings"
	"testing"
)

func videoCall(id string, name, args string) string {
	return `{"jsonrpc":"2.0","id":` + id + `,"method":"tools/call","params":{"name":"` + name + `","arguments":` + args + `}}`
}

func TestVideoMCPWhitelistConfirmationAndPrecision(t *testing.T) {
	var paths []string
	dispatch := func(ctx context.Context, path string, body []byte) ([]byte, int) {
		paths = append(paths, path)
		if path == "/internal/videos/generate" && string(body) != `{"model":"seedance-2.5","prompt":"hi","duration":5}` {
			t.Fatal("request changed")
		}
		return []byte(`{"status":"queued","task_id":"one","terminal":false}`), 200
	}
	input := strings.Join([]string{
		`{"jsonrpc":"2.0","id":9007199254740993,"method":"initialize"}`,
		`{"jsonrpc":"2.0","method":"tools/call","params":{"name":"video_generate","arguments":{"confirmed":true,"request":{}}}}`,
		`{"jsonrpc":"2.0","id":"list","method":"tools/list"}`,
		videoCall("3", "video_capabilities", "{}"),
		videoCall("4", "video_generate", `{"confirmed":true,"request":{"model":"seedance-2.5","prompt":"hi","duration":5}}`),
		videoCall("5", "video_task", `{"task_id":"one._:-1"}`),
	}, "\n") + "\n"
	var out bytes.Buffer
	if ServeVideoMCP(context.Background(), strings.NewReader(input), &out, dispatch) != nil {
		t.Fatal("serve")
	}
	if strings.Join(paths, ",") != "/internal/videos/capabilities,/internal/videos/generate,/internal/videos/tasks/one._:-1" {
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
	for i, name := range []string{"gateway_capabilities", "video_capabilities", "video_generate", "video_task"} {
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
	var list map[string]any
	json.Unmarshal([]byte(lines[1]), &list)
	tools := list["result"].(map[string]any)["tools"].([]any)
	schema := tools[2].(map[string]any)["inputSchema"].(map[string]any)["properties"].(map[string]any)["request"].(map[string]any)
	properties := schema["properties"].(map[string]any)
	if schema["additionalProperties"] != false || len(properties) != 8 || properties["prompt"].(map[string]any)["maxLength"] != float64(7000) {
		t.Fatal("video request schema")
	}
	for _, name := range []string{"duration", "resolution", "aspect_ratio", "reference_images", "first_frame_image", "last_frame_image"} {
		if properties[name] == nil {
			t.Fatal("missing video control", name)
		}
	}
	for _, tc := range []struct {
		serve func(context.Context, io.Reader, io.Writer, ImageDispatch) error
		name  string
	}{{ServeImageMCP, "video_generate"}, {ServeVideoMCP, "image_generate"}} {
		var denied bytes.Buffer
		if tc.serve(context.Background(), strings.NewReader(videoCall("1", tc.name, `{"confirmed":true,"request":{}}`)+"\n"), &denied, func(context.Context, string, []byte) ([]byte, int) {
			t.Fatal("cross-modality dispatched")
			return nil, 200
		}) != nil || !strings.Contains(denied.String(), "-32602") {
			t.Fatal("cross-modality mode boundary")
		}
	}
	// Normal MCP stays read-only, even if callers ask for billed tools.
	out.Reset()
	if ServeMCP(strings.NewReader(videoCall("1", "video_generate", `{"confirmed":true,"request":{}}`)+"\n"), &out) != nil || !strings.Contains(out.String(), "-32602") {
		t.Fatal("read-only boundary")
	}
}

func TestVideoMCPRejectsBeforeDispatch(t *testing.T) {
	fixtures := []string{
		videoCall("1", "video_generate", `{"request":{}}`), videoCall("1", "video_generate", `{"confirmed":false,"request":{}}`),
		videoCall("1", "video_generate", `{"confirmed":"true","request":{}}`), videoCall("1", "video_generate", `{"confirmed":true,"request":null}`),
		videoCall("1", "video_generate", `{"confirmed":false,"confirmed":true,"request":{}}`),
		videoCall("1", "video_generate", `{"confirmed":true,"request":{"model":"x","model":"y"}}`),
		videoCall("1", "video_generate", `{"confirmed":true,"request":{},"key":"synthetic-private"}`),
		videoCall("1", "video_capabilities", `{"endpoint":"synthetic-private"}`), videoCall("1", "video_capabilities", "null"),
		videoCall("1", "video_task", `{"task_id":"../secret"}`), videoCall("1", "video_task", `{"task_id":"a?key=synthetic-private"}`),
		videoCall("1", "video_task", `{"task_id":""}`), videoCall("1", "video_task", `{"task_id":"a","extra":1}`),
		videoCall("1", "run_shell", `{"key":"synthetic-private"}`),
		`{"jsonrpc":"2.0","id":[],"method":"tools/list"}`, `{"jsonrpc":"2.0","id":null,"method":"tools/list"}`,
		`{"jsonrpc":"2.0","id":1,"method":"tools/list","extra":true}`,
		videoCall("1", "video_generate", `{"confirmed":true,"request":`+strings.Repeat("[", 65)+"0"+strings.Repeat("]", 65)+"}"),
		"\xff", "broken", videoCall("1", "video_task", `{"task_id":"`+strings.Repeat("x", 257)+`"}`),
	}
	for _, input := range fixtures {
		var out bytes.Buffer
		err := ServeVideoMCP(context.Background(), strings.NewReader(input+"\n"), &out, func(context.Context, string, []byte) ([]byte, int) { t.Fatal("invalid dispatched"); return nil, 200 })
		if err != nil || strings.Contains(out.String(), "synthetic-private") || !strings.Contains(out.String(), "error") {
			t.Fatal("invalid reflection/rejection")
		}
	}
}

func TestVideoMCPOutputFailuresCancellationAndBounds(t *testing.T) {
	call := videoCall("1", "video_generate", `{"confirmed":true,"request":{}}`) + "\n"
	for _, writer := range []io.Writer{shortMCPWriter{}, failedMCPWriter{}} {
		calls := 0
		err := ServeVideoMCP(context.Background(), strings.NewReader(call+call), writer, func(context.Context, string, []byte) ([]byte, int) { calls++; return []byte("{}"), 200 })
		if err == nil || calls != 1 || strings.Contains(err.Error(), "synthetic-private") {
			t.Fatal("write failure replay/reflection")
		}
	}
	for _, data := range [][]byte{[]byte("broken synthetic-private"), []byte("\xff"), []byte(strings.Repeat(" ", 16<<20) + "{}")} {
		var out bytes.Buffer
		if ServeVideoMCP(context.Background(), strings.NewReader(call), &out, func(context.Context, string, []byte) ([]byte, int) { return data, 200 }) != nil || !strings.Contains(out.String(), `"isError":true`) || strings.Contains(out.String(), "synthetic-private") {
			t.Fatal("bad dispatch output")
		}
	}
	var out bytes.Buffer
	if ServeVideoMCP(context.Background(), strings.NewReader(call), &out, func(context.Context, string, []byte) ([]byte, int) { return []byte("synthetic-private"), 429 }) != nil || !strings.Contains(out.String(), `"isError":true`) || strings.Contains(out.String(), "synthetic-private") {
		t.Fatal("upstream error")
	}
	ctx, cancel := context.WithCancel(context.Background())
	if ServeVideoMCP(ctx, strings.NewReader(call+call), &out, func(ctx context.Context, _ string, _ []byte) ([]byte, int) { cancel(); return []byte("{}"), 200 }) != nil {
		t.Fatal("cancel")
	}
	out.Reset()
	if ServeVideoMCP(context.Background(), strings.NewReader(strings.Repeat("x", VideoMCPLineLimit+3)), &out, func(context.Context, string, []byte) ([]byte, int) { t.Fatal("large dispatched"); return nil, 200 }) == nil || out.Len() != 0 {
		t.Fatal("input bound")
	}
}
