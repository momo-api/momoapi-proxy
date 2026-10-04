// Package protocol is an offline, bounded compatibility experiment, not a proxy.
package protocol

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"
	"unicode/utf16"
	"unicode/utf8"
)

const (
	MaxInput  = 1 << 20
	MaxOutput = 4 << 20
	MaxEvent  = 256 << 10
	MaxDepth  = 32
	MaxTools  = 512
	MaxCalls  = 128
)

type Tool struct {
	Type      string `json:"type"`
	Name      string `json:"name"`
	Namespace string `json:"namespace"`
	Tools     []Tool `json:"tools"`
	Function  *struct {
		Name string `json:"name"`
	} `json:"function"`
}
type Call struct {
	Name   string `json:"name"`
	CallID string `json:"call_id"`
	// Complete payload text only. No JSON reserialization or custom-input rewriting.
	Text string `json:"text"`
}
type Request struct {
	Tools           []Tool `json:"tools"`
	AdditionalTools []Tool `json:"additional_tools"`
	Calls           []Call `json:"calls"`
}
type Identity struct{ Wire, Name, Namespace, Kind string }

// safeName matches Node's ASCII regexp over UTF-16 code units, including emoji.
func safeName(s string) string {
	var b strings.Builder
	for _, c := range utf16.Encode([]rune(s)) {
		if c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '_' || c == '-' {
			b.WriteByte(byte(c))
		} else {
			b.WriteByte('_')
		}
	}
	return b.String()
}

func Registry(req Request) ([]Identity, error) {
	result := []Identity{}
	wires := map[string]bool{}
	visited := 0
	var visit func(Tool, string, int) error
	visit = func(t Tool, ns string, depth int) error {
		visited++
		if visited > MaxTools || depth > MaxDepth {
			return errors.New("tool limit")
		}
		if t.Type == "namespace" || t.Type == "additional_tools" {
			if t.Function != nil || (t.Type == "additional_tools" && (t.Name != "" || t.Namespace != "")) {
				return errors.New("contradictory wrapper")
			}
			if t.Type == "namespace" {
				if t.Namespace != "" {
					ns = t.Namespace
				} else if t.Name != "" {
					ns = t.Name
				}
				if ns == "functions" {
					ns = ""
				}
			}
			for _, child := range t.Tools {
				if err := visit(child, ns, depth+1); err != nil {
					return err
				}
			}
			return nil
		}
		name := t.Name
		if t.Tools != nil || t.Namespace != "" ||
			(t.Type != "function" && t.Type != "custom" && !(t.Type == "" && t.Function != nil)) ||
			(t.Function != nil && (t.Type == "custom" || t.Name != "")) {
			return errors.New("contradictory tool")
		}
		if name == "" && t.Function != nil {
			name = t.Function.Name
		}
		if name == "" || (t.Type != "function" && t.Type != "custom" && t.Function == nil) {
			return errors.New("unsupported tool")
		}
		if len(name) > 1024 || len(ns) > 1024 {
			return errors.New("name limit")
		}
		wire := safeName(name)
		if ns != "" {
			wire = safeName(ns) + "__" + wire
		}
		if wires[wire] {
			return errors.New("wire collision")
		}
		wires[wire] = true
		kind := "function"
		if t.Type == "custom" || name == "exec" || name == "apply_patch" {
			kind = "custom"
		}
		result = append(result, Identity{wire, name, ns, kind})
		return nil
	}
	for _, t := range append(append([]Tool{}, req.Tools...), req.AdditionalTools...) {
		if err := visit(t, "", 1); err != nil {
			return nil, err
		}
	}
	return result, nil
}

// Exact wire names win. Unlike legacy Node heuristics, ambiguous bare names fail.
func Restore(name string, registry []Identity) (Identity, error) {
	for _, t := range registry {
		if t.Wire == name {
			return t, nil
		}
	}
	var matches []Identity
	for _, t := range registry {
		if t.Name == name {
			matches = append(matches, t)
		}
	}
	if len(matches) == 1 {
		return matches[0], nil
	}
	return Identity{}, errors.New("unknown or ambiguous tool")
}

// validateJSON rejects duplicate keys and excessive nesting before decoding.
func validateJSON(data []byte) error {
	// Go JSON otherwise replaces isolated UTF-16 surrogate escapes with U+FFFD.
	// Reject instead of silently altering original names or payload strings.
	for i := 0; i < len(data); i++ {
		if data[i] != '"' {
			continue
		}
		for i++; i < len(data) && data[i] != '"'; i++ {
			if data[i] != '\\' {
				continue
			}
			i++
			if i >= len(data) || data[i] != 'u' {
				continue
			}
			if i+4 >= len(data) {
				return errors.New("invalid Unicode escape")
			}
			unit, err := strconv.ParseUint(string(data[i+1:i+5]), 16, 16)
			if err != nil {
				return errors.New("invalid Unicode escape")
			}
			i += 4
			if unit >= 0xdc00 && unit <= 0xdfff {
				return errors.New("isolated surrogate")
			}
			if unit >= 0xd800 && unit <= 0xdbff {
				if i+6 >= len(data) || data[i+1] != '\\' || data[i+2] != 'u' {
					return errors.New("isolated surrogate")
				}
				low, err := strconv.ParseUint(string(data[i+3:i+7]), 16, 16)
				if err != nil || low < 0xdc00 || low > 0xdfff {
					return errors.New("isolated surrogate")
				}
				i += 6
			}
		}
	}
	d := json.NewDecoder(bytes.NewReader(data))
	d.UseNumber()
	var value func(int) error
	value = func(depth int) error {
		if depth > MaxDepth {
			return errors.New("JSON depth limit")
		}
		t, err := d.Token()
		if err != nil {
			return err
		}
		delim, ok := t.(json.Delim)
		if !ok {
			return nil
		}
		switch delim {
		case '{':
			keys := map[string]bool{}
			for d.More() {
				key, err := d.Token()
				if err != nil {
					return err
				}
				s, ok := key.(string)
				if !ok || keys[s] {
					return errors.New("duplicate JSON key")
				}
				keys[s] = true
				if err := value(depth + 1); err != nil {
					return err
				}
			}
		case '[':
			for d.More() {
				if err := value(depth + 1); err != nil {
					return err
				}
			}
		default:
			return errors.New("unexpected JSON delimiter")
		}
		_, err = d.Token()
		return err
	}
	if err := value(1); err != nil {
		return err
	}
	if _, err := d.Token(); err != io.EOF {
		return errors.New("trailing JSON")
	}
	return nil
}

// Convert buffers the entire bounded result: validation failure returns no SSE.
func Convert(data []byte) ([]byte, error) {
	if len(data) > MaxInput || !utf8.Valid(data) {
		return nil, errors.New("input limit or encoding")
	}
	if err := validateJSON(data); err != nil {
		return nil, err
	}
	var req Request
	d := json.NewDecoder(bytes.NewReader(data))
	d.DisallowUnknownFields()
	if err := d.Decode(&req); err != nil {
		return nil, err
	}
	// A null root is not a request.
	if bytes.Equal(bytes.TrimSpace(data), []byte("null")) {
		return nil, errors.New("request required")
	}
	registry, err := Registry(req)
	if err != nil {
		return nil, err
	}
	if len(req.Calls) > MaxCalls {
		return nil, errors.New("call limit")
	}
	var out bytes.Buffer
	emit := func(typ string, fields map[string]any) error {
		fields["type"] = typ
		var encoded bytes.Buffer
		enc := json.NewEncoder(&encoded)
		enc.SetEscapeHTML(false)
		if err := enc.Encode(fields); err != nil {
			return err
		}
		frame := []byte("event: " + typ + "\ndata: " + strings.TrimSuffix(encoded.String(), "\n") + "\n\n")
		if len(frame) > MaxEvent || out.Len()+len(frame) > MaxOutput {
			return errors.New("output limit")
		}
		out.Write(frame)
		return nil
	}
	output := []any{}
	seen := map[string]bool{}
	for index, call := range req.Calls {
		if call.CallID == "" || len(call.CallID) > 1024 || seen[call.CallID] {
			return nil, errors.New("invalid call ID")
		}
		seen[call.CallID] = true
		t, err := Restore(call.Name, registry)
		if err != nil {
			return nil, err
		}
		prefix, typ, field, eventStem := "fc", "function_call", "arguments", "response.function_call_arguments"
		if t.Kind == "custom" {
			prefix, typ, field, eventStem = "ctc", "custom_tool_call", "input", "response.custom_tool_call_input"
		}
		id := fmt.Sprintf("%s_test_%d", prefix, index)
		item := map[string]any{"id": id, "type": typ, "status": "completed", "call_id": call.CallID, "name": t.Name, field: call.Text}
		if t.Namespace != "" {
			item["namespace"] = t.Namespace
		}
		added := map[string]any{}
		for k, v := range item {
			added[k] = v
		}
		added["status"] = "in_progress"
		added[field] = ""
		common := func() map[string]any {
			return map[string]any{"response_id": "resp_test", "output_index": index, "item_id": id}
		}
		if err := emit("response.output_item.added", map[string]any{"response_id": "resp_test", "output_index": index, "item": added}); err != nil {
			return nil, err
		}
		if call.Text != "" {
			f := common()
			f["delta"] = call.Text
			if err := emit(eventStem+".delta", f); err != nil {
				return nil, err
			}
		}
		f := common()
		f[field] = call.Text
		if err := emit(eventStem+".done", f); err != nil {
			return nil, err
		}
		if err := emit("response.output_item.done", map[string]any{"response_id": "resp_test", "output_index": index, "item": item}); err != nil {
			return nil, err
		}
		output = append(output, item)
	}
	if err := emit("response.completed", map[string]any{"response": map[string]any{"id": "resp_test", "object": "response", "status": "completed", "model": "mock", "output": output}}); err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}
