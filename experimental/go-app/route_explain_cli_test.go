//go:build !appcheck && !routecheck

package main

import (
	"bytes"
	"encoding/json"
	"os"
	"strings"
	"testing"

	"github.com/momo-api/momoapi-proxy/experimental/go-app/internal/appcore"
)

func TestRouteExplainCLISelectionAndNoRetry(t *testing.T) {
	args := []string{"--mode", "momo-routing", "--model", "claude-private"}
	var out bytes.Buffer
	if runRouteExplain(args, &out) != nil {
		t.Fatal("output")
	}
	var report appcore.RouteExplanation
	if json.Unmarshal(out.Bytes(), &report) != nil || report.RequestValidated || report.Decision.Protocol != "claude" || report.Decision.UpstreamStatus != appcore.CapabilityUnverified || strings.Contains(out.String(), "claude-private") {
		t.Fatal("selection claim/leak")
	}
	var reversed bytes.Buffer
	if runRouteExplain([]string{"--model", "claude-private", "--mode", "momo-routing"}, &reversed) != nil || !bytes.Equal(out.Bytes(), reversed.Bytes()) {
		t.Fatal("order/determinism")
	}
	for _, short := range []bool{true, false} {
		w := &diagFailWriter{short: short}
		if err := runRouteExplain(args, w); err == nil || w.calls != 1 || strings.Contains(err.Error(), "private") {
			t.Fatal("writer retry/leak")
		}
	}
}

func TestRouteExplainCLIRejectsArgumentsBeforeOutput(t *testing.T) {
	for _, args := range [][]string{nil, {"--mode", "momo-routing"}, {"--model", "private", "--model", "private"}, {"--mode", "private", "--model", "private"}, {"--mode", "passthrough", "--model", "private\n"}, {"--mode", "passthrough", "--model", ""}, {"--mode", "passthrough", "--private", "private"}} {
		w := &diagFailWriter{}
		if err := runRouteExplain(args, w); err == nil || w.calls != 0 || strings.Contains(err.Error(), "private") {
			t.Fatal("arguments/output/leak")
		}
	}
	// Dispatch malformed arguments before desktop/serve or private stdin reads.
	oldArgs, oldStdin := os.Args, os.Stdin
	defer func() { os.Args, os.Stdin = oldArgs, oldStdin }()
	os.Args, os.Stdin = []string{"preview", "route-explain"}, nil
	if run() == nil {
		t.Fatal("malformed command accepted")
	}
}
