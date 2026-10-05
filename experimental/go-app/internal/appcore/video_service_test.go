package appcore

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestVideoActualTCPStrictWireAndSession(t *testing.T) {
	var mu sync.Mutex
	var paths []string
	var submitted map[string]any
	c, endpoint, _, _ := testCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+syntheticKey || r.Header.Get("Cookie") != "" {
			t.Error("video auth/header isolation")
		}
		mu.Lock()
		defer mu.Unlock()
		paths = append(paths, r.URL.Path)
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/v1/models":
			io.WriteString(w, `{"data":[{"id":"MiniMax-H3-Max"},{"id":"seedance-2.5"},{"id":"foreign"}]}`)
		case "/v1/video/generations":
			data, _ := io.ReadAll(r.Body)
			submitted, _ = decodeObject(string(data))
			io.WriteString(w, `{"task_id":"task_video","status":"submitted","key":"private-not-output"}`)
		case "/v1/videos/task_video":
			io.WriteString(w, `{"code":200,"data":{"task_id":"task_video","status":"SUCCESS","result_url":"https://video.example/result.mp4","progress":100,"key":"private-not-output"}}`)
		default:
			t.Error("unexpected video path")
			w.WriteHeader(404)
		}
	}))
	body := `{"model":"seedance-2.5","prompt":" 中文🙂 ","duration":7,"resolution":"720p","reference_images":["https://images.example/a.png"],"aspect_ratio":"adaptive"}`
	code, _, _ := request(t, c, endpoint, "/internal/videos/generate", "POST", body, nil)
	if code != 409 {
		t.Fatal("catalog first", code)
	}
	code, _, _ = request(t, c, endpoint, "/internal/videos/tasks/foreign", "GET", "", nil)
	if code != 404 {
		t.Fatal("foreign task", code)
	}
	mu.Lock()
	count := len(paths)
	mu.Unlock()
	if count != 0 {
		t.Fatal("automatic upstream request")
	}
	code, data, _ := request(t, c, endpoint, "/internal/videos/capabilities", "GET", "", nil)
	if code != 200 || strings.Contains(string(data), "foreign") {
		t.Fatal("catalog", code)
	}
	code, data, _ = request(t, c, endpoint, "/internal/videos/generate", "POST", body, map[string]string{"Cookie": "not-forwarded"})
	var result videoResult
	if code != 200 || json.Unmarshal(data, &result) != nil || result.TaskID != "task_video" || result.Status != "queued" || result.Terminal || strings.Contains(string(data), "private") {
		t.Fatal("submission", code)
	}
	code, data, _ = request(t, c, endpoint, "/internal/videos/tasks/task_video", "GET", "", nil)
	if code != 200 || json.Unmarshal(data, &result) != nil || !result.Terminal || result.Status != "completed" || result.RemoteURL != "https://video.example/result.mp4" || strings.Contains(string(data), "private") {
		t.Fatal("completion", code)
	}
	mu.Lock()
	want, _ := decodeObject(`{"model":"seedance-2.5","prompt":"中文🙂","duration":7,"resolution":"720p","aspect_ratio":"adaptive","image_urls":["https://images.example/a.png"]}`)
	valid := reflect.DeepEqual(submitted, want) && reflect.DeepEqual(paths, []string{"/v1/models", "/v1/video/generations", "/v1/videos/task_video"})
	mu.Unlock()
	if !valid {
		t.Fatal("wire or retry/download")
	}
	c.Stop()
	_ = c.Start()
	code, _, _ = request(t, c, endpoint, "/internal/videos/generate", "POST", body, nil)
	if code != 409 {
		t.Fatal("catalog survived Stop")
	}
	code, _, _ = request(t, c, endpoint, "/internal/videos/tasks/task_video", "GET", "", nil)
	if code != 404 {
		t.Fatal("task survived Stop")
	}
}

func TestVideoRequestContracts(t *testing.T) {
	for _, tc := range []struct{ model, input, want string }{
		{"MiniMax-H3-Max", `{"prompt":"hi"}`, `{"prompt":"hi","duration":5,"resolution":"768P"}`},
		{"seedance-2.5", `{"prompt":"hi"}`, `{"prompt":"hi","duration":4,"resolution":"480p","aspect_ratio":"adaptive"}`},
		{"MiniMax-H3-Max", `{"prompt":"hi","duration":15,"resolution":"1080P","first_frame_image":"https://images.example/a","last_frame_image":"https://images.example/b","aspect_ratio":"adaptive"}`, `{"prompt":"hi","duration":15,"resolution":"1080P","first_frame_image":"https://images.example/a","last_frame_image":"https://images.example/b","aspect_ratio":"adaptive"}`},
	} {
		p, _ := videoBaseProfile(tc.model)
		p.Available = true
		input, _ := decodeObject(tc.input)
		input["model"] = tc.model
		body, _ := json.Marshal(input)
		wire, err := buildVideoGeneration(body, p)
		if err != nil {
			t.Fatal("valid request", err)
		}
		got, _ := decodeObject(string(wire))
		want, _ := decodeObject(tc.want)
		want["model"] = tc.model
		if !reflect.DeepEqual(got, want) {
			t.Fatal("wire defaults")
		}
	}
	p, _ := videoBaseProfile("seedance-2.5")
	p.Available = true
	for _, bad := range []string{
		`"duration":3`, `"duration":31`, `"duration":4.0`, `"duration":"4"`, `"duration":null`,
		`"resolution":"480P"`, `"resolution":null`, `"aspect_ratio":"3:2"`,
		`"audio":true`, `"generate_audio":false`, `"seconds":4`, `"n":1`, `"unknown":1`,
		`"reference_images":null`, `"reference_images":["data:image/png;base64,AAAA"]`,
		`"reference_images":["https://127.0.0.1/a"]`, `"reference_images":["https://images.example/a"],"aspect_ratio":"16:9"`,
		`"first_frame_image":"https://images.example/a","reference_images":["https://images.example/b"]`,
		`"first_frame_image":"https://images.example/a","aspect_ratio":"16:9"`,
		`"first_frame_image":null`, `"first_frame_image":"asset:img_fake"`,
	} {
		if _, err := buildVideoGeneration([]byte(`{"model":"seedance-2.5","prompt":"hi",`+bad+"}"), p); err == nil {
			t.Fatal("accepted unsupported", bad)
		}
	}
	for _, prompt := range []string{"", " ", strings.Repeat("🙂", 3501), strings.Repeat("a", 7001)} {
		body, _ := json.Marshal(map[string]any{"model": p.ID, "prompt": prompt})
		if _, err := buildVideoGeneration(body, p); err == nil {
			t.Fatal("prompt limit")
		}
	}
	for _, prompt := range []string{strings.Repeat("🙂", 3500), strings.Repeat("a", 7000)} {
		body, _ := json.Marshal(map[string]any{"model": p.ID, "prompt": prompt})
		if _, err := buildVideoGeneration(body, p); err != nil {
			t.Fatal("UTF16 boundary")
		}
	}
	refs := make([]string, 31)
	for i := range refs {
		refs[i] = "https://images.example/a"
	}
	body, _ := json.Marshal(map[string]any{"model": p.ID, "prompt": "hi", "reference_images": refs})
	if _, err := buildVideoGeneration(body, p); err == nil {
		t.Fatal("references limit")
	}
}

func TestVideoResultStrictEnvelopes(t *testing.T) {
	for _, good := range []string{
		`{"task_id":"task_one","status":"submitted"}`,
		`{"id":"task_one","status":"in_progress","progress":0}`,
		`{"code":200,"data":{"task_id":"task_one","status":"SUCCESS","result_url":"https://video.example/a"}}`,
		`{"task_id":"task_one","status":"failed","error":{"message":"private"}}`,
		`{"task_id":"task_one","status":"completed","metadata":{"url":"https://video.example/a"}}`,
	} {
		result, err := parseVideoResult([]byte(good), "task_one")
		if err != nil || result.TaskID != "task_one" || strings.Contains(result.Error, "private") {
			t.Fatal("valid result")
		}
	}
	for _, bad := range []string{
		`{}`, `{"task_id":"task_one","status":"completed"}`,
		`{"task_id":"task_one","status":"queued","url":"https://video.example/a"}`,
		`{"task_id":"task_one","status":"failed","url":"https://video.example/a"}`,
		`{"task_id":"other","status":"queued"}`,
		`{"task_id":"task_one","id":"other","status":"queued"}`,
		`{"task_id":"task_one","status":"queued","data":{"status":"failed"}}`,
		`{"task_id":"task_one","status":"queued","progress":101}`,
		`{"task_id":"task_one","status":"queued","progress":0.5}`,
		`{"task_id":"task_one","status":"queued","error":{"message":"private"}}`,
		`{"task_id":"task_one","status":"completed","url":"https://127.0.0.1/a"}`,
		`{"task_id":"task_one","status":"completed","url":"https://video.example/a","result":{"url":"https://video.example/b"}}`,
		`{"task_id":"task_one","status":"weird"}`,
		`{"task_id":"task_one","status":"queued","status":"failed"}`,
	} {
		if _, err := parseVideoResult([]byte(bad), "task_one"); err == nil {
			t.Fatal("accepted bad envelope", bad)
		}
	}
}

func TestVideoCatalogErrorsFailClosedNoFallback(t *testing.T) {
	for _, status := range []int{401, 403, 404, 429, 500} {
		var calls atomic.Int32
		c, endpoint, _, _ := testCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			calls.Add(1)
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(status)
			io.WriteString(w, syntheticKey)
		}))
		code, data, _ := request(t, c, endpoint, "/internal/videos/capabilities", "GET", "", nil)
		if code != status || calls.Load() != 1 || strings.Contains(string(data), syntheticKey) {
			t.Fatal("error/fallback")
		}
	}
	for _, bad := range []string{`{}`, `{"data":null}`, `{"data":[{"id":17}]}`, `{"data":[{"id":"seedance-2.5"},{"id":"seedance-2.5"}]}`} {
		if _, err := parseVideoCatalog([]byte(bad)); err == nil {
			t.Fatal("catalog invalid")
		}
	}
}

func TestVideoStopCancelsPendingNoLateTask(t *testing.T) {
	started := make(chan struct{})
	release := make(chan struct{})
	var sends atomic.Int32
	c, endpoint, _, _ := testCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/v1/models" {
			io.WriteString(w, `{"data":[{"id":"seedance-2.5"}]}`)
			return
		}
		sends.Add(1)
		close(started)
		select {
		case <-release:
		case <-r.Context().Done():
		}
		io.WriteString(w, `{"task_id":"task_late","status":"queued"}`)
	}))
	defer close(release)
	request(t, c, endpoint, "/internal/videos/capabilities", "GET", "", nil)
	done := make(chan int, 1)
	go func() {
		_, status := c.DesktopVideos(context.Background(), "/internal/videos/generate", []byte(`{"model":"seedance-2.5","prompt":"hi"}`))
		done <- status
	}()
	select {
	case <-started:
	case <-time.After(3 * time.Second):
		t.Fatal("no send")
	}
	c.Stop()
	select {
	case status := <-done:
		if status == 200 {
			t.Fatal("late success")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("stop did not cancel")
	}
	_ = c.Start()
	code, _, _ := request(t, c, endpoint, "/internal/videos/tasks/task_late", "GET", "", nil)
	if code != 404 || sends.Load() != 1 {
		t.Fatal("late task/retry")
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.active != 0 || c.videos.pending != 0 {
		t.Fatal("admission leak")
	}
}
