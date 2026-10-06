package appcore

func (e *responseWriter) geminiPart(ev streamEvent) error {
	if ev.gemini == nil || ev.gemini.Model != e.model || ev.gemini.CallIDAbsent || ev.gemini.Signature != "" && !validGeminiSignature(ev.gemini.Signature) {
		return errRouted
	}
	if err := e.flushText(); err != nil {
		return err
	}
	id, err := newID("msg_")
	if err != nil {
		return err
	}
	item := map[string]any{"id": id, "type": "message", "role": "assistant", "status": "completed"}
	part := map[string]any{"type": "output_text", "text": ev.text, "momo_gemini": ev.gemini}
	field := "content"
	event := "response.output_text"
	if ev.kind == "gemini-thought" {
		item = map[string]any{"id": id, "type": "reasoning", "status": "completed", "momo_gemini": ev.gemini}
		part = map[string]any{"type": "summary_text", "text": ev.text}
		field = "summary"
		event = "response.reasoning_summary_text"
	}
	item[field] = []any{part}
	added := map[string]any{}
	for k, v := range item {
		added[k] = v
	}
	added["status"] = "in_progress"
	added[field] = []any{}
	if err := e.event("response.output_item.added", map[string]any{"response_id": e.id, "output_index": e.index, "item": added}); err != nil {
		return err
	}
	common := func() map[string]any {
		p := map[string]any{"response_id": e.id, "item_id": id, "output_index": e.index}
		if field == "summary" {
			p["summary_index"] = 0
		} else {
			p["content_index"] = 0
		}
		return p
	}
	empty := map[string]any{}
	for k, v := range part {
		empty[k] = v
	}
	empty["text"] = ""
	p := common()
	p["part"] = empty
	partEvent := "response.content_part"
	if field == "summary" {
		partEvent = "response.reasoning_summary_part"
	}
	if err := e.event(partEvent+".added", p); err != nil {
		return err
	}
	if ev.text != "" {
		p = common()
		p["delta"] = ev.text
		if err := e.event(event+".delta", p); err != nil {
			return err
		}
	}
	p = common()
	p["text"] = ev.text
	if err := e.event(event+".done", p); err != nil {
		return err
	}
	p = common()
	p["part"] = part
	if err := e.event(partEvent+".done", p); err != nil {
		return err
	}
	if err := e.event("response.output_item.done", map[string]any{"response_id": e.id, "output_index": e.index, "item": item}); err != nil {
		return err
	}
	e.output = append(e.output, item)
	e.index++
	return nil
}
