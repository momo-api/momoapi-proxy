//go:build appcheck && !nogui

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"reflect"
	"strings"
	"time"

	"github.com/momo-api/momoapi-proxy/experimental/go-app/internal/appcore"
	"github.com/momo-api/momoapi-proxy/experimental/go-app/internal/integration"
)

func probeMediaUpstream(w http.ResponseWriter, r *http.Request, data []byte) bool {
	switch r.URL.Path {
	case "/agent/media-capabilities":
		if r.Method != "GET" || len(data) != 0 {
			w.WriteHeader(400)
			return true
		}
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"models":[{"id":"momoapi-gpt-image-2-5-flare","modality":"image","available":true,"operations":["generate","edit"],"parameters":{"max_reference_images":{"maximum":2}}},{"id":"gemini-3.1-flash-image","modality":"image","available":true,"operations":["generate","edit"],"parameters":{},"transports":{"edit":"chat-completions-multimodal"}}]}`)
	case "/v1/chat/completions":
		var body map[string]any
		if json.Unmarshal(data, &body) != nil || body["model"] != "gemini-3.1-flash-image" {
			return false
		}
		messages, _ := body["messages"].([]any)
		if len(messages) != 1 {
			w.WriteHeader(400)
			return true
		}
		m, _ := messages[0].(map[string]any)
		parts, _ := m["content"].([]any)
		if len(parts) != 2 {
			w.WriteHeader(400)
			return true
		}
		text, _ := parts[0].(map[string]any)
		prompt, _ := text["text"].(string)
		if prompt != "gemini-edit-api" && prompt != "gemini-edit-mcp" && prompt != "gemini-edit-connected" && prompt != "gemini-edit-gui" {
			w.WriteHeader(400)
			return true
		}
		want := map[string]any{"model": "gemini-3.1-flash-image", "messages": []any{map[string]any{"role": "user", "content": []any{map[string]any{"type": "text", "text": prompt}, map[string]any{"type": "image_url", "image_url": map[string]any{"url": probeImageURL}}}}}, "modalities": []any{"text", "image"}, "extra_body": map[string]any{"google": map[string]any{"image_config": map[string]any{"aspect_ratio": "1:1", "image_size": "1K"}}}}
		if r.Method != "POST" || !reflect.DeepEqual(body, want) {
			w.WriteHeader(400)
			return true
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"index": 0, "finish_reason": "stop", "message": map[string]any{"role": "assistant", "images": []any{map[string]any{"type": "image_url", "image_url": map[string]any{"url": probeImageURL}}}}}}})
	case "/v1/images/edits":
		var body map[string]any
		if r.Method != "POST" || json.Unmarshal(data, &body) != nil || len(body) != 4 || body["model"] != "momoapi-gpt-image-2-5-flare" || body["n"] != float64(1) {
			w.WriteHeader(400)
			return true
		}
		prompt, ok := body["prompt"].(string)
		refs, refsOK := body["images"].([]any)
		const reference = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
		if !ok || !refsOK || len(refs) != 1 || refs[0] != reference || !includesProbeEditPrompt(prompt) {
			w.WriteHeader(400)
			return true
		}
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"task_id":"task_`+prompt+`","status":"submitted"}`)
	case "/v1/tasks/task_edit-api", "/v1/tasks/task_edit-mcp", "/v1/tasks/task_edit-connected", "/v1/tasks/task_edit-gui":
		if r.Method != "GET" || len(data) != 0 {
			w.WriteHeader(400)
			return true
		}
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"task_id":"`+strings.TrimPrefix(r.URL.Path, "/v1/tasks/")+`","status":"completed","url":"https://images.example/edited.png"}`)
	case "/v1/images/generations":
		if r.Method != "POST" || (string(data) != `{"model":"momoapi-gpt-image-2-5-flare","n":1,"prompt":"media-probe"}` && string(data) != `{"model":"momoapi-gpt-image-2-5-flare","n":1,"prompt":"gui-inline-probe"}` && string(data) != `{"model":"momoapi-gpt-image-2-5-flare","n":1,"prompt":"mcp-probe"}` && string(data) != `{"model":"momoapi-gpt-image-2-5-flare","n":1,"prompt":"mcp-connected-probe"}`) {
			w.WriteHeader(400)
			return true
		}
		w.Header().Set("Content-Type", "application/json")
		if strings.Contains(string(data), "mcp-connected-probe") {
			io.WriteString(w, `{"task_id":"task_mcp_connected","status":"submitted"}`)
			return true
		}
		if strings.Contains(string(data), "mcp-probe") {
			io.WriteString(w, `{"task_id":"task_mcp_probe","status":"submitted"}`)
			return true
		}
		if strings.Contains(string(data), "gui-inline-probe") {
			io.WriteString(w, `{"data":[{"b64_json":"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="}]}`)
			return true
		}
		io.WriteString(w, `{"data":[{"status":"submitted","task_id":"task_media_probe"}]}`)
	case "/v1/tasks/task_media_probe", "/v1/tasks/task_mcp_probe", "/v1/tasks/task_mcp_connected":
		if r.Method != "GET" || len(data) != 0 {
			w.WriteHeader(400)
			return true
		}
		w.Header().Set("Content-Type", "application/json")
		if strings.HasSuffix(r.URL.Path, "task_mcp_connected") {
			io.WriteString(w, `{"task_id":"task_mcp_connected","status":"completed","url":"https://images.example/connected.png"}`)
			return true
		}
		if strings.HasSuffix(r.URL.Path, "task_mcp_probe") {
			io.WriteString(w, `{"task_id":"task_mcp_probe","status":"completed","url":"https://images.example/mcp.png"}`)
			return true
		}
		io.WriteString(w, `{"data":{"id":"task_media_probe","status":"completed","result":{"images":[{"url":["https://images.example/probe.png"]}]}}}`)
	default:
		return false
	}
	return true
}

func probeMediaRequests(core *appcore.Core) error {
	base, key, err := probeCredentials(core)
	if err != nil {
		return err
	}
	client := http.Client{Timeout: 4 * time.Second}
	defer client.CloseIdleConnections()
	for _, tc := range []struct{ method, path, body string }{{"GET", "/internal/images/capabilities", ""}, {"POST", "/internal/images/generate", `{"model":"momoapi-gpt-image-2-5-flare","prompt":"media-probe"}`}, {"GET", "/internal/images/tasks/task_media_probe", ""}} {
		r, _ := http.NewRequest(tc.method, strings.TrimSuffix(base, "/v1")+tc.path, strings.NewReader(tc.body))
		r.Header.Set("Authorization", "Bearer "+key)
		r.Header.Set("Content-Type", "application/json")
		response, err := client.Do(r)
		if err != nil {
			return err
		}
		data, err := io.ReadAll(io.LimitReader(response.Body, 16385))
		response.Body.Close()
		var result map[string]any
		if err != nil || response.StatusCode != 200 || len(data) > 16384 || json.Unmarshal(data, &result) != nil {
			return errors.New("media chain probe")
		}
		if tc.path == "/internal/images/generate" && (result["task_id"] != "task_media_probe" || result["terminal"] != false) {
			return errors.New("media submit probe")
		}
		if strings.Contains(tc.path, "/tasks/") && (result["terminal"] != true || !strings.Contains(string(data), "https://images.example/probe.png")) {
			return errors.New("media completion probe")
		}
	}
	// Native runner exercises the same opt-in MCP stream against real TLS mock,
	// not a stubbed dispatcher. Normal shipped-binary tests cover CLI ownership.
	input := `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"image_capabilities","arguments":{}}}
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"image_generate","arguments":{"confirmed":true,"request":{"model":"momoapi-gpt-image-2-5-flare","prompt":"mcp-probe"}}}}
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"image_task","arguments":{"task_id":"task_mcp_probe"}}}
`
	var output bytes.Buffer
	if integration.ServeImageMCP(context.Background(), strings.NewReader(input), &output, core.DesktopImages) != nil || strings.Count(output.String(), "\n") != 3 || strings.Contains(output.String(), `"isError":true`) || !strings.Contains(output.String(), "https://images.example/mcp.png") || strings.Contains(output.String(), "synthetic-appcheck-only") || strings.Contains(output.String(), key) {
		return errors.New("image MCP native probe")
	}
	dispatch, closeClient, err := integration.NewLocalImageDispatch(strings.TrimSuffix(base, "/v1"), key)
	if err != nil {
		return errors.New("image MCP connector probe")
	}
	defer closeClient()
	input = strings.ReplaceAll(strings.ReplaceAll(input, "mcp-probe", "mcp-connected-probe"), "task_mcp_probe", "task_mcp_connected")
	output.Reset()
	if integration.ServeImageMCP(context.Background(), strings.NewReader(input), &output, dispatch) != nil || strings.Count(output.String(), "\n") != 3 || strings.Contains(output.String(), `"isError":true`) || !strings.Contains(output.String(), "https://images.example/connected.png") || strings.Contains(output.String(), key) {
		return errors.New("image MCP connected TCP probe")
	}
	if err := probeImageEditRequests(core); err != nil {
		return err
	}
	return probeVideoRequests(core)
}

func includesProbeEditPrompt(s string) bool {
	return s == "edit-api" || s == "edit-mcp" || s == "edit-connected" || s == "edit-gui"
}

func probeImageEditRequests(core *appcore.Core) error {
	const reference = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
	base, key, err := probeCredentials(core)
	if err != nil {
		return err
	}
	request := func(prompt string) string {
		raw, _ := json.Marshal(map[string]any{"model": "momoapi-gpt-image-2-5-flare", "prompt": prompt, "reference_images": []string{reference}})
		return string(raw)
	}
	// First API path, then both explicit MCP dispatch modes: 6 physical TLS sends.
	_, code := core.DesktopImages(context.Background(), "/internal/images/edit", []byte(request("edit-api")))
	if code != 200 {
		return errors.New("API image edit submit")
	}
	data, code := core.DesktopImages(context.Background(), "/internal/images/tasks/task_edit-api", nil)
	if code != 200 || !strings.Contains(string(data), "edited.png") {
		return errors.New("API image edit task")
	}
	connected, closeClient, err := integration.NewLocalImageDispatch(strings.TrimSuffix(base, "/v1"), key)
	if err != nil {
		return err
	}
	defer closeClient()
	for _, tc := range []struct {
		prompt   string
		dispatch integration.ImageDispatch
	}{{"edit-mcp", core.DesktopImages}, {"edit-connected", connected}} {
		input := `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"image_edit","arguments":{"confirmed":true,"request":` + request(tc.prompt) + `}}}` + "\n" + `{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"image_task","arguments":{"task_id":"task_` + tc.prompt + `"}}}` + "\n"
		var out bytes.Buffer
		if integration.ServeImageMCP(context.Background(), strings.NewReader(input), &out, tc.dispatch) != nil || strings.Count(out.String(), "\n") != 2 || strings.Contains(out.String(), `"isError":true`) || !strings.Contains(out.String(), "edited.png") || strings.Contains(out.String(), key) {
			return errors.New("image edit MCP submit/task")
		}
	}
	for _, tc := range []struct {
		prompt   string
		dispatch integration.ImageDispatch
	}{{"gemini-edit-api", core.DesktopImages}, {"gemini-edit-mcp", core.DesktopImages}, {"gemini-edit-connected", connected}} {
		raw, _ := json.Marshal(map[string]any{"model": "gemini-3.1-flash-image", "prompt": tc.prompt, "reference_images": []string{reference}})
		if tc.prompt == "gemini-edit-api" {
			data, code := tc.dispatch(context.Background(), "/internal/images/edit", raw)
			if code != 200 || !strings.Contains(string(data), `"terminal":true`) || !strings.Contains(string(data), "b64_json") {
				return errors.New("Gemini API image edit")
			}
		} else {
			input := `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"image_edit","arguments":{"confirmed":true,"request":` + string(raw) + `}}}` + "\n"
			var out bytes.Buffer
			if integration.ServeImageMCP(context.Background(), strings.NewReader(input), &out, tc.dispatch) != nil || strings.Contains(out.String(), `"isError":true`) || !strings.Contains(out.String(), "b64_json") {
				return errors.New("Gemini MCP image edit")
			}
		}
	}
	return nil
}
