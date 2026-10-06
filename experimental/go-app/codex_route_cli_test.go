//go:build !appcheck && !routecheck

package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/momo-api/momoapi-proxy/experimental/go-app/internal/integration"
)

func TestCodexRouteCLIExplicitPreviewApply(t *testing.T) {
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal("fixture path")
	}
	path := filepath.Join(dir, "config.toml")
	initial := []byte("model_provider='openai'\n[mcp_servers.synthetic]\ncommand='keep'\n")
	os.WriteFile(path, initial, 0600)
	args := []string{"--config", path, "--mode", "direct", "--endpoint", "https://momoapi.us"}
	var out bytes.Buffer
	if err := runCodexRoute(append([]string{"preview"}, args...), &out); err != nil {
		t.Fatal(err)
	}
	var p integration.CodexRoutePreview
	if json.Unmarshal(out.Bytes(), &p) != nil || !p.Changed {
		t.Fatal("preview")
	}
	if bytes.Contains(out.Bytes(), []byte(path)) || bytes.Contains(out.Bytes(), []byte("command")) {
		t.Fatal("config reflected")
	}
	for _, bad := range [][]string{{}, {"apply"}, {"preview", "--config", path, "--mode", "native", "--confirm"}, {"preview", "--config", path, "--mode", "native", "--mode", "direct"}, append([]string{"apply"}, args...), append(append([]string{"apply"}, args...), "--confirm", "--revision", "bad")} {
		if err := runCodexRoute(bad, &out); err == nil {
			t.Fatal("invalid CLI")
		}
	}
	if got, _ := os.ReadFile(path); !bytes.Equal(got, initial) {
		t.Fatal("unconfirmed write")
	}
	if err := runCodexRoute(append(append([]string{"apply"}, args...), "--confirm", "--revision", p.Revision), &out); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(path); !strings.Contains(string(got), "momo-go-direct") {
		t.Fatal("apply missing")
	}
}
