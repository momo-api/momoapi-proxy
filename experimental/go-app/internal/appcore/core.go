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
	mu              sync.Mutex
	config          Config
	running         bool
	active          int
	cancels         map[uint64]context.CancelFunc
	serial          uint64
	token           string
	endpoint        string
	client          *http.Client
	history         responseHistory
	attachments     attachmentStore
	images          imageSession
	videos          videoSession
	routeCounts     [routeDiagnosticSlots]routeDiagnosticCounter
	routeGeneration uint64
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
	for _, cidr := range []string{"0.0.0.0/8", "100.64.0.0/10", "192.0.0.0/24", "192.0.2.0/24", "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24", "240.0.0.0/4", "64:ff9b::/96", "64:ff9b:1::/48", "100::/64", "2001:db8::/32", "2001::/32", "2002::/16"} {
		_, block, _ := net.ParseCIDR(cidr)
		if block.Contains(ip) {
			return false
		}
	}
	return true
}
func publicDial(ctx context.Context, network, address string) (net.Conn, error) {
	dial := net.Dialer{Timeout: 10 * time.Second}
	return publicDialWith(ctx, network, address, net.DefaultResolver.LookupIPAddr, dial.DialContext)
}

// Dependencies are injected only by package tests, never via product flags.
func publicDialWith(ctx context.Context, network, address string, lookup func(context.Context, string) ([]net.IPAddr, error), connect func(context.Context, string, string) (net.Conn, error)) (net.Conn, error) {
	host, port, err := net.SplitHostPort(address)
	if err != nil || port != "443" {
		return nil, errors.New("upstream address rejected")
	}
	ips, err := lookup(ctx, host)
	if err != nil || len(ips) == 0 {
		return nil, errors.New("upstream resolution failed")
	}
	// Reject mixed public/private DNS answers; connect only validated literal IPs.
	for _, ip := range ips {
		if !publicIP(ip.IP) {
			return nil, errors.New("upstream address rejected")
		}
	}
	for _, ip := range ips {
		conn, err := connect(ctx, network, net.JoinHostPort(ip.IP.String(), port))
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
	c.attachments.clear()
	c.images.clear()
	c.videos.clear()
	c.routeCounts = [routeDiagnosticSlots]routeDiagnosticCounter{}
	c.routeGeneration++
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
		capability = routedCapabilityLabel()
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
	c.attachments.clear()
	c.images.clear()
	c.videos.clear()
	c.routeCounts = [routeDiagnosticSlots]routeDiagnosticCounter{}
	c.routeGeneration++
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
		if path := canonicalPublicRoute(r.URL.Path); path != "" && path != r.URL.Path {
			// Clone instead of mutating the caller's request/URL. All downstream
			// admission, history and protocol gates see the canonical API route.
			r = r.Clone(r.Context())
			r.URL.Path = path
		}
		attachmentRoute, attachmentMethod := attachmentRoute(r.URL.Path, r.Method)
		imageRoute, imageMethod := imageRoute(r.URL.Path, r.Method)
		videoRoute, videoMethod := videoRoute(r.URL.Path, r.Method)
		if !videoRoute && !imageRoute && !attachmentRoute && r.URL.Path != "/v1/models" && r.URL.Path != "/v1/responses" && r.URL.Path != "/v1/chat/completions" && r.URL.Path != "/v1/responses/compact" {
			http.NotFound(w, r)
			return
		}
		if videoRoute && !videoMethod || imageRoute && !imageMethod || attachmentRoute && !attachmentMethod || !videoRoute && !imageRoute && !attachmentRoute && (r.URL.Path == "/v1/models" && r.Method != "GET" || r.URL.Path != "/v1/models" && r.Method != "POST") {
			http.Error(w, "method denied", 405)
			return
		}
		c.proxy(w, r)
	})
}
func (c *Core) proxy(w http.ResponseWriter, r *http.Request) {
	replay, validReplay := providerReplayRequested(r)
	if !validReplay {
		http.Error(w, "invalid history replay policy", 400)
		return
	}
	dsml, validDSML := dsmlRequested(r)
	if !validDSML {
		http.Error(w, "invalid tool text policy", 400)
		return
	}
	clientPolicy, validClientPolicy := clientPolicyRequested(r)
	if !validClientPolicy {
		http.Error(w, "invalid client policy", 400)
		return
	}
	nativeCompact, validCompactHeader := nativeCompactRequested(r)
	if !validCompactHeader {
		http.Error(w, "invalid compact policy", 400)
		return
	}
	attachmentInline, validAttachmentHeader := attachmentInlineRequested(r)
	if !validAttachmentHeader {
		http.Error(w, "invalid attachment policy", 400)
		return
	}
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
	generation := c.history.generation
	routeGeneration := c.routeGeneration
	c.serial++
	id := c.serial
	requestTimeout := 120 * time.Second
	if image, _ := imageRoute(r.URL.Path, r.Method); image && (r.URL.Path == "/internal/images/generate" || r.URL.Path == "/internal/images/edit") {
		requestTimeout = 300 * time.Second
	}
	ctx, cancel := context.WithTimeout(r.Context(), requestTimeout)
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
	if local, _ := attachmentRoute(r.URL.Path, r.Method); local {
		c.attachmentRequest(ctx, w, r, body, config, generation)
		return
	}
	if image, _ := imageRoute(r.URL.Path, r.Method); image {
		c.imageRequest(ctx, w, r, body, config, generation)
		return
	}
	if video, _ := videoRoute(r.URL.Path, r.Method); video {
		c.videoRequest(ctx, w, r, body, config, generation)
		return
	}
	stream := false
	var routed *chatPlan
	var selectedAdapter routeAdapter
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
		protocol := resolveProtocol(model)
		converted := r.URL.Path == "/v1/responses" && config.Mode == "momo-routing" && responseConversionProtocol(protocol)
		if replay && !converted {
			http.Error(w, "history replay policy requires converted routing", 400)
			return
		}
		if dsml && (!converted || protocol != "chat") {
			http.Error(w, "tool text policy requires converted Chat routing", 400)
			return
		}
		// Reject duplicate controls/schema keys before history normalization
		// can reserialize them away. Native/default bytes still bypass this.
		if converted {
			if protocol == "claude" && !validClaudeUnicode(body) {
				http.Error(w, "invalid explicit conversion request", 400)
				return
			}
			if _, err := decodeVideoObject(body); err != nil {
				http.Error(w, "invalid explicit conversion request", 400)
				return
			}
		}
		if clientPolicy && converted {
			body, err = normalizeTextToolsClient(body)
			if err != nil {
				http.Error(w, "unsupported text-tools client options", 400)
				return
			}
		}
		if attachmentInline {
			protocol := resolveProtocol(model)
			if protocol == "claude" && !validClaudeUnicode(body) {
				http.Error(w, "invalid explicit conversion request", 400)
				return
			}
			if config.Mode != "momo-routing" || nativeCompact || !responseConversionProtocol(protocol) {
				http.Error(w, "attachment policy requires converted routing", 400)
				return
			}
			body, err = c.expandAttachments(ctx, body, generation)
			if err != nil {
				http.Error(w, "unsupported or expired attachment", 400)
				return
			}
		}
		if r.URL.Path == "/v1/responses/compact" {
			if !nativeCompact {
				c.localCheckpoint(ctx, w, body, config)
				return
			}
			if resolveProtocol(model) != "responses" {
				http.Error(w, "native compact requires a Responses model", 422)
				return
			}
			if stream {
				http.Error(w, "native compact requires JSON output", 400)
				return
			}
		}
		if r.URL.Path == "/v1/responses" && config.Mode == "momo-routing" {
			var seed *historySeed
			protocol := resolveProtocol(model)
			if responseConversionProtocol(protocol) {
				var historyErr error
				body, seed, historyErr = c.prepareRoutedHistoryPolicy(body, model, replay)
				if historyErr != nil {
					http.Error(w, "unsupported or expired routed history", 400)
					return
				}
			}
			// All explicit policies, attachment expansion and history preparation
			// precede this single strict build. No completion/history is committed.
			decision, plan, routeErr := preflightResponses(config.Mode, model, body)
			c.recordRoutePreflight(routeGeneration, decision, routeErr)
			if routeErr != nil {
				routePreflightError(w, routeErr)
				return
			}
			routed = plan
			if routed != nil {
				routedProtocol = decision.Protocol
				selectedAdapter, _ = responseRouteAdapter(routedProtocol)
				body = routed.body
				upstreamPath = selectedAdapter.targetPath(model)
			}
			if routed != nil {
				if replay {
					w.Header().Set("X-MOMO-History", "replay-v1")
				}
				if dsml {
					if routed.loading != nil {
						http.Error(w, "tool text policy cannot combine client search", 400)
						return
					}
					routed.dsml = true
					w.Header().Set("X-MOMO-Tool-Text", "dsml-v1")
				}
				if clientPolicy {
					w.Header().Set("X-MOMO-Client-Policy", "text-tools-v1")
				}
				routed.prepareCompletion = c.historyCompletion(ctx, seed)
			}
		}
		if r.URL.Path == "/v1/responses" && config.Mode != "momo-routing" {
			decision, _, routeErr := preflightResponses(config.Mode, model, body)
			c.recordRoutePreflight(routeGeneration, decision, routeErr)
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
		convertErr := selectedAdapter.convert(ctx, w, upstream.Body, routed)
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
		if err != nil || len(data) > MaxResponse || !json.Valid(data) || nativeCompact && !validateNativeCompactResponse(data) {
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
