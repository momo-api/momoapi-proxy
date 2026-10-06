package appcore

import (
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

const videoTestBody = `{"model":"seedance-2.5","prompt":"hi"}`
const videoTestCatalog = `{"data":[{"id":"seedance-2.5"}]}`

func readyVideo(t *testing.T, c *Core, endpoint string) {
	t.Helper()
	code, _, _ := request(t, c, endpoint, "/internal/videos/capabilities", "GET", "", nil)
	if code != 200 {
		t.Fatal("video catalog", code)
	}
}

func TestVideoReservationsCollisionAndSharedAdmission(t *testing.T) {
	reached := make(chan struct{}, 4)
	release := make(chan struct{})
	var sends atomic.Int32
	c, endpoint, _, _ := testCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/v1/models" {
			io.WriteString(w, videoTestCatalog)
			return
		}
		sends.Add(1)
		reached <- struct{}{}
		<-release
		io.WriteString(w, `{"task_id":"task_collision","status":"submitted"}`)
	}))
	readyVideo(t, c, endpoint)
	c.mu.Lock()
	c.active = 4
	c.mu.Unlock()
	_, busy := c.DesktopVideos(context.Background(), "/internal/videos/capabilities", nil)
	c.mu.Lock()
	c.active = 0
	c.mu.Unlock()
	if busy != 503 {
		t.Fatal("native shared admission bypass")
	}
	c.mu.Lock()
	c.videos.tasks = map[string]videoTask{}
	for i := 0; i < maxVideoTasks-2; i++ {
		c.videos.tasks[fmt.Sprintf("task_%d", i)] = videoTask{time.Now().Add(time.Hour)}
	}
	c.mu.Unlock()
	done := make(chan int, 2)
	for i := 0; i < 2; i++ {
		go func() {
			code, _, _ := request(t, c, endpoint, "/internal/videos/generate", "POST", videoTestBody, nil)
			done <- code
		}()
	}
	for i := 0; i < 2; i++ {
		select {
		case <-reached:
		case <-time.After(3 * time.Second):
			close(release)
			t.Fatal("parallel send")
		}
	}
	code, _, _ := request(t, c, endpoint, "/internal/videos/generate", "POST", videoTestBody, nil)
	if code != 507 || sends.Load() != 2 {
		t.Error("unreserved send")
	}
	close(release)
	outcomes := map[int]int{}
	for i := 0; i < 2; i++ {
		select {
		case code := <-done:
			outcomes[code]++
		case <-time.After(3 * time.Second):
			t.Fatal("drain")
		}
	}
	if outcomes[200] != 1 || outcomes[502] != 1 {
		t.Fatal("collision")
	}
	waitActive(t, c, 0)
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.videos.pending != 0 || len(c.videos.tasks) != maxVideoTasks-1 {
		t.Fatal("reservation leak")
	}
}

func TestVideoCatalogTTLTaskTTLIsolationAndFailedRefresh(t *testing.T) {
	var fail atomic.Bool
	var sends atomic.Int32
	c, endpoint, _, _ := testCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/v1/models" {
			if fail.Load() {
				w.WriteHeader(429)
				return
			}
			io.WriteString(w, videoTestCatalog)
			return
		}
		sends.Add(1)
		io.WriteString(w, `{"task_id":"task_expire","status":"queued"}`)
	}))
	readyVideo(t, c, endpoint)
	c.mu.Lock()
	c.videos.checked = time.Now().Add(-videoCatalogTTL - time.Second)
	c.mu.Unlock()
	code, _, _ := request(t, c, endpoint, "/internal/videos/generate", "POST", videoTestBody, nil)
	if code != 409 || sends.Load() != 0 {
		t.Fatal("expired permission")
	}
	readyVideo(t, c, endpoint)
	code, _, _ = request(t, c, endpoint, "/internal/videos/generate", "POST", videoTestBody, nil)
	if code != 200 {
		t.Fatal("submit")
	}
	c.mu.Lock()
	c.videos.tasks["task_expire"] = videoTask{time.Now().Add(-time.Second)}
	c.mu.Unlock()
	code, _, _ = request(t, c, endpoint, "/internal/videos/tasks/task_expire", "GET", "", nil)
	if code != 404 || sends.Load() != 1 {
		t.Fatal("task expiry sent")
	}
	fail.Store(true)
	code, _, _ = request(t, c, endpoint, "/internal/videos/capabilities", "GET", "", nil)
	if code != 429 {
		t.Fatal("refresh error")
	}
	code, _, _ = request(t, c, endpoint, "/internal/videos/generate", "POST", videoTestBody, nil)
	if code != 409 || sends.Load() != 1 {
		t.Fatal("failed refresh retained permission")
	}
	other, url, _, _ := testCore(t, http.HandlerFunc(func(http.ResponseWriter, *http.Request) { t.Error("foreign upstream") }))
	code, _, _ = request(t, other, url, "/internal/videos/tasks/task_expire", "GET", "", nil)
	if code != 404 {
		t.Fatal("foreign Core")
	}
}

func TestVideoDeadlinesErrorsRoutesAndStalledUpload(t *testing.T) {
	c, endpoint, _, _ := testCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, videoTestCatalog)
	}))
	readyVideo(t, c, endpoint)
	originalTimeout := c.client.Timeout
	c.client.Transport = roundTripFunc(func(r *http.Request) (*http.Response, error) {
		deadline, ok := r.Context().Deadline()
		remaining := time.Until(deadline)
		if !ok || remaining < 55*time.Second || remaining > 60*time.Second {
			t.Error("video bounded deadline")
		}
		return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: io.NopCloser(strings.NewReader(`{"task_id":"task_deadline","status":"queued"}`))}, nil
	})
	code, _, _ := request(t, c, endpoint, "/internal/videos/generate", "POST", videoTestBody, nil)
	if code != 200 || c.client.Timeout != originalTimeout {
		t.Fatal("generation deadline/client mutation")
	}
	code, _, _ = request(t, c, endpoint, "/internal/videos/tasks/task_deadline", "GET", "", nil)
	if code != 200 {
		t.Fatal("task deadline")
	}
	for _, tc := range []struct {
		path, method, body string
		want               int
	}{
		{"/internal/videos/generate", "GET", "", 405}, {"/internal/videos/capabilities", "POST", "", 405},
		{"/internal/videos/capabilities", "GET", "{}", 400}, {"/internal/videos/tasks/task_deadline", "POST", "", 405},
		{"/internal/videos/tasks/task_deadline?x=1", "GET", "", 400}, {"/internal/videos/tasks/task_deadline/content", "GET", "", 404},
	} {
		code, _, _ := request(t, c, endpoint, tc.path, tc.method, tc.body, nil)
		if code != tc.want {
			t.Fatal("route gate", tc.path, code)
		}
	}
	for _, status := range []int{401, 429, 500} {
		var sends atomic.Int32
		c.client.Transport = roundTripFunc(func(*http.Request) (*http.Response, error) {
			sends.Add(1)
			return &http.Response{StatusCode: status, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(syntheticKey))}, nil
		})
		code, data, _ := request(t, c, endpoint, "/internal/videos/generate", "POST", videoTestBody, nil)
		if code != status || sends.Load() != 1 || strings.Contains(string(data), syntheticKey) {
			t.Fatal("error retry/reflection")
		}
	}
	conn, err := net.DialTimeout("tcp", strings.TrimPrefix(endpoint, "http://"), time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	io.WriteString(conn, "POST /internal/videos/generate HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer "+c.token+"\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{")
	waitActive(t, c, 1)
	c.Stop()
	waitActive(t, c, 0)
	_, code = c.DesktopVideos(context.Background(), "/internal/images/capabilities", nil)
	if code != 400 {
		t.Fatal("native path isolation")
	}
}

func TestVideoWriteFailuresAbortWithoutReplayOrRollbackClaim(t *testing.T) {
	for _, mode := range []string{"ok", "short", "error", "flush", "deadline"} {
		t.Run(mode, func(t *testing.T) {
			var sends atomic.Int32
			c, endpoint, _, _ := testCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				if r.URL.Path == "/v1/models" {
					io.WriteString(w, videoTestCatalog)
					return
				}
				sends.Add(1)
				io.WriteString(w, `{"task_id":"task_write","status":"submitted"}`)
			}))
			readyVideo(t, c, endpoint)
			w := &jsonProbeWriter{header: make(http.Header), mode: mode}
			r := httptest.NewRequest("POST", "/internal/videos/generate", strings.NewReader(videoTestBody))
			r.Header.Set("Authorization", "Bearer "+c.token)
			r.Header.Set("Content-Type", "application/json")
			var aborted any
			func() { defer func() { aborted = recover() }(); c.Handler().ServeHTTP(w, r) }()
			if mode == "ok" {
				if aborted != nil || w.writes != 1 {
					t.Fatal("success")
				}
			} else if aborted != http.ErrAbortHandler {
				t.Fatal("failed delivery ended cleanly")
			}
			if w.writes > 1 || sends.Load() != 1 || c.State().Active != 0 {
				t.Fatal("replay/error/admission")
			}
			c.mu.Lock()
			_, tracked := c.videos.tasks["task_write"]
			pending := c.videos.pending
			c.mu.Unlock()
			if !tracked || pending != 0 {
				t.Fatal("submission must remain tracked, not pretend remote rollback")
			}
		})
	}
}
