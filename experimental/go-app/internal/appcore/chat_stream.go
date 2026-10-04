package appcore

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
)

const maxRoutedRetained = 1 << 20
const maxRoutedEvent = 1 << 20

type chatCall struct {
	id         string
	name, args strings.Builder
}

// Incremental text, bounded retained tool arguments, exact namespace restoration.
// Never manufacture completion on malformed data/truncated EOF/length refusal.
// Unlike the legacy Node adapter, require finish_reason and [DONE]. No replay.
func convertChatStream(ctx context.Context, w http.ResponseWriter, body io.Reader, plan *chatPlan) error {
	e, err := newResponseWriter(w, plan.model)
	if err != nil {
		return err
	}
	calls := map[int]*chatCall{}
	order := []int{}
	retained := 0
	finished := false
	dsmlTail := ""
	return readRoutedSSE(ctx, body, func(_ string, raw string) (bool, error) {
		if raw == "[DONE]" {
			if !finished {
				return false, errRouted
			}
			seenIDs := map[string]bool{}
			for _, index := range order {
				call := calls[index]
				_, exists := plan.restoreTool(call.name.String())
				if !exists || call.id == "" || seenIDs[call.id] {
					return false, errRouted
				}
				seenIDs[call.id] = true
				if err = e.accept(streamEvent{kind: "tool", call: streamToolCall{call.id, call.name.String(), call.args.String()}}, plan); err != nil {
					return false, err
				}
			}
			if err = e.flushText(); err != nil {
				return false, err
			}
			return true, e.accept(streamEvent{kind: "complete"}, plan)
		}
		var chunk map[string]json.RawMessage
		if json.Unmarshal([]byte(raw), &chunk) != nil || chunk == nil {
			return false, errRouted
		}
		if _, exists := chunk["error"]; exists {
			return false, errRouted
		}
		var choices []struct {
			Index        int
			Delta        map[string]json.RawMessage
			FinishReason *string `json:"finish_reason"`
		}
		if v, ok := chunk["choices"]; !ok || json.Unmarshal(v, &choices) != nil {
			return false, errRouted
		}
		if len(choices) == 0 {
			return false, nil
		} // usage-only: intentionally no usage claim
		if len(choices) != 1 || choices[0].Index != 0 {
			return false, errRouted
		}
		choice := choices[0]
		for key := range choice.Delta {
			if key != "role" && key != "content" && key != "tool_calls" {
				return false, errRouted
			}
		}
		if raw, ok := choice.Delta["content"]; ok && string(raw) != "null" {
			var s string
			if json.Unmarshal(raw, &s) != nil || finished && s != "" {
				return false, errRouted
			}
			retained += len(s)
			if retained > maxRoutedRetained {
				return false, errRouted
			}
			// DSML/tool-text synthesis not migrated: never report it as a successful tool.
			joined := dsmlTail + s
			if strings.Contains(joined, "DSML") {
				return false, errRouted
			}
			if len(joined) > 3 {
				dsmlTail = joined[len(joined)-3:]
			} else {
				dsmlTail = joined
			}
			if err := e.accept(streamEvent{kind: "text", text: s}, plan); err != nil {
				return false, err
			}
		}
		if raw, ok := choice.Delta["tool_calls"]; ok {
			if finished {
				return false, errRouted
			}
			var deltas []struct {
				Index    *int
				ID       string
				Type     string
				Function struct{ Name, Arguments string }
			}
			if json.Unmarshal(raw, &deltas) != nil {
				return false, errRouted
			}
			for _, delta := range deltas {
				if delta.Index == nil || *delta.Index < 0 || *delta.Index > 127 || delta.Type != "" && delta.Type != "function" {
					return false, errRouted
				}
				index := *delta.Index
				call := calls[index]
				if call == nil {
					call = &chatCall{}
					calls[index] = call
					order = append(order, index)
				}
				if delta.ID != "" {
					if len(delta.ID) > 128 || call.id != "" && call.id != delta.ID {
						return false, errRouted
					}
					call.id = delta.ID
				}
				retained += len(delta.Function.Name) + len(delta.Function.Arguments)
				if retained > maxRoutedRetained {
					return false, errRouted
				}
				if call.name.Len()+len(delta.Function.Name) > 64 {
					return false, errRouted
				}
				call.name.WriteString(delta.Function.Name)
				call.args.WriteString(delta.Function.Arguments)
			}
		}
		if choice.FinishReason != nil {
			if finished || (*choice.FinishReason != "stop" && *choice.FinishReason != "tool_calls") {
				return false, errRouted
			}
			finished = true
			if *choice.FinishReason == "tool_calls" && len(calls) == 0 {
				return false, errRouted
			}
		}
		return false, nil
	})
}
