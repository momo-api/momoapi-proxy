package appcore

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func editFixtureCatalog(id string) string {
	return strings.Replace(fixtureImageCatalog(id), `"parameters":{}`, `"parameters":{"max_reference_images":{"maximum":2}}`, 1)
}

func TestImageEditProfilesAndStrictReferences(t *testing.T) {
	reference := inlineFixture(t, "image/png")
	for _, id := range imageIDs {
		t.Run(id, func(t *testing.T) {
			profiles, err := parseImageCatalog([]byte(fixtureImageCatalog(id)))
			if err != nil {
				t.Fatal(err)
			}
			p := profiles[id]
			raw, _ := json.Marshal(map[string]any{"model": id, "prompt": "hi", "reference_images": []string{reference}})
			wire, n, path, err := buildImageEdit(raw, p)
			if id == "gpt-image-2-momoapi" {
				if err == nil || includes(p.Operations, "edit") {
					t.Fatal("unimplemented Chat media edit")
				}
				return
			}
			if err != nil || n != 1 {
				t.Fatal("implemented edit profile", err)
			}
			body, _ := decodeVideoObject(wire)
			if id == "gemini-3.1-flash-image" {
				if path != "/v1/chat/completions" || body["messages"] == nil {
					t.Fatal("Gemini edit transport")
				}
				return
			}
			field := "image_urls"
			if p.profile == "web" {
				field = "images"
				if path != "/v1/images/edits" {
					t.Fatal("web edit path")
				}
			} else if path != "/v1/images/generations" {
				t.Fatal("generations reference path")
			}
			if !reflect.DeepEqual(body[field], []any{reference}) {
				t.Fatal("reference lost")
			}
			count := p.MaxReferences + 1
			refs := make([]string, count)
			for i := range refs {
				refs[i] = reference
			}
			raw, _ = json.Marshal(map[string]any{"model": id, "prompt": "hi", "reference_images": refs})
			if _, _, _, err := buildImageEdit(raw, p); err == nil {
				t.Fatal("static count exceeded")
			}
		})
	}
	profiles, _ := parseImageCatalog([]byte(editFixtureCatalog("gpt-image-2.5-flare")))
	p := profiles["gpt-image-2.5-flare"]
	for _, refs := range []any{nil, []any{}, "data", []any{nil}, []any{map[string]any{"url": reference}}, []any{"asset:img_abc"}, []any{"file:///test.png"}, []any{"http://images.example/a"}, []any{"https://127.0.0.1/a"}, []any{"https://user:pass@images.example/a"}, []any{"data:image/png;base64,AA=="}, []any{strings.Replace(reference, "image/png", "image/jpeg", 1)}} {
		raw, _ := json.Marshal(map[string]any{"model": p.ID, "prompt": "hi", "reference_images": refs})
		if _, _, _, err := buildImageEdit(raw, p); err == nil {
			t.Fatal("invalid references accepted")
		}
	}
	for _, extra := range []string{`"mask":"a"`, `"images":[]`, `"image_urls":[]`, `"model":"other"`, `"reference_images":[]`, `"n":1.5`, `"output_format":"jpeg","background":"transparent"`} {
		raw := `{"model":"gpt-image-2.5-flare","prompt":"hi","reference_images":[` + strconvQuote(reference) + `],` + extra + `}`
		if _, _, _, err := buildImageEdit([]byte(raw), p); err == nil {
			t.Fatal("unknown/duplicate control accepted", extra)
		}
	}
	raw, _ := json.Marshal(map[string]any{"model": p.ID, "prompt": "hi", "reference_images": []string{reference, "https://images.example/a.png"}})
	wire, _, _, err := buildImageEdit(raw, p)
	if err != nil {
		t.Fatal("APIMart reference delegation", err)
	}
	got, _ := decodeVideoObject(wire)
	if !reflect.DeepEqual(got["image_urls"], []any{reference, "https://images.example/a.png"}) {
		t.Fatal("reference order")
	}
}

func strconvQuote(s string) string { b, _ := json.Marshal(s); return string(b) }

func TestImageEditSessionCapacityStaleCollisionAndFailedDelivery(t *testing.T) {
	var sends atomic.Int32
	var failRefresh atomic.Bool
	c, endpoint, _, _ := testCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/agent/media-capabilities" {
			if failRefresh.Load() {
				w.WriteHeader(500)
				return
			}
			io.WriteString(w, editFixtureCatalog("gpt-image-2.5-flare"))
			return
		}
		if r.URL.Path != "/v1/images/generations" {
			t.Error("edit path")
			w.WriteHeader(404)
			return
		}
		sends.Add(1)
		io.WriteString(w, `{"task_id":"edit_collision","status":"submitted"}`)
	}))
	readyImageCatalog(t, c, endpoint)
	raw, _ := json.Marshal(map[string]any{"model": "gpt-image-2.5-flare", "prompt": "hi", "reference_images": []string{inlineFixture(t, "image/png")}})
	c.mu.Lock()
	c.images.pending = maxImageTasks
	c.mu.Unlock()
	_, code := c.DesktopImages(context.Background(), "/internal/images/edit", raw)
	if code != 507 || sends.Load() != 0 {
		t.Fatal("capacity before bill")
	}
	c.mu.Lock()
	c.images.pending = 0
	c.images.checked = time.Now().Add(-imageCatalogTTL)
	c.mu.Unlock()
	_, code = c.DesktopImages(context.Background(), "/internal/images/edit", raw)
	if code != 409 || sends.Load() != 0 {
		t.Fatal("stale edit permission")
	}
	readyImageCatalog(t, c, endpoint)
	r := httptest.NewRequest("POST", "http://localhost/internal/images/edit", nil)
	r.Header.Set("Content-Type", "application/json")
	w := &jsonProbeWriter{header: make(http.Header), mode: "short"}
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
		c.imageRequest(context.Background(), w, r, raw, c.config, c.history.generation)
	}()
	c.mu.Lock()
	task, tracked := c.images.tasks["edit_collision"]
	pending := c.images.pending
	c.mu.Unlock()
	if !panicked || !tracked || pending != 0 || sends.Load() != 1 {
		t.Fatal("failed delivery lost submitted edit")
	}
	_, code = c.DesktopImages(context.Background(), "/internal/images/edit", raw)
	c.mu.Lock()
	after := c.images.tasks["edit_collision"]
	pending = c.images.pending
	c.mu.Unlock()
	if code != 502 || after != task || pending != 0 || sends.Load() != 2 {
		t.Fatal("task collision overwritten or retried")
	}
	failRefresh.Store(true)
	code, _, _ = request(t, c, endpoint, "/internal/images/capabilities", "GET", "", nil)
	if code != 500 {
		t.Fatal("refresh should fail")
	}
	_, code = c.DesktopImages(context.Background(), "/internal/images/edit", raw)
	if code != 409 || sends.Load() != 2 {
		t.Fatal("failed refresh retained edit permission")
	}
}

func TestImageEditCatalogPermissionAndCountIntersection(t *testing.T) {
	id := "momoapi-gpt-image-2-5-flare"
	for _, tc := range []struct {
		parameters, operations, transport string
		max                               int
		edit                              bool
	}{
		{`{}`, `["generate"]`, "", 0, false},
		{`{}`, `["edit"]`, "", 4, true},
		{`{"max_reference_images":{"maximum":999}}`, `["generate","edit"]`, "", 4, true},
		{`{"max_reference_images":{"maximum":0}}`, `["generate","edit"]`, "", 0, false},
		{`{"max_reference_images":{"allowed":[2,4],"maximum":3}}`, `["edit"]`, "", 2, true},
		{`{}`, `["generate","edit"]`, `,"transports":{"edit":"https://evil.example"}`, 0, false},
		{`{}`, `["generate","edit"]`, `,"transports":{"edit":null}`, 0, false},
	} {
		raw := `{"models":[{"id":"` + id + `","modality":"image","available":true,"operations":` + tc.operations + `,"parameters":` + tc.parameters + tc.transport + `}]}`
		profiles, err := parseImageCatalog([]byte(raw))
		if err != nil {
			t.Fatal(err)
		}
		p := profiles[id]
		if p.MaxReferences != tc.max || includes(p.Operations, "edit") != tc.edit {
			t.Fatal("permission/count intersection")
		}
		input, _ := json.Marshal(map[string]any{"model": id, "prompt": "hi"})
		if _, _, err := buildImageGeneration(input, p); (err == nil) != includes(p.Operations, "generate") {
			t.Fatal("edit-only promoted generation")
		}
	}
	for _, parameters := range []string{`{"max_reference_images":{"maximum":"2"}}`, `{"max_reference_images":{"maximum":1.5}}`, `{"max_reference_images":{"minimum":3,"maximum":2}}`, `{"max_reference_images":{"allowed":[1,1]}}`, `{"max_reference_images":{"allowed":[]}}`} {
		raw := strings.Replace(fixtureImageCatalog(id), `"parameters":{}`, `"parameters":`+parameters, 1)
		if _, err := parseImageCatalog([]byte(raw)); err == nil {
			t.Fatal("malformed reference catalog")
		}
	}
	fallback, err := fallbackImageCatalog([]byte(`{"data":[{"id":"momoapi-gpt-image-2-5-flare"}]}`))
	if err != nil || includes(fallback[id].Operations, "edit") || fallback[id].MaxReferences != 0 {
		t.Fatal("model list inferred edit")
	}
	duplicate := strings.Replace(fixtureImageCatalog(id), `"available":true`, `"available":false,"available":true`, 1)
	if _, err := parseImageCatalog([]byte(duplicate)); err == nil {
		t.Fatal("duplicate permission accepted")
	}
}

func TestImageEditStopDuringSubmissionNoTaskOrRetry(t *testing.T) {
	entered, exited := make(chan struct{}), make(chan struct{})
	var sends atomic.Int32
	c, endpoint, _, _ := testCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/agent/media-capabilities" {
			io.WriteString(w, editFixtureCatalog("momoapi-gpt-image-2-5-flare"))
			return
		}
		if r.URL.Path != "/v1/images/edits" {
			t.Error("unexpected path")
			w.WriteHeader(404)
			return
		}
		sends.Add(1)
		io.Copy(io.Discard, r.Body)
		close(entered)
		select {
		case <-r.Context().Done():
		case <-time.After(5 * time.Second):
		}
		close(exited)
	}))
	readyImageCatalog(t, c, endpoint)
	raw, _ := json.Marshal(map[string]any{"model": "momoapi-gpt-image-2-5-flare", "prompt": "hi", "reference_images": []string{inlineFixture(t, "image/png")}})
	done := make(chan int, 1)
	go func() { _, code := c.DesktopImages(context.Background(), "/internal/images/edit", raw); done <- code }()
	select {
	case <-entered:
	case <-time.After(3 * time.Second):
		t.Fatal("no edit send")
	}
	c.Stop()
	select {
	case code := <-done:
		if code == 200 {
			t.Fatal("cancelled edit succeeded")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("Stop did not release edit")
	}
	select {
	case <-exited:
	case <-time.After(3 * time.Second):
		t.Fatal("upstream not cancelled")
	}
	c.mu.Lock()
	tasks, pending := len(c.images.tasks), c.images.pending
	c.mu.Unlock()
	if sends.Load() != 1 || tasks != 0 || pending != 0 {
		t.Fatal("Stop retained effects or retried")
	}
}

func TestImageEditActualTCPAndManualTask(t *testing.T) {
	var sends atomic.Int32
	reference := inlineFixture(t, "image/png")
	c, endpoint, _, _ := testCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/agent/media-capabilities":
			io.WriteString(w, editFixtureCatalog("momoapi-gpt-image-2-5-flare"))
		case "/v1/images/edits":
			sends.Add(1)
			raw, _ := io.ReadAll(r.Body)
			got, err := decodeObject(string(raw))
			if err != nil || got["model"] != "momoapi-gpt-image-2-5-flare" || got["prompt"] != "edit" || !reflect.DeepEqual(got["images"], []any{reference}) || len(got) != 4 {
				t.Error("edit wire changed reference, operation or controls")
			}
			io.WriteString(w, `{"data":[{"task_id":"edit_one","status":"submitted"}]}`)
		case "/v1/tasks/edit_one":
			io.WriteString(w, `{"data":{"id":"edit_one","status":"completed","result":{"images":[{"url":"https://images.example/edit.png"}]}}}`)
		default:
			t.Error("unexpected network", r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	raw, _ := json.Marshal(map[string]any{"model": "momoapi-gpt-image-2-5-flare", "prompt": " edit ", "reference_images": []string{reference}})
	code, _, _ := request(t, c, endpoint, "/internal/images/edit", "POST", string(raw), nil)
	if code != 409 || sends.Load() != 0 {
		t.Fatal("edit must require fresh catalog", code)
	}
	readyImageCatalog(t, c, endpoint)
	code, data, _ := request(t, c, endpoint, "/internal/images/edit", "POST", string(raw), nil)
	if code != 200 || sends.Load() != 1 || !strings.Contains(string(data), "edit_one") {
		t.Fatal("edit unavailable", code, string(data))
	}
	code, data, _ = request(t, c, endpoint, "/internal/images/tasks/edit_one", "GET", "", nil)
	if code != 200 || !strings.Contains(string(data), "edit.png") || sends.Load() != 1 {
		t.Fatal("manual edit task", code)
	}
	c.Stop()
	if c.Start() != nil {
		t.Fatal("restart")
	}
	code, _, _ = request(t, c, endpoint, "/internal/images/tasks/edit_one", "GET", "", nil)
	if code != 404 {
		t.Fatal("edit task survived Stop", code)
	}
}
