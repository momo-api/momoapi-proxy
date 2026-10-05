//go:build !appcheck && !routecheck

package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"github.com/momo-api/momoapi-proxy/experimental/go-app/internal/appcore"
	"strings"
	"testing"
)

type diagFailWriter struct {
	calls int
	short bool
}

func (w *diagFailWriter) Write(b []byte) (int, error) {
	w.calls++
	if w.short {
		return len(b) - 1, nil
	}
	return 0, errors.New("synthetic-private-error")
}
func TestDiagnosticOutputAndFailedWriteNoRetry(t *testing.T) {
	var out bytes.Buffer
	if writeDiagnostics(&out) != nil {
		t.Fatal("output")
	}
	var r appcore.DiagnosticReport
	if json.Unmarshal(out.Bytes(), &r) != nil || r.Scope != "offline-process" || r.Gateway.Configured || r.Gateway.ListenerAllocated || !strings.HasSuffix(out.String(), string(rune(10))) {
		t.Fatal("offline report")
	}
	for _, short := range []bool{true, false} {
		w := &diagFailWriter{short: short}
		err := writeDiagnostics(w)
		if err == nil || w.calls != 1 || strings.Contains(err.Error(), "synthetic-private") {
			t.Fatal("write failure retry/leak")
		}
	}
}
