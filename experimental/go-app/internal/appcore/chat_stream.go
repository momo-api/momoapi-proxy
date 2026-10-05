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
	e, err := newRoutedResponseWriter(w, plan)
	if err != nil {
		return err
	}
	calls := map[int]*chatCall{}
	order := []int{}
	retained := 0
	finished := false
	terminal := "complete"
	var usage map[string]any
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
			return true, e.accept(streamEvent{kind: terminal, usage: usage}, plan)
		}
		var chunk map[string]json.RawMessage
		if json.Unmarshal([]byte(raw), &chunk) != nil || chunk == nil {
			return false, errRouted
		}
		if _, exists := chunk["error"]; exists {
			return false, errRouted
		}
		if raw, present := chunk["usage"]; present && string(raw) != "null" {
			u, err := decodeObject(string(raw))
			if err != nil {
				return false, err
			}
			next, err := chatTokenUsage(u)
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
		var choices []struct {
			Index        int
			Delta        map[string]json.RawMessage
			FinishReason *string `json:"finish_reason"`
		}
		if v, ok := chunk["choices"]; !ok || json.Unmarshal(v, &choices) != nil || choices == nil {
			return false, errRouted
		}
		if len(choices) == 0 {
			if !finished || chunk["usage"] == nil || string(chunk["usage"]) == "null" {
				return false, errRouted
			}
			return false, nil
		} // usage-only trailers are not a terminal; still require [DONE].
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
			if finished || (*choice.FinishReason != "stop" && *choice.FinishReason != "tool_calls" && *choice.FinishReason != "length") {
				return false, errRouted
			}
			finished = true
			if *choice.FinishReason == "length" {
				terminal = "incomplete"
			}
			if *choice.FinishReason == "tool_calls" && len(calls) == 0 {
				return false, errRouted
			}
		}
		return false, nil
	})
}

// Counts are provider-reported tokens, never currency or an account balance.
// Cache/reasoning are subsets, not extra tokens added to the provider total.
func chatTokenUsage(u map[string]any) (map[string]any, error) {
	if u == nil || !only(u, "prompt_tokens", "completion_tokens", "total_tokens", "prompt_tokens_details", "completion_tokens_details") {
		return nil, errRouted
	}
	in, ok := tokenCount(u["prompt_tokens"])
	if !ok {
		return nil, errRouted
	}
	out, ok := tokenCount(u["completion_tokens"])
	if !ok {
		return nil, errRouted
	}
	total, ok := tokenCount(u["total_tokens"])
	if !ok || in+out > 1<<53-1 || total != in+out {
		return nil, errRouted
	}
	var cached, reasoning int64
	for _, spec := range []struct {
		key, mapped string
		allowed     []string
		count       int64
		dest        *int64
	}{
		{"prompt_tokens_details", "cached_tokens", []string{"cached_tokens", "audio_tokens"}, in, &cached},
		{"completion_tokens_details", "reasoning_tokens", []string{"reasoning_tokens", "audio_tokens", "accepted_prediction_tokens", "rejected_prediction_tokens"}, out, &reasoning},
	} {
		if v, present := u[spec.key]; present && v != nil {
			details := obj(v)
			if details == nil || !only(details, spec.allowed...) {
				return nil, errRouted
			}
			for key, value := range details {
				n, ok := tokenCount(value)
				if !ok || (key == spec.mapped || key == "audio_tokens") && n > spec.count {
					return nil, errRouted
				}
				if key == spec.mapped {
					*spec.dest = n
				}
			}
		}
	}
	return map[string]any{"input_tokens": in, "output_tokens": out, "total_tokens": total, "input_tokens_details": map[string]any{"cached_tokens": cached}, "output_tokens_details": map[string]any{"reasoning_tokens": reasoning}}, nil
}
