package appcore

import (
	"context"
	"mime"
	"net/http"
	"net/url"
	"strings"
	"time"
)

func (c *Core) videoRequest(parent context.Context, w http.ResponseWriter, r *http.Request, body []byte, config Config, generation uint64) {
	if r.Method == "GET" && len(body) != 0 {
		http.Error(w, "body denied", 400)
		return
	}
	ctx, cancel := context.WithTimeout(parent, 60*time.Second)
	defer cancel()
	if r.URL.Path == "/internal/videos/capabilities" {
		c.refreshVideoCatalog(ctx, w, config, generation)
		return
	}
	if r.URL.Path == "/internal/videos/generate" {
		typ, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
		if err != nil || typ != "application/json" {
			http.Error(w, "JSON required", 415)
			return
		}
		m, err := decodeVideoObject(body)
		if err != nil {
			http.Error(w, "invalid video request", 400)
			return
		}
		c.mu.Lock()
		if !c.running || ctx.Err() != nil || generation != c.history.generation {
			c.mu.Unlock()
			http.Error(w, "video session unavailable", 503)
			return
		}
		profile, ok := c.videos.profiles[str(m["model"])]
		checked := c.videos.checked
		fresh := time.Now().Before(checked.Add(videoCatalogTTL))
		c.mu.Unlock()
		if !ok || !profile.Available || !fresh {
			http.Error(w, "query video capabilities and select an available model", 409)
			return
		}
		wire, err := buildVideoGeneration(body, profile)
		if err != nil {
			http.Error(w, "unsupported video request", 400)
			return
		}
		c.mu.Lock()
		c.videos.expire(time.Now())
		if !c.running || ctx.Err() != nil || generation != c.history.generation {
			c.mu.Unlock()
			http.Error(w, "video session unavailable", 503)
			return
		}
		if checked != c.videos.checked || !time.Now().Before(checked.Add(videoCatalogTTL)) {
			c.mu.Unlock()
			http.Error(w, "video catalog changed or expired", 409)
			return
		}
		if len(c.videos.tasks)+c.videos.pending >= maxVideoTasks {
			c.mu.Unlock()
			http.Error(w, "video task storage full", 507)
			return
		}
		c.videos.pending++
		c.mu.Unlock()
		defer func() {
			c.mu.Lock()
			if generation == c.history.generation {
				c.videos.pending--
			}
			c.mu.Unlock()
		}()
		// Reuse the protected JSON transport, never a separate protocol/converter.
		data, status := c.mediaJSON(ctx, config, "POST", "/v1/video/generations", wire, MaxResponse, true)
		if status != 200 {
			http.Error(w, "video upstream unavailable or rejected", status)
			return
		}
		result, err := parseVideoResult(data, "")
		if err != nil {
			http.Error(w, "video upstream response rejected", 502)
			return
		}
		c.mu.Lock()
		if !c.running || ctx.Err() != nil || generation != c.history.generation {
			c.mu.Unlock()
			http.Error(w, "video session unavailable", 503)
			return
		}
		if _, duplicate := c.videos.tasks[result.TaskID]; duplicate {
			c.mu.Unlock()
			http.Error(w, "video upstream task collision", 502)
			return
		}
		if c.videos.tasks == nil {
			c.videos.tasks = map[string]videoTask{}
		}
		c.videos.tasks[result.TaskID] = videoTask{time.Now().Add(videoTaskTTL)}
		c.mu.Unlock()
		writeImageResult(ctx, w, result)
		return
	}
	id := strings.TrimPrefix(r.URL.Path, "/internal/videos/tasks/")
	c.mu.Lock()
	c.videos.expire(time.Now())
	task, known := c.videos.tasks[id]
	valid := c.running && ctx.Err() == nil && generation == c.history.generation
	c.mu.Unlock()
	if !valid {
		http.Error(w, "video session unavailable", 503)
		return
	}
	if !known {
		http.Error(w, "video task not found in this session", 404)
		return
	}
	data, status := c.mediaJSON(ctx, config, "GET", "/v1/videos/"+url.PathEscape(id), nil, MaxResponse, true)
	if status != 200 {
		http.Error(w, "video upstream unavailable or rejected", status)
		return
	}
	result, err := parseVideoResult(data, id)
	if err != nil {
		http.Error(w, "video upstream response rejected", 502)
		return
	}
	c.mu.Lock()
	current, exists := c.videos.tasks[id]
	valid = c.running && ctx.Err() == nil && generation == c.history.generation && exists && current == task && time.Now().Before(task.expires)
	c.mu.Unlock()
	if !valid {
		http.Error(w, "video session unavailable", 503)
		return
	}
	writeImageResult(ctx, w, result)
}

func (c *Core) refreshVideoCatalog(parent context.Context, w http.ResponseWriter, config Config, generation uint64) {
	c.mu.Lock()
	if !c.running || parent.Err() != nil || generation != c.history.generation {
		c.mu.Unlock()
		http.Error(w, "video session unavailable", 503)
		return
	}
	if c.videos.refreshing {
		c.mu.Unlock()
		http.Error(w, "video catalog query busy", 409)
		return
	}
	c.videos.refreshing = true
	c.videos.profiles = nil
	c.videos.checked = time.Time{}
	c.mu.Unlock()
	defer func() {
		c.mu.Lock()
		if generation == c.history.generation {
			c.videos.refreshing = false
		}
		c.mu.Unlock()
	}()
	ctx, cancel := context.WithTimeout(parent, 15*time.Second)
	defer cancel()
	data, status := c.mediaJSON(ctx, config, "GET", "/v1/models", nil, 256<<10, true)
	if status != 200 {
		http.Error(w, "video catalog unavailable or rejected", status)
		return
	}
	profiles, err := parseVideoCatalog(data)
	if err != nil {
		http.Error(w, "video catalog response rejected", 502)
		return
	}
	checked := time.Now()
	c.mu.Lock()
	if !c.running || ctx.Err() != nil || generation != c.history.generation {
		c.mu.Unlock()
		http.Error(w, "video session unavailable", 503)
		return
	}
	c.videos.profiles = profiles
	c.videos.checked = checked
	c.mu.Unlock()
	writeImageResult(ctx, w, publicVideoCatalog(profiles, checked))
}
