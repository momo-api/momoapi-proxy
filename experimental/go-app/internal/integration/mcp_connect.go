package integration

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

const LocalMCPKeyEnv = "MOMO_LOCAL_API_KEY"

// ValidateLocalEndpoint accepts the current gateway's exact IPv4 loopback
// origin only, never DNS, paths, remote addresses, userinfo or URL extensions.
func ValidateLocalEndpoint(endpoint string) error {
	u, err := url.Parse(endpoint)
	if err != nil || u.Scheme != "http" || u.Hostname() != "127.0.0.1" || u.User != nil || u.Path != "" || u.RawPath != "" || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || u.Opaque != "" {
		return errors.New("local endpoint unavailable")
	}
	port, err := strconv.Atoi(u.Port())
	if err != nil || port < 1 || port > 65535 || endpoint != "http://"+net.JoinHostPort("127.0.0.1", strconv.Itoa(port)) {
		return errors.New("local endpoint unavailable")
	}
	return nil
}

// ImageMCPConfig exports no credential. The client must explicitly inherit
// MOMO_LOCAL_API_KEY, copied privately from the desktop's local connection.
// No upstream API key, env value, private prelude, profile or auto-install.
func ImageMCPConfig(executable, endpoint string) (string, error) {
	if executable == "" || strings.ContainsAny(executable, "\r\n\x00") || ValidateLocalEndpoint(endpoint) != nil {
		return "", errors.New("local MCP export unavailable")
	}
	data, err := json.MarshalIndent(map[string]any{"mcpServers": map[string]any{"momo-images-preview": map[string]any{"command": executable, "args": []string{"mcp-images-connect", "--endpoint", endpoint}}}}, "", "  ")
	return string(data), err
}

// NewLocalImageDispatch never owns/configures the gateway. This explicit mode
// attaches to an already running desktop/serve process. No health/catalog query
// at initialization; no generic URLs, proxies, redirects, retries or downloads.
func NewLocalImageDispatch(endpoint, token string) (ImageDispatch, func(), error) {
	if ValidateLocalEndpoint(endpoint) != nil || !validLocalSessionToken(token) {
		return nil, nil, errors.New("local MCP connection unavailable")
	}
	address := strings.TrimPrefix(endpoint, "http://")
	dialer := net.Dialer{Timeout: 5 * time.Second}
	transport := &http.Transport{Proxy: nil, DisableKeepAlives: true, MaxIdleConns: 1, MaxIdleConnsPerHost: 1, MaxConnsPerHost: 1, MaxResponseHeaderBytes: 32 << 10, ResponseHeaderTimeout: 305 * time.Second, DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
		if network != "tcp" || addr != address {
			return nil, errors.New("local address denied")
		}
		return dialer.DialContext(ctx, "tcp4", address)
	}}
	client := &http.Client{Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error { return errors.New("local redirect denied") }}
	dispatch := func(parent context.Context, path string, body []byte) ([]byte, int) {
		method, timeout := "GET", 125*time.Second
		switch {
		case path == "/internal/images/capabilities":
			timeout = 20 * time.Second
		case path == "/internal/images/generate":
			method, timeout = "POST", 305*time.Second
		case strings.HasPrefix(path, "/internal/images/tasks/"):
			id := strings.TrimPrefix(path, "/internal/images/tasks/")
			if len(id) == 0 || len(id) > 256 || id == "." || id == ".." || strings.Trim(id, "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._:-") != "" {
				return nil, 400
			}
		default:
			return nil, 400
		}
		if len(body) > ImageMCPLineLimit || (method == "GET" && len(body) != 0) {
			return nil, 400
		}
		ctx, cancel := context.WithTimeout(parent, timeout)
		defer cancel()
		r, err := http.NewRequestWithContext(ctx, method, endpoint+path, bytes.NewReader(body))
		if err != nil {
			return nil, 400
		}
		r.Header.Set("Authorization", "Bearer "+token)
		r.Header.Set("Accept", "application/json")
		if method == "POST" {
			r.Header.Set("Content-Type", "application/json")
		}
		response, err := client.Do(r)
		if err != nil {
			return nil, 503
		}
		defer response.Body.Close()
		if response.StatusCode != 200 {
			return nil, 503
		} // no error body/headers reflected
		typ, _, err := mime.ParseMediaType(response.Header.Get("Content-Type"))
		if err != nil || typ != "application/json" {
			return nil, 502
		}
		data, err := io.ReadAll(io.LimitReader(response.Body, (16<<20)+1))
		if err != nil || len(data) > 16<<20 || !utf8.Valid(data) || !json.Valid(data) || bytes.Contains(data, []byte(token)) || ctx.Err() != nil {
			return nil, 502
		}
		return data, 200
	}
	return dispatch, client.CloseIdleConnections, nil
}

func validLocalSessionToken(token string) bool {
	if len(token) != 64 {
		return false
	}
	for _, c := range token {
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return false
		}
	}
	return true
}
