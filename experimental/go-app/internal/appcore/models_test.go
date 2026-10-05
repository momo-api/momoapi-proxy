package appcore

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestModelsExplicitWhitelist(t *testing.T) {
	var calls atomic.Int32
	c, _, _, _ := testCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.URL.Path != "/v1/models" || r.Method != "GET" || r.Header.Get("Authorization") != "Bearer "+syntheticKey || r.Header.Get("Cookie") != "" || r.Header.Get("Origin") != "" {
			t.Error("catalog request contract")
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"data":[{"id":"z","owned_by":"private-do-not-render"},{"id":"a","key":"private-do-not-render"}],"account":"private-do-not-render"}`)
	}))
	c.Stop()
	_ = c.State()
	if calls.Load() != 0 {
		t.Fatal("automatic model query")
	}
	q, err := c.QueryModels(context.Background())
	if err != nil || strings.Join(q.IDs, ",") != "a,z" || q.CheckedAt <= 0 || calls.Load() != 1 || c.State().Active != 0 {
		t.Fatal("explicit model result/admission")
	}
	b, _ := json.Marshal(q)
	if strings.Contains(string(b), "private") || strings.Contains(string(b), syntheticKey) {
		t.Fatal("metadata leak")
	}
}

func TestModelsErrorsAndBounds(t *testing.T) {
	for _, tc := range []struct {
		status    int
		typ, body string
		want      error
	}{
		{401, "application/json", syntheticKey, ErrModelsUnauthorized},
		{403, "application/json", syntheticKey, ErrModelsUnauthorized},
		{404, "application/json", syntheticKey, ErrModelsUnsupported},
		{405, "application/json", syntheticKey, ErrModelsUnsupported},
		{429, "application/json", syntheticKey, ErrModelsUnavailable},
		{200, "text/html", syntheticKey, ErrModelsUnavailable},
		{200, "application/json", strings.Repeat(" ", (256<<10)+1), ErrModelsUnavailable},
		{200, "application/json", "{}", ErrModelsUnavailable},
		{200, "application/json", `{"data":null}`, ErrModelsUnavailable},
		{200, "application/json", `{"data":[{}]}`, ErrModelsUnavailable},
		{200, "application/json", `{"data":[{"id":null}]}`, ErrModelsUnavailable},
		{200, "application/json", `{"data":[{"id":12}]}`, ErrModelsUnavailable},
		{200, "application/json", `{"data":[{"id":"a"},{"id":"a"}]}`, ErrModelsUnavailable},
		{200, "application/json", `{"data":[{"id":"a\nb"}]}`, ErrModelsUnavailable},
		{200, "application/json", `{"data":[{"id":"a\u202eb"}]}`, ErrModelsUnavailable},
		{200, "application/json", `{"data":[]}` + "{}", ErrModelsUnavailable},
		{200, "application/json", "{\"data\":[{\"id\":\"\xff\"}]}", ErrModelsUnavailable},
	} {
		t.Run(fmt.Sprint(tc.status, len(tc.body)), func(t *testing.T) {
			c, _, _, _ := testCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", tc.typ)
				w.WriteHeader(tc.status)
				fmt.Fprint(w, tc.body)
			}))
			_, err := c.QueryModels(context.Background())
			if !errors.Is(err, tc.want) || strings.Contains(err.Error(), syntheticKey) || c.State().Active != 0 {
				t.Fatal("model error boundary")
			}
		})
	}
	for _, data := range []string{
		`{"data":[{"id":"` + strings.Repeat("x", 161) + `"}]}`,
		`{"data":[` + strings.TrimSuffix(strings.Repeat(`{"id":"a"},`, 2049), ",") + "]}",
	} {
		if _, err := parseModelIDs([]byte(data)); err == nil {
			t.Fatal("catalog budget")
		}
	}
	ids, err := parseModelIDs([]byte(`{"data":[]}`))
	if err != nil || ids == nil || len(ids) != 0 {
		t.Fatal("genuine empty catalog")
	}
	c, _ := New()
	defer c.Close()
	if _, err := c.QueryModels(context.Background()); !errors.Is(err, ErrModelsUnavailable) {
		t.Fatal("unconfigured")
	}
}

func TestModelsStopAdmissionAndCancellation(t *testing.T) {
	entered := make(chan struct{})
	c, _, _, _ := testCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { close(entered); <-r.Context().Done() }))
	done := make(chan error, 1)
	go func() { _, err := c.QueryModels(context.Background()); done <- err }()
	<-entered
	if c.State().Active != 1 || c.Configure(Config{Endpoint: "https://other.example", APIKey: syntheticKey}) == nil {
		t.Fatal("query configuration race")
	}
	c.Stop()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("cancelled result")
		}
	case <-time.After(time.Second):
		t.Fatal("Stop did not cancel query")
	}
	if c.State().Active != 0 {
		t.Fatal("retained admission")
	}
	c.mu.Lock()
	c.active = 4
	c.mu.Unlock()
	if _, err := c.QueryModels(context.Background()); !errors.Is(err, ErrModelsBusy) {
		t.Fatal("admission bypass")
	}
	c.mu.Lock()
	c.active = 0
	c.mu.Unlock()
}

func TestModelsParentCancellationAndTransportFailures(t *testing.T) {
	for _, mode := range []string{"parent-cancel", "truncated-body", "redirect"} {
		t.Run(mode, func(t *testing.T) {
			var calls atomic.Int32
			entered := make(chan struct{})
			mock := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				if mode == "parent-cancel" {
					close(entered)
					<-r.Context().Done()
					return
				}
				if mode == "redirect" {
					w.Header().Set("Location", "/redirect-target")
					w.WriteHeader(302)
					return
				}
				w.Header().Set("Content-Type", "application/json")
				w.Header().Set("Content-Length", "9999")
				fmt.Fprint(w, `{"data":[{"id":"a"}]}`)
			}))
			defer mock.Close()
			c, _ := New()
			defer c.Close()
			original := c.client.CheckRedirect
			c.client = mock.Client()
			c.client.CheckRedirect = original
			if err := c.Configure(Config{Endpoint: "https://mock.example", APIKey: syntheticKey}); err != nil {
				t.Fatal("synthetic config")
			}
			transport := c.client.Transport
			c.client.Transport = roundTripFunc(func(r *http.Request) (*http.Response, error) {
				mapped := r.Clone(r.Context())
				mapped.URL.Host = strings.TrimPrefix(mock.URL, "https://")
				return transport.RoundTrip(mapped)
			})
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			done := make(chan error, 1)
			go func() { _, err := c.QueryModels(ctx); done <- err }()
			if mode == "parent-cancel" {
				<-entered
				cancel()
			}
			select {
			case err := <-done:
				if !errors.Is(err, ErrModelsUnavailable) || calls.Load() != 1 || c.State().Active != 0 {
					t.Fatal("transport failure/one-send contract")
				}
			case <-time.After(time.Second):
				t.Fatal("query failure deadline")
			}
		})
	}
}
