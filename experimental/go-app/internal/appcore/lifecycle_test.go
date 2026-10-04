package appcore

import (
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptrace"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func waitActive(t *testing.T, core *Core, want int) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if core.State().Active == want {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("active requests did not reach %d (got %d)", want, core.State().Active)
}

func TestStopInterruptsStalledUploadsAndAllowsRestart(t *testing.T) {
	var reached atomic.Int32
	core, endpoint, _, _ := testCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		reached.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, "{\"data\":[]}")
	}))
	// Exhaust all four admission slots with actual incomplete TCP request bodies.
	// Sending only one byte leaves ReadAll blocked until Stop or the 15s timeout.
	for i := 0; i < 4; i++ {
		conn, err := net.DialTimeout("tcp", strings.TrimPrefix(endpoint, "http://"), time.Second)
		if err != nil {
			t.Fatal(err)
		}
		defer conn.Close()
		_ = conn.SetDeadline(time.Now().Add(4 * time.Second))
		_, err = fmt.Fprintf(conn, "POST /v1/responses HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer %s\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{", core.token)
		if err != nil {
			t.Fatal("stalled upload setup failed")
		}
	}
	waitActive(t, core, 4)
	code, _, _ := request(t, core, endpoint, "/v1/models", "GET", "", nil)
	if code != 503 || reached.Load() != 0 {
		t.Fatal("admission limit failed or incomplete upload forwarded")
	}
	core.Stop()
	waitActive(t, core, 0)
	if err := core.Configure(Config{"https://mock.example", syntheticKey}); err != nil {
		t.Fatal("stop did not release configuration gate")
	}
	if err := core.Start(); err != nil {
		t.Fatal("restart failed")
	}
	code, _, _ = request(t, core, endpoint, "/v1/models", "GET", "", nil)
	if code != 200 || reached.Load() != 1 {
		t.Fatal("restart did not recover admission")
	}
}

func TestStopInterruptsChunkedUpload(t *testing.T) {
	var reached atomic.Int32
	core, endpoint, _, _ := testCore(t, http.HandlerFunc(func(http.ResponseWriter, *http.Request) { reached.Add(1) }))
	conn, err := net.DialTimeout("tcp", strings.TrimPrefix(endpoint, "http://"), time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(4 * time.Second))
	_, err = fmt.Fprintf(conn, "POST /v1/chat/completions HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer %s\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n64\r\n{", core.token)
	if err != nil {
		t.Fatal("chunked upload setup failed")
	}
	waitActive(t, core, 1)
	core.Stop()
	waitActive(t, core, 0)
	if reached.Load() != 0 {
		t.Fatal("incomplete chunk reached upstream")
	}
}

func TestCompletedUploadCancellationDoesNotPoisonKeepAlive(t *testing.T) {
	core, endpoint, _, _ := testCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, "{\"data\":[]}")
	}))
	transport := &http.Transport{MaxConnsPerHost: 1}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: 2 * time.Second}
	var reused atomic.Int32
	for i := 0; i < 20; i++ {
		req, _ := http.NewRequest("POST", endpoint+"/v1/responses", strings.NewReader("{\"model\":\"mock\"}"))
		req = req.WithContext(httptrace.WithClientTrace(req.Context(), &httptrace.ClientTrace{GotConn: func(info httptrace.GotConnInfo) {
			if info.Reused {
				reused.Add(1)
			}
		}}))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer "+core.token)
		res, err := client.Do(req)
		if err != nil {
			t.Fatal("keep-alive request failed")
		}
		_, readErr := io.Copy(io.Discard, res.Body)
		_ = res.Body.Close()
		if res.StatusCode != 200 || readErr != nil {
			t.Fatal("keep-alive connection poisoned")
		}
	}
	if reused.Load() != 19 {
		t.Fatal("completed requests unexpectedly closed keep-alive connections")
	}
}
