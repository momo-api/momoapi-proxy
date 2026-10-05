// Package appcore owns the local gateway with default exact passthrough and
// explicit partial MOMO routing. No credential discovery or Node dependency.
package appcore

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

const MaxRequest = 1 << 20
const MaxResponse = 16 << 20
const Capability = "responses-chat-passthrough"
const Version = "0.4.0-preview"

type Config struct {
	Endpoint string
	APIKey   string
	Mode     string
}
type State struct {
	Version       string
	Endpoint      string
	LocalEndpoint string
	Configured    bool
	Running       bool
	Active        int
	Capability    string
	Mode          string
}
type Core struct {
	mu       sync.Mutex
	config   Config
	running  bool
	active   int
	cancels  map[uint64]context.CancelFunc
	serial   uint64
	token    string
	endpoint string
	client   *http.Client
	history  responseHistory
}

func New() (*Core, error) {
	var b [32]byte
	if _, err := rand.Read(b[:]); err != nil {
		return nil, errors.New("session unavailable")
	}
	transport := &http.Transport{Proxy: nil, DialContext: publicDial, TLSHandshakeTimeout: 10 * time.Second, ResponseHeaderTimeout: 30 * time.Second, MaxResponseHeaderBytes: 32 << 10, MaxIdleConns: 4, MaxIdleConnsPerHost: 4}
	return &Core{token: hex.EncodeToString(b[:]), cancels: map[uint64]context.CancelFunc{}, client: &http.Client{Transport: transport, Timeout: 120 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return errors.New("redirect denied") }}}, nil
}

func publicIP(ip net.IP) bool {
	if ip == nil || !ip.IsGlobalUnicast() || ip.IsPrivate() || ip.IsLoopback() || ip.IsLinkLocalUnicast() {
		return false
	}
	// Block non-public special-use ranges beyond Go's RFC1918/ULA classification.
	for _, cidr := range []string{"0.0.0.0/8", "100.64.0.0/10", "192.0.0.0/24", "192.0.2.0/24", "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24", "240.0.0.0/4", "2001:db8::/32", "2001::/32", "2002::/16"} {
		_, block, _ := net.ParseCIDR(cidr)
		if block.Contains(ip) {
			return false
		}
	}
	return true
}
func publicDial(ctx context.Context, network, address string) (net.Conn, error) {
	host, port, err := net.SplitHostPort(address)
	if err != nil || port != "443" {
		return nil, errors.New("upstream address rejected")
	}
	ips, err := net.DefaultResolver.LookupIPAddr(ctx, host)
	if err != nil || len(ips) == 0 {
		return nil, errors.New("upstream resolution failed")
	}
	// Reject mixed public/private DNS answers; connect only validated literal IPs.
	for _, ip := range ips {
		if !publicIP(ip.IP) {
			return nil, errors.New("upstream address rejected")
		}
	}
	dial := net.Dialer{Timeout: 10 * time.Second}
	for _, ip := range ips {
		conn, err := dial.DialContext(ctx, network, net.JoinHostPort(ip.IP.String(), port))
		if err == nil {
			return conn, nil
		}
	}
	return nil, errors.New("upstream unavailable")
}

// ValidateConfig validates without changing state or resolving the endpoint.
func ValidateConfig(c Config) error {
	if c.Mode != "" && c.Mode != "passthrough" && c.Mode != "momo-routing" {
		return errors.New("invalid routing mode")
	}
	u, err := url.Parse(c.Endpoint)
	if err != nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || u.RawPath != "" || (u.Path != "" && u.Path != "/") || (u.Port() != "" && u.Port() != "443") {
		return errors.New("use an HTTPS upstream origin on port 443")
	}
	if ip := net.ParseIP(u.Hostname()); ip != nil && !publicIP(ip) {
		return errors.New("private upstream denied")
	}
	if len(c.APIKey) < 1 || len(c.APIKey) > 4096 || strings.ContainsAny(c.APIKey, "\r\n\x00") {
		return errors.New("invalid upstream key")
	}
	return nil
}
func (c *Core) Configure(config Config) error {
	if err := ValidateConfig(config); err != nil {
		return err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.running || c.active != 0 {
		return errors.New("stop service before changing upstream")
	}
	config.Endpoint = strings.TrimSuffix(config.Endpoint, "/")
	c.config = config
	c.history.clear()
	return nil
}
func (c *Core) State() State {
	c.mu.Lock()
	defer c.mu.Unlock()
	mode := c.config.Mode
	if mode == "" {
		mode = "passthrough"
	}
	capability := Capability
	if mode == "momo-routing" {
		capability = "partial-momo-responses-chat-claude-gemini-routing"
	}
	return State{Version, c.config.Endpoint, c.endpoint, c.config.APIKey != "", c.running, c.active, capability, mode}
}
func (c *Core) Start() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.config.APIKey == "" {
		return errors.New("configure upstream first")
	}
	c.running = true
	return nil
}
func (c *Core) Stop() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.running = false
	c.history.clear()
	for _, cancel := range c.cancels {
		cancel()
	}
}
func (c *Core) Close() {
	c.Stop()
	c.mu.Lock()
	c.config = Config{}
	c.mu.Unlock()
	c.client.CloseIdleConnections()
}

// ConnectionJSON is for explicit native clipboard action/private CLI stdout only.
// Never call it from a WebView binding or include it in State.
func (c *Core) ConnectionJSON() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	b, _ := json.Marshal(map[string]string{"base_url": c.endpoint + "/v1", "api_key": c.token})
	return string(b)
}

func (c *Core) Handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		browser := r.Header.Get("Origin") != ""
		for name := range r.Header {
			if strings.HasPrefix(strings.ToLower(name), "sec-fetch-") {
				browser = true
			}
		}
		if browser {
			http.Error(w, "browser API denied", 403)
			return
		}
		if subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), []byte("Bearer "+c.token)) != 1 {
			http.Error(w, "unauthorized", 401)
			return
		}
		if r.URL.RawPath != "" || r.URL.RawQuery != "" || r.URL.ForceQuery {
			http.Error(w, "invalid route", 400)
			return
		}
		if r.URL.Path != "/v1/models" && r.URL.Path != "/v1/responses" && r.URL.Path != "/v1/chat/completions" && r.URL.Path != "/v1/responses/compact" {
			http.NotFound(w, r)
			return
		}
		if r.URL.Path == "/v1/models" && r.Method != "GET" || r.URL.Path != "/v1/models" && r.Method != "POST" {
			http.Error(w, "method denied", 405)
			return
		}
		c.proxy(w, r)
	})
}
func (c *Core) proxy(w http.ResponseWriter, r *http.Request) {
	c.mu.Lock()
	if !c.running {
		c.mu.Unlock()
		http.Error(w, "proxy stopped", 503)
		return
	}
	if c.active >= 4 {
		c.mu.Unlock()
		http.Error(w, "proxy busy", 503)
		return
	}
	config := c.config
	c.serial++
	id := c.serial
	ctx, cancel := context.WithTimeout(r.Context(), 120*time.Second)
	c.cancels[id] = cancel
	c.active++
	c.mu.Unlock()
	defer func() { cancel(); c.mu.Lock(); delete(c.cancels, id); c.active--; c.mu.Unlock() }()
	// Context cancellation alone does not unblock a server-side request-body
	// read. Interrupt this request's socket read so Stop releases admission even
	// when a client stalls mid-upload. Join any running callback before proceeding
	// so it cannot later modify a connection reused by another request.
	readCancelled := make(chan struct{})
	interruptRead := context.AfterFunc(ctx, func() {
		_ = http.NewResponseController(w).SetReadDeadline(time.Now())
		close(readCancelled)
	})
	body, err := io.ReadAll(io.LimitReader(r.Body, MaxRequest+1))
	if !interruptRead() {
		<-readCancelled
	}
	if ctx.Err() != nil {
		http.Error(w, "request cancelled", 503)
		return
	}
	if err != nil || len(body) > MaxRequest {
		http.Error(w, "request body rejected", 413)
		return
	}
	stream := false
	var routed *chatPlan
	routedProtocol := ""
	upstreamPath := r.URL.Path
	if r.Method == "GET" {
		if len(body) != 0 {
			http.Error(w, "body denied", 400)
			return
		}
	} else {
		requestType, _, typeErr := mime.ParseMediaType(r.Header.Get("Content-Type"))
		if typeErr != nil || requestType != "application/json" {
			http.Error(w, "JSON required", 415)
			return
		}
		var payload map[string]json.RawMessage
		if json.Unmarshal(body, &payload) != nil || payload == nil {
			http.Error(w, "invalid JSON", 400)
			return
		}
		var model string
		if json.Unmarshal(payload["model"], &model) != nil || model == "" {
			http.Error(w, "model required", 400)
			return
		}
		if raw, ok := payload["stream"]; ok && (string(raw) != "true" && string(raw) != "false") {
			http.Error(w, "invalid stream flag", 400)
			return
		}
		stream = string(payload["stream"]) == "true"
		if r.URL.Path == "/v1/responses/compact" {
			c.localCheckpoint(ctx, w, body, config)
			return
		}
		if r.URL.Path == "/v1/responses" && config.Mode == "momo-routing" {
			var seed *historySeed
			protocol := resolveProtocol(model)
			if protocol == "chat" || protocol == "claude" || protocol == "gemini" {
				var historyErr error
				body, seed, historyErr = c.prepareRoutedHistory(body, model)
				if historyErr != nil {
					http.Error(w, "unsupported or expired routed history", 400)
					return
				}
			}
			switch resolveProtocol(model) {
			case "chat":
				routedProtocol = "chat"
				var routeErr error
				routed, routeErr = buildChatPlan(body)
				if routeErr != nil {
					routedPayloadError(w, routeErr)
					return
				}
				body = routed.body
				upstreamPath = "/v1/chat/completions"
			case "claude":
				routedProtocol = "claude"
				var routeErr error
				routed, routeErr = buildClaudePlan(body)
				if routeErr != nil {
					routedPayloadError(w, routeErr)
					return
				}
				body = routed.body
				upstreamPath = "/v1/messages"
			case "responses": // preserve existing exact native protocol bytes
			case "gemini":
				routedProtocol = "gemini"
				var routeErr error
				routed, routeErr = buildGeminiPlan(body)
				if routeErr != nil {
					routedPayloadError(w, routeErr)
					return
				}
				body = routed.body
				upstreamPath = "/v1beta/models/" + url.PathEscape(model) + ":streamGenerateContent?alt=sse"
			default:
				http.Error(w, "model protocol not migrated", 501)
				return
			}
			if routed != nil {
				routed.prepareCompletion = c.historyCompletion(ctx, seed)
			}
		}
		if r.URL.Path == "/v1/chat/completions" {
			var messages []json.RawMessage
			if json.Unmarshal(payload["messages"], &messages) != nil || len(messages) == 0 {
				http.Error(w, "messages required", 400)
				return
			}
		}
		// Forward exact bytes: do not drop namespace or normalize provider fields.
	}
	upstreamReq, err := http.NewRequestWithContext(ctx, r.Method, config.Endpoint+upstreamPath, bytes.NewReader(body))
	if err != nil {
		http.Error(w, "upstream unavailable", 502)
		return
	}
	upstreamReq.Header.Set("Authorization", "Bearer "+config.APIKey)
	if routedProtocol == "claude" {
		upstreamReq.Header.Set("anthropic-version", "2023-06-01")
	}
	if r.Method == "POST" {
		upstreamReq.Header.Set("Content-Type", "application/json")
	}
	upstream, err := c.client.Do(upstreamReq)
	if err != nil {
		http.Error(w, "upstream unavailable", 502)
		return
	}
	defer upstream.Body.Close()
	// Never reflect upstream error bodies/headers: may contain credentials or HTML.
	if upstream.StatusCode != 200 {
		status := upstream.StatusCode
		if status < 400 || status > 599 {
			status = 502
		}
		http.Error(w, "upstream rejected request", status)
		return
	}
	typ, _, typeErr := mime.ParseMediaType(upstream.Header.Get("Content-Type"))
	if routed != nil {
		if typeErr != nil || typ != "text/event-stream" {
			http.Error(w, "upstream protocol mismatch", 502)
			return
		}
		var convertErr error
		if routedProtocol == "claude" {
			convertErr = convertClaudeStream(ctx, w, upstream.Body, routed)
		} else if routedProtocol == "gemini" {
			convertErr = convertGeminiStream(ctx, w, upstream.Body, routed)
		} else {
			convertErr = convertChatStream(ctx, w, upstream.Body, routed)
		}
		if convertErr != nil {
			if !routed.stream && !errors.Is(convertErr, errRoutedWrite) {
				http.Error(w, "upstream conversion failed", 502)
				return
			}
			panic(http.ErrAbortHandler)
		}
		return
	}
	if stream {
		if typeErr != nil || typ != "text/event-stream" {
			http.Error(w, "upstream protocol mismatch", 502)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
		w.WriteHeader(200)
		controller := http.NewResponseController(w)
		buffer := make([]byte, 8192)
		total := 0
		for {
			n, err := upstream.Body.Read(buffer)
			if ctx.Err() != nil {
				panic(http.ErrAbortHandler)
			}
			total += n
			if total > MaxResponse {
				// Abort the HTTP response, do not inject a non-upstream SSE frame or
				// signal clean HTTP EOF after an arbitrary partial event.
				panic(http.ErrAbortHandler)
			}
			if n > 0 {
				if controller.SetWriteDeadline(time.Now().Add(15*time.Second)) != nil {
					panic(http.ErrAbortHandler)
				}
				if written, e := w.Write(buffer[:n]); e != nil || written != n {
					panic(http.ErrAbortHandler)
				}
				if controller.Flush() != nil {
					panic(http.ErrAbortHandler)
				}
			}
			if err != nil {
				if err != io.EOF {
					panic(http.ErrAbortHandler)
				}
				return
			}
		}
	} else {
		if typeErr != nil || typ != "application/json" {
			http.Error(w, "upstream protocol mismatch", 502)
			return
		}
		data, err := io.ReadAll(io.LimitReader(upstream.Body, MaxResponse+1))
		if ctx.Err() != nil {
			panic(http.ErrAbortHandler)
		}
		if err != nil || len(data) > MaxResponse || !json.Valid(data) {
			http.Error(w, "upstream body rejected", 502)
			return
		}
		controller := http.NewResponseController(w)
		if controller.SetWriteDeadline(time.Now().Add(15*time.Second)) != nil {
			panic(http.ErrAbortHandler)
		}
		w.Header().Set("Content-Type", "application/json")
		if written, err := w.Write(data); err != nil || written != len(data) || controller.Flush() != nil {
			panic(http.ErrAbortHandler)
		}
	}
}

// Serve binds random IPv4 loopback. Caller owns cancellation, not the WebView.
func (c *Core) Serve(ctx context.Context, ready func(string)) error {
	l, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return errors.New("local listener unavailable")
	}
	c.mu.Lock()
	c.endpoint = "http://" + l.Addr().String()
	c.mu.Unlock()
	server := &http.Server{Handler: c.Handler(), ReadHeaderTimeout: 3 * time.Second, ReadTimeout: 15 * time.Second, IdleTimeout: 5 * time.Second, MaxHeaderBytes: 8192}
	finished := make(chan struct{})
	shutdownDone := make(chan struct{})
	go func() {
		defer close(shutdownDone)
		select {
		case <-ctx.Done():
		case <-finished:
			return
		}
		c.Stop()
		shutdown, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_ = server.Shutdown(shutdown)
		_ = server.Close()
	}()
	ready(c.State().LocalEndpoint)
	err = server.Serve(&limitedListener{Listener: l, slots: make(chan struct{}, 32)})
	close(finished)
	<-shutdownDone
	c.Close()
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return errors.New("local server failed")
}

type limitedListener struct {
	net.Listener
	slots chan struct{}
}
type limitedConn struct {
	net.Conn
	once    sync.Once
	release func()
}

func (c *limitedConn) Close() error { err := c.Conn.Close(); c.once.Do(c.release); return err }
func (l *limitedListener) Accept() (net.Conn, error) {
	for {
		c, err := l.Listener.Accept()
		if err != nil {
			return nil, err
		}
		select {
		case l.slots <- struct{}{}:
			return &limitedConn{Conn: c, release: func() { <-l.slots }}, nil
		default:
			_ = c.Close()
		}
	}
}
