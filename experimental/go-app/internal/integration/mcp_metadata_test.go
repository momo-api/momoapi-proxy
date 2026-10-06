package integration

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"strings"
	"testing"
)

func TestMediaMCPClientMetadata(t *testing.T) {
	for _, tc := range []struct {
		name  string
		serve func(context.Context, io.Reader, io.Writer, ImageDispatch) error
	}{{"image", ServeImageMCP}, {"video", ServeVideoMCP}} {
		t.Run(tc.name, func(t *testing.T) {
			// Actual Codex 0.156.0 field/type shape, with synthetic values only.
			meta := `{"callId":"synthetic-private","x-codex-turn-metadata":{"turn":1},"threadId":"synthetic-private","sessionId":"synthetic-private","windowId":"synthetic-private","itemId":"synthetic-private","progressToken":9007199254740993,"confirmed":true}`
			for _, action := range []string{"capabilities", "generate", "task", "gateway"} {
				name, args, path, body := tc.name+"_"+action, "{}", "/internal/"+tc.name+"s/"+action, ""
				switch action {
				case "generate":
					body = `{"model":"explicit","prompt":"synthetic"}`
					args = `{"confirmed":true,"request":` + body + "}"
				case "task":
					args, path = `{"task_id":"one"}`, "/internal/"+tc.name+"s/tasks/one"
				case "gateway":
					name, path = "gateway_capabilities", ""
				}
				calls := 0
				var out bytes.Buffer
				input := `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"` + name + `","arguments":` + args + `,"_meta":` + meta + "}}" + string(rune(10))
				err := tc.serve(context.Background(), strings.NewReader(input), &out, func(_ context.Context, gotPath string, gotBody []byte) ([]byte, int) {
					calls++
					if gotPath != path || string(gotBody) != body {
						t.Fatal("metadata changed dispatch")
					}
					return []byte(`{"synthetic_ok":true}`), 200
				})
				want := 1
				if action == "gateway" {
					want = 0
				}
				var reply map[string]json.RawMessage
				if err != nil || calls != want || json.Unmarshal(out.Bytes(), &reply) != nil || reply["error"] != nil || strings.Contains(out.String(), "synthetic-private") || strings.Contains(out.String(), "progressToken") {
					t.Fatalf("metadata rejected/reflected: %s", action)
				}
			}
			for _, meta := range []string{"{}", `{"progressToken":"synthetic-private"}`} {
				var out bytes.Buffer
				input := `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"` + tc.name + `_capabilities","arguments":{},"_meta":` + meta + "}}" + string(rune(10))
				calls := 0
				err := tc.serve(context.Background(), strings.NewReader(input), &out, func(context.Context, string, []byte) ([]byte, int) { calls++; return []byte("{}"), 200 })
				if err != nil || calls != 1 || strings.Contains(out.String(), "error") || strings.Contains(out.String(), "synthetic-private") {
					t.Fatal("valid empty/string metadata")
				}
			}
		})
	}
}

func TestMediaMCPMetadataCannotAuthorizeOrBypassBounds(t *testing.T) {
	for _, tc := range []struct {
		name  string
		serve func(context.Context, io.Reader, io.Writer, ImageDispatch) error
	}{{"image", ServeImageMCP}, {"video", ServeVideoMCP}} {
		prefix := `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"` + tc.name + `_capabilities","arguments":{},"_meta":`
		fixtures := []string{}
		for _, meta := range []string{"null", "[]", "1", "true", `"synthetic-private"`, `{"progressToken":null}`, `{"progressToken":[]}`, `{"progressToken":true}`, `{"progressToken":1,"progressToken":2}`, `{"nested":` + strings.Repeat("[", 65) + "0" + strings.Repeat("]", 65) + "}"} {
			fixtures = append(fixtures, prefix+meta+"}}")
		}
		fixtures = append(fixtures, prefix+`{},"extra":true}}`, prefix+`{},"_meta":{}}}`,
			`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"`+tc.name+`_generate","arguments":{"request":{}},"_meta":{"confirmed":true,"request":{}}}}`,
			`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"`+tc.name+`_generate","arguments":{"confirmed":false,"request":{}},"_meta":{"confirmed":true}}}`)
		for _, input := range fixtures {
			var out bytes.Buffer
			err := tc.serve(context.Background(), strings.NewReader(input+string(rune(10))), &out, func(context.Context, string, []byte) ([]byte, int) {
				t.Fatal("invalid metadata dispatched")
				return nil, 200
			})
			if err != nil || !strings.Contains(out.String(), "error") || strings.Contains(out.String(), "synthetic-private") {
				t.Fatal("metadata rejection/reflection")
			}
		}
		var out bytes.Buffer
		input := prefix + `{"large":"` + strings.Repeat("x", ImageMCPLineLimit) + `"}}}`
		if tc.serve(context.Background(), strings.NewReader(input), &out, func(context.Context, string, []byte) ([]byte, int) {
			t.Fatal("oversize metadata dispatched")
			return nil, 200
		}) == nil || out.Len() != 0 {
			t.Fatal("metadata line bound")
		}
	}
}
