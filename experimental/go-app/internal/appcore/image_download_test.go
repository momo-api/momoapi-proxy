package appcore

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/momo-api/momoapi-proxy/experimental/go-app/internal/integration"
)

func testImageDownload(t *testing.T, handler http.Handler) (integration.ImageAssetDownload, *http.Client) {
	t.Helper()
	mock := httptest.NewTLSServer(handler)
	t.Cleanup(mock.Close)
	client, transport := imageDownloadClient()
	// Test-only root/dial injection, retaining real product redirect/header/body
	// policies. Certificate still verified; no production trust override exists.
	pool := x509.NewCertPool()
	pool.AddCert(mock.Certificate())
	transport.TLSClientConfig = &tls.Config{RootCAs: pool, ServerName: "example.com", MinVersion: tls.VersionTLS12}
	transport.DialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
		if address != "images.example:443" {
			return nil, errImageDownload
		}
		return (&net.Dialer{}).DialContext(ctx, network, strings.TrimPrefix(mock.URL, "https://"))
	}
	t.Cleanup(transport.CloseIdleConnections)
	return imageResultDownloader("images.example", client), client
}

func TestImageDownloadExplicitOriginAndProductionPolicy(t *testing.T) {
	for _, origin := range []string{"", "http://images.example", "https://127.0.0.1", "https://[::1]", "https://169.254.169.254", "https://192.0.2.1", "https://user:secret@images.example", "https://images.example:444", "https://images.example:", "https://images.example/path", "https://images.example?", "https://images.example?token=private", "https://images.example#", "https://images.example\\other", "https://images.example/%61"} {
		if _, _, err := NewImageResultDownloader(origin); err == nil || strings.Contains(err.Error(), "private") || strings.Contains(err.Error(), "secret") {
			t.Fatal("invalid origin accepted/reflected")
		}
	}
	for _, origin := range []string{"https://images.example", "https://images.example/", "https://images.example:443", "https://1.1.1.1"} {
		_, closeClient, err := NewImageResultDownloader(origin)
		if err != nil {
			t.Fatal("valid origin")
		}
		closeClient()
	}
	client, transport := imageDownloadClient()
	if transport.Proxy != nil || !transport.DisableKeepAlives || !transport.DisableCompression || client.Jar != nil || client.CheckRedirect(nil, nil) == nil || client.Timeout != 30*time.Second || transport.MaxResponseHeaderBytes != 16<<10 {
		t.Fatal("unsafe product client")
	}
	var hits atomic.Int32
	down, _ := testImageDownload(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { hits.Add(1); w.WriteHeader(500) }))
	for _, raw := range []string{"https://other.example/a", "https://images.example.evil/a", "http://images.example/a", "https://images.example:444/a", "https://user@images.example/a", "https://images.example/a#fragment", "https://images.example/a#", "https://images.example/%61", "https://[::ffff:127.0.0.1]/a", strings.Repeat("a", 4097)} {
		if _, _, err := down(context.Background(), raw); err == nil {
			t.Fatal("unsafe result URL")
		}
	}
	if hits.Load() != 0 {
		t.Fatal("invalid URL reached server")
	}
}

func TestImageDownloadPublicDNSMixedAndPinnedLiteral(t *testing.T) {
	for _, ips := range [][]string{{"127.0.0.1"}, {"1.1.1.1", "10.0.0.1"}, {"::ffff:169.254.169.254"}, {"64:ff9b::a00:1"}, {"64:ff9b:1::1"}, {"100::1"}, {"2001:db8::1"}, {}} {
		dials := 0
		_, err := publicDialWith(context.Background(), "tcp", "images.example:443", func(context.Context, string) ([]net.IPAddr, error) {
			var out []net.IPAddr
			for _, ip := range ips {
				out = append(out, net.IPAddr{IP: net.ParseIP(ip)})
			}
			return out, nil
		}, func(context.Context, string, string) (net.Conn, error) { dials++; return nil, errors.New("unexpected") })
		if err == nil || dials != 0 {
			t.Fatal("nonpublic/mixed answer dialed")
		}
	}
	lookups, dials := 0, 0
	a, b := net.Pipe()
	defer a.Close()
	defer b.Close()
	conn, err := publicDialWith(context.Background(), "tcp", "images.example:443", func(_ context.Context, host string) ([]net.IPAddr, error) {
		lookups++
		if host != "images.example" {
			t.Error("hostname")
		}
		return []net.IPAddr{{IP: net.ParseIP("1.1.1.1")}}, nil
	}, func(_ context.Context, network, address string) (net.Conn, error) {
		dials++
		if address != "1.1.1.1:443" || network != "tcp" {
			t.Error("unpinned dial")
		}
		return a, nil
	})
	if err != nil || conn != a || lookups != 1 || dials != 1 {
		t.Fatal("pinned DNS")
	}
	// Real default resolver loopback rejection without a public network call.
	if _, err := publicDial(context.Background(), "tcp", "localhost:443"); err == nil {
		t.Fatal("loopback DNS")
	}
}

func TestImageDownloadTLSBoundsAuthRedirectAndNoReplay(t *testing.T) {
	png := strings.Split(inlineFixture(t, "image/png"), ",")[1]
	data, _ := base64.StdEncoding.DecodeString(png)
	for _, kind := range []string{"ok", "redirect", "status", "missing-mime", "wrong-mime", "magic", "encoding", "length", "chunked", "headers", "timeout", "body-timeout", "truncated", "disconnect"} {
		t.Run(kind, func(t *testing.T) {
			var hits atomic.Int32
			down, client := testImageDownload(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				hits.Add(1)
				if r.Method != "GET" || r.Header.Get("Authorization") != "" || r.Header.Get("Cookie") != "" || r.Header.Get("Referer") != "" || r.Header.Get("Accept-Encoding") != "" || r.URL.RawQuery != "signed=synthetic-only" {
					t.Error("download request/auth")
				}
				w.Header().Set("Content-Type", "image/png")
				switch kind {
				case "redirect":
					http.Redirect(w, r, "https://images.example/second", 302)
					return
				case "status":
					w.WriteHeader(403)
					return
				case "missing-mime":
					w.Header()["Content-Type"] = nil
				case "wrong-mime":
					w.Header().Set("Content-Type", "image/jpeg")
				case "magic":
					w.Write([]byte("not an image"))
					return
				case "encoding":
					w.Header().Set("Content-Encoding", "gzip")
				case "length":
					w.Header().Set("Content-Length", "8388609")
					w.WriteHeader(200)
					return
				case "chunked":
					w.WriteHeader(200)
					w.(http.Flusher).Flush()
					w.Write(bytes.Repeat([]byte("x"), imageDownloadMaxBytes+1))
					return
				case "headers":
					w.Header().Set("X-Oversized", strings.Repeat("x", 32<<10))
				case "timeout":
					<-r.Context().Done()
					return
				case "body-timeout":
					w.WriteHeader(200)
					w.(http.Flusher).Flush()
					<-r.Context().Done()
					return
				case "truncated":
					w.Header().Set("Content-Length", "4096")
					w.Write(data)
					return
				case "disconnect":
					conn, _, _ := w.(http.Hijacker).Hijack()
					conn.Close()
					return
				}
				w.Write(data)
			}))
			if kind == "timeout" || kind == "body-timeout" {
				client.Timeout = 50 * time.Millisecond
			}
			mime, b64, err := down(context.Background(), "https://images.example/result.png?signed=synthetic-only")
			if kind == "ok" {
				if err != nil || mime != "image/png" || b64 != png {
					t.Fatal("original image")
				}
			} else if err == nil || mime != "" || b64 != "" || strings.Contains(err.Error(), "signed=") {
				t.Fatal("invalid download accepted/reflected")
			}
			if hits.Load() != 1 {
				t.Fatal("download redirected/replayed", hits.Load())
			}
		})
	}
	down, _ := testImageDownload(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { t.Error("canceled request sent") }))
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, _, err := down(ctx, "https://images.example/a"); err == nil {
		t.Fatal("canceled download")
	}
}

func TestImageDownloadFormatsAndTLSVerification(t *testing.T) {
	for _, mime := range []string{"image/png", "image/jpeg", "image/webp"} {
		t.Run(mime, func(t *testing.T) {
			b64 := strings.Split(inlineFixture(t, mime), ",")[1]
			if mime == "image/webp" {
				b64 = "UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA"
			}
			data, _ := base64.StdEncoding.DecodeString(b64)
			down, _ := testImageDownload(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", mime+"; test=synthetic")
				w.Write(data)
			}))
			actual, saved, err := down(context.Background(), "https://images.example/result")
			if err != nil || actual != mime || saved != b64 {
				t.Fatal("format/bytes")
			}
		})
	}
	var hits atomic.Int32
	down, client := testImageDownload(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { hits.Add(1) }))
	client.Transport.(*http.Transport).TLSClientConfig.ServerName = "wrong.example"
	if _, _, err := down(context.Background(), "https://images.example/a"); err == nil || hits.Load() != 0 {
		t.Fatal("TLS hostname not verified")
	}
}

func TestPluginURLResultConnectedSaveReopenEditAndNoBilledRetry(t *testing.T) {
	model := "momoapi-gpt-image-2-5-flare"
	reference := inlineFixture(t, "image/png")
	data, _ := base64.StdEncoding.DecodeString(strings.Split(reference, ",")[1])
	var gets, billed atomic.Int32
	var broken atomic.Bool
	down, _ := testImageDownload(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gets.Add(1)
		if r.Header.Get("Authorization") != "" || r.Header.Get("Cookie") != "" {
			t.Error("download auth leak")
		}
		if broken.Load() {
			w.WriteHeader(500)
			return
		}
		w.Header().Set("Content-Type", "image/png")
		w.Write(data)
	}))
	c, endpoint, _, _ := testCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/agent/media-capabilities":
			io.WriteString(w, fixtureImageCatalog(model))
		case "/v1/images/generations", "/v1/images/edits":
			billed.Add(1)
			if r.URL.Path == "/v1/images/edits" {
				var p map[string]any
				json.NewDecoder(r.Body).Decode(&p)
				refs, ok := p["images"].([]any)
				if !ok || len(refs) != 2 || refs[0] != reference || refs[1] != reference {
					t.Error("ordered original refs")
				}
			}
			io.WriteString(w, `{"data":[{"url":"https://images.example/result.png?signed=synthetic-only"}]}`)
		default:
			t.Error("unexpected upstream")
			w.WriteHeader(404)
		}
	}))
	dispatch, closeClient, err := integration.NewLocalImageAssetDispatch(endpoint, c.token)
	if err != nil {
		t.Fatal(err)
	}
	defer closeClient()
	directory := filepath.Join(t.TempDir(), "library")
	store, err := integration.OpenImageAssetLibrary(directory, DecodeLocalImageSave)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { store.Close() }()
	call := func(name string, args any) map[string]any {
		t.Helper()
		raw, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": map[string]any{"name": name, "arguments": args}})
		var out bytes.Buffer
		if integration.ServePluginImageDownloadsMCP(context.Background(), bytes.NewReader(append(raw, '\n')), &out, dispatch, store, down) != nil {
			t.Fatal("serve")
		}
		if strings.Contains(out.String(), c.token) || strings.Contains(out.String(), syntheticKey) || strings.Contains(out.String(), "signed=") {
			t.Fatal("secret/source reflection")
		}
		var reply struct{ Result map[string]any }
		json.Unmarshal(out.Bytes(), &reply)
		return reply.Result
	}
	text := func(result map[string]any) map[string]any {
		t.Helper()
		if result["isError"] == true {
			t.Fatal("unexpected error")
		}
		var value map[string]any
		json.Unmarshal([]byte(result["content"].([]any)[0].(map[string]any)["text"].(string)), &value)
		return value
	}
	cap := text(call("image_capabilities", map[string]any{}))
	if cap["asset_storage"].(map[string]any)["automatic_downloads"] != true || cap["plugin_compatibility"].(map[string]any)["automatic_downloads"] != true {
		t.Fatal("catalog download policy")
	}
	args := map[string]any{"model": model, "prompt": "explicit generation"}
	img := text(call("image_generate", args))["images"].([]any)[0].(map[string]any)
	if img["url"] != nil || img["b64_json"] != nil || img["vision_available"] != false || gets.Load() != 1 || billed.Load() != 1 {
		t.Fatal("compact original save")
	}
	actual, err := os.ReadFile(img["local_path"].(string))
	if err != nil || !bytes.Equal(actual, data) {
		t.Fatal("saved bytes")
	}
	store.Close()
	store, err = integration.OpenImageAssetLibrary(directory, DecodeLocalImageSave)
	if err != nil {
		t.Fatal(err)
	}
	if text(call("image_asset_get", map[string]any{"asset_id": img["asset_id"]}))["asset_id"] != img["asset_id"] || gets.Load() != 1 || billed.Load() != 1 {
		t.Fatal("reopened offline metadata")
	}
	call("image_edit", map[string]any{"model": model, "prompt": "explicit edit", "reference_images": []any{img["reference"], reference}})
	if gets.Load() != 2 || billed.Load() != 2 {
		t.Fatal("edit sends")
	}
	broken.Store(true)
	if call("image_generate", args)["isError"] != true || gets.Load() != 3 || billed.Load() != 3 {
		t.Fatal("failed GET replayed generation")
	}
	broken.Store(false)
	store.Close()
	if call("image_generate", args)["isError"] != true || gets.Load() != 4 || billed.Load() != 4 {
		t.Fatal("failed disk replayed generation")
	}
	c.Stop()
	if call("image_generate", args)["isError"] != true || gets.Load() != 4 || billed.Load() != 4 {
		t.Fatal("Stop gate")
	}
}
