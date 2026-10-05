package appcore

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func fixtureImageCatalog(id string) string {
	return fmt.Sprintf(`{"models":[{"id":%q,"modality":"image","available":true,"operations":["generate","edit"],"parameters":{},"key":"private-do-not-expose"}],"account":"private-do-not-expose"}`, id)
}
func readyImageCatalog(t *testing.T, c *Core, endpoint string) {
	t.Helper()
	status, data, _ := request(t, c, endpoint, "/internal/images/capabilities", "GET", "", nil)
	if status != 200 || strings.Contains(string(data), "private-do-not-expose") || strings.Contains(string(data), syntheticKey) {
		t.Fatal("image catalog", status)
	}
}
func TestImageCatalogAndGenerateTaskActualTCP(t *testing.T) {
	var mu sync.Mutex
	paths := []string{}
	bodies := []string{}
	c, endpoint, _, _ := testCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+syntheticKey || r.Header.Get("Cookie") != "" || r.Header.Get("X-MOMO-Attachments") != "" {
			t.Error("image upstream headers")
		}
		body, _ := io.ReadAll(r.Body)
		mu.Lock()
		paths = append(paths, r.URL.Path)
		bodies = append(bodies, string(body))
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/agent/media-capabilities":
			io.WriteString(w, fixtureImageCatalog("momoapi-gpt-image-2-5-flare"))
		case "/v1/images/generations":
			io.WriteString(w, `{"data":[{"status":"submitted","task_id":"task_one","private":"private-do-not-expose"}]}`)
		case "/v1/tasks/task_one":
			io.WriteString(w, `{"code":200,"data":{"id":"task_one","status":"completed","result":{"images":[{"url":["https://images.example/result.png"]}]},"key":"private-do-not-expose"}}`)
		default:
			t.Error("unexpected image path")
			w.WriteHeader(404)
		}
	}))
	body := `{"model":"momoapi-gpt-image-2-5-flare","prompt":" 中文🙂 ","n":1,"quality":"high","aspect_ratio":"16:9"}`
	code, _, _ := request(t, c, endpoint, "/internal/images/generate", "POST", body, nil)
	if code != 409 {
		t.Fatal("no catalog")
	}
	code, _, _ = request(t, c, endpoint, "/internal/images/tasks/foreign", "GET", "", nil)
	if code != 404 {
		t.Fatal("foreign task")
	}
	mu.Lock()
	if len(paths) != 0 {
		t.Error("automatic calls")
	}
	mu.Unlock()
	readyImageCatalog(t, c, endpoint)
	code, data, _ := request(t, c, endpoint, "/internal/images/generate", "POST", body, map[string]string{"Cookie": "private-client"})
	if code != 200 || strings.Contains(string(data), "private") {
		t.Fatal("generate", code)
	}
	var result imageResult
	_ = json.Unmarshal(data, &result)
	if result.TaskID != "task_one" || result.Status != "submitted" || result.Terminal || len(result.Images) != 0 {
		t.Fatal("submitted result")
	}
	code, data, _ = request(t, c, endpoint, "/internal/images/tasks/task_one", "GET", "", nil)
	if code != 200 || strings.Contains(string(data), "private") {
		t.Fatal("task")
	}
	_ = json.Unmarshal(data, &result)
	if !result.Terminal || len(result.Images) != 1 || result.Images[0].URL != "https://images.example/result.png" {
		t.Fatal("completed task")
	}
	mu.Lock()
	gotPaths := append([]string{}, paths...)
	gotBody := bodies[1]
	mu.Unlock()
	if !reflect.DeepEqual(gotPaths, []string{"/agent/media-capabilities", "/v1/images/generations", "/v1/tasks/task_one"}) {
		t.Fatal("retry/fetch/poll")
	}
	p, _ := decodeObject(gotBody)
	want, _ := decodeObject(`{"model":"momoapi-gpt-image-2-5-flare","prompt":"中文🙂","n":1,"quality":"high","size":"16:9"}`)
	if !reflect.DeepEqual(p, want) {
		t.Fatal("web generation wire")
	}
	c.Stop()
	if c.Start() != nil {
		t.Fatal("restart")
	}
	code, _, _ = request(t, c, endpoint, "/internal/images/tasks/task_one", "GET", "", nil)
	if code != 404 {
		t.Fatal("task survived Stop")
	}
	code, _, _ = request(t, c, endpoint, "/internal/images/generate", "POST", body, nil)
	if code != 409 {
		t.Fatal("catalog survived Stop")
	}
}

func TestImageGenerationProfileWireAndStrictControls(t *testing.T) {
	for _, tc := range []struct{ id, request, want string }{
		{"momoapi-gpt-image-2-5-flare", `{"prompt":"hi","n":2,"size":"1024x1024","quality":"high"}`, `{"prompt":"hi","n":2,"size":"1024x1024","quality":"high"}`},
		{"momoapi-gpt-image-2-5-prism", `{"prompt":"hi","aspect_ratio":"4:3","quality":"low"}`, `{"prompt":"hi","n":1,"aspect_ratio":"4:3","quality":"low"}`},
		{"momoapi-gemini-nano-banana-3", `{"prompt":"hi","resolution":"4k"}`, `{"prompt":"hi","n":1,"aspect_ratio":"1:1","resolution":"4k"}`},
		{"gpt-image-2.5-flare", `{"prompt":"hi","n":4,"size":"1536x1024","quality":"max","output_format":"webp","output_compression":80,"background":"transparent"}`, `{"prompt":"hi","n":4,"size":"1536x1024","resolution":"1k","quality":"max","output_format":"webp","output_compression":80,"background":"transparent","moderation":"low"}`},
		{"gpt-image-2", `{"prompt":"hi","aspect_ratio":"16:9","resolution":"4k"}`, `{"prompt":"hi","n":1,"size":"1536x1024","quality":"high"}`},
		{"gemini-3.1-flash-image", `{"prompt":"hi","aspect_ratio":"4:3","resolution":"2k"}`, `{"prompt":"hi","n":1,"size":"4:3","quality":"2K"}`},
	} {
		t.Run(tc.id, func(t *testing.T) {
			p, _ := imageBaseProfile(tc.id)
			p.Available = true
			input, _ := decodeObject(tc.request)
			input["model"] = tc.id
			raw, _ := json.Marshal(input)
			wire, _, err := buildImageGeneration(raw, p)
			if err != nil {
				t.Fatal(err)
			}
			got, _ := decodeObject(string(wire))
			want, _ := decodeObject(tc.want)
			want["model"] = tc.id
			if !reflect.DeepEqual(got, want) {
				t.Fatal("profile wire")
			}
		})
	}
	p, _ := imageBaseProfile("gpt-image-2.5-flare")
	p.Available = true
	for _, bad := range []string{`"n":"1"`, `"n":null`, `"n":1.5`, `"n":5`, `"stream":false`, `"partial_images":0`, `"reference_images":[]`, `"model":null`, `"quality":"bad"`, `"size":"10x10"`, `"size":"1024x1024","aspect_ratio":"1:1"`, `"output_format":"png","output_compression":80`, `"output_format":"jpeg","background":"transparent"`, `"input_fidelity":"high"`, `"resolution":"8k"`, `"mask":"bad"`} {
		body := `{"model":"gpt-image-2.5-flare","prompt":"hi",` + bad + "}"
		if _, _, err := buildImageGeneration([]byte(body), p); err == nil {
			t.Fatal("accepted control", bad)
		}
	}
	for _, prompt := range []string{"", " ", strings.Repeat("a", 32001)} {
		raw, _ := json.Marshal(map[string]any{"model": p.ID, "prompt": prompt})
		if _, _, err := buildImageGeneration(raw, p); err == nil {
			t.Fatal("prompt")
		}
	}
	for _, s := range []string{"auto", "1024x1024", "1536x1024", "3840x2160", "1280x512"} {
		if s != "auto" && !validNativeImageSize(s) {
			t.Fatal("valid size", s)
		}
	}
	for _, s := range []string{"01024x1024", "1024x1", "4096x1024", "100x100", "1024x1025", "0x0", "1024x1024x1024"} {
		if validNativeImageSize(s) {
			t.Fatal("bad size", s)
		}
	}
}

func TestImageCatalogConstraintsFallbackAndRedaction(t *testing.T) {
	p := fixtureImageCatalog("momoapi-gpt-image-2-5-flare")
	p = strings.Replace(p, `"parameters":{}`, `"parameters":{"n":{"allowed":[2,4]},"quality":{"allowed":["high"]}}`, 1)
	profiles, err := parseImageCatalog([]byte(p))
	if err != nil {
		t.Fatal(err)
	}
	profile := profiles["momoapi-gpt-image-2-5-flare"]
	if !reflect.DeepEqual(profile.AllowedN, []int{2, 4}) || profile.MaxN != 4 {
		t.Fatal("N catalog set")
	}
	if _, _, err := buildImageGeneration([]byte(`{"model":"momoapi-gpt-image-2-5-flare","prompt":"hi","n":3}`), profile); err == nil {
		t.Fatal("gap in n set")
	}
	for _, bad := range []string{"{}", `{"models":null}`, strings.Replace(p, `"available":true`, `"available":"true"`, 1), strings.Replace(p, `[2,4]`, `["2"]`, 1), strings.Replace(p, `["high"]`, `["foreign"]`, 1)} {
		if _, err := parseImageCatalog([]byte(bad)); err == nil {
			t.Fatal("invalid catalog")
		}
	}
	for _, status := range []int{401, 403, 429, 500, 404, 405} {
		t.Run(fmt.Sprint(status), func(t *testing.T) {
			var calls atomic.Int32
			c, endpoint, _, _ := testCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				w.Header().Set("Content-Type", "application/json")
				if r.URL.Path == "/agent/media-capabilities" {
					w.WriteHeader(status)
					io.WriteString(w, syntheticKey)
					return
				}
				if r.URL.Path != "/v1/models" {
					t.Error("fallback path")
				}
				io.WriteString(w, `{"data":[{"id":"momoapi-gpt-image-2-5-flare"},{"id":"gpt-image-2.5-flare"}]}`)
			}))
			code, data, _ := request(t, c, endpoint, "/internal/images/capabilities", "GET", "", nil)
			if strings.Contains(string(data), syntheticKey) {
				t.Fatal("error echoed")
			}
			if status == 404 || status == 405 {
				if code != 200 || calls.Load() != 2 {
					t.Fatal("minimal fallback")
				}
				c.mu.Lock()
				profile := c.images.profiles["momoapi-gpt-image-2-5-flare"]
				_, hasAPIMart := c.images.profiles["gpt-image-2.5-flare"]
				c.mu.Unlock()
				if hasAPIMart || profile.profile != "minimal" || profile.MaxN != 1 {
					t.Fatal("unverified controls")
				}
				if _, _, err := buildImageGeneration([]byte(`{"model":"momoapi-gpt-image-2-5-flare","prompt":"hi","quality":"high"}`), profile); err == nil {
					t.Fatal("fallback extra control")
				}
			} else if code != status || calls.Load() != 1 {
				t.Fatal("fallback on error")
			}
		})
	}
}

func TestImageCatalogFinalWireControlConstraints(t *testing.T) {
	catalog := strings.Replace(fixtureImageCatalog("gpt-image-2.5-flare"), `"parameters":{}`, `"parameters":{"n":{"allowed":[1,2],"minimum":2,"maximum":2},"size":{"allowed":["16:9"]},"output_format":{"allowed":["webp"]},"moderation":{"allowed":["auto"]},"background":{"allowed":["opaque"]},"output_compression":{"minimum":40,"maximum":60}}`, 1)
	profiles, err := parseImageCatalog([]byte(catalog))
	if err != nil {
		t.Fatal(err)
	}
	profile := profiles["gpt-image-2.5-flare"]
	if !reflect.DeepEqual(profile.AllowedN, []int{2}) {
		t.Fatal("public N constraints must match final wire")
	}
	body := `{"model":"gpt-image-2.5-flare","prompt":"hi","n":2,"aspect_ratio":"16:9","output_format":"webp","moderation":"auto","background":"opaque","output_compression":50}`
	if _, _, err := buildImageGeneration([]byte(body), profile); err != nil {
		t.Fatal("catalog compatible request", err)
	}
	for _, bad := range []string{strings.Replace(body, `"n":2`, `"n":1`, 1), strings.Replace(body, `,"moderation":"auto"`, "", 1), strings.Replace(body, `"output_format":"webp"`, `"output_format":"jpeg"`, 1), strings.Replace(body, `"output_compression":50`, `"output_compression":70`, 1), strings.Replace(body, `"aspect_ratio":"16:9"`, `"aspect_ratio":"1:1"`, 1)} {
		if _, _, err := buildImageGeneration([]byte(bad), profile); err == nil {
			t.Fatal("catalog controls bypass")
		}
	}
	for _, control := range []string{`"output_format":{"allowed":[]}`, `"output_compression":{"minimum":60,"maximum":40}`, `"size":{"allowed":[2]}`, `"background":null`} {
		bad := strings.Replace(fixtureImageCatalog("gpt-image-2.5-flare"), `"parameters":{}`, `"parameters":{`+control+`}`, 1)
		if _, err := parseImageCatalog([]byte(bad)); err == nil {
			t.Fatal("malformed controls accepted")
		}
	}
}

func TestImageGenerationWriteFailureKeepsSubmittedTaskAndDrains(t *testing.T) {
	c, endpoint, _, _ := testCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/agent/media-capabilities" {
			io.WriteString(w, fixtureImageCatalog("gpt-image-2.5-flare"))
			return
		}
		io.WriteString(w, `{"task_id":"submitted_write_failure","status":"submitted"}`)
	}))
	readyImageCatalog(t, c, endpoint)
	r := httptest.NewRequest("POST", "http://localhost/internal/images/generate", nil)
	r.Header.Set("Content-Type", "application/json")
	w := &jsonProbeWriter{header: make(http.Header), mode: "error"}
	panicked := false
	func() {
		defer func() {
			if value := recover(); value != nil {
				if !errors.Is(value.(error), http.ErrAbortHandler) {
					t.Fatal(value)
				}
				panicked = true
			}
		}()
		c.imageRequest(context.Background(), w, r, []byte(`{"model":"gpt-image-2.5-flare","prompt":"hi"}`), c.config, c.history.generation)
	}()
	if !panicked {
		t.Fatal("failed delivery not aborted")
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if _, ok := c.images.tasks["submitted_write_failure"]; !ok || c.images.pending != 0 {
		t.Fatal("submitted task lost or pending leaked")
	}
	p, _ := imageBaseProfile("gpt-image-2.5-flare")
	p.Available = true
	if _, _, err := buildImageGeneration([]byte("{\"model\":\"gpt-image-2.5-flare\",\"prompt\":\"\xff\"}"), p); err == nil {
		t.Fatal("invalid UTF8 request")
	}
}

func TestImageResultKnownShapesAndTerminalGates(t *testing.T) {
	img := inlineFixture(t, "image/png")
	b64 := strings.Split(img, ",")[1]
	for _, body := range []string{fmt.Sprintf(`{"b64_json":%q}`, b64), fmt.Sprintf(`{"data":[{"b64_json":%q,"mime_type":"image/png"}]}`, b64), `{"url":"https://images.example/image.png"}`, `{"data":[{"task_id":"task_a","status":"submitted"}]}`, `{"data":{"id":"task_a","status":"completed","result":{"images":[{"url":["https://images.example/image.png"]}]}}}`, `{"data":{"status":"failed","error":{"message":"private-do-not-expose"}}}`} {
		id := ""
		if strings.Contains(body, `"id":"task_a"`) || strings.Contains(body, `"status":"failed"`) {
			id = "task_a"
		}
		result, err := parseImageResult([]byte(body), id, 1)
		if err != nil {
			t.Fatal("valid shape", err, body)
		}
		raw, _ := json.Marshal(result)
		if strings.Contains(string(raw), "private") {
			t.Fatal("task error echo")
		}
	}
	for _, body := range []string{"{}", `{"data":null}`, `{"code":500,"task_id":"task_a"}`, `{"task_id":"../bad"}`, `{"task_id":"a","data":{"task_id":"b"}}`, `{"url":"http://images.example/a"}`, `{"url":"https://localhost/a"}`, `{"url":"https://user:pass@images.example/a"}`, `{"b64_json":"aGk="}`, `{"data":{"status":"completed"}}`, `{"data":{"status":"failed","url":"https://images.example/a"}}`, `{"error":"private","task_id":"a"}`, `{"data":{"id":"foreign","status":"processing"}}`, `{"status":"processing","url":"https://images.example/a"}`, `{"status":"unknown","task_id":"a"}`, `{"status":"partial","b64_json":"aGk="}`} {
		if _, err := parseImageResult([]byte(body), "task_a", 1); err == nil {
			t.Fatal("bad result accepted", body)
		}
	}
	if _, err := parseImageResult([]byte(fmt.Sprintf(`{"b64_json":%q,"mime_type":"image/jpeg"}`, b64)), "", 1); err == nil {
		t.Fatal("output MIME mismatch")
	}
}

func TestImageTaskCapacityExpiryGenerationAndWriteFailures(t *testing.T) {
	var calls atomic.Int32
	c, endpoint, _, _ := testCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/agent/media-capabilities" {
			io.WriteString(w, fixtureImageCatalog("gpt-image-2.5-flare"))
			return
		}
		io.WriteString(w, `{"task_id":"task_unique","status":"submitted"}`)
	}))
	readyImageCatalog(t, c, endpoint)
	body := `{"model":"gpt-image-2.5-flare","prompt":"hi"}`
	c.mu.Lock()
	c.images.pending = maxImageTasks
	c.mu.Unlock()
	code, _, _ := request(t, c, endpoint, "/internal/images/generate", "POST", body, nil)
	if code != 507 || calls.Load() != 1 {
		t.Fatal("task reservation before bill")
	}
	c.mu.Lock()
	c.images.pending = 0
	c.images.checked = time.Now().Add(-imageCatalogTTL)
	c.mu.Unlock()
	code, _, _ = request(t, c, endpoint, "/internal/images/generate", "POST", body, nil)
	if code != 409 || calls.Load() != 1 {
		t.Fatal("stale catalog")
	}
	readyImageCatalog(t, c, endpoint)
	code, _, _ = request(t, c, endpoint, "/internal/images/generate", "POST", body, nil)
	if code != 200 {
		t.Fatal("submit")
	}
	c.mu.Lock()
	c.images.tasks["task_unique"] = imageTask{time.Now().Add(-time.Second), 1}
	c.mu.Unlock()
	code, _, _ = request(t, c, endpoint, "/internal/images/tasks/task_unique", "GET", "", nil)
	if code != 404 {
		t.Fatal("task TTL")
	}
	for _, mode := range []string{"ok", "short", "error", "flush", "deadline"} {
		w := &jsonProbeWriter{header: make(http.Header), mode: mode}
		panicked := false
		func() {
			defer func() {
				if value := recover(); value != nil {
					if !errors.Is(value.(error), http.ErrAbortHandler) {
						t.Fatal(value)
					}
					panicked = true
				}
			}()
			writeImageResult(context.Background(), w, imageResult{Images: []imageOutput{}, TaskID: "a"})
		}()
		if panicked != (mode != "ok") {
			t.Fatal("image write boundary", mode)
		}
	}
	oldGeneration := c.history.generation
	c.Stop()
	c.Start()
	w := httptest.NewRecorder()
	c.refreshImageCatalog(context.Background(), w, Config{Endpoint: "https://mock.example", APIKey: syntheticKey}, oldGeneration)
	if w.Code != 503 {
		t.Fatal("late refresh")
	}
}

func TestImageStopCancellationAndRefreshSerialization(t *testing.T) {
	reached := make(chan struct{}, 1)
	released := make(chan struct{})
	c, endpoint, _, _ := testCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		reached <- struct{}{}
		<-released
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, fixtureImageCatalog("gpt-image-2.5-flare"))
	}))
	done := make(chan int, 1)
	go func() {
		req, _ := http.NewRequest("GET", endpoint+"/internal/images/capabilities", nil)
		req.Header.Set("Authorization", "Bearer "+c.token)
		response, err := http.DefaultClient.Do(req)
		if err != nil {
			done <- 0
			return
		}
		io.Copy(io.Discard, response.Body)
		response.Body.Close()
		done <- response.StatusCode
	}()
	select {
	case <-reached:
	case <-time.After(time.Second):
		t.Fatal("catalog started")
	}
	code, _, _ := request(t, c, endpoint, "/internal/images/capabilities", "GET", "", nil)
	if code != 409 {
		t.Fatal("parallel refresh not serialized")
	}
	c.Stop()
	close(released)
	select {
	case code := <-done:
		if code == 200 {
			t.Fatal("stopped refresh published")
		}
	case <-time.After(time.Second):
		t.Fatal("Stop failed")
	}
	waitActive(t, c, 0)
	c.mu.Lock()
	if c.images.profiles != nil || c.images.refreshing || c.images.pending != 0 {
		t.Error("Stop retained image state")
	}
	c.mu.Unlock()
}

func TestImageRouteSecurityAndFailedRefreshRevokesCatalog(t *testing.T) {
	var calls atomic.Int32
	var fail atomic.Bool
	c, endpoint, _, _ := testCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.Header().Set("Content-Type", "application/json")
		if fail.Load() {
			w.Header().Set("Set-Cookie", syntheticKey)
			w.WriteHeader(500)
			io.WriteString(w, syntheticKey)
			return
		}
		io.WriteString(w, fixtureImageCatalog("momoapi-gpt-image-2-5-flare"))
	}))
	for _, tc := range []struct {
		path, method, body string
		headers            map[string]string
		code               int
	}{
		{"/internal/images/capabilities", "GET", "", map[string]string{"Authorization": ""}, 401},
		{"/internal/images/generate", "POST", "{}", map[string]string{"Origin": "https://evil.example"}, 403},
		{"/internal/images/capabilities?x=1", "GET", "", nil, 400},
		{"/internal/images/capabilities", "POST", "", nil, 405},
		{"/internal/images/capabilities", "GET", "{}", nil, 400},
		{"/internal/images/generate", "GET", "", nil, 405},
		{"/internal/images/generate", "POST", "{}", map[string]string{"Content-Type": "text/plain"}, 415},
		{"/internal/images/edit", "POST", "{}", nil, 409},
		{"/internal/images/assets", "GET", "", nil, 404},
		{"/internal/images/tasks/foreign", "GET", "", nil, 404},
		{"/internal/images/tasks/%2e%2e", "GET", "", nil, 400},
		{"/internal/images/generate", "POST", strings.Repeat("x", MaxRequest+1), nil, 413},
	} {
		code, _, _ := request(t, c, endpoint, tc.path, tc.method, tc.body, tc.headers)
		if code != tc.code {
			t.Fatal(tc.path, code)
		}
	}
	if calls.Load() != 0 {
		t.Fatal("boundary upstream")
	}
	readyImageCatalog(t, c, endpoint)
	fail.Store(true)
	code, data, headers := request(t, c, endpoint, "/internal/images/capabilities", "GET", "", nil)
	if code != 500 || strings.Contains(string(data), syntheticKey) || headers.Get("Set-Cookie") != "" {
		t.Fatal("refresh redaction")
	}
	code, _, _ = request(t, c, endpoint, "/internal/images/generate", "POST", `{"model":"momoapi-gpt-image-2-5-flare","prompt":"hi"}`, nil)
	if code != 409 || calls.Load() != 2 {
		t.Fatal("failed refresh permission kept")
	}
}
