package appcore

import (
	"context"
	"strings"
	"testing"
)

func TestRoutedSSEFramingAndTerminal(t *testing.T) {
	var event, data string
	err := readRoutedSSE(context.Background(), strings.NewReader(":comment\r\nevent: empty\r\n\r\nevent: actual\r\ndata: first\r\ndata:second\r\n\r\n"), func(e, d string) (bool, error) { event, data = e, d; return true, nil })
	if err != nil || event != "actual" || data != "first\nsecond" {
		t.Fatal("SSE framing")
	}
	for _, body := range []string{"", "data: dangling", "data: valid\n\n"} {
		if readRoutedSSE(context.Background(), strings.NewReader(body), func(e, d string) (bool, error) { return false, nil }) == nil {
			t.Fatal("EOF manufactured terminal")
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if readRoutedSSE(ctx, strings.NewReader("data: end\n\n"), func(e, d string) (bool, error) { t.Error("cancelled event delivered"); return true, nil }) == nil {
		t.Fatal("cancellation ignored")
	}
}
func TestRoutedSSEPhysicalWireAndEventBudgets(t *testing.T) {
	terminal := "data: end\r\n\r\n"
	// Comment lines cost bytes too. The terminal delimiter crosses the exact cap.
	prefix := strings.Repeat(":ignored\r\n", MaxResponse/10-1)
	padding := MaxResponse - len(prefix) - len(terminal) + 1
	body := prefix + ":" + strings.Repeat("a", padding-3) + "\r\n" + terminal
	if len(body) != MaxResponse+1 {
		t.Fatal("wire fixture")
	}
	if readRoutedSSE(context.Background(), strings.NewReader(body), func(e, d string) (bool, error) { return true, nil }) == nil {
		t.Fatal("CRLF physical cap bypass")
	}
	body = prefix + ":" + strings.Repeat("a", padding-4) + "\r\n" + terminal
	if len(body) != MaxResponse {
		t.Fatal("wire fixture")
	}
	if err := readRoutedSSE(context.Background(), strings.NewReader(body), func(e, d string) (bool, error) { return true, nil }); err != nil {
		t.Fatal("exact wire limit rejected", err)
	}
	if readRoutedSSE(context.Background(), strings.NewReader(strings.Repeat("data: ping\n\n", 65537)), func(e, d string) (bool, error) { return false, nil }) == nil {
		t.Fatal("event count limit ignored")
	}
	if readRoutedSSE(context.Background(), strings.NewReader("data: "+strings.Repeat("a", maxRoutedEvent)+"\n\n"), func(e, d string) (bool, error) { return true, nil }) == nil {
		t.Fatal("event size cap ignored")
	}
}
