package appcore

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
)

type claudeBlock struct {
	kind, id, name, initial string
	args                    strings.Builder
}

// Ordered Messages blocks -> neutral events -> the shared Responses encoder.
// Require start, closed blocks, an accepted stop reason and message_stop.
func convertClaudeStream(ctx context.Context, w http.ResponseWriter, body io.Reader, plan *chatPlan) error {
	e, err := newResponseWriter(w, plan.model)
	if err != nil {
		return err
	}
	started, finished := false, false
	next, retained, toolCount := 0, 0, 0
	var active *claudeBlock
	ids := map[string]bool{}
	var inputTokens, outputTokens int64
	usageKnown := false
	charge := func(s string) error {
		retained += len(s)
		if retained > maxRoutedRetained {
			return errRouted
		}
		return nil
	}
	return readRoutedSSE(ctx, body, func(event, raw string) (bool, error) {
		m, err := decodeObject(raw)
		if err != nil {
			return false, err
		}
		typ := str(m["type"])
		if event != "" && event != typ {
			return false, errRouted
		}
		if typ == "ping" {
			if !only(m, "type") {
				return false, errRouted
			}
			return false, nil
		}
		if typ == "error" {
			return false, errRouted
		}
		switch typ {
		case "message_start":
			if !only(m, "type", "message") {
				return false, errRouted
			}
			message := obj(m["message"])
			if started || message == nil || str(message["type"]) != "message" || str(message["role"]) != "assistant" {
				return false, errRouted
			}
			content, ok := message["content"].([]any)
			if !ok || len(content) != 0 || message["stop_reason"] != nil || message["stop_sequence"] != nil || !only(message, "id", "type", "role", "model", "content", "stop_reason", "stop_sequence", "usage") {
				return false, errRouted
			}
			u := obj(message["usage"])
			if u == nil {
				return false, errRouted
			}
			in, ok := tokenCount(u["input_tokens"])
			if !ok {
				return false, errRouted
			}
			out, ok := tokenCount(u["output_tokens"])
			if !ok {
				return false, errRouted
			}
			for _, k := range []string{"cache_read_input_tokens", "cache_creation_input_tokens"} {
				if v, present := u[k]; present {
					n, ok := tokenCount(v)
					if !ok || in+n > 1<<53-1 {
						return false, errRouted
					}
					in += n
				}
			}
			inputTokens, outputTokens, usageKnown = in, out, true
			started = true
		case "content_block_start":
			if !only(m, "type", "index", "content_block") {
				return false, errRouted
			}
			index, ok := tokenCount(m["index"])
			if !started || finished || active != nil || !ok || index != int64(next) || next >= 128 {
				return false, errRouted
			}
			b := obj(m["content_block"])
			if b == nil {
				return false, errRouted
			}
			active = &claudeBlock{kind: str(b["type"])}
			switch active.kind {
			case "text":
				text, ok := b["text"].(string)
				if !ok || !only(b, "type", "text") {
					return false, errRouted
				}
				if err := charge(text); err != nil {
					return false, err
				}
				if err := e.accept(streamEvent{kind: "text", text: text}, plan); err != nil {
					return false, err
				}
			case "tool_use":
				active.id, active.name = str(b["id"]), str(b["name"])
				if !only(b, "type", "id", "name", "input") || active.id == "" || len(active.id) > 128 || ids[active.id] || !wireName(active.name) || obj(b["input"]) == nil {
					return false, errRouted
				}
				if _, ok := plan.restoreTool(active.name); !ok {
					return false, errRouted
				}
				v, err := json.Marshal(b["input"])
				if err != nil {
					return false, err
				}
				active.initial = string(v)
				ids[active.id] = true
				toolCount++
				if err := charge(active.id + active.name + active.initial); err != nil {
					return false, err
				}
			default:
				return false, errRouted // thinking/signatures/media are not implemented
			}
		case "content_block_delta":
			if !only(m, "type", "index", "delta") {
				return false, errRouted
			}
			index, ok := tokenCount(m["index"])
			if active == nil || !ok || index != int64(next) || finished {
				return false, errRouted
			}
			d := obj(m["delta"])
			if active.kind == "text" {
				text, ok := d["text"].(string)
				if !ok || str(d["type"]) != "text_delta" || !only(d, "type", "text") {
					return false, errRouted
				}
				if err := charge(text); err != nil {
					return false, err
				}
				if err := e.accept(streamEvent{kind: "text", text: text}, plan); err != nil {
					return false, err
				}
			} else {
				s, ok := d["partial_json"].(string)
				if !ok || str(d["type"]) != "input_json_delta" || !only(d, "type", "partial_json") || active.initial != "{}" {
					return false, errRouted
				}
				if err := charge(s); err != nil {
					return false, err
				}
				active.args.WriteString(s)
			}
		case "content_block_stop":
			if !only(m, "type", "index") {
				return false, errRouted
			}
			index, ok := tokenCount(m["index"])
			if active == nil || !ok || index != int64(next) || finished {
				return false, errRouted
			}
			if active.kind == "tool_use" {
				args := active.initial
				if active.args.Len() > 0 {
					args = active.args.String()
				}
				if _, err := decodeObject(args); err != nil {
					return false, err
				}
				if err := e.accept(streamEvent{kind: "tool", call: streamToolCall{active.id, active.name, args}}, plan); err != nil {
					return false, err
				}
			}
			active = nil
			next++
		case "message_delta":
			if !only(m, "type", "delta", "usage") {
				return false, errRouted
			}
			if !started || finished || active != nil {
				return false, errRouted
			}
			d := obj(m["delta"])
			reason := str(d["stop_reason"])
			if reason != "end_turn" && reason != "stop_sequence" && reason != "tool_use" {
				return false, errRouted
			}
			if (reason == "tool_use") != (toolCount > 0) {
				return false, errRouted
			}
			if !only(d, "stop_reason", "stop_sequence") {
				return false, errRouted
			}
			if reason == "stop_sequence" {
				if s, ok := d["stop_sequence"].(string); !ok || s == "" {
					return false, errRouted
				}
			} else if d["stop_sequence"] != nil {
				return false, errRouted
			}
			u := obj(m["usage"])
			n, ok := tokenCount(u["output_tokens"])
			if !ok || n < outputTokens {
				return false, errRouted
			}
			outputTokens = n
			finished = true
		case "message_stop":
			if !only(m, "type") {
				return false, errRouted
			}
			if !started || !finished || active != nil || !usageKnown || inputTokens+outputTokens > 1<<53-1 {
				return false, errRouted
			}
			usage := map[string]any{"input_tokens": inputTokens, "output_tokens": outputTokens, "total_tokens": inputTokens + outputTokens}
			return true, e.accept(streamEvent{kind: "complete", usage: usage}, plan)
		default:
			return false, errRouted
		}
		return false, nil
	})
}
func tokenCount(v any) (int64, bool) {
	n, ok := v.(json.Number)
	if !ok {
		return 0, false
	}
	count, err := n.Int64()
	return count, err == nil && count >= 0 && count <= 1<<53-1
}
