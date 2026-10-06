package appcore

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/momo-api/momoapi-proxy/experimental/go-app/internal/integration"
)

func TestPluginMCPConnectedTCPAndTLSUpstreamLifecycle(t *testing.T) {
	for _, video := range []bool{false, true} {
		modality := "image"
		model := "momoapi-gpt-image-2-5-flare"
		if video {
			modality, model = "video", "seedance-2.5"
		}
		t.Run(modality, func(t *testing.T) {
			var sends, generate, edit, tasks atomic.Int32
			reference := inlineFixture(t, "image/png")
			c, endpoint, _, _ := testCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				sends.Add(1)
				w.Header().Set("Content-Type", "application/json")
				if r.Header.Get("Authorization") != "Bearer "+syntheticKey {
					t.Error("upstream auth")
				}
				data, _ := io.ReadAll(r.Body)
				var body map[string]any
				json.Unmarshal(data, &body)
				switch r.URL.Path {
				case "/agent/media-capabilities":
					io.WriteString(w, fixtureImageCatalog(model))
				case "/v1/models":
					io.WriteString(w, `{"data":[{"id":"seedance-2.5"}]}`)
				case "/v1/images/generations":
					generate.Add(1)
					if video || body["model"] != model || body["prompt"] != "plugin prompt" || body["n"] != float64(1) || len(body) != 3 {
						t.Error("image flat upstream wire")
					}
					io.WriteString(w, `{"task_id":"plugin_one","status":"submitted"}`)
				case "/v1/images/edits":
					edit.Add(1)
					refs, ok := body["images"].([]any)
					if video || !ok || len(refs) != 1 || refs[0] != reference || body["model"] != model || body["prompt"] != "edit prompt" || len(body) != 4 {
						t.Error("image edit wire")
					}
					io.WriteString(w, `{"data":[{"url":"https://images.example/edited.png"}]}`)
				case "/v1/tasks/plugin_one":
					tasks.Add(1)
					io.WriteString(w, `{"status":"completed","url":"https://images.example/result.png"}`)
				case "/v1/video/generations":
					generate.Add(1)
					if !video || body["model"] != model || body["prompt"] != "plugin prompt" || body["duration"] != float64(4) || body["resolution"] != "480p" || body["aspect_ratio"] != "adaptive" || len(body) != 5 {
						t.Error("video flat upstream wire")
					}
					io.WriteString(w, `{"task_id":"plugin_one","status":"submitted"}`)
				case "/v1/videos/plugin_one":
					tasks.Add(1)
					io.WriteString(w, `{"id":"plugin_one","status":"completed","metadata":{"url":"https://video.example/result.mp4"}}`)
				default:
					t.Error("unexpected path", r.URL.Path)
					w.WriteHeader(404)
				}
			}))
			key := c.token // synthetic test Core only; never read a real profile
			connect, serve := integration.NewLocalImageDispatch, integration.ServePluginImageMCP
			if video {
				connect, serve = integration.NewLocalVideoDispatch, integration.ServePluginVideoMCP
			}
			dispatch, closeClient, err := connect(endpoint, key)
			if err != nil {
				t.Fatal(err)
			}
			defer closeClient()
			call := func(name, args string) string {
				return `{"jsonrpc":"2.0","id":9007199254740993,"method":"tools/call","params":{"name":"` + name + `","arguments":` + args + "}}\n"
			}
			var out bytes.Buffer
			input := `{"jsonrpc":"2.0","id":1,"method":"tools/list"}` + "\n" +
				call(modality+"_generate", `{"model":"`+model+`","prompt":"plugin prompt"}`) +
				call(modality+"_task_status", `{"task_id":"foreign"}`) + call(modality+"_capabilities", "{}") +
				call(modality+"_generate", `{"model":"`+model+`","prompt":"plugin prompt"}`) + call(modality+"_task_status", `{"task_id":"plugin_one"}`)
			if !video {
				raw, _ := json.Marshal(map[string]any{"model": model, "prompt": "edit prompt", "reference_images": []string{reference}})
				input += call("image_edit", string(raw))
			}
			if serve(context.Background(), strings.NewReader(input), &out, dispatch) != nil {
				t.Fatal("serve")
			}
			expected := int32(4)
			if video {
				expected = 3
			}
			if sends.Load() != expected || generate.Load() != 1 || tasks.Load() != 1 || !video && edit.Load() != 1 {
				t.Fatal("no retry/exact upstream count", sends.Load(), generate.Load(), tasks.Load(), edit.Load())
			}
			if !strings.Contains(out.String(), "result.") || strings.Contains(out.String(), syntheticKey) || strings.Contains(out.String(), key) || !strings.Contains(out.String(), `"isError":true`) {
				t.Fatal("results/secret or no catalog gate")
			}
			// Exiting connector does not own/Stop the gateway; Stop invalidates task.
			if !c.State().Running {
				t.Fatal("connector stopped owner")
			}
			c.Stop()
			out.Reset()
			if serve(context.Background(), strings.NewReader(call(modality+"_task_status", `{"task_id":"plugin_one"}`)), &out, dispatch) != nil || sends.Load() != expected || !strings.Contains(out.String(), `"isError":true`) {
				t.Fatal("Stop/session gate")
			}
		})
	}
}
