package appcore

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
)

// Gemini SSE has no [DONE]. Require STOP plus clean framed EOF, not EOF alone.
// Consume trailers before completing, so late errors/malformed usage cannot pass.
func convertGeminiStream(ctx context.Context, w http.ResponseWriter, body io.Reader, plan *chatPlan) error {
	e, err := newResponseWriter(w, plan.model)
	if err != nil {
		return err
	}
	finished := false
	retained, callCount := 0, 0
	ids := map[string]bool{}
	var usage map[string]any
	charge := func(s string) error {
		retained += len(s)
		if retained > maxRoutedRetained {
			return errRouted
		}
		return nil
	}
	return readRoutedSSEToEOF(ctx, body, func(event, raw string) (bool, error) {
		if event != "" && event != "message" {
			return false, errRouted
		}
		root, err := decodeObject(raw)
		if err != nil {
			return false, err
		}
		if !only(root, "candidates", "usageMetadata", "modelVersion", "responseId", "createTime", "promptFeedback") {
			return false, errRouted
		}
		if feedback, present := root["promptFeedback"]; present {
			f := obj(feedback)
			if f == nil || !only(f, "safetyRatings") || validateGeminiSafety(f["safetyRatings"]) != nil {
				return false, errRouted
			}
		}
		if u, present := root["usageMetadata"]; present {
			next, err := geminiTokenUsage(obj(u))
			if err != nil {
				return false, err
			}
			if usage != nil {
				for _, k := range []string{"input_tokens", "output_tokens", "total_tokens"} {
					if next[k].(int64) < usage[k].(int64) {
						return false, errRouted
					}
				}
				for _, pair := range [][2]string{{"input_tokens_details", "cached_tokens"}, {"output_tokens_details", "reasoning_tokens"}} {
					if obj(next[pair[0]])[pair[1]].(int64) < obj(usage[pair[0]])[pair[1]].(int64) {
						return false, errRouted
					}
				}
			}
			usage = next
		}
		candidates, present := root["candidates"]
		if !present {
			if root["usageMetadata"] == nil {
				return false, errRouted
			}
			return false, nil
		}
		list, ok := candidates.([]any)
		if !ok || len(list) > 1 {
			return false, errRouted
		}
		if len(list) == 0 {
			if root["usageMetadata"] == nil {
				return false, errRouted
			}
			return false, nil
		}
		c := obj(list[0])
		if c == nil || finished || !only(c, "index", "content", "finishReason", "safetyRatings") {
			return false, errRouted
		}
		if index, present := c["index"]; present {
			n, ok := tokenCount(index)
			if !ok || n != 0 {
				return false, errRouted
			}
		}
		if err := validateGeminiSafety(c["safetyRatings"]); err != nil {
			return false, err
		}
		if content, present := c["content"]; present {
			m := obj(content)
			if m == nil || !only(m, "role", "parts") {
				return false, errRouted
			}
			if role, present := m["role"]; present {
				if role != "model" {
					return false, errRouted
				}
			}
			parts, ok := m["parts"].([]any)
			if !ok || len(parts) > 128 {
				return false, errRouted
			}
			for _, part := range parts {
				p := obj(part)
				if p == nil {
					return false, errRouted
				}
				if text, present := p["text"]; present {
					s, ok := text.(string)
					if !ok || !only(p, "text") {
						return false, errRouted
					}
					if err := charge(s); err != nil {
						return false, err
					}
					if err := e.accept(streamEvent{kind: "text", text: s}, plan); err != nil {
						return false, err
					}
				} else if v, present := p["functionCall"]; present {
					if !only(p, "functionCall") {
						return false, errRouted
					} // reject thoughtSignature, don't fake continuation
					call := obj(v)
					if call == nil || !only(call, "name", "args", "id") || obj(call["args"]) == nil {
						return false, errRouted
					}
					name := str(call["name"])
					if !wireName(name) {
						return false, errRouted
					}
					if _, ok := plan.restoreTool(name); !ok {
						return false, errRouted
					}
					id := ""
					if v, present := call["id"]; present {
						var ok bool
						id, ok = v.(string)
						if !ok || id == "" || len(id) > 128 {
							return false, errRouted
						}
					} else {
						id, err = newID("call_")
						if err != nil {
							return false, err
						}
					}
					if ids[id] || callCount >= 128 {
						return false, errRouted
					}
					ids[id] = true
					callCount++
					args, err := json.Marshal(call["args"])
					if err != nil {
						return false, err
					}
					if err := charge(id + name + string(args)); err != nil {
						return false, err
					}
					if err := e.accept(streamEvent{kind: "tool", call: streamToolCall{id, name, string(args)}}, plan); err != nil {
						return false, err
					}
				} else {
					return false, errRouted
				}
			}
		}
		if reason, present := c["finishReason"]; present {
			if reason != "STOP" {
				return false, errRouted
			}
			finished = true
		}
		return false, nil
	}, func() error {
		if !finished || usage == nil {
			return errRouted
		}
		return e.accept(streamEvent{kind: "complete", usage: usage}, plan)
	})
}
func validateGeminiSafety(v any) error {
	if v == nil {
		return nil
	}
	ratings, ok := v.([]any)
	if !ok {
		return errRouted
	}
	for _, rating := range ratings {
		m := obj(rating)
		if m == nil || !only(m, "category", "probability", "probabilityScore", "severity", "severityScore", "blocked") {
			return errRouted
		}
		if blocked, present := m["blocked"]; present {
			if blocked != false {
				return errRouted
			}
		}
	}
	return nil
}
func geminiTokenUsage(u map[string]any) (map[string]any, error) {
	if u == nil {
		return nil, errRouted
	}
	in, ok := tokenCount(u["promptTokenCount"])
	if !ok {
		return nil, errRouted
	}
	out, ok := tokenCount(u["candidatesTokenCount"])
	if !ok {
		return nil, errRouted
	}
	total, ok := tokenCount(u["totalTokenCount"])
	if !ok {
		return nil, errRouted
	}
	var cached, thought int64
	for key, dest := range map[string]*int64{"cachedContentTokenCount": &cached, "thoughtsTokenCount": &thought} {
		if v, present := u[key]; present {
			n, ok := tokenCount(v)
			if !ok {
				return nil, errRouted
			}
			*dest = n
		}
	}
	if in+out+thought > 1<<53-1 || total < in+out+thought || cached > in {
		return nil, errRouted
	}
	return map[string]any{"input_tokens": in, "output_tokens": out, "total_tokens": total, "input_tokens_details": map[string]any{"cached_tokens": cached}, "output_tokens_details": map[string]any{"reasoning_tokens": thought}}, nil
}
