//go:build routecheck

package appcore

import (
	"net/http"
	"net/url"
	"time"
)

// No production entry point or flag; compiled only in never-packaged harness.
func InstallRoutecheckMock(c *Core, mockURL string) func() {
	target, _ := url.Parse(mockURL)
	transport := &http.Transport{Proxy: nil}
	c.client.CloseIdleConnections()
	c.client = &http.Client{Transport: routecheckTransport{transport, target}, Timeout: 120 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrNotSupported }}
	return transport.CloseIdleConnections
}

type routecheckTransport struct {
	base   *http.Transport
	target *url.URL
}

func (t routecheckTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	if r.URL.Host != "mock.example" {
		return nil, http.ErrNotSupported
	}
	clone := r.Clone(r.Context())
	clone.URL.Scheme = t.target.Scheme
	clone.URL.Host = t.target.Host
	return t.base.RoundTrip(clone)
}
