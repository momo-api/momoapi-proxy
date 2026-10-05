package appcore

import (
	"bytes"
	"context"
	"net/http"
	"time"
)

// DesktopImages is for the authenticated native asset bridge only. No token,
// upstream key, transport configuration or arbitrary endpoint crosses the page.
// Reuse proxy admission/cancellation/generation guards and exact image contracts;
// never issue a loopback HTTP request with a privileged token in browser JS.
func (c *Core) DesktopImages(ctx context.Context, path string, body []byte) ([]byte, int) {
	return c.desktopMedia(ctx, path, body, false)
}

// DesktopVideos uses the same bounded native sink and core admission. Fixed
// video paths only; never expose a token or arbitrary upstream URL to the page.
func (c *Core) DesktopVideos(ctx context.Context, path string, body []byte) ([]byte, int) {
	return c.desktopMedia(ctx, path, body, true)
}

func (c *Core) desktopMedia(ctx context.Context, path string, body []byte, video bool) ([]byte, int) {
	method := "GET"
	if path == "/internal/images/generate" || path == "/internal/images/edit" || path == "/internal/videos/generate" {
		method = "POST"
	}
	known, allowed := imageRoute(path, method)
	if video {
		known, allowed = videoRoute(path, method)
	}
	if !known || !allowed || len(body) > MaxRequest {
		return nil, 400
	}
	r, err := http.NewRequestWithContext(ctx, method, "http://localhost"+path, bytes.NewReader(body))
	if err != nil {
		return nil, 400
	}
	r.Header.Set("Content-Type", "application/json")
	w := &desktopImageWriter{header: make(http.Header)}
	c.proxy(w, r)
	if ctx.Err() != nil {
		return nil, 503
	}
	if w.code == 0 {
		w.code = 200
	}
	return w.body.Bytes(), w.code
}

// Bounded memory sink, not a TCP writer: deadlines/Flush do not block. The
// native asset handler delivers one already-validated buffer, without replay or
// rollback on failed WebView delivery. Existing image/task registration precedes
// delivery just as it does for local TCP. No detached goroutine/request retry.
type desktopImageWriter struct {
	header http.Header
	body   bytes.Buffer
	code   int
}

func (w *desktopImageWriter) Header() http.Header { return w.header }
func (w *desktopImageWriter) WriteHeader(code int) {
	if w.code == 0 {
		w.code = code
	}
}
func (w *desktopImageWriter) Write(b []byte) (int, error) {
	if w.body.Len()+len(b) > MaxResponse {
		return 0, http.ErrContentLength
	}
	if w.code == 0 {
		w.code = 200
	}
	return w.body.Write(b)
}
func (w *desktopImageWriter) Flush()                           {}
func (w *desktopImageWriter) SetWriteDeadline(time.Time) error { return nil }
func (w *desktopImageWriter) SetReadDeadline(time.Time) error  { return nil }
