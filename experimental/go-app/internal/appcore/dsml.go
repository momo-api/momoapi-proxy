package appcore

import (
	"encoding/json"
	"encoding/xml"
	"io"
	"net/http"
	"strings"
	"unicode/utf8"
)

// Text-to-call conversion changes the trust interpretation of model text.
// It is request-scoped and never inferred from model names or saved history.
func dsmlRequested(r *http.Request) (bool, bool) {
	values := r.Header.Values("X-MOMO-Tool-Text")
	if len(values) == 0 {
		return false, true
	}
	return true, len(values) == 1 && values[0] == "dsml-v1" && r.Method == "POST" && r.URL.Path == "/v1/responses"
}

var dsmlMarkers = []string{"<||DSML||", "<｜｜DSML｜｜", "</||DSML||", "</｜｜DSML｜｜", "<tool_calls", "</tool_calls", "<invoke", "</invoke", "<parameter", "</parameter"}

// Scan once rather than repeatedly searching the whole remaining payload for
// each tag dialect. Raw parameters can contain many ordinary '<' characters.
func firstDSMLMarker(s string) int {
	for pos := 0; pos < len(s); {
		i := strings.IndexByte(s[pos:], '<')
		if i < 0 {
			return -1
		}
		pos += i
		for _, marker := range dsmlMarkers {
			if strings.HasPrefix(s[pos:], marker) {
				return pos
			}
		}
		pos++
	}
	return -1
}

// Hold only a possible marker prefix on the normal path, so arbitrary chunk
// splits cannot leak markup or split a UTF-8 code point. Once a marker arrives,
// retain the bounded remainder until a verified protocol terminal, then parse.
type dsmlText struct {
	enabled, found bool
	pending        string
	body           strings.Builder
}

func (d *dsmlText) push(text string) (string, error) {
	if d.found {
		d.body.WriteString(text)
		return "", nil
	}
	window := d.pending + text
	if first := firstDSMLMarker(window); first >= 0 {
		if !d.enabled {
			return "", errRouted
		}
		d.found = true
		d.pending = ""
		d.body.WriteString(window[first:])
		return window[:first], nil
	}
	hold := 0
	for _, marker := range dsmlMarkers {
		for n := 1; n < len(marker) && n <= len(window); n++ {
			if n > hold && strings.HasSuffix(window, marker[:n]) {
				hold = n
			}
		}
	}
	split := len(window) - hold
	for split > 0 && split < len(window) && !utf8.RuneStart(window[split]) {
		split--
	}
	d.pending = window[split:]
	return window[:split], nil
}

type dsmlParser struct {
	text   string
	pos    int
	events []streamEvent
	calls  int
}
type dsmlTag struct {
	name  string
	attrs map[string]string
	end   int
}

// Parse only the tag header as XML, not parameter values: those are raw text
// (e.g. JS/patch '<' and '&') or explicit JSON, never decoded XML entities.
// No DTD/entities/namespace tricks, comments, nesting or guessed control fields.
func (p *dsmlParser) tag() (dsmlTag, error) {
	rest := p.text[p.pos:]
	end := strings.IndexByte(rest, '>')
	if end < 0 || end > 1024 {
		return dsmlTag{}, errRouted
	}
	raw := rest[:end+1]
	for _, prefix := range []string{"<||DSML||", "<｜｜DSML｜｜"} {
		if strings.HasPrefix(raw, prefix) {
			raw = "<" + raw[len(prefix):]
			break
		}
	}
	if strings.HasPrefix(raw, "</") || strings.HasSuffix(raw, "/>") {
		return dsmlTag{}, errRouted
	}
	decoder := xml.NewDecoder(strings.NewReader(strings.TrimSuffix(raw, ">") + "/>"))
	token, err := decoder.Token()
	start, ok := token.(xml.StartElement)
	if err != nil || !ok || start.Name.Space != "" {
		return dsmlTag{}, errRouted
	}
	attrs := map[string]string{}
	for _, a := range start.Attr {
		if a.Name.Space != "" {
			return dsmlTag{}, errRouted
		}
		if _, exists := attrs[a.Name.Local]; exists {
			return dsmlTag{}, errRouted
		}
		attrs[a.Name.Local] = a.Value
	}
	if token, err := decoder.Token(); err != nil {
		return dsmlTag{}, errRouted
	} else if end, ok := token.(xml.EndElement); !ok || end.Name != start.Name {
		return dsmlTag{}, errRouted
	}
	if _, err := decoder.Token(); err != io.EOF {
		return dsmlTag{}, errRouted
	}
	return dsmlTag{start.Name.Local, attrs, p.pos + end + 1}, nil
}
func (p *dsmlParser) skipSpace() {
	for p.pos < len(p.text) {
		switch p.text[p.pos] {
		case ' ', 10, 13, 9:
			p.pos++
		default:
			return
		}
	}
}
func dsmlClose(name string) []string {
	return []string{"</" + name + ">", "</||DSML||" + name + ">", "</｜｜DSML｜｜" + name + ">"}
}
func (p *dsmlParser) close(name string) bool {
	for _, s := range dsmlClose(name) {
		if strings.HasPrefix(p.text[p.pos:], s) {
			p.pos += len(s)
			return true
		}
	}
	return false
}
func hasDSMLMarker(s string) bool {
	return firstDSMLMarker(s) >= 0
}
func dsmlParameterEnd(s string) (int, string) {
	closings := dsmlClose("parameter")
	for pos := 0; pos < len(s); {
		i := strings.Index(s[pos:], "</")
		if i < 0 {
			break
		}
		pos += i
		for _, closing := range closings {
			if strings.HasPrefix(s[pos:], closing) {
				return pos, closing
			}
		}
		pos += 2
	}
	return -1, ""
}

func (p *dsmlParser) invoke(plan *chatPlan) error {
	tag, err := p.tag()
	if err != nil || tag.name != "invoke" || len(tag.attrs) != 1 || !wireName(tag.attrs["name"]) {
		return errRouted
	}
	name := tag.attrs["name"]
	tool, ok := plan.restoreTool(name)
	if !ok || tool.kind == "tool_search" || plan.choice == "none" || plan.selected != "" && plan.selected != tool.wire || plan.allowed != nil && !plan.allowed[tool.wire] || plan.loading != nil {
		return errRouted
	}
	p.pos = tag.end
	args := map[string]any{}
	for {
		p.skipSpace()
		if p.close("invoke") {
			break
		}
		tag, err = p.tag()
		if err != nil || tag.name != "parameter" || len(tag.attrs) < 1 || len(tag.attrs) > 2 {
			return errRouted
		}
		for k := range tag.attrs {
			if k != "name" && k != "string" {
				return errRouted
			}
		}
		key := tag.attrs["name"]
		if key == "" || len(key) > 256 || len(args) >= 128 {
			return errRouted
		}
		if _, exists := args[key]; exists {
			return errRouted
		}
		p.pos = tag.end
		offset, closing := dsmlParameterEnd(p.text[p.pos:])
		if closing == "" {
			return errRouted
		}
		end := p.pos + offset
		value := p.text[p.pos:end]
		if hasDSMLMarker(value) {
			return errRouted
		}
		flag, present := tag.attrs["string"]
		if !present || flag == "true" {
			args[key] = value
		} else if flag == "false" {
			// Reuse duplicate-free/depth64 JSON framing. No numeric coercion.
			wrapped := []byte(`{"value":` + value + "}")
			object, err := decodeVideoObject(wrapped)
			if err != nil || len(object) != 1 {
				return errRouted
			}
			v, exists := object["value"]
			if !exists {
				return errRouted
			}
			args[key] = v
		} else {
			return errRouted
		}
		p.pos = end + len(closing)
	}
	p.calls++
	if p.calls > 128 {
		return errRouted
	}
	if tool.kind == "custom" {
		if len(args) != 1 {
			return errRouted
		}
		if _, ok := args["input"].(string); !ok {
			return errRouted
		}
	}
	data, err := json.Marshal(args)
	if err != nil {
		return errRouted
	}
	id, err := newID("call_dsml_")
	if err != nil {
		return err
	}
	p.events = append(p.events, streamEvent{kind: "tool", call: streamToolCall{id, name, string(data)}})
	return nil
}
func parseDSML(text string, plan *chatPlan) ([]streamEvent, error) {
	if len(text) > maxRoutedRetained || !utf8.ValidString(text) {
		return nil, errRouted
	}
	p := &dsmlParser{text: text}
	for p.pos < len(text) {
		first := len(text)
		if i := firstDSMLMarker(text[p.pos:]); i >= 0 {
			first = p.pos + i
		}
		if first > p.pos {
			p.events = append(p.events, streamEvent{kind: "text", text: text[p.pos:first]})
			p.pos = first
		}
		if p.pos == len(text) {
			break
		}
		tag, err := p.tag()
		if err != nil {
			return nil, err
		}
		if tag.name == "invoke" {
			if err := p.invoke(plan); err != nil {
				return nil, err
			}
			continue
		}
		if tag.name != "tool_calls" || len(tag.attrs) != 0 {
			return nil, errRouted
		}
		p.pos = tag.end
		count := p.calls
		for {
			p.skipSpace()
			if p.close("tool_calls") {
				break
			}
			if err := p.invoke(plan); err != nil {
				return nil, err
			}
		}
		if p.calls == count {
			return nil, errRouted
		}
	}
	if p.calls == 0 {
		return nil, errRouted
	}
	return p.events, nil
}
