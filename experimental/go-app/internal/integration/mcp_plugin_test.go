package integration

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"strings"
	"testing"
)

func TestPluginMCPFlatArgumentsTaskNamesAndIsolation(t *testing.T) {
	for _, video := range []bool{false, true} {
		modality, serve := "image", ServePluginImageMCP
		if video {
			modality, serve = "video", ServePluginVideoMCP
		}
		var paths []string
		dispatch := func(_ context.Context, path string, body []byte) ([]byte, int) {
			paths = append(paths, path)
			if strings.HasSuffix(path, "/generate") && string(body) != `{"model":"chosen","prompt":"中文🙂"}` {
				t.Fatal("flat request changed", string(body))
			}
			if strings.HasSuffix(path, "/capabilities") {
				return []byte(`{"models":[{"id":"chosen","available":true,"max_n":2,"allowed_n":[1,2],"max_reference_images":3,"aspect_ratios":["1:1"],"durations":[5],"resolutions":["480p"],"constraints":{"quality":{"allowed":["high"]}}}],"storage":"no disk"}`), 200
			}
			return []byte(`{"task_id":"one","terminal":false}`), 200
		}
		input := `{"jsonrpc":"2.0","id":9007199254740993,"method":"initialize"}` + "\n" +
			`{"jsonrpc":"2.0","method":"tools/call","params":{"name":"` + modality + `_generate","arguments":{"model":"chosen","prompt":"ignored notification"}}}` + "\n" +
			`{"jsonrpc":"2.0","id":2,"method":"tools/list"}` + "\n" +
			videoCall("3", modality+"_capabilities", "{}") + "\n" +
			videoCall("4", modality+"_generate", `{"model":"chosen","prompt":"中文🙂"}`) + "\n" +
			videoCall("5", modality+"_task_status", `{"task_id":"one"}`) + "\n"
		var out bytes.Buffer
		if serve(context.Background(), strings.NewReader(input), &out, dispatch) != nil || len(paths) != 3 {
			t.Fatal("dispatch count", paths)
		}
		lines := strings.Split(strings.TrimSpace(out.String()), "\n")
		if len(lines) != 5 || !strings.Contains(lines[0], "9007199254740993") || !strings.Contains(lines[0], "momo-"+modality) {
			t.Fatal("id/notifications")
		}
		var list struct {
			Result struct {
				Tools []struct {
					Name        string
					InputSchema map[string]any
				}
			}
		}
		if json.Unmarshal([]byte(lines[1]), &list) != nil {
			t.Fatal("list")
		}
		for _, tool := range list.Result.Tools {
			if tool.Name == modality+"_generate" {
				p := tool.InputSchema["properties"].(map[string]any)
				if p["prompt"] == nil || p["request"] != nil || p["confirmed"] != nil {
					t.Fatal("not plugin flat schema")
				}
			}
			if tool.Name == modality+"_task" || strings.Contains(tool.Name, "asset") {
				t.Fatal("unsupported plugin claims")
			}
		}
		var reply struct {
			Result struct{ Content []struct{ Text string } }
		}
		json.Unmarshal([]byte(lines[2]), &reply)
		var catalog map[string]any
		json.Unmarshal([]byte(reply.Result.Content[0].Text), &catalog)
		model := catalog["models"].([]any)[0].(map[string]any)
		limits := model["limits"].(map[string]any)
		if limits["max_reference_images"] != float64(3) || limits["max_n"] != float64(2) || model["parameter_schema"] == nil {
			t.Fatal("Node plugin catalog contract")
		}
		if paths[2] != "/internal/"+modality+"s/tasks/one" {
			t.Fatal("task route")
		}
		// The safer existing modes MUST NOT start accepting flat billed calls.
		safe := ServeImageMCP
		if video {
			safe = ServeVideoMCP
		}
		out.Reset()
		if safe(context.Background(), strings.NewReader(videoCall("1", modality+"_generate", `{"model":"chosen","prompt":"hi"}`)+"\n"), &out, func(context.Context, string, []byte) ([]byte, int) {
			t.Fatal("implicit normal-mode confirmation")
			return nil, 200
		}) != nil || !strings.Contains(out.String(), "-32602") {
			t.Fatal("mode isolation")
		}
	}
}

func TestPluginMCPExportNoSecretsOrImplicitConfig(t *testing.T) {
	if Capabilities()["plugin_media_calls"] == nil || !strings.Contains(Skill, "image_task_status/video_task_status") || !strings.Contains(Skill, "NOT full installed-plugin compatibility") {
		t.Fatal("stale support boundary")
	}
	for _, video := range []bool{false, true} {
		modality := "image"
		if video {
			modality = "video"
		}
		raw, err := PluginMCPConfig("preview", "http://127.0.0.1:1234", video)
		var config struct {
			MCPServers map[string]struct {
				Command string
				Args    []string
				Env     any
			}
		}
		if err != nil || json.Unmarshal([]byte(raw), &config) != nil {
			t.Fatal("export")
		}
		c := config.MCPServers["momo-"+modality]
		if c.Command != "preview" || strings.Join(c.Args, ",") != "mcp,"+modality+",--endpoint,http://127.0.0.1:1234" || c.Env != nil || len(config.MCPServers) != 1 {
			t.Fatal("config scope")
		}
		for _, endpoint := range []string{"", "http://localhost:1", "http://127.0.0.1:1/", "https://momoapi.us"} {
			if _, err := PluginMCPConfig("preview", endpoint, video); err == nil {
				t.Fatal("endpoint")
			}
		}
	}
}

func TestPluginMCPInvalidNoSendAndNoReflection(t *testing.T) {
	for _, serve := range []func(context.Context, io.Reader, io.Writer, ImageDispatch) error{ServePluginImageMCP, ServePluginVideoMCP} {
		for _, args := range []string{`{"prompt":"hi"}`, `{"model":"x","prompt":"hi","confirmed":true}`, `{"model":"x","prompt":"hi","request":{}}`, `{"model":"x","prompt":"hi","unknown":"synthetic-private"}`, `{"model":null,"prompt":"hi"}`, `{"model":"x","model":"y","prompt":"hi"}`} {
			var out bytes.Buffer
			// Test both modalities; cross-modality requests must also reject.
			for _, name := range []string{"image_generate", "video_generate"} {
				out.Reset()
				if serve(context.Background(), strings.NewReader(videoCall("1", name, args)+"\n"), &out, func(context.Context, string, []byte) ([]byte, int) { t.Fatal("invalid dispatch"); return nil, 200 }) != nil || !strings.Contains(out.String(), "error") || strings.Contains(out.String(), "synthetic-private") {
					t.Fatal("reject/reflection")
				}
			}
		}
	}
}

func TestPluginMCPFailuresCancellationAndNoReplay(t *testing.T) {
	for _, tc := range []struct {
		serve func(context.Context, io.Reader, io.Writer, ImageDispatch) error
		name  string
	}{{ServePluginImageMCP, "image_capabilities"}, {ServePluginVideoMCP, "video_capabilities"}} {
		serve, name := tc.serve, tc.name
		call := videoCall("1", name, "{}") + "\n"
		for _, writer := range []io.Writer{shortMCPWriter{}, failedMCPWriter{}} {
			sends := 0
			if serve(context.Background(), strings.NewReader(call+call), writer, func(context.Context, string, []byte) ([]byte, int) { sends++; return []byte(`{"models":[]}`), 200 }) == nil || sends != 1 {
				t.Fatal("output failure replay")
			}
		}
		var out bytes.Buffer
		for _, data := range []string{`{"models":null}`, `{"models":[null]}`, `{"models":[],"models":[]}`, "synthetic-private"} {
			out.Reset()
			if serve(context.Background(), strings.NewReader(call), &out, func(context.Context, string, []byte) ([]byte, int) { return []byte(data), 200 }) != nil || !strings.Contains(out.String(), `"isError":true`) || strings.Contains(out.String(), "synthetic-private") {
				t.Fatal("bad catalog reflected")
			}
		}
		ctx, cancel := context.WithCancel(context.Background())
		out.Reset()
		sends := 0
		if serve(ctx, strings.NewReader(call+call), &out, func(context.Context, string, []byte) ([]byte, int) {
			sends++
			cancel()
			return []byte(`{"models":[]}`), 200
		}) != nil || sends != 1 || out.Len() != 0 {
			t.Fatal("cancel late output/send")
		}
	}
}

func TestPluginMCPBilledFailuresOneSendNoMetadataReflection(t *testing.T) {
	for _, tc := range []struct {
		serve func(context.Context, io.Reader, io.Writer, ImageDispatch) error
		name  string
	}{{ServePluginImageMCP, "image_generate"}, {ServePluginVideoMCP, "video_generate"}} {
		call := `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"` + tc.name + `","arguments":{"model":"chosen","prompt":"hi"},"_meta":{"progressToken":9007199254740993,"threadId":"synthetic-private","confirmed":true}}}` + "\n"
		sends := 0
		var out bytes.Buffer
		dispatch := func(_ context.Context, _ string, body []byte) ([]byte, int) {
			sends++
			if string(body) != `{"model":"chosen","prompt":"hi"}` {
				t.Fatal("metadata/body changed")
			}
			return []byte("synthetic-private"), 429
		}
		if tc.serve(context.Background(), strings.NewReader(call), &out, dispatch) != nil || sends != 1 || !strings.Contains(out.String(), `"isError":true`) || strings.Contains(out.String(), "synthetic-private") {
			t.Fatal("bill retry/reflection")
		}
		for _, writer := range []io.Writer{shortMCPWriter{}, failedMCPWriter{}} {
			sends = 0
			if tc.serve(context.Background(), strings.NewReader(call+call), writer, dispatch) == nil || sends != 1 {
				t.Fatal("billed write failure replay")
			}
		}
	}
}
