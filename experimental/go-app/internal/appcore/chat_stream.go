package appcore

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"
)

const maxRoutedRetained = 1 << 20
const maxRoutedEvent = 1 << 20

type chatCall struct {
	id         string
	name, args strings.Builder
}
type responseWriter struct {
	w                http.ResponseWriter
	id, model, msgID string
	text             strings.Builder
	output           []any
	written          int
	index            int
}

func newID(prefix string) (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return prefix + hex.EncodeToString(b[:]), nil
}
func (e *responseWriter) event(name string, p map[string]any) error {
	p["type"] = name
	b, err := json.Marshal(p)
	if err != nil {
		return err
	}
	frame := "event: " + name + "\ndata: " + string(b) + "\n\n"
	e.written += len(frame)
	if e.written > MaxResponse {
		return errRouted
	}
	controller := http.NewResponseController(e.w)
	if err = controller.SetWriteDeadline(time.Now().Add(15 * time.Second)); err != nil {
		return err
	}
	if _, err = io.WriteString(e.w, frame); err != nil {
		return err
	}
	return controller.Flush()
}
func (e *responseWriter) textDelta(s string) error {
	if s == "" {
		return nil
	}
	if e.msgID == "" {
		id, err := newID("msg_")
		if err != nil {
			return err
		}
		e.msgID = id
		if err = e.event("response.output_item.added", map[string]any{"response_id": e.id, "output_index": e.index, "item": map[string]any{"id": id, "type": "message", "role": "assistant", "status": "in_progress", "content": []any{}}}); err != nil {
			return err
		}
		if err = e.event("response.content_part.added", map[string]any{"response_id": e.id, "item_id": id, "output_index": e.index, "content_index": 0, "part": map[string]string{"type": "output_text", "text": ""}}); err != nil {
			return err
		}
	}
	e.text.WriteString(s)
	return e.event("response.output_text.delta", map[string]any{"response_id": e.id, "item_id": e.msgID, "output_index": e.index, "content_index": 0, "delta": s})
}
func (e *responseWriter) flushText() error {
	if e.msgID == "" {
		return nil
	}
	s := e.text.String()
	common := func() map[string]any {
		return map[string]any{"response_id": e.id, "item_id": e.msgID, "output_index": e.index, "content_index": 0}
	}
	p := common()
	p["text"] = s
	if err := e.event("response.output_text.done", p); err != nil {
		return err
	}
	p = common()
	p["part"] = map[string]string{"type": "output_text", "text": s}
	if err := e.event("response.content_part.done", p); err != nil {
		return err
	}
	item := map[string]any{"id": e.msgID, "type": "message", "role": "assistant", "status": "completed", "content": []any{map[string]string{"type": "output_text", "text": s}}}
	if err := e.event("response.output_item.done", map[string]any{"response_id": e.id, "output_index": e.index, "item": item}); err != nil {
		return err
	}
	e.output = append(e.output, item)
	e.index++
	e.msgID = ""
	return nil
}
func (e *responseWriter) toolCall(call *chatCall, tool chatTool) error {
	if err := e.flushText(); err != nil {
		return err
	}
	var args any
	if json.Unmarshal([]byte(call.args.String()), &args) != nil {
		return errRouted
	}
	field, typ, prefix, event := "arguments", "function_call", "fc_", "response.function_call_arguments"
	valueBytes, err := json.Marshal(args)
	if err != nil {
		return err
	}
	value := string(valueBytes)
	if tool.kind == "custom" {
		input, ok := obj(args)["input"].(string)
		if !ok || !only(obj(args), "input") {
			return errRouted
		}
		value = input
		field = "input"
		typ = "custom_tool_call"
		prefix = "ctc_"
		event = "response.custom_tool_call_input"
	}
	id, err := newID(prefix)
	if err != nil {
		return err
	}
	item := map[string]any{"id": id, "type": typ, "status": "completed", "call_id": call.id, "name": tool.name, field: value}
	if tool.namespace != "" {
		item["namespace"] = tool.namespace
	}
	added := map[string]any{}
	for k, v := range item {
		added[k] = v
	}
	added["status"] = "in_progress"
	added[field] = ""
	if err = e.event("response.output_item.added", map[string]any{"response_id": e.id, "output_index": e.index, "item": added}); err != nil {
		return err
	}
	if value != "" {
		if err = e.event(event+".delta", map[string]any{"response_id": e.id, "item_id": id, "output_index": e.index, "delta": value}); err != nil {
			return err
		}
	}
	if err = e.event(event+".done", map[string]any{"response_id": e.id, "item_id": id, "output_index": e.index, field: value}); err != nil {
		return err
	}
	if err = e.event("response.output_item.done", map[string]any{"response_id": e.id, "output_index": e.index, "item": item}); err != nil {
		return err
	}
	e.output = append(e.output, item)
	e.index++
	return nil
}

// Incremental text, bounded retained tool arguments, exact namespace restoration.
// Never manufacture completion on malformed data/truncated EOF/length refusal.
// Unlike the legacy Node adapter, require finish_reason and [DONE]. No replay.
func convertChatStream(ctx context.Context, w http.ResponseWriter, body io.Reader, plan *chatPlan) error {
	id, err := newID("resp_")
	if err != nil {
		return err
	}
	e := &responseWriter{w: w, id: id, model: plan.model, output: []any{}}
	w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	if err = e.event("response.created", map[string]any{"response": map[string]any{"id": id, "object": "response", "status": "in_progress", "model": plan.model, "output": []any{}}}); err != nil {
		return err
	}
	scanner := bufio.NewScanner(io.LimitReader(body, MaxResponse+1))
	scanner.Buffer(make([]byte, 4096), maxRoutedEvent)
	calls := map[int]*chatCall{}
	order := []int{}
	retained, total := 0, 0
	finished := false
	events := 0
	dsmlTail := ""
	var data strings.Builder
	consume := func(raw string) (bool, error) {
		events++
		if events > 65536 {
			return false, errRouted
		}
		if ctx.Err() != nil {
			return false, ctx.Err()
		}
		if raw == "[DONE]" {
			if !finished {
				return false, errRouted
			}
			return true, nil
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
			if err := e.textDelta(s); err != nil {
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
	}
	for scanner.Scan() {
		line := scanner.Text()
		total += len(line) + 1
		if total > MaxResponse {
			return errRouted
		}
		if line == "" {
			if data.Len() == 0 {
				continue
			}
			raw := strings.TrimSuffix(data.String(), "\n")
			data.Reset()
			done, err := consume(raw)
			if err != nil {
				return err
			}
			if done {
				seenIDs := map[string]bool{}
				for _, index := range order {
					call := calls[index]
					tool, exists := plan.restoreTool(call.name.String())
					if !exists || call.id == "" || seenIDs[call.id] {
						return errRouted
					}
					seenIDs[call.id] = true
					if err = e.toolCall(call, tool); err != nil {
						return err
					}
				}
				if err = e.flushText(); err != nil {
					return err
				}
				return e.event("response.completed", map[string]any{"response": map[string]any{"id": id, "object": "response", "status": "completed", "model": plan.model, "output": e.output}})
			}
		} else if strings.HasPrefix(line, "data:") {
			value := strings.TrimPrefix(line, "data:")
			value = strings.TrimPrefix(value, " ")
			if data.Len()+len(value) > maxRoutedEvent {
				return errRouted
			}
			data.WriteString(value)
			data.WriteByte('\n')
		}
	}
	if scanner.Err() != nil {
		return scanner.Err()
	}
	return errors.New("incomplete Chat stream")
}
