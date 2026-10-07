//go:build !appcheck && !routecheck

package main

import (
	"bytes"
	"encoding/json"
	"github.com/momo-api/momoapi-proxy/experimental/go-app/internal/appcore"
	"strings"
	"testing"
)

func TestRouteCapabilitiesOfflineOutput(t *testing.T) {
	var out bytes.Buffer
	if writeRouteCapabilities(&out) != nil {
		t.Fatal("output")
	}
	var matrix appcore.RouteCapabilityMatrix
	if json.Unmarshal(out.Bytes(), &matrix) != nil || matrix.Scope != "local-adapter" || len(matrix.Routes) != 5 {
		t.Fatal("matrix")
	}
	for _, short := range []bool{true, false} {
		w := &diagFailWriter{short: short}
		err := writeRouteCapabilities(w)
		if err == nil || w.calls != 1 || strings.Contains(err.Error(), "synthetic-private") {
			t.Fatal("write retry/leak")
		}
	}
}
