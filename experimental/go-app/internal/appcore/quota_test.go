package appcore

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

const quotaFixture = `{"code":true,"data":{"object":"token_usage","total_available":12345,"total_used":55,"total_granted":12400,"unlimited_quota":false,"expires_at":0,"name":"private-name","key":"private-value"}}`

func TestQuotaWhitelistAndExplicitOnly(t *testing.T) {
	var calls atomic.Int32
	c, _, _, _ := testCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.URL.Path != "/api/usage/token/" || r.Method != "GET" || r.Header.Get("Authorization") != "Bearer "+syntheticKey || r.Header.Get("Cookie") != "" {
			t.Error("quota request contract")
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, quotaFixture)
	}))
	c.Stop()
	_ = c.State()
	if calls.Load() != 0 {
		t.Fatal("automatic query")
	}
	q, err := c.QueryTokenQuota(context.Background())
	if err != nil || q.Available != 12345 || q.Used != 55 || q.CheckedAt == 0 || calls.Load() != 1 {
		t.Fatal("quota result")
	}
	b, _ := json.Marshal(q)
	if strings.Contains(string(b), "private") || strings.Contains(string(b), syntheticKey) {
		t.Fatal("quota metadata leak")
	}
	if c.State().Active != 0 {
		t.Fatal("admission not released")
	}
}

func TestQuotaErrorsAndSchema(t *testing.T) {
	for _, tc := range []struct {
		status    int
		typ, body string
		want      error
	}{
		{401, "application/json", syntheticKey, ErrQuotaUnauthorized},
		{403, "application/json", syntheticKey, ErrQuotaUnauthorized},
		{404, "text/html", syntheticKey, ErrQuotaUnsupported},
		{429, "application/json", syntheticKey, ErrQuotaUnavailable},
		{200, "text/html", syntheticKey, ErrQuotaUnavailable},
		{200, "application/json", strings.Repeat(" ", 8193), ErrQuotaUnavailable},
		{200, "application/json", "{}", ErrQuotaUnavailable},
		{200, "application/json", strings.Replace(quotaFixture, "true", "false", 1), ErrQuotaUnavailable},
		{200, "application/json", strings.Replace(quotaFixture, "12345", "null", 1), ErrQuotaUnavailable},
		{200, "application/json", strings.Replace(quotaFixture, "12345", "1.5", 1), ErrQuotaUnavailable},
		{200, "application/json", strings.Replace(quotaFixture, "12345", "9007199254740992", 1), ErrQuotaUnavailable},
		{200, "application/json", quotaFixture + "{}", ErrQuotaUnavailable},
	} {
		t.Run(fmt.Sprint(tc.status, len(tc.body)), func(t *testing.T) {
			c, _, _, _ := testCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", tc.typ)
				w.WriteHeader(tc.status)
				fmt.Fprint(w, tc.body)
			}))
			_, err := c.QueryTokenQuota(context.Background())
			if !errors.Is(err, tc.want) || strings.Contains(err.Error(), syntheticKey) {
				t.Fatal("unsafe quota error")
			}
		})
	}
	for _, available := range []string{"0", "-1"} {
		q, err := parseTokenQuota([]byte(strings.Replace(quotaFixture, "12345", available, 1)))
		if err != nil || q.Available > 0 {
			t.Fatal("zero/debt quota")
		}
	}
	q, err := parseTokenQuota([]byte(strings.Replace(quotaFixture, `"unlimited_quota":false`, `"unlimited_quota":true`, 1)))
	if err != nil || !q.Unlimited {
		t.Fatal("unlimited")
	}
}

func TestQuotaStopAndAdmission(t *testing.T) {
	entered := make(chan struct{})
	c, _, _, _ := testCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { close(entered); <-r.Context().Done() }))
	done := make(chan error, 1)
	go func() { _, err := c.QueryTokenQuota(context.Background()); done <- err }()
	<-entered
	if c.State().Active != 1 || c.Configure(Config{"https://other.example", syntheticKey}) == nil {
		t.Fatal("config changed during quota query")
	}
	c.Stop()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("cancel accepted")
		}
	case <-time.After(time.Second):
		t.Fatal("Stop did not cancel")
	}
	if c.State().Active != 0 {
		t.Fatal("query admission retained")
	}
	c.mu.Lock()
	c.active = 4
	c.mu.Unlock()
	if _, err := c.QueryTokenQuota(context.Background()); !errors.Is(err, ErrQuotaBusy) {
		t.Fatal("quota limit")
	}
	c.mu.Lock()
	c.active = 0
	c.mu.Unlock()
}
