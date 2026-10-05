package appcore

import (
	"context"
	"io"
	"net"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestImageGenerationStopCancellationReservationAndIsolation(t *testing.T) {
	reached := make(chan struct{}, 1)
	release := make(chan struct{})
	defer close(release)
	c, endpoint, _, _ := testCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/agent/media-capabilities" {
			io.WriteString(w, fixtureImageCatalog("gpt-image-2.5-flare"))
			return
		}
		reached <- struct{}{}
		<-release
		io.WriteString(w, `{"task_id":"late_paid_task","status":"submitted"}`)
	}))
	readyImageCatalog(t, c, endpoint)
	done := make(chan int, 1)
	go func() {
		r, _ := http.NewRequest("POST", endpoint+"/internal/images/generate", strings.NewReader(`{"model":"gpt-image-2.5-flare","prompt":"hi"}`))
		r.Header.Set("Authorization", "Bearer "+c.token)
		r.Header.Set("Content-Type", "application/json")
		res, err := http.DefaultClient.Do(r)
		if err != nil {
			done <- 0
			return
		}
		io.Copy(io.Discard, res.Body)
		res.Body.Close()
		done <- res.StatusCode
	}()
	select {
	case <-reached:
	case <-time.After(time.Second):
		t.Fatal("generation not sent")
	}
	c.mu.Lock()
	if c.images.pending != 1 {
		t.Error("no reservation")
	}
	c.mu.Unlock()
	c.Stop()
	select {
	case code := <-done:
		if code == 200 {
			t.Fatal("late success")
		}
	case <-time.After(time.Second):
		t.Fatal("generation not cancelled")
	}
	waitActive(t, c, 0)
	if c.Start() != nil {
		t.Fatal("restart")
	}
	c.mu.Lock()
	if len(c.images.tasks) != 0 || c.images.pending != 0 || c.images.profiles != nil {
		t.Error("old session retained")
	}
	c.mu.Unlock()
	code, _, _ := request(t, c, endpoint, "/internal/images/tasks/late_paid_task", "GET", "", nil)
	if code != 404 {
		t.Fatal("late task recorded")
	}
	other, otherURL, _, _ := testCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { t.Error("foreign task contacted upstream") }))
	code, _, _ = request(t, other, otherURL, "/internal/images/tasks/late_paid_task", "GET", "", nil)
	if code != 404 {
		t.Fatal("task crosses Core")
	}
}

func TestImageConcurrentReservationsDrainAndCollision(t *testing.T) {
	reached := make(chan struct{}, 4)
	release := make(chan struct{})
	var sends atomic.Int32
	c, endpoint, _, _ := testCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/agent/media-capabilities" {
			io.WriteString(w, fixtureImageCatalog("gpt-image-2.5-flare"))
			return
		}
		sends.Add(1)
		reached <- struct{}{}
		<-release
		io.WriteString(w, `{"task_id":"same_task","status":"submitted"}`)
	}))
	readyImageCatalog(t, c, endpoint)
	c.mu.Lock()
	c.images.tasks = map[string]imageTask{}
	for i := 0; i < maxImageTasks-2; i++ {
		c.images.tasks[strings.Repeat("x", i+1)] = imageTask{time.Now().Add(time.Hour), 1}
	}
	c.mu.Unlock()
	done := make(chan int, 2)
	for i := 0; i < 2; i++ {
		go func() {
			code, _, _ := request(t, c, endpoint, "/internal/images/generate", "POST", `{"model":"gpt-image-2.5-flare","prompt":"hi"}`, nil)
			done <- code
		}()
	}
	for i := 0; i < 2; i++ {
		select {
		case <-reached:
		case <-time.After(time.Second):
			close(release)
			t.Fatal("parallel send")
		}
	}
	code, _, _ := request(t, c, endpoint, "/internal/images/generate", "POST", `{"model":"gpt-image-2.5-flare","prompt":"hi"}`, nil)
	if code != 507 || sends.Load() != 2 {
		t.Error("unreserved send")
	}
	close(release)
	outcomes := map[int]int{}
	for i := 0; i < 2; i++ {
		select {
		case code := <-done:
			outcomes[code]++
		case <-time.After(time.Second):
			t.Fatal("generation drain")
		}
	}
	waitActive(t, c, 0)
	if outcomes[200] != 1 || outcomes[502] != 1 {
		t.Fatal("collision not rejected", outcomes)
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.images.pending != 0 || len(c.images.tasks) != maxImageTasks-1 {
		t.Fatal("reservation leak")
	}
}

func TestImageStopInterruptsActualStalledUpload(t *testing.T) {
	c, endpoint, _, _ := testCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { t.Error("stalled upload sent upstream") }))
	conn, err := net.DialTimeout("tcp", strings.TrimPrefix(endpoint, "http://"), time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	io.WriteString(conn, "POST /internal/images/generate HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer "+c.token+"\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{")
	waitActive(t, c, 1)
	c.Stop()
	waitActive(t, c, 0)
}

func TestImageJSONLimitsMIMEUTF8DeadlineAndCancellation(t *testing.T) {
	for _, tc := range []struct {
		name, mime, body string
		limit            int
		want             int
	}{{"ok", "application/json; charset=utf-8", "{}", 2, 200}, {"budget", "application/json", "{} ", 2, 502}, {"mime", "text/event-stream", "{}", 2, 502}, {"invalidJSON", "application/json", "{", 2, 502}, {"utf8", "application/json", "{\"x\":\"\xff\"}", 100, 502}, {"redirect", "application/json", "{}", 2, 502}} {
		t.Run(tc.name, func(t *testing.T) {
			var calls atomic.Int32
			c, _, _, _ := testCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				w.Header().Set("Content-Type", tc.mime)
				if tc.name == "redirect" {
					w.Header().Set("Location", "https://external.example/private")
					w.WriteHeader(302)
				}
				io.WriteString(w, tc.body)
			}))
			// Match production redirect denial on testCore's injected TLS client.
			c.client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrNotSupported }
			data, status := c.imageJSON(context.Background(), Config{Endpoint: "https://mock.example", APIKey: syntheticKey}, "GET", "/image", nil, tc.limit)
			if status != tc.want || calls.Load() != 1 || status != 200 && len(data) != 0 {
				t.Fatal("image boundary", status, calls.Load())
			}
			ctx, cancel := context.WithCancel(context.Background())
			cancel()
			_, status = c.imageJSON(ctx, Config{Endpoint: "https://mock.example", APIKey: syntheticKey}, "GET", "/image", nil, 100)
			if status != 502 || calls.Load() != 1 {
				t.Fatal("cancelled request sent")
			}
		})
	}
	c, endpoint, _, _ := testCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, fixtureImageCatalog("gpt-image-2.5-flare"))
	}))
	readyImageCatalog(t, c, endpoint)
	originalTimeout := c.client.Timeout
	c.client.Transport = roundTripFunc(func(r *http.Request) (*http.Response, error) {
		deadline, ok := r.Context().Deadline()
		remaining := time.Until(deadline)
		if !ok || remaining < 295*time.Second || remaining > 300*time.Second {
			t.Error("generation does not receive bounded 300s")
		}
		return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: io.NopCloser(strings.NewReader(`{"task_id":"deadline_task","status":"submitted"}`))}, nil
	})
	code, _, _ := request(t, c, endpoint, "/internal/images/generate", "POST", `{"model":"gpt-image-2.5-flare","prompt":"hi"}`, nil)
	if code != 200 || c.client.Timeout != originalTimeout {
		t.Fatal("image deadline globally mutates client")
	}
}
