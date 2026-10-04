package protocol

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
	"unicode/utf8"
)

// MockSession is a test-only private-stdin contract. Endpoint must be a literal
// IPv4 loopback random port, not a hostname, redirect or production URL.
type MockSession struct {
	Endpoint   string  `json:"endpoint"`
	Capability string  `json:"capability"`
	Request    Request `json:"request"`
}

func RunMock(ctx context.Context, data []byte) ([]byte, error) {
	if len(data) > MaxInput || !utf8.Valid(data) || validateJSON(data) != nil {
		return nil, errors.New("mock session rejected")
	}
	var s MockSession
	d := json.NewDecoder(bytes.NewReader(data))
	d.DisallowUnknownFields()
	if err := d.Decode(&s); err != nil {
		return nil, err
	}
	u, err := url.Parse(s.Endpoint)
	if err != nil || u.Scheme != "http" || u.Hostname() != "127.0.0.1" || u.Port() == "" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" {
		return nil, errors.New("mock endpoint rejected")
	}
	if len(s.Request.Calls) != 0 {
		return nil, errors.New("mock input calls forbidden")
	}
	if len(s.Capability) != 64 {
		return nil, errors.New("mock capability required")
	}
	for _, c := range s.Capability {
		if !strings.ContainsRune("0123456789abcdef", c) {
			return nil, errors.New("mock capability rejected")
		}
	}
	registry, err := Registry(s.Request)
	if err != nil {
		return nil, err
	}
	tools := []any{}
	for _, t := range registry {
		tools = append(tools, map[string]any{"type": "function", "function": map[string]any{"name": t.Wire}})
	}
	body, err := json.Marshal(map[string]any{"model": "mock", "stream": true, "tools": tools})
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	transport := &http.Transport{Proxy: nil, DisableKeepAlives: true, ResponseHeaderTimeout: 3 * time.Second, MaxResponseHeaderBytes: 16 << 10, DialContext: (&net.Dialer{Timeout: 3 * time.Second}).DialContext}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: 3 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return errors.New("redirect denied") }}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, s.Endpoint+"/v1/chat/completions", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Momo-Mock-Capability", s.Capability)
	upstream, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer upstream.Body.Close()
	if upstream.StatusCode != 200 || upstream.Header.Get("X-Momo-Mock-Capability") != s.Capability || !strings.HasPrefix(strings.ToLower(upstream.Header.Get("Content-Type")), "text/event-stream") {
		return nil, errors.New("mock upstream rejected")
	}
	return ConvertChat(s.Request, io.LimitReader(upstream.Body, MaxInput+1))
}
