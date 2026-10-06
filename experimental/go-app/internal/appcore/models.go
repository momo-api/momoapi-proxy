package appcore

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"sort"
	"time"
	"unicode"
	"unicode/utf8"
)

// ModelSnapshot is an explicit, token-scoped catalog check, not proof that any
// listed model or inference protocol works. No owner/account metadata is exposed.
type ModelSnapshot struct {
	IDs       []string
	CheckedAt int64
}

var ErrModelsUnavailable = errors.New("model catalog unavailable")
var ErrModelsUnauthorized = errors.New("model catalog authorization rejected")
var ErrModelsUnsupported = errors.New("model catalog endpoint unsupported")
var ErrModelsBusy = errors.New("model catalog query busy")

func (c *Core) QueryModels(parent context.Context) (ModelSnapshot, error) {
	c.mu.Lock()
	if c.config.APIKey == "" {
		c.mu.Unlock()
		return ModelSnapshot{}, ErrModelsUnavailable
	}
	if c.active >= 4 {
		c.mu.Unlock()
		return ModelSnapshot{}, ErrModelsBusy
	}
	config := c.config
	c.serial++
	id := c.serial
	ctx, cancel := context.WithTimeout(parent, 8*time.Second)
	c.cancels[id] = cancel
	c.active++
	c.mu.Unlock()
	defer func() { cancel(); c.mu.Lock(); delete(c.cancels, id); c.active--; c.mu.Unlock() }()
	req, err := http.NewRequestWithContext(ctx, "GET", config.Endpoint+"/v1/models", nil)
	if err != nil {
		return ModelSnapshot{}, ErrModelsUnavailable
	}
	req.Header.Set("Authorization", "Bearer "+config.APIKey)
	req.Header.Set("Accept", "application/json")
	resp, err := c.client.Do(req)
	if err != nil {
		return ModelSnapshot{}, ErrModelsUnavailable
	}
	defer resp.Body.Close()
	switch resp.StatusCode {
	case 401, 403:
		return ModelSnapshot{}, ErrModelsUnauthorized
	case 404, 405:
		return ModelSnapshot{}, ErrModelsUnsupported
	case 200:
	default:
		return ModelSnapshot{}, ErrModelsUnavailable
	}
	typ, _, err := mime.ParseMediaType(resp.Header.Get("Content-Type"))
	if err != nil || typ != "application/json" {
		return ModelSnapshot{}, ErrModelsUnavailable
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, (256<<10)+1))
	if err != nil || len(data) > 256<<10 || !utf8.Valid(data) {
		return ModelSnapshot{}, ErrModelsUnavailable
	}
	ids, err := parseModelIDs(data)
	if err != nil || ctx.Err() != nil {
		return ModelSnapshot{}, ErrModelsUnavailable
	}
	return ModelSnapshot{IDs: ids, CheckedAt: time.Now().Unix()}, nil
}

func parseModelIDs(data []byte) ([]string, error) {
	var envelope struct {
		Data *[]struct{ ID string }
	}
	if json.Unmarshal(data, &envelope) != nil || envelope.Data == nil || len(*envelope.Data) > 2048 {
		return nil, ErrModelsUnavailable
	}
	ids := make([]string, 0, len(*envelope.Data))
	seen := make(map[string]bool)
	for _, item := range *envelope.Data {
		if len(item.ID) == 0 || len(item.ID) > 160 || seen[item.ID] {
			return nil, ErrModelsUnavailable
		}
		for _, r := range item.ID {
			if unicode.IsControl(r) || unicode.IsSpace(r) || unicode.Is(unicode.Cf, r) || r == utf8.RuneError {
				return nil, ErrModelsUnavailable
			}
		}
		seen[item.ID] = true
		ids = append(ids, item.ID)
	}
	sort.Strings(ids)
	return ids, nil
}
