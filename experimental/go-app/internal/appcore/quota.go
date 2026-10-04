package appcore

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"time"
)

// TokenQuota is a whitelist, not an account record or monetary balance.
// NewAPI returns quota units; currency conversion and account-wide wallet access
// require a separate, verified account API. Never forward its name/model list.
type TokenQuota struct {
	Available int64
	Used      int64
	Granted   int64
	Unlimited bool
	ExpiresAt int64
	CheckedAt int64
}

var ErrQuotaUnavailable = errors.New("token quota unavailable")
var ErrQuotaUnauthorized = errors.New("token quota authorization rejected")
var ErrQuotaUnsupported = errors.New("token quota endpoint unsupported")
var ErrQuotaBusy = errors.New("token quota query busy")

// QueryTokenQuota is invoked explicitly, never by State or startup. It uses only
// the configured key/origin, the same pinned public-HTTPS transport, no cookies,
// redirects or fallback endpoints, and shares Stop cancellation/admission.
func (c *Core) QueryTokenQuota(parent context.Context) (TokenQuota, error) {
	c.mu.Lock()
	if c.config.APIKey == "" {
		c.mu.Unlock()
		return TokenQuota{}, ErrQuotaUnavailable
	}
	if c.active >= 4 {
		c.mu.Unlock()
		return TokenQuota{}, ErrQuotaBusy
	}
	config := c.config
	c.serial++
	id := c.serial
	ctx, cancel := context.WithTimeout(parent, 8*time.Second)
	c.cancels[id] = cancel
	c.active++
	c.mu.Unlock()
	defer func() { cancel(); c.mu.Lock(); delete(c.cancels, id); c.active--; c.mu.Unlock() }()
	req, err := http.NewRequestWithContext(ctx, "GET", config.Endpoint+"/api/usage/token/", nil)
	if err != nil {
		return TokenQuota{}, ErrQuotaUnavailable
	}
	req.Header.Set("Authorization", "Bearer "+config.APIKey)
	req.Header.Set("Accept", "application/json")
	resp, err := c.client.Do(req)
	if err != nil {
		return TokenQuota{}, ErrQuotaUnavailable
	}
	defer resp.Body.Close()
	if resp.StatusCode == 401 || resp.StatusCode == 403 {
		return TokenQuota{}, ErrQuotaUnauthorized
	}
	if resp.StatusCode == 404 || resp.StatusCode == 405 {
		return TokenQuota{}, ErrQuotaUnsupported
	}
	if resp.StatusCode != 200 {
		return TokenQuota{}, ErrQuotaUnavailable
	}
	typ, _, err := mime.ParseMediaType(resp.Header.Get("Content-Type"))
	if err != nil || typ != "application/json" {
		return TokenQuota{}, ErrQuotaUnavailable
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, 8193))
	if err != nil || len(data) > 8192 {
		return TokenQuota{}, ErrQuotaUnavailable
	}
	quota, err := parseTokenQuota(data)
	if err != nil {
		return TokenQuota{}, ErrQuotaUnavailable
	}
	if ctx.Err() != nil {
		return TokenQuota{}, ErrQuotaUnavailable
	}
	quota.CheckedAt = time.Now().Unix()
	return quota, nil
}

func parseTokenQuota(data []byte) (TokenQuota, error) {
	// Pointer fields distinguish missing/null values from genuine zero balances.
	var envelope struct {
		Code *bool
		Data *struct {
			Object    string
			Available *int64 `json:"total_available"`
			Used      *int64 `json:"total_used"`
			Granted   *int64 `json:"total_granted"`
			Unlimited *bool  `json:"unlimited_quota"`
			ExpiresAt *int64 `json:"expires_at"`
		}
	}
	if json.Unmarshal(data, &envelope) != nil || envelope.Code == nil || !*envelope.Code || envelope.Data == nil {
		return TokenQuota{}, ErrQuotaUnavailable
	}
	d := envelope.Data
	const maxSafe = 9007199254740991
	if d.Object != "token_usage" || d.Available == nil || d.Used == nil || d.Granted == nil || d.Unlimited == nil || d.ExpiresAt == nil {
		return TokenQuota{}, ErrQuotaUnavailable
	}
	if *d.Available < -maxSafe || *d.Available > maxSafe || *d.Used < 0 || *d.Used > maxSafe || *d.Granted < 0 || *d.Granted > maxSafe || *d.ExpiresAt < 0 || *d.ExpiresAt > 253402300799 {
		return TokenQuota{}, ErrQuotaUnavailable
	}
	return TokenQuota{Available: *d.Available, Used: *d.Used, Granted: *d.Granted, Unlimited: *d.Unlimited, ExpiresAt: *d.ExpiresAt}, nil
}
