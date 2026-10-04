//go:build appcheck

package appcore

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"time"
)

// InstallProbeMock exists only in the never-distributed native probe binary.
// Normal builds have no transport injection or loopback upstream bypass.
func InstallProbeMock(c *Core, handler http.Handler) func() {
	mock := httptest.NewTLSServer(handler)
	client := mock.Client()
	client.Timeout = 3 * time.Second
	client.CheckRedirect = c.client.CheckRedirect
	transport := client.Transport.(*http.Transport)
	client.Transport = probeTransport{transport, strings.TrimPrefix(mock.URL, "https://")}
	c.client.CloseIdleConnections()
	c.client = client // installed before WebView loads; no concurrent requests
	return func() { client.CloseIdleConnections(); mock.Close() }
}

type probeTransport struct {
	*http.Transport
	host string
}

func (t probeTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	mapped := r.Clone(r.Context())
	if mapped.URL.Host != "mock.example" {
		return nil, http.ErrNotSupported
	}
	mapped.URL.Host = t.host
	return t.Transport.RoundTrip(mapped)
}
