package appcore

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/momo-api/momoapi-proxy/experimental/go-app/internal/integration"
)

const imageDownloadMaxBytes = 8 << 20

var errImageDownload = errors.New("image result download unavailable; no automatic retry")

// NewImageResultDownloader creates a separate unauthenticated client. Only the
// explicitly selected HTTPS origin is permitted; no ambient proxy, cookie jar,
// redirects, connection reuse (GET replay), or credentials from the Core.
// The callback is used ONLY on normalized image results, never a generic fetch tool.
func NewImageResultDownloader(origin string) (integration.ImageAssetDownload, func(), error) {
	u, err := imageDownloadURL(origin)
	if err != nil || u.Path != "" && u.Path != "/" || u.RawQuery != "" || u.ForceQuery {
		return nil, nil, errImageDownload
	}
	client, transport := imageDownloadClient()
	return imageResultDownloader(u.Hostname(), client), transport.CloseIdleConnections, nil
}

func imageDownloadClient() (*http.Client, *http.Transport) {
	transport := &http.Transport{Proxy: nil, DialContext: publicDial, DisableKeepAlives: true, DisableCompression: true, TLSHandshakeTimeout: 10 * time.Second, ResponseHeaderTimeout: 10 * time.Second, MaxResponseHeaderBytes: 16 << 10}
	return &http.Client{Transport: transport, Timeout: 30 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return errImageDownload }}, transport
}

func imageDownloadURL(raw string) (*url.URL, error) {
	if len(raw) == 0 || len(raw) > 4096 || strings.ContainsAny(raw, "\x00\r\n\\#") {
		return nil, errImageDownload
	}
	u, err := url.Parse(raw)
	if err != nil || !validMediaURL(raw) || u.RawPath != "" || strings.HasSuffix(u.Host, ":") {
		return nil, errImageDownload
	}
	if ip := net.ParseIP(u.Hostname()); ip != nil && !publicIP(ip) {
		return nil, errImageDownload
	}
	return u, nil
}

func imageResultDownloader(host string, client *http.Client) integration.ImageAssetDownload {
	return func(ctx context.Context, raw string) (string, string, error) {
		u, err := imageDownloadURL(raw)
		if err != nil || !strings.EqualFold(u.Hostname(), host) {
			return "", "", errImageDownload
		}
		ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
		defer cancel()
		r, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
		if err != nil {
			return "", "", errImageDownload
		}
		r.Header.Set("Accept", "image/png, image/jpeg, image/webp")
		response, err := client.Do(r)
		if err != nil {
			return "", "", errImageDownload
		}
		defer response.Body.Close()
		kind, _, err := mime.ParseMediaType(response.Header.Get("Content-Type"))
		if err != nil || response.StatusCode != http.StatusOK || kind != "image/png" && kind != "image/jpeg" && kind != "image/webp" || response.Header.Get("Content-Encoding") != "" || response.ContentLength > imageDownloadMaxBytes {
			return "", "", errImageDownload
		}
		data, err := io.ReadAll(io.LimitReader(response.Body, imageDownloadMaxBytes+1))
		if err != nil || ctx.Err() != nil || len(data) == 0 || len(data) > imageDownloadMaxBytes {
			return "", "", errImageDownload
		}
		b64 := base64.StdEncoding.EncodeToString(data)
		// Same bounded header/framing/dimension validator as native Save, not full
		// pixel integrity/content safety. Declared MIME must match original bytes.
		payload, _ := json.Marshal(map[string]any{"confirmed": true, "mime_type": kind, "b64_json": b64})
		if _, _, err := DecodeLocalImageSave(payload); err != nil {
			return "", "", errImageDownload
		}
		return kind, b64, nil
	}
}
