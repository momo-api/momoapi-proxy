package appcore

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"
)

type responseWriter struct {
	w                http.ResponseWriter
	id, model, msgID string
	text             strings.Builder
	output           []any
	written          int
	index            int
	completed        bool
	buffered         bool
	toolCount        int
}

var errRoutedWrite = errors.New("routed response write failed")

func newID(prefix string) (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return prefix + hex.EncodeToString(b[:]), nil
}
func (e *responseWriter) event(name string, p map[string]any) error {
	if e.buffered {
		if name != "response.completed" && name != "response.incomplete" {
			return nil
		}
		b, err := json.Marshal(p["response"])
		if err != nil || len(b) > MaxResponse {
			return errRouted
		}
		if err := http.NewResponseController(e.w).SetWriteDeadline(time.Now().Add(15 * time.Second)); err != nil {
			return err
		}
		e.w.Header().Set("Content-Type", "application/json; charset=utf-8")
		n, err := e.w.Write(b)
		if err != nil || n != len(b) {
			return errRoutedWrite
		}
		if http.NewResponseController(e.w).Flush() != nil {
			return errRoutedWrite
		}
		return nil
	}
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
	var n int
	if n, err = io.WriteString(e.w, frame); err != nil || n != len(frame) {
		if err == nil {
			err = io.ErrShortWrite
		}
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
	e.text.Reset()
	return nil
}
func (e *responseWriter) toolCall(call streamToolCall, tool chatTool) error {
	args, parseErr := decodeObject(call.args)
	if parseErr != nil {
		return errRouted
	}
	if tool.kind == "tool_search" {
		return e.searchCall(call, args)
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
	if err := e.flushText(); err != nil {
		return err
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

// streamEvent is protocol neutral. Only validated tool calls reach the encoder.
type streamToolCall struct{ id, name, args string }

// Tool search arguments are an object, never a function argument string or an
// invented builtin SSE arguments stream. Lifecycle uses ordinary item events.
func (e *responseWriter) searchCall(call streamToolCall, args map[string]any) error {
	if err := e.flushText(); err != nil {
		return err
	}
	id, err := newID("tsc_")
	if err != nil {
		return err
	}
	item := map[string]any{"id": id, "type": "tool_search_call", "execution": "client", "call_id": call.id, "arguments": args, "status": "completed"}
	added := map[string]any{"id": id, "type": "tool_search_call", "execution": "client", "call_id": call.id, "arguments": map[string]any{}, "status": "in_progress"}
	if err := e.event("response.output_item.added", map[string]any{"response_id": e.id, "output_index": e.index, "item": added}); err != nil {
		return err
	}
	if err := e.event("response.output_item.done", map[string]any{"response_id": e.id, "output_index": e.index, "item": item}); err != nil {
		return err
	}
	e.output = append(e.output, item)
	e.index++
	return nil
}

type streamEvent struct {
	kind  string
	text  string
	call  streamToolCall
	usage map[string]any
}

func newRoutedResponseWriter(w http.ResponseWriter, plan *chatPlan) (*responseWriter, error) {
	id, err := newID("resp_")
	if err != nil {
		return nil, err
	}
	e := &responseWriter{w: w, id: id, model: plan.model, output: []any{}, buffered: !plan.stream}
	if plan.stream {
		w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	}
	err = e.event("response.created", map[string]any{"response": map[string]any{"id": id, "object": "response", "status": "in_progress", "model": plan.model, "output": []any{}}})
	return e, err
}
func (e *responseWriter) accept(ev streamEvent, plan *chatPlan) error {
	if e.completed {
		return errRouted
	}
	switch ev.kind {
	case "text":
		return e.textDelta(ev.text)
	case "tool":
		if plan.loading != nil && (ev.call.id == "" || len(ev.call.id) > 128) {
			return errRouted
		}
		tool, ok := plan.restoreTool(ev.call.name)
		if !ok || plan.choice == "none" || plan.selected != "" && tool.wire != plan.selected || plan.allowed != nil && !plan.allowed[tool.wire] || plan.loading != nil && (!plan.loading.active[tool.wire] || e.toolCount > 0 || len(plan.loading.seen) >= 128 || plan.loading.seen[ev.call.id]) {
			return errRouted
		}
		if tool.kind == "tool_search" {
			args, err := decodeObject(ev.call.args)
			if plan.loading == nil || ev.call.id == "" || len(ev.call.id) > 64 || err != nil || validateSearchValue(plan.loading.search, args) != nil {
				return errRouted
			}
		}
		if plan.loading != nil && plan.loading.constraints[tool.wire] != nil {
			args, err := decodeObject(ev.call.args)
			if err != nil || validateSearchValue(plan.loading.constraints[tool.wire], args) != nil {
				return errRouted
			}
		}
		e.toolCount++
		return e.toolCall(ev.call, tool)
	case "complete", "incomplete":
		if ev.kind == "complete" && (plan.choice == "required" || plan.selected != "") && e.toolCount == 0 {
			return errRouted
		}
		e.completed = true
		if err := e.flushText(); err != nil {
			return err
		}
		r := map[string]any{"id": e.id, "object": "response", "status": "completed", "model": e.model, "output": e.output}
		if ev.kind == "incomplete" {
			r["status"] = "incomplete"
			r["incomplete_details"] = map[string]string{"reason": "max_output_tokens"}
		}
		if ev.usage != nil {
			r["usage"] = ev.usage
		}
		var commit func()
		if ev.kind == "complete" && plan.prepareCompletion != nil {
			var err error
			commit, err = plan.prepareCompletion(e.id, e.output)
			if err != nil {
				return err
			}
		}
		terminal := "response.completed"
		if ev.kind == "incomplete" {
			terminal = "response.incomplete"
		}
		if err := e.event(terminal, map[string]any{"response": r}); err != nil {
			return err
		}
		if commit != nil {
			commit()
		}
		return nil
	}
	return errRouted
}
