package appcore

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestGeminiImageEditCatalogAndExactChatWire(t *testing.T) {
	profiles, err := parseImageCatalog([]byte(fixtureImageCatalog("gemini-3.1-flash-image")))
	if err != nil {
		t.Fatal(err)
	}
	p := profiles["gemini-3.1-flash-image"]
	reference := inlineFixture(t, "image/png")
	raw, _ := json.Marshal(map[string]any{"model": p.ID, "prompt": " edit 🙂 ", "aspect_ratio": "4:3", "resolution": "2k", "reference_images": []string{reference}})
	wire, n, path, err := buildImageEdit(raw, p)
	if err != nil || n != 1 || path != "/v1/chat/completions" {
		t.Fatal("Gemini chat editing unavailable", err)
	}
	got, _ := decodeVideoObject(wire)
	want := map[string]any{"model": p.ID, "messages": []any{map[string]any{"role": "user", "content": []any{map[string]any{"type": "text", "text": "edit 🙂"}, map[string]any{"type": "image_url", "image_url": map[string]any{"url": reference}}}}}, "modalities": []any{"text", "image"}, "extra_body": map[string]any{"google": map[string]any{"image_config": map[string]any{"aspect_ratio": "4:3", "image_size": "2K"}}}}
	if !reflect.DeepEqual(got, want) {
		t.Fatal("Gemini edit wire differs")
	}
}

func TestGeminiEditPermissionInputAndStop(t *testing.T) {
	ref := inlineFixture(t, "image/png")
	profiles, _ := parseImageCatalog([]byte(fixtureImageCatalog("gemini-3.1-flash-image")))
	p := profiles["gemini-3.1-flash-image"]
	for _, request := range []map[string]any{
		{"model": p.ID, "prompt": "edit", "reference_images": []string{ref, ref}},
		{"model": p.ID, "prompt": "edit", "reference_images": []string{"https://images.example/a.png"}},
		{"model": p.ID, "prompt": "edit", "n": 2, "reference_images": []string{ref}},
		{"model": p.ID, "prompt": "edit", "resolution": "8k", "reference_images": []string{ref}},
		{"model": p.ID, "prompt": "edit", "mask": ref, "reference_images": []string{ref}},
		{"model": p.ID, "prompt": "edit", "stream": true, "reference_images": []string{ref}},
	} {
		raw, _ := json.Marshal(request)
		if _, _, _, err := buildImageEdit(raw, p); err == nil {
			t.Fatal("unsupported Gemini edit accepted")
		}
	}
	for _, catalog := range []string{
		strings.Replace(fixtureImageCatalog(p.ID), `["generate","edit"]`, `["generate"]`, 1),
		strings.Replace(fixtureImageCatalog(p.ID), `"parameters":{}`, `"parameters":{},"transports":{"edit":"images-generations-reference"}`, 1),
		strings.Replace(fixtureImageCatalog(p.ID), `"parameters":{}`, `"parameters":{"max_reference_images":{"minimum":2}}`, 1),
	} {
		profiles, err := parseImageCatalog([]byte(catalog))
		if err != nil || includes(profiles[p.ID].Operations, "edit") {
			t.Fatal("catalog cannot authorize different transport/count")
		}
	}
	entered, exited := make(chan struct{}), make(chan struct{})
	var sends atomic.Int32
	c, endpoint, _, _ := testCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/agent/media-capabilities" {
			io.WriteString(w, fixtureImageCatalog(p.ID))
			return
		}
		io.Copy(io.Discard, r.Body)
		sends.Add(1)
		close(entered)
		select {
		case <-r.Context().Done():
		case <-time.After(5 * time.Second):
		}
		close(exited)
	}))
	readyImageCatalog(t, c, endpoint)
	raw, _ := json.Marshal(map[string]any{"model": p.ID, "prompt": "edit", "reference_images": []string{ref}})
	done := make(chan int, 1)
	go func() { _, code := c.DesktopImages(context.Background(), "/internal/images/edit", raw); done <- code }()
	select {
	case <-entered:
	case <-time.After(3 * time.Second):
		t.Fatal("no Chat send")
	}
	c.Stop()
	select {
	case code := <-done:
		if code == 200 {
			t.Fatal("cancelled Chat edit success")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("Chat edit Stop stalled")
	}
	select {
	case <-exited:
	case <-time.After(3 * time.Second):
		t.Fatal("Chat edit upstream not cancelled")
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if sends.Load() != 1 || len(c.images.tasks) != 0 || c.images.pending != 0 {
		t.Fatal("late state or retry")
	}
}

func TestChatImageFinishedKnownOutputsAndRejections(t *testing.T) {
	ref := inlineFixture(t, "image/png")
	part := map[string]any{"type": "image_url", "image_url": map[string]any{"url": ref}}
	makeBody := func(message map[string]any, finish any) []byte {
		raw, _ := json.Marshal(map[string]any{"choices": []any{map[string]any{"index": 0, "message": message, "finish_reason": finish}}})
		return raw
	}
	for _, m := range []map[string]any{
		{"role": "assistant", "content": "do not echo", "images": []any{part}},
		{"role": "assistant", "content": []any{map[string]any{"type": "text", "text": "do not echo"}, part}},
		{"role": "assistant", "content": nil, "images": []any{map[string]any{"type": "image_url", "image_url": map[string]any{"url": "https://images.example/output.png"}}}},
	} {
		result, err := parseChatImageResult(makeBody(m, "stop"), 1)
		if err != nil || !result.Terminal || len(result.Images) != 1 || result.TaskID != "" {
			t.Fatal("finished image rejected")
		}
		raw, _ := json.Marshal(result)
		if strings.Contains(string(raw), "do not echo") {
			t.Fatal("prose reflected")
		}
	}
	for _, finish := range []any{nil, "length", "content_filter", "tool_calls", "unknown"} {
		if _, err := parseChatImageResult(makeBody(map[string]any{"role": "assistant", "images": []any{part}}, finish), 1); err == nil {
			t.Fatal("unfinished/refused accepted")
		}
	}
	for _, m := range []map[string]any{
		{"role": "user", "images": []any{part}},
		{"role": "assistant", "content": ref},
		{"role": "assistant", "content": []any{map[string]any{"type": "text", "text": ref}}},
		{"role": "assistant", "images": []any{part, part}},
		{"role": "assistant", "refusal": "no", "images": []any{part}},
		{"role": "assistant", "tool_calls": []any{}, "images": []any{part}},
		{"role": "assistant", "images": []any{map[string]any{"type": "image_url", "image_url": map[string]any{"url": "data:image/png;base64,AA=="}}}},
		{"role": "assistant", "images": []any{map[string]any{"type": "image_url", "image_url": map[string]any{"url": "https://user:pass@images.example/private"}}}},
		{"role": "assistant", "images": []any{map[string]any{"type": "image_url", "image_url": map[string]any{"url": ref, "detail": "high"}}}},
	} {
		if _, err := parseChatImageResult(makeBody(m, "stop"), 1); err == nil {
			t.Fatal("bad output accepted")
		}
	}
	for _, raw := range [][]byte{
		[]byte(`{"choices":[],"choices":[]}`), []byte(`{"choices":[],"data":[{"url":"https://images.example/a"}]}`), []byte("data: [DONE]\n\n"), {0xff}, []byte(`{"choices":[]}{}`),
	} {
		if _, err := parseChatImageResult(raw, 1); err == nil {
			t.Fatal("invalid chat envelope")
		}
	}
}

func TestGeminiImageEditActualTCPOutputAndNoTaskOnFailure(t *testing.T) {
	ref := inlineFixture(t, "image/png")
	var sends atomic.Int32
	var refuse atomic.Bool
	c, endpoint, _, _ := testCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/agent/media-capabilities" {
			io.WriteString(w, fixtureImageCatalog("gemini-3.1-flash-image"))
			return
		}
		if r.URL.Path != "/v1/chat/completions" {
			t.Error("unexpected transport")
			w.WriteHeader(404)
			return
		}
		sends.Add(1)
		raw, _ := io.ReadAll(r.Body)
		got, _ := decodeVideoObject(raw)
		if got["modalities"] == nil || got["stream"] != nil || got["n"] != nil || got["model"] != "gemini-3.1-flash-image" {
			t.Error("wrong chat wire")
		}
		finish := "stop"
		if refuse.Load() {
			finish = "content_filter"
		}
		json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"index": 0, "finish_reason": finish, "message": map[string]any{"role": "assistant", "images": []any{map[string]any{"type": "image_url", "image_url": map[string]any{"url": ref}}}}}}})
	}))
	raw, _ := json.Marshal(map[string]any{"model": "gemini-3.1-flash-image", "prompt": "edit", "reference_images": []string{ref}})
	code, _, _ := request(t, c, endpoint, "/internal/images/edit", "POST", string(raw), nil)
	if code != 409 || sends.Load() != 0 {
		t.Fatal("fresh directory gate")
	}
	readyImageCatalog(t, c, endpoint)
	code, data, _ := request(t, c, endpoint, "/internal/images/edit", "POST", string(raw), nil)
	if code != 200 || !strings.Contains(string(data), `"terminal":true`) || !strings.Contains(string(data), "b64_json") || sends.Load() != 1 {
		t.Fatal("actual edit result", code)
	}
	refuse.Store(true)
	code, _, _ = request(t, c, endpoint, "/internal/images/edit", "POST", string(raw), nil)
	if code != 502 || sends.Load() != 2 {
		t.Fatal("failure no retry", code)
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.images.tasks) != 0 || c.images.pending != 0 {
		t.Fatal("Chat response fabricated task")
	}
}
