package appcore

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"mime"
	"net/http"
	"net/url"
	"strings"
	"time"
	"unicode/utf8"
)

// Single HTTP send per operation. Reuse the protected public transport settings,
// with a per-image clone for long generation headers; no global deadline change.
// Test-only wrappers remain injected. Redirect policy remains deny, never follow
// provider image URLs or add auth to them. No retries or synchronous task polling.
func (c *Core) imageJSON(ctx context.Context, config Config, method, path string, body []byte, limit int) ([]byte, int) {
	return c.mediaJSON(ctx, config, method, path, body, limit, false)
}

// Video explicitly disables reuse so Go's transport cannot replay a task GET
// on a previously-used connection. Image transport behavior remains unchanged.
func (c *Core) mediaJSON(ctx context.Context, config Config, method, path string, body []byte, limit int, noReuse bool) ([]byte, int) {
	req, err := http.NewRequestWithContext(ctx, method, config.Endpoint+path, bytes.NewReader(body))
	if err != nil {
		return nil, 502
	}
	req.Header.Set("Authorization", "Bearer "+config.APIKey)
	req.Header.Set("Accept", "application/json")
	if method == "POST" {
		req.Header.Set("Content-Type", "application/json")
	}
	client := *c.client
	client.Timeout = 0
	if transport, ok := client.Transport.(*http.Transport); ok {
		clone := transport.Clone()
		if noReuse {
			clone.DisableKeepAlives = true
		}
		clone.ResponseHeaderTimeout = 300 * time.Second
		client.Transport = clone
		defer clone.CloseIdleConnections()
	}
	response, err := client.Do(req)
	if err != nil {
		return nil, 502
	}
	defer response.Body.Close()
	if response.StatusCode != 200 {
		status := response.StatusCode
		if status < 400 || status > 599 {
			status = 502
		}
		return nil, status
	}
	typ, _, err := mime.ParseMediaType(response.Header.Get("Content-Type"))
	if err != nil || typ != "application/json" {
		return nil, 502
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, int64(limit)+1))
	if err != nil || len(data) > limit || ctx.Err() != nil || !json.Valid(data) || !utf8.Valid(data) {
		return nil, 502
	}
	return data, 200
}

func (c *Core) imageRequest(ctx context.Context, w http.ResponseWriter, r *http.Request, body []byte, config Config, generation uint64) {
	if r.Method == "GET" && len(body) != 0 {
		http.Error(w, "body denied", 400)
		return
	}
	if r.URL.Path == "/internal/images/capabilities" {
		c.refreshImageCatalog(ctx, w, config, generation)
		return
	}
	if r.URL.Path == "/internal/images/generate" || r.URL.Path == "/internal/images/edit" {
		typ, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
		if err != nil || typ != "application/json" {
			http.Error(w, "JSON required", 415)
			return
		}
		p, err := decodeVideoObject(body)
		if err != nil {
			http.Error(w, "invalid image request", 400)
			return
		}
		model := str(p["model"])
		c.mu.Lock()
		if !c.running || ctx.Err() != nil || generation != c.history.generation {
			c.mu.Unlock()
			http.Error(w, "image session unavailable", 503)
			return
		}
		profile, ok := c.images.profiles[model]
		catalogChecked := c.images.checked
		fresh := time.Now().Before(catalogChecked.Add(imageCatalogTTL))
		c.mu.Unlock()
		if !ok || !profile.Available || !fresh {
			http.Error(w, "query image capabilities and select an available model", 409)
			return
		}
		var wire []byte
		var n int
		upstreamPath := "/v1/images/generations"
		if r.URL.Path == "/internal/images/edit" {
			wire, n, upstreamPath, err = buildImageEdit(body, profile)
		} else {
			wire, n, err = buildImageGeneration(body, profile)
		}
		if err != nil {
			http.Error(w, "unsupported image request", 400)
			return
		}
		c.mu.Lock()
		c.images.expire(time.Now())
		if !c.running || ctx.Err() != nil || generation != c.history.generation {
			c.mu.Unlock()
			http.Error(w, "image session unavailable", 503)
			return
		}
		if c.images.checked != catalogChecked || !time.Now().Before(catalogChecked.Add(imageCatalogTTL)) {
			c.mu.Unlock()
			http.Error(w, "image catalog changed or expired; query capabilities", 409)
			return
		}
		if len(c.images.tasks)+c.images.pending >= maxImageTasks {
			c.mu.Unlock()
			http.Error(w, "image task storage full", 507)
			return
		}
		c.images.pending++
		c.mu.Unlock()
		defer func() {
			c.mu.Lock()
			if generation == c.history.generation {
				c.images.pending--
			}
			c.mu.Unlock()
		}()
		data, status := c.imageJSON(ctx, config, "POST", upstreamPath, wire, MaxResponse)
		if status != 200 {
			http.Error(w, "image upstream unavailable or rejected", status)
			return
		}
		var result imageResult
		if upstreamPath == "/v1/chat/completions" {
			result, err = parseChatImageResult(data, n)
		} else {
			result, err = parseImageResult(data, "", n)
		}
		if err != nil {
			http.Error(w, "image upstream response rejected", 502)
			return
		}
		c.mu.Lock()
		if !c.running || ctx.Err() != nil || generation != c.history.generation {
			c.mu.Unlock()
			http.Error(w, "image session unavailable", 503)
			return
		}
		if result.TaskID != "" {
			if _, duplicate := c.images.tasks[result.TaskID]; duplicate {
				c.mu.Unlock()
				http.Error(w, "image upstream task collision", 502)
				return
			}
			if c.images.tasks == nil {
				c.images.tasks = map[string]imageTask{}
			}
			c.images.tasks[result.TaskID] = imageTask{time.Now().Add(imageTaskTTL), n}
		}
		c.mu.Unlock()
		writeImageResult(ctx, w, result)
		return
	}
	id := strings.TrimPrefix(r.URL.Path, "/internal/images/tasks/")
	c.mu.Lock()
	c.images.expire(time.Now())
	task, known := c.images.tasks[id]
	valid := c.running && ctx.Err() == nil && generation == c.history.generation
	c.mu.Unlock()
	if !valid {
		http.Error(w, "image session unavailable", 503)
		return
	}
	if !known {
		http.Error(w, "image task not found in this session", 404)
		return
	}
	data, status := c.imageJSON(ctx, config, "GET", "/v1/tasks/"+url.PathEscape(id), nil, MaxResponse)
	if status != 200 {
		http.Error(w, "image upstream unavailable or rejected", status)
		return
	}
	result, err := parseImageResult(data, id, task.maxN)
	if err != nil {
		http.Error(w, "image upstream response rejected", 502)
		return
	}
	c.mu.Lock()
	current, exists := c.images.tasks[id]
	valid = c.running && ctx.Err() == nil && generation == c.history.generation && exists && current == task && time.Now().Before(task.expires)
	c.mu.Unlock()
	if !valid {
		http.Error(w, "image session unavailable", 503)
		return
	}
	writeImageResult(ctx, w, result)
}

func (c *Core) refreshImageCatalog(parent context.Context, w http.ResponseWriter, config Config, generation uint64) {
	c.mu.Lock()
	if !c.running || parent.Err() != nil || generation != c.history.generation {
		c.mu.Unlock()
		http.Error(w, "image session unavailable", 503)
		return
	}
	// An explicit failed refresh cannot silently keep previous permission alive.
	if c.images.refreshing {
		c.mu.Unlock()
		http.Error(w, "image catalog query busy", 409)
		return
	}
	c.images.refreshing = true
	c.images.profiles = nil
	c.images.checked = time.Time{}
	c.mu.Unlock()
	defer func() {
		c.mu.Lock()
		if generation == c.history.generation {
			c.images.refreshing = false
		}
		c.mu.Unlock()
	}()
	ctx, cancel := context.WithTimeout(parent, 15*time.Second)
	defer cancel()
	data, status := c.imageJSON(ctx, config, "GET", "/agent/media-capabilities", nil, 256<<10)
	var profiles map[string]imageProfile
	var err error
	if status == 200 {
		profiles, err = parseImageCatalog(data)
	} else if status == 404 || status == 405 {
		// Only an explicitly missing contract allows the documented minimal Web
		// model-list query. Authorization/429/5xx/malformed catalog do NOT fallback.
		data, status = c.imageJSON(ctx, config, "GET", "/v1/models", nil, 256<<10)
		if status == 200 {
			profiles, err = fallbackImageCatalog(data)
		}
	}
	if status != 200 {
		http.Error(w, "image catalog unavailable or rejected", status)
		return
	}
	if err != nil {
		http.Error(w, "image catalog response rejected", 502)
		return
	}
	checked := time.Now()
	c.mu.Lock()
	if !c.running || ctx.Err() != nil || generation != c.history.generation {
		c.mu.Unlock()
		http.Error(w, "image session unavailable", 503)
		return
	}
	c.images.profiles, c.images.checked = profiles, checked
	c.mu.Unlock()
	writeImageResult(ctx, w, publicImageCatalog(profiles, checked))
}

func writeImageResult(ctx context.Context, w http.ResponseWriter, value any) {
	data, err := json.Marshal(value)
	if err != nil || len(data) > MaxResponse {
		http.Error(w, "image output rejected", 502)
		return
	}
	if ctx.Err() != nil {
		http.Error(w, "image request cancelled", 503)
		return
	}
	controller := http.NewResponseController(w)
	if controller.SetWriteDeadline(time.Now().Add(15*time.Second)) != nil {
		panic(http.ErrAbortHandler)
	}
	w.Header().Set("Content-Type", "application/json")
	if n, err := w.Write(data); err != nil || n != len(data) || controller.Flush() != nil {
		panic(http.ErrAbortHandler)
	}
}
