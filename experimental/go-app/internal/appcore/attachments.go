package appcore

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"mime"
	"net/http"
	"strings"
	"time"
)

const maxAttachments = 64
const maxAttachmentBytes = 8 << 20 // canonical JSON, including Base64
const attachmentTTL = 30 * time.Minute

// Core.mu owns this store. No disk, content-hash IDs, URL fetching, cloud uploads,
// eviction, provider file IDs or cross-device sharing. History stores independent
// inline snapshots; deleting an asset does NOT erase already submitted history.
type attachmentStore struct {
	entries map[string]attachmentEntry
	bytes   int
}
type attachmentEntry struct {
	part json.RawMessage
	meta attachmentMetadata
}
type attachmentMetadata struct {
	ID      string    `json:"asset_id"`
	Type    string    `json:"type"`
	MIME    string    `json:"mime_type"`
	Bytes   int       `json:"decoded_bytes"`
	Name    string    `json:"filename,omitempty"`
	Created time.Time `json:"created_at"`
	Expires time.Time `json:"expires_at"`
}

func validAttachmentID(id string) bool {
	if len(id) != 68 || !strings.HasPrefix(id, "att_") {
		return false
	}
	for _, r := range id[4:] {
		if r < '0' || r > '9' && r < 'a' || r > 'f' {
			return false
		}
	}
	return true
}
func attachmentRoute(path, method string) (bool, bool) {
	if path == "/internal/attachments" {
		return true, method == "POST"
	}
	if id, found := strings.CutPrefix(path, "/internal/attachments/"); found && validAttachmentID(id) {
		return true, method == "GET" || method == "DELETE"
	}
	return false, false
}
func attachmentInlineRequested(r *http.Request) (bool, bool) {
	values := r.Header.Values("X-MOMO-Attachments")
	if len(values) == 0 {
		return false, true
	}
	return true, len(values) == 1 && values[0] == "inline" && (r.URL.Path == "/v1/responses" || r.URL.Path == "/v1/responses/compact")
}
func (s *attachmentStore) clear() { s.entries = nil; s.bytes = 0 }
func (s *attachmentStore) remove(id string) {
	if entry, ok := s.entries[id]; ok {
		s.bytes -= len(entry.part)
		delete(s.entries, id)
	}
}
func (s *attachmentStore) expire(now time.Time) {
	for id, entry := range s.entries {
		if !now.Before(entry.meta.Expires) {
			s.remove(id)
		}
	}
}

func attachmentPart(data []byte) (json.RawMessage, attachmentMetadata, error) {
	// Check original bytes before canonicalization can erase ambiguous fields
	// or substitute invalid UTF-8. Registration is an explicit local API.
	p, err := decodeVideoObject(data)
	if err != nil || !only(p, "part") {
		return nil, attachmentMetadata{}, errRouted
	}
	part := obj(p["part"])
	meta := attachmentMetadata{Type: str(part["type"])}
	budget := &imageBudget{}
	switch meta.Type {
	case "input_image":
		if !strings.HasPrefix(str(part["image_url"]), "data:") {
			return nil, meta, errUnsupportedImage
		}
		image, err := parseRouteImage(part, "gpt-5.5", budget)
		if err != nil {
			return nil, meta, err
		}
		meta.MIME = image.mime
	case "input_file":
		if !strings.HasPrefix(str(part["file_data"]), "data:") {
			return nil, meta, errUnsupportedFile
		}
		// Local registration does not choose an inference provider. The
		// eventual routed request revalidates provider support (Chat rejects
		// non-PDF); no capability/permission is inferred from registration.
		file, err := parseRouteFile(part, "claude-sonnet-4-6", budget)
		if err != nil {
			return nil, meta, err
		}
		meta.MIME, meta.Name = file.mime, file.name
	default:
		return nil, meta, errRouted
	}
	meta.Bytes = budget.bytes
	raw, err := json.Marshal(part)
	return raw, meta, err
}

func writeAttachmentJSON(ctx context.Context, w http.ResponseWriter, value any) {
	data, err := json.Marshal(value)
	if err != nil || ctx.Err() != nil {
		http.Error(w, "attachment unavailable", 503)
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

// Uses the gateway's normal auth/admission/body read/cancel and generation guard.
// Registration precedes response writing; failed delivery is not rollback. No
// listing: an unknown registration can consume a slot until Stop/absolute TTL.
func (c *Core) attachmentRequest(ctx context.Context, w http.ResponseWriter, r *http.Request, body []byte, config Config, generation uint64) {
	if config.Mode != "momo-routing" {
		http.Error(w, "attachments require routing mode", 400)
		return
	}
	var part json.RawMessage
	var meta attachmentMetadata
	if r.Method == "POST" {
		typ, _, typeErr := mime.ParseMediaType(r.Header.Get("Content-Type"))
		if typeErr != nil || typ != "application/json" {
			http.Error(w, "JSON required", 415)
			return
		}
		var err error
		part, meta, err = attachmentPart(body)
		if err != nil {
			http.Error(w, "unsupported attachment", 400)
			return
		}
		var b [32]byte
		if _, err := rand.Read(b[:]); err != nil {
			http.Error(w, "attachment unavailable", 503)
			return
		}
		meta.ID = "att_" + hex.EncodeToString(b[:])
	} else if len(body) != 0 {
		http.Error(w, "body denied", 400)
		return
	}
	c.mu.Lock()
	if ctx.Err() != nil || !c.running || c.history.generation != generation {
		c.mu.Unlock()
		http.Error(w, "attachment unavailable", 503)
		return
	}
	now := time.Now()
	c.attachments.expire(now)
	if r.Method == "POST" {
		if len(c.attachments.entries) >= maxAttachments || len(part) > maxAttachmentBytes-c.attachments.bytes {
			c.mu.Unlock()
			http.Error(w, "attachment storage full", 507)
			return
		}
		if _, collision := c.attachments.entries[meta.ID]; collision {
			c.mu.Unlock()
			http.Error(w, "attachment unavailable", 503)
			return
		}
		meta.Created, meta.Expires = now, now.Add(attachmentTTL)
		if c.attachments.entries == nil {
			c.attachments.entries = map[string]attachmentEntry{}
		}
		c.attachments.entries[meta.ID] = attachmentEntry{part, meta}
		c.attachments.bytes += len(part)
	} else {
		id := strings.TrimPrefix(r.URL.Path, "/internal/attachments/")
		entry, ok := c.attachments.entries[id]
		if !ok {
			c.mu.Unlock()
			http.Error(w, "attachment not found", 404)
			return
		}
		meta = entry.meta
		if r.Method == "DELETE" {
			c.attachments.remove(id)
		}
	}
	c.mu.Unlock()
	if r.Method == "DELETE" {
		writeAttachmentJSON(ctx, w, map[string]bool{"deleted": true})
		return
	}
	writeAttachmentJSON(ctx, w, meta)
}

var errAttachment = errors.New("unsupported or expired attachment")

// Expand only user-message content and candidate tool-result array locations. The
// subsequent shared IR validates pairing (including previous_response_id history),
// roles and unknown fields BEFORE any upstream send/history commit. Never
// recursively rewrite function arguments, tools/schemas, assistant or instructions.
// Call BEFORE history preparation: anchors own inline snapshots, not TTL references.
func (c *Core) expandAttachments(ctx context.Context, data []byte, generation uint64) ([]byte, error) {
	// compact is not a converted Responses request: it needs the same raw
	// framing gate here, before reference expansion reserializes any objects.
	if _, err := decodeVideoObject(data); err != nil {
		return nil, errAttachment
	}
	var body map[string]json.RawMessage
	var items []json.RawMessage
	if json.Unmarshal(data, &body) != nil || json.Unmarshal(body["input"], &items) != nil || items == nil {
		return nil, errAttachment
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if ctx.Err() != nil || !c.running || c.history.generation != generation {
		return nil, errAttachment
	}
	c.attachments.expire(time.Now())
	// Bound retained replacement bytes independent of source whitespace/order.
	// Adding deltas to raw request size over-rejects valid later shrinkage. Every
	// resolved part survives in final JSON; its sum cannot exceed the whole budget.
	// Remaining unchanged source is itself <=1MiB; final marshal checks full size.
	budget, references := 0, 0
	for i, raw := range items {
		var item map[string]json.RawMessage
		if json.Unmarshal(raw, &item) != nil || item == nil {
			return nil, errAttachment
		}
		var role, kind string
		_ = json.Unmarshal(item["role"], &role)
		_ = json.Unmarshal(item["type"], &kind)
		field := ""
		if role == "user" && (kind == "" || kind == "message") {
			field = "content"
		} else if role == "" && (kind == "function_call_output" || kind == "custom_tool_call_output") {
			field = "output"
		}
		if field == "" {
			continue
		}
		var parts []json.RawMessage
		if json.Unmarshal(item[field], &parts) != nil {
			continue
		} // text is checked by strict IR
		changed := false
		for j, rawPart := range parts {
			var part map[string]json.RawMessage
			if json.Unmarshal(rawPart, &part) != nil {
				continue
			}
			var typ, id string
			_ = json.Unmarshal(part["type"], &typ)
			if typ != "momo_attachment" {
				continue
			}
			if len(part) != 2 || json.Unmarshal(part["asset_id"], &id) != nil || !validAttachmentID(id) {
				return nil, errAttachment
			}
			entry, ok := c.attachments.entries[id]
			if !ok {
				return nil, errAttachment
			}
			references++
			budget += len(entry.part)
			if references > 48 || budget > MaxRequest {
				return nil, errAttachment
			}
			parts[j], changed = entry.part, true
		}
		if changed {
			item[field], _ = json.Marshal(parts)
			items[i], _ = json.Marshal(item)
		}
	}
	body["input"], _ = json.Marshal(items)
	result, err := json.Marshal(body)
	if err != nil || len(result) > MaxRequest {
		return nil, errAttachment
	}
	return result, nil
}
