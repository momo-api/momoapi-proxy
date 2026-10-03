// Package control is an isolated demo, NOT an API proxy.
package control

import (
	"bytes"
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync/atomic"
	"time"
)

const Protocol = 1

type Session struct {
	Endpoint string
	Token    string
}
type State struct {
	Protocol         int
	Experimental     bool
	ProxyImplemented bool
	DemoRunning      bool
}

// Session secrets must arrive by private pipe, never argv, env or files.
func ReadSession(r io.Reader) (Session, error) {
	var s Session
	data, err := io.ReadAll(io.LimitReader(r, 4097))
	if err != nil || len(data) > 4096 {
		return Session{}, errors.New("invalid session input")
	}
	d := json.NewDecoder(bytes.NewReader(data))
	d.DisallowUnknownFields()
	if d.Decode(&s) != nil {
		return Session{}, errors.New("invalid session input")
	}
	var extra any
	if d.Decode(&extra) != io.EOF {
		return Session{}, errors.New("invalid session input")
	}
	if len(s.Token) != 64 || strings.Trim(s.Token, "01234567"+"89abcdef") != "" {
		return Session{}, errors.New("session requires a random 32-byte hex token")
	}
	if s.Endpoint != "" {
		u, err := url.Parse(s.Endpoint)
		if err != nil || u.Scheme != "http" || u.Hostname() != "127.0.0.1" || u.Port() == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Path != "" {
			return Session{}, errors.New("invalid loopback endpoint")
		}
		port, err := strconv.Atoi(u.Port())
		if err != nil || port < 1 || port > 65535 || u.ForceQuery {
			return Session{}, errors.New("invalid loopback endpoint")
		}
	}
	return s, nil
}

func Handler(token string) http.Handler {
	var running atomic.Bool
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		browser := r.Header.Get("Origin") != ""
		for name := range r.Header {
			if strings.HasPrefix(strings.ToLower(name), "sec-fetch-") {
				browser = true
			}
		}
		if browser {
			http.Error(w, "browser control denied", 403)
			return
		}
		if len(token) != 64 || subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), []byte("Bearer "+token)) != 1 {
			http.Error(w, "unauthorized", 401)
			return
		}
		if r.URL.RawQuery != "" || r.URL.ForceQuery || r.URL.RawPath != "" {
			http.Error(w, "query denied", 400)
			return
		}
		if r.Method == "GET" {
			body, err := io.ReadAll(io.LimitReader(r.Body, 2))
			if err != nil || len(body) != 0 {
				http.Error(w, "body denied", 400)
				return
			}
		}
		switch r.URL.Path {
		case "/control/v1/state":
			if r.Method != "GET" {
				http.Error(w, "method denied", 405)
				return
			}
		case "/control/v1/demo/start", "/control/v1/demo/stop":
			if r.Method != "POST" {
				http.Error(w, "method denied", 405)
				return
			}
			body, err := io.ReadAll(io.LimitReader(r.Body, 2))
			if err != nil || len(body) != 0 {
				http.Error(w, "body denied", 400)
				return
			}
			running.Store(strings.HasSuffix(r.URL.Path, "/start"))
		default:
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(State{Protocol: Protocol, Experimental: true, DemoRunning: running.Load()})
	})
}

func Serve(ctx context.Context, token string, ready func(string)) error {
	l, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return err
	}
	server := &http.Server{Handler: Handler(token), ReadHeaderTimeout: 3 * time.Second, ReadTimeout: 3 * time.Second, WriteTimeout: 3 * time.Second, IdleTimeout: 5 * time.Second, MaxHeaderBytes: 8192}
	done := make(chan struct{})
	defer close(done)
	go func() {
		select {
		case <-ctx.Done():
		case <-done:
			return
		}
		shutdown, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_ = server.Shutdown(shutdown)
	}()
	ready("http://" + l.Addr().String()) // endpoint only; never token
	err = server.Serve(&cappedListener{Listener: l, slots: make(chan struct{}, 32)})
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}

func Call(ctx context.Context, s Session, action string) (State, error) {
	path, method := "/control/v1/state", "GET"
	switch action {
	case "state":
	case "start", "stop":
		path = "/control/v1/demo/" + action
		method = "POST"
	default:
		return State{}, errors.New("unsupported action")
	}
	req, err := http.NewRequestWithContext(ctx, method, s.Endpoint+path, nil)
	if err != nil {
		return State{}, errors.New("invalid request")
	}
	req.Header.Set("Authorization", "Bearer "+s.Token)
	transport := &http.Transport{Proxy: nil}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: 3 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	res, err := client.Do(req)
	if err != nil {
		return State{}, errors.New("demo service unavailable")
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return State{}, errors.New("demo service rejected request")
	}
	if res.Header.Get("Content-Type") != "application/json" {
		return State{}, errors.New("incompatible demo service")
	}
	data, err := io.ReadAll(io.LimitReader(res.Body, 4097))
	if err != nil || len(data) > 4096 {
		return State{}, errors.New("incompatible demo service")
	}
	var state State
	if decodeState(data, &state) != nil || state.Protocol != Protocol || !state.Experimental || state.ProxyImplemented {
		return State{}, errors.New("incompatible demo service")
	}
	return state, nil
}

func decodeState(data []byte, state *State) error {
	d := json.NewDecoder(bytes.NewReader(data))
	start, err := d.Token()
	if err != nil || start != json.Delim('{') {
		return errors.New("invalid state")
	}
	seen := map[string]bool{}
	for d.More() {
		key, err := d.Token()
		if err != nil {
			return err
		}
		name, ok := key.(string)
		if !ok || seen[name] {
			return errors.New("duplicate state field")
		}
		seen[name] = true
		var dst any
		switch name {
		case "Protocol":
			dst = &state.Protocol
		case "Experimental":
			dst = &state.Experimental
		case "ProxyImplemented":
			dst = &state.ProxyImplemented
		case "DemoRunning":
			dst = &state.DemoRunning
		default:
			return errors.New("unknown state field")
		}
		var raw json.RawMessage
		if d.Decode(&raw) != nil || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) || json.Unmarshal(raw, dst) != nil {
			return errors.New("invalid state field")
		}
	}
	if len(seen) != 4 {
		return errors.New("missing state field")
	}
	if _, err = d.Token(); err != nil {
		return err
	}
	var extra any
	if d.Decode(&extra) != io.EOF {
		return errors.New("trailing state")
	}
	return nil
}
