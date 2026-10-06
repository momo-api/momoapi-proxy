package appcore

import (
	"bufio"
	"context"
	"io"
	"strings"
)

// Shared bounded SSE framing. A clean HTTP EOF is not a protocol terminal.
func readRoutedSSE(ctx context.Context, body io.Reader, consume func(string, string) (bool, error)) error {
	return readRoutedSSEWithEOF(ctx, body, consume, nil)
}
func readRoutedSSEToEOF(ctx context.Context, body io.Reader, consume func(string, string) (bool, error), terminal func() error) error {
	return readRoutedSSEWithEOF(ctx, body, consume, terminal)
}
func readRoutedSSEWithEOF(ctx context.Context, body io.Reader, consume func(string, string) (bool, error), terminal func() error) error {
	scanner := bufio.NewScanner(io.LimitReader(body, MaxResponse+1))
	scanner.Buffer(make([]byte, 4096), maxRoutedEvent)
	// Count physical bytes consumed, including CRLF, not normalized scanner text.
	wireBytes := 0
	scanner.Split(func(data []byte, atEOF bool) (int, []byte, error) {
		advance, token, err := bufio.ScanLines(data, atEOF)
		wireBytes += advance
		if wireBytes > MaxResponse {
			return 0, nil, errRouted
		}
		return advance, token, err
	})
	var data strings.Builder
	event := ""
	events := 0
	for scanner.Scan() {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		line := scanner.Text()
		if line == "" {
			if data.Len() == 0 {
				event = ""
				continue
			}
			events++
			if events > 65536 {
				return errRouted
			}
			done, err := consume(event, strings.TrimSuffix(data.String(), "\n"))
			if err != nil {
				return err
			}
			if done {
				return nil
			}
			data.Reset()
			event = ""
		} else if strings.HasPrefix(line, "data:") {
			value := strings.TrimPrefix(strings.TrimPrefix(line, "data:"), " ")
			if data.Len()+len(value)+1 > maxRoutedEvent {
				return errRouted
			}
			data.WriteString(value)
			data.WriteByte('\n')
		} else if strings.HasPrefix(line, "event:") {
			event = strings.TrimSpace(line[6:])
		}
	}
	if scanner.Err() != nil {
		return scanner.Err()
	}
	if ctx.Err() != nil {
		return ctx.Err()
	}
	if terminal != nil && data.Len() == 0 && event == "" {
		return terminal()
	}
	return errRouted
}
