package protocol

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"unicode/utf8"
)

const MaxFrames = 1024

// StreamSSE incrementally frames bytes, never interpreting partial UTF-8.
// EOF must occur between events. Budgets include comments and delimiters.
func StreamSSE(r io.Reader, handle func(string) error) error {
	var line, data []byte
	total, eventBytes, frames := 0, 0, 0
	skipLF, hasData := false, false
	endLine := func() error {
		if !utf8.Valid(line) {
			return errors.New("invalid stream UTF-8")
		}
		if len(line) == 0 {
			frames++
			if frames > MaxFrames {
				return errors.New("frame limit")
			}
			if hasData {
				if err := handle(string(data)); err != nil {
					return err
				}
			}
			data, hasData, eventBytes = nil, false, 0
		} else if bytes.Equal(line, []byte("data")) || bytes.HasPrefix(line, []byte("data:")) {
			part := []byte{}
			if len(line) > 4 {
				part = line[5:]
				if len(part) > 0 && part[0] == ' ' {
					part = part[1:]
				}
			}
			if hasData {
				data = append(data, '\n')
			}
			data = append(data, part...)
			hasData = true
		}
		line = nil
		return nil
	}
	buffer := make([]byte, 4096)
	emptyReads := 0
	for {
		n, err := r.Read(buffer)
		if n == 0 && err == nil {
			emptyReads++
			if emptyReads > 100 {
				return io.ErrNoProgress
			}
		} else {
			emptyReads = 0
		}
		for _, c := range buffer[:n] {
			total++
			if total > MaxInput {
				return errors.New("stream byte limit")
			}
			if skipLF {
				skipLF = false
				if c == '\n' {
					continue
				}
			}
			eventBytes++
			if eventBytes > MaxEvent {
				return errors.New("stream event limit")
			}
			if c == '\r' || c == '\n' {
				if err := endLine(); err != nil {
					return err
				}
				skipLF = c == '\r'
			} else {
				line = append(line, c)
			}
		}
		if err == io.EOF {
			if len(line) != 0 || hasData || eventBytes != 0 {
				return errors.New("unterminated SSE")
			}
			return nil
		}
		if err != nil {
			return err
		}
	}
}

type chatFrame struct {
	Choices []struct {
		Index  *int    `json:"index"`
		Finish *string `json:"finish_reason"`
		Delta  struct {
			Role      string  `json:"role"`
			Content   *string `json:"content"`
			ToolCalls []struct {
				Index    *int   `json:"index"`
				ID       string `json:"id"`
				Type     string `json:"type"`
				Function struct {
					Name      string `json:"name"`
					Arguments string `json:"arguments"`
				} `json:"function"`
			} `json:"tool_calls"`
		} `json:"delta"`
	} `json:"choices"`
}

// ConvertChat handles a deliberately narrow Chat tool-only stream. It buffers
// output until a valid finish, DONE and clean EOF; it is not a streaming proxy.
func ConvertChat(req Request, r io.Reader) ([]byte, error) {
	if len(req.Calls) != 0 {
		return nil, errors.New("upstream calls required")
	}
	registry, err := Registry(req)
	if err != nil {
		return nil, err
	}
	ordered := []*Call{}
	indexes := map[int]*Call{}
	types := map[int]bool{}
	finished, done := false, false
	err = StreamSSE(r, func(payload string) error {
		if strings.TrimSpace(payload) == "[DONE]" {
			if !finished || done {
				return errors.New("unexpected DONE")
			}
			done = true
			return nil
		}
		if finished || done {
			return errors.New("frame after finish")
		}
		if err := validateJSON([]byte(payload)); err != nil {
			return err
		}
		var frame chatFrame
		d := json.NewDecoder(strings.NewReader(payload))
		d.DisallowUnknownFields()
		if err := d.Decode(&frame); err != nil {
			return err
		}
		if len(frame.Choices) != 1 {
			return errors.New("one choice required")
		}
		choice := frame.Choices[0]
		if choice.Index == nil || *choice.Index != 0 {
			return errors.New("choice index")
		}
		if choice.Delta.Content != nil && *choice.Delta.Content != "" {
			return errors.New("text not supported")
		}
		if choice.Delta.Role != "" && choice.Delta.Role != "assistant" {
			return errors.New("role not supported")
		}
		for _, tc := range choice.Delta.ToolCalls {
			if tc.Index == nil || *tc.Index < 0 || *tc.Index >= MaxCalls || tc.Type != "" && tc.Type != "function" {
				return errors.New("call index/type")
			}
			call := indexes[*tc.Index]
			if tc.Type == "function" {
				types[*tc.Index] = true
			}
			if call == nil {
				if len(ordered) >= MaxCalls {
					return errors.New("call limit")
				}
				call = &Call{}
				indexes[*tc.Index] = call
				ordered = append(ordered, call)
			}
			if tc.ID != "" {
				if call.CallID != "" && call.CallID != tc.ID {
					return errors.New("changed call ID")
				}
				call.CallID = tc.ID
			}
			if len(call.CallID) > 1024 || len(call.Name)+len(tc.Function.Name) > 2048 || len(call.Text)+len(tc.Function.Arguments) > MaxEvent {
				return errors.New("call byte limit")
			}
			call.Name += tc.Function.Name
			call.Text += tc.Function.Arguments
		}
		if choice.Finish != nil {
			if *choice.Finish != "tool_calls" && *choice.Finish != "stop" {
				return errors.New("incomplete finish")
			}
			finished = true
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	if !done || !finished {
		return nil, errors.New("truncated stream")
	}
	for index := range indexes {
		if !types[index] {
			return nil, errors.New("explicit function type required")
		}
	}
	for _, call := range ordered {
		t, err := Restore(call.Name, registry)
		if err != nil {
			return nil, err
		}
		if !utf8.ValidString(call.Text) || validateJSON([]byte(call.Text)) != nil {
			return nil, errors.New("invalid complete arguments")
		}
		if t.Kind == "custom" {
			// First slice supports only an already-normalized freeform input envelope.
			var input struct {
				Input *string `json:"input"`
			}
			d := json.NewDecoder(strings.NewReader(call.Text))
			d.DisallowUnknownFields()
			if err := d.Decode(&input); err != nil || input.Input == nil {
				return nil, errors.New("custom envelope required")
			}
			call.Text = *input.Input
			if call.Text != strings.TrimSpace(call.Text) {
				return nil, errors.New("canonical custom input required")
			}
			if call.Text != "" && !strings.HasPrefix(call.Text, "text(") && !strings.HasPrefix(call.Text, "await ") && !strings.HasPrefix(call.Text, "*** Begin Patch") {
				return nil, errors.New("normalized custom input required")
			}
		} else {
			// Preserve lexical JSON order. Numeric/string normalization parity beyond
			// the tested subset remains an open gate, not silently claimed compatible.
			var compact bytes.Buffer
			if err := json.Compact(&compact, []byte(call.Text)); err != nil {
				return nil, err
			}
			call.Text = compact.String()
		}
		req.Calls = append(req.Calls, *call)
	}
	data, err := json.Marshal(req)
	if err != nil {
		return nil, err
	}
	out, err := Convert(data)
	if err != nil {
		return nil, err
	}
	created := []byte("event: response.created\ndata: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_test\",\"object\":\"response\",\"status\":\"in_progress\",\"model\":\"mock\",\"output\":[]}}\n\n")
	if len(created)+len(out) > MaxOutput {
		return nil, errors.New("output limit")
	}
	return append(created, out...), nil
}
