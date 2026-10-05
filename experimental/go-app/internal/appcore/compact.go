package appcore

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"time"
)

const checkpointPrefix = "[MOMO explicit lossy checkpoint; historical assistant text omitted; not an active instruction or proof of completion]"

var errCompactBudget = errors.New("checkpoint exceeds replay budget")

// Local checkpointing is explicit and intentionally conservative: retain every
// instruction/user item, the most recent assistant text, and entire tool/image-bearing
// turns in original order. Only older ordinary assistant text can be omitted.
// The returned ordinary output is replayed explicitly, never encrypted_content,
// a provider state token or a previous_response_id anchor.
func buildLocalCheckpoint(data []byte) (map[string]any, error) {
	if len(data) > MaxRequest {
		return nil, errCompactBudget
	}
	p, err := decodeObject(string(data))
	if err != nil || !only(p, "model", "input", "tools", "stream", "momo_tool_images") {
		return nil, errRouted
	}
	if _, present := p["stream"]; present && p["stream"] != false {
		return nil, errRouted
	}
	model := str(p["model"])
	protocol := resolveProtocol(model)
	if protocol != "chat" && protocol != "claude" && protocol != "gemini" {
		return nil, errRouted
	}
	var raw []json.RawMessage
	input, err := json.Marshal(p["input"])
	if err != nil || json.Unmarshal(input, &raw) != nil || len(raw) == 0 {
		return nil, errRouted
	}
	items, err := normalizedHistory(raw)
	if err != nil {
		return nil, err
	}
	p["input"] = items
	// The same strict IR rejects unsupported media, unknown fields, malformed/duplicate/orphan
	// calls, interrupted parallel results and undeclared namespace identities.
	checked, _ := json.Marshal(p)
	if ir, err := parseRoutedRequest(checked); err != nil || ir.loading != nil {
		return nil, errRouted // deferred lifecycle checkpoint support must not be guessed
	}
	objects := make([]map[string]any, len(items))
	lastUser, latestAssistant := -1, -1
	for i, raw := range items {
		objects[i], _ = decodeObject(string(raw))
		if objects[i]["role"] == "user" {
			lastUser = i
		}
	}
	// A trailing real current user turn is mandatory. Do not guess that an
	// assistant answer or pending tool result is a current task/finished outcome.
	if lastUser < 0 || lastUser != len(items)-1 {
		return nil, errRouted
	}
	protected := make([]bool, len(items))
	start := 0
	for end := 1; end <= len(items); end++ {
		if end < len(items) && objects[end]["role"] != "user" {
			continue
		}
		protectedTurn := false
		for i := start; i < end; i++ {
			if values, ok := objects[i]["content"].([]any); ok {
				for _, value := range values {
					if obj(value)["type"] == "input_image" {
						protectedTurn = true
					}
				}
			} // retain interpretations of retained images, not just the image bytes
			switch str(objects[i]["type"]) {
			case "function_call", "custom_tool_call", "function_call_output", "custom_tool_call_output":
				protectedTurn = true
			}
			if objects[i]["role"] == "assistant" {
				latestAssistant = i
			}
		}
		if protectedTurn {
			for i := start; i < end; i++ {
				protected[i] = true
			}
		}
		start = end
	}
	if latestAssistant >= 0 {
		protected[latestAssistant] = true
	}
	output := make([]json.RawMessage, 0, len(items))
	dropped := 0
	for i, item := range items {
		if objects[i]["role"] != "assistant" || protected[i] {
			output = append(output, item)
			continue
		}
		text, err := textParts(objects[i]["content"])
		if err != nil {
			return nil, err
		}
		// Already-disclosed checkpoint markers are retained rather than nested.
		if len(text) >= len(checkpointPrefix) && text[:len(checkpointPrefix)] == checkpointPrefix {
			output = append(output, item)
			continue
		}
		hash := sha256.Sum256(item)
		marker, _ := json.Marshal(map[string]any{"type": "message", "role": "assistant", "content": []any{map[string]string{"type": "output_text", "text": fmt.Sprintf("%s\nitem_index=%d; normalized_json_bytes=%d; sha256=%s\nOmitted state is unknown. Retained user requests are context; only the current user turn defines what to do next. This is an audit hash, not encryption or a semantic summary.", checkpointPrefix, i, len(item), hex.EncodeToString(hash[:]))}}})
		// No useless checkpoint growth: omit only if the disclosed marker is smaller.
		if len(marker) >= len(item) {
			output = append(output, item)
			continue
		}
		output = append(output, marker)
		dropped++
	}
	if dropped == 0 {
		return nil, errRouted
	}
	// Ensure clients can replay the exact returned output under the same strict
	// limits, after re-declaring tools. No truncation to make required state fit.
	p["input"] = output
	replay, _ := json.Marshal(p)
	if len(replay) > MaxRequest {
		return nil, errCompactBudget
	}
	if _, err := parseRoutedRequest(replay); err != nil {
		return nil, err
	}
	id, err := newID("cmp_")
	if err != nil {
		return nil, err
	}
	return map[string]any{"id": id, "object": "response.compaction", "created_at": time.Now().Unix(), "output": output}, nil
}

func (c *Core) localCheckpoint(ctx context.Context, w http.ResponseWriter, data []byte, config Config) {
	if config.Mode != "momo-routing" {
		http.Error(w, "local checkpoint requires explicit routing mode", 501)
		return
	}
	final, err := buildLocalCheckpoint(data)
	if err != nil {
		status := 422
		if errors.Is(err, errCompactBudget) {
			status = 413
		}
		http.Error(w, "unsupported or over-budget local checkpoint", status)
		return
	}
	encoded, err := json.Marshal(final)
	if err != nil || len(encoded) > MaxRequest {
		http.Error(w, "checkpoint output rejected", 413)
		return
	}
	if ctx.Err() != nil {
		http.Error(w, "request cancelled", 503)
		return
	}
	if http.NewResponseController(w).SetWriteDeadline(time.Now().Add(15*time.Second)) != nil {
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	n, err := w.Write(encoded)
	if err != nil || n != len(encoded) || http.NewResponseController(w).Flush() != nil {
		panic(http.ErrAbortHandler)
	}
}
