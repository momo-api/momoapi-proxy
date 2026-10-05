package appcore

import (
	"bytes"
	"context"
	"encoding/json"
	"time"
)

const maxHistoryEntries = 64
const maxHistoryBytes = 8 << 20
const maxHistoryItems = 2048
const historyTTL = 30 * time.Minute

// Owned by one Core, only in memory, never exposed through State/Skill/MCP/vault.
// All access/expiry/eviction uses Core.mu; Stop/configure invalidates generations.
type responseHistory struct {
	entries    map[string]historyEntry
	order      []string
	bytes      int
	generation uint64
}
type historyEntry struct {
	model   string
	input   []json.RawMessage
	bytes   int
	expires time.Time
}
type historySeed struct {
	model      string
	input      []json.RawMessage
	generation uint64
	store      bool
}

func (h *responseHistory) clear() {
	h.entries = nil
	h.order = nil
	h.bytes = 0
	h.generation++
}
func (h *responseHistory) remove(id string) {
	if entry, ok := h.entries[id]; ok {
		h.bytes -= entry.bytes
		delete(h.entries, id)
	}
	for i, v := range h.order {
		if v == id {
			h.order = append(h.order[:i], h.order[i+1:]...)
			break
		}
	}
}
func (h *responseHistory) expire(now time.Time) {
	for id, entry := range h.entries {
		if !now.Before(entry.expires) {
			h.remove(id)
		}
	}
}

// Accept only validated completed-output metadata. Preserve semantic fields and
// number precision; unknown data still reaches the strict request parser.
func normalizedHistory(items []json.RawMessage) ([]json.RawMessage, error) {
	if len(items) > maxHistoryItems {
		return nil, errRouted
	}
	out := make([]json.RawMessage, 0, len(items))
	bytes := 0
	for _, raw := range items {
		item, err := decodeObject(string(raw))
		if err != nil {
			return nil, err
		}
		if v, present := item["id"]; present {
			id, ok := v.(string)
			if !ok || id == "" || len(id) > 128 {
				return nil, errRouted
			}
			typ := str(item["type"])
			if typ != "message" && typ != "function_call" && typ != "custom_tool_call" {
				return nil, errRouted
			}
			if typ == "message" && item["role"] != "assistant" {
				return nil, errRouted
			}
			delete(item, "id")
		}
		if v, present := item["status"]; present {
			typ := str(item["type"])
			if v != "completed" || (typ != "message" && typ != "function_call" && typ != "custom_tool_call") {
				return nil, errRouted
			}
			if typ == "message" && item["role"] != "assistant" {
				return nil, errRouted
			}
			delete(item, "status")
		}
		b, err := json.Marshal(item)
		if err != nil {
			return nil, err
		}
		bytes += len(b)
		if bytes > MaxRequest {
			return nil, errRouted
		}
		out = append(out, b)
	}
	return out, nil
}

// Only converted Responses paths use local anchors; native/default bytes bypass
// this entirely. Instructions/knobs are per-turn, never silently inherited.
func (c *Core) prepareRoutedHistory(data []byte, model string) ([]byte, *historySeed, error) {
	var body map[string]json.RawMessage
	if json.Unmarshal(data, &body) != nil {
		return nil, nil, errRouted
	}
	store := true
	if raw, present := body["store"]; present {
		if string(raw) != "true" && string(raw) != "false" {
			return nil, nil, errRouted
		}
		store = string(raw) == "true"
		delete(body, "store")
	}
	var items []json.RawMessage
	if json.Unmarshal(body["input"], &items) != nil || items == nil {
		return nil, nil, errRouted
	}
	items, err := normalizedHistory(items)
	if err != nil {
		return nil, nil, err
	}
	previous := ""
	if raw, present := body["previous_response_id"]; present {
		if json.Unmarshal(raw, &previous) != nil || previous == "" || len(previous) > 128 {
			return nil, nil, errRouted
		}
		delete(body, "previous_response_id")
	}
	c.mu.Lock()
	c.history.expire(time.Now())
	generation := c.history.generation
	if previous != "" {
		entry, ok := c.history.entries[previous]
		if !ok || entry.model != model {
			c.mu.Unlock()
			return nil, nil, errRouted
		}
		// Drop no partial overlap and no repeated-turn content. Only a complete exact
		// semantic prefix is already present; otherwise input is a new suffix.
		full := len(items) >= len(entry.input)
		if full {
			for i, raw := range entry.input {
				if !bytes.Equal(raw, items[i]) {
					full = false
					break
				}
			}
		}
		if !full {
			items = append(append([]json.RawMessage{}, entry.input...), items...)
		}
		c.history.remove(previous)
		if c.history.entries == nil {
			c.history.entries = map[string]historyEntry{}
		}
		c.history.entries[previous] = entry
		c.history.bytes += entry.bytes
		c.history.order = append(c.history.order, previous)
	}
	c.mu.Unlock()
	items, err = normalizedHistory(items)
	if err != nil {
		return nil, nil, err
	}
	body["input"], err = json.Marshal(items)
	if err != nil {
		return nil, nil, err
	}
	b, err := json.Marshal(body)
	if err != nil || len(b) > MaxRequest {
		return nil, nil, errRouted
	}
	return b, &historySeed{model: model, input: items, generation: generation, store: store}, nil
}

// Prepare storage BEFORE emitting completed, commit AFTER a successful local
// terminal write/flush. This is not a network-delivery acknowledgement.
func (c *Core) historyCompletion(ctx context.Context, seed *historySeed) func(string, []any) (func(), error) {
	return func(id string, output []any) (func(), error) {
		if !seed.store {
			return nil, nil
		}
		raw, err := json.Marshal(output)
		if err != nil || len(raw) > MaxRequest {
			return nil, errRouted
		}
		var items []json.RawMessage
		if json.Unmarshal(raw, &items) != nil {
			return nil, errRouted
		}
		items = append(append([]json.RawMessage{}, seed.input...), items...)
		items, err = normalizedHistory(items)
		if err != nil {
			return nil, err
		}
		size := len(id) + len(seed.model)
		for _, raw := range items {
			size += len(raw)
		}
		if size > MaxRequest {
			return nil, errRouted
		}
		return func() {
			c.mu.Lock()
			defer c.mu.Unlock()
			if ctx.Err() != nil || !c.running || c.history.generation != seed.generation {
				return
			}
			c.history.expire(time.Now())
			if c.history.entries == nil {
				c.history.entries = map[string]historyEntry{}
			}
			c.history.remove(id)
			c.history.entries[id] = historyEntry{model: seed.model, input: items, bytes: size, expires: time.Now().Add(historyTTL)}
			c.history.order = append(c.history.order, id)
			c.history.bytes += size
			for len(c.history.entries) > maxHistoryEntries || c.history.bytes > maxHistoryBytes {
				c.history.remove(c.history.order[0])
			}
		}, nil
	}
}
