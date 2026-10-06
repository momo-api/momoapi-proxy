package integration

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/pelletier/go-toml/v2"
)

func routeConfig() []byte {
	return []byte("# keep comment\r\nmodel = 'gpt-5.6-luna'\r\nmodel_provider = 'openai' # keep inline\r\nmodel_reasoning_effort = 'high'\r\nnotes = '''\r\n[model_providers.fake]\r\nmodel_provider = 'not-real'\r\n'''\r\n[mcp_servers.example]\r\ncommand = 'example'\r\n[projects.'C:/synthetic']\r\ntrust_level = 'trusted'\r\n")
}

func TestCodexThreeRoutesPreserveSourceAndHistory(t *testing.T) {
	data := routeConfig()
	for _, options := range []CodexRouteOptions{{Mode: "direct", Endpoint: "https://momoapi.us"}, {Mode: "proxy", Endpoint: "http://127.0.0.1:12345"}, {Mode: "native"}, {Mode: "proxy", Endpoint: "http://127.0.0.1:12345"}, {Mode: "native"}, {Mode: "direct", Endpoint: "https://momoapi.us"}} {
		p, next, err := PlanCodexRoute(data, options)
		if err != nil {
			t.Fatal(err)
		}
		if !p.Changed || len(p.Revision) != 64 {
			t.Fatal("preview")
		}
		for _, part := range []string{"# keep comment\r\n", "# keep inline\r\n", "model = 'gpt-5.6-luna'\r\n", "model_reasoning_effort = 'high'\r\n", "notes = '''\r\n[model_providers.fake]\r\nmodel_provider = 'not-real'\r\n'''\r\n", "[mcp_servers.example]\r\ncommand = 'example'\r\n", "[projects.'C:/synthetic']\r\ntrust_level = 'trusted'\r\n"} {
			if !bytes.Contains(next, []byte(part)) {
				t.Fatal("unrelated source changed")
			}
		}
		if options.Mode == "native" && (!bytes.Contains(next, []byte("[model_providers.momo-go-direct]")) || !bytes.Contains(next, []byte("[model_providers.momo-go-proxy]"))) {
			t.Fatal("history provider deleted")
		}
		var parsed map[string]any
		if toml.Unmarshal(next, &parsed) != nil {
			t.Fatal("invalid TOML")
		}
		data = next
	}
	p, next, err := PlanCodexRoute(data, CodexRouteOptions{Mode: "direct", Endpoint: "https://momoapi.us"})
	if err != nil || p.Changed || !bytes.Equal(next, data) {
		t.Fatal("not idempotent")
	}
}

func TestCodexRouteFailClosedAndCatalogConsent(t *testing.T) {
	for _, source := range []string{"model_provider='foreign'\n[model_providers.foreign]\nbase_url='https://unrelated.example/v1'\n", "profile='work'\n", "openai_base_url='https://thirdparty.example/v1'\n", "chatgpt_base_url='https://thirdparty.example'\n", "experimental_realtime_ws_base_url='http://127.0.0.1:12345/v1'\n", "model_catalog_json='private.json'\n", "model_provider=1\n", "model_provider='openai'\nmodel_provider='duplicate'\n", "model_provider='openai'\nmodel='unterminated", "\xff"} {
		if _, next, err := PlanCodexRoute([]byte(source), CodexRouteOptions{Mode: "native"}); err == nil || next != nil || strings.Contains(err.Error(), "thirdparty") {
			t.Fatal("accepted ambiguity or leaked contents")
		}
	}
	for _, o := range []CodexRouteOptions{{Mode: "other"}, {Mode: "native", Endpoint: "https://momoapi.us"}, {Mode: "proxy", Endpoint: "http://localhost:12345"}, {Mode: "direct", Endpoint: "http://momoapi.us"}, {Mode: "direct", Endpoint: "https://user:pass@momoapi.us"}, {Mode: "direct", Endpoint: "https://momoapi.us/v1"}, {Mode: "direct", Endpoint: "https://momoapi.us?"}, {Mode: "direct", Endpoint: "https://momoapi.us#"}} {
		if _, _, err := PlanCodexRoute(nil, o); err == nil {
			t.Fatal("bad options accepted")
		}
	}
	catalog := []byte("model_catalog_json = '''\nprivate/path\n''' # comment\nmodel_provider='momo-local-preview'\n[model_providers.momo-local-preview]\nbase_url='http://127.0.0.1:12345/v1'\n")
	p, next, err := PlanCodexRoute(catalog, CodexRouteOptions{Mode: "native", ClearCatalog: true})
	if err != nil || !p.Changed || bytes.Contains(next, []byte("private/path")) || !bytes.Contains(next, []byte("[model_providers.momo-local-preview]")) {
		t.Fatal("catalog detach")
	}
	_, first, _ := PlanCodexRoute(nil, CodexRouteOptions{Mode: "proxy", Endpoint: "http://127.0.0.1:12345"})
	if _, _, err := PlanCodexRoute(first, CodexRouteOptions{Mode: "proxy", Endpoint: "http://127.0.0.1:12346"}); err == nil {
		t.Fatal("history definition replaced")
	}
}

func TestCodexRouteFileRevisionBackupAndNoCredentialAccess(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.toml")
	data := routeConfig()
	if os.WriteFile(path, data, 0600) != nil {
		t.Fatal("fixture")
	}
	// A directory instead of an auth file proves this route never opens it.
	os.Mkdir(filepath.Join(dir, "auth.json"), 0700)
	o := CodexRouteOptions{Mode: "direct", Endpoint: "https://momoapi.us"}
	p, err := PreviewCodexRouteFile(path, o)
	if err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(path); !bytes.Equal(got, data) {
		t.Fatal("preview wrote")
	}
	if _, err = ApplyCodexRouteFile(path, o, "wrong"); err == nil {
		t.Fatal("stale apply")
	}
	os.WriteFile(path, append(data, []byte("# later edit\n")...), 0600)
	if _, err = ApplyCodexRouteFile(path, o, p.Revision); err == nil {
		t.Fatal("changed file overwritten")
	}
	p, err = PreviewCodexRouteFile(path, o)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = ApplyCodexRouteFile(path, o, p.Revision); err != nil {
		t.Fatal(err)
	}
	backups, _ := filepath.Glob(filepath.Join(dir, "config.toml.momo-*.bak"))
	if len(backups) != 1 {
		t.Fatal("backup count")
	}
	if raw, _ := os.ReadFile(backups[0]); !bytes.Equal(raw, append(data, []byte("# later edit\n")...)) {
		t.Fatal("wrong backup")
	}
	p, _ = PreviewCodexRouteFile(path, o)
	if p.Changed {
		t.Fatal("repeat would rewrite")
	}
	if _, err = ApplyCodexRouteFile(path, o, p.Revision); err != nil {
		t.Fatal(err)
	}
	if _, err = PreviewCodexRouteFile(filepath.Join(dir, "auth.json"), o); err == nil {
		t.Fatal("arbitrary file")
	}
	if _, err = PreviewCodexRouteFile(filepath.Join(dir, "missing", "config.toml"), o); err == nil {
		t.Fatal("created directory")
	}
}

func TestCodexNativeLegacyNodeAndExplicitCatalogDetach(t *testing.T) {
	source := []byte("model_provider='Codex'\nmodel_catalog_json='synthetic.json'\nopenai_base_url='https://momoapi.us/v1'\n[mcp_servers.keep]\ncommand='keep'\n[model_providers.Codex]\nbase_url='https://momoapi.us/v1'\nwire_api='responses'\n")
	options := CodexRouteOptions{Mode: "native", ClearCatalog: true, ClearMomoOverride: true}
	local := []byte("model_provider='momo-route'\nopenai_base_url='http://127.0.0.1:18789/v1'\n[model_providers.momo-route]\nbase_url='http://127.0.0.1:18789/v1'\n")
	if _, _, err := PlanCodexRoute(local, options); err != nil {
		t.Fatal("identified old MOMO local override")
	}
	_, next, err := PlanCodexRoute(source, options)
	if err != nil || bytes.Contains(next, []byte("openai_base_url=")) || bytes.Contains(next, []byte("model_catalog_json=")) || !bytes.Contains(next, []byte("[model_providers.Codex]\nbase_url='https://momoapi.us/v1'")) {
		t.Fatal("legacy native detach")
	}
	for _, raw := range []string{"https://unrelated.example/v1", "https://momoapi.us/v1?", "https://momoapi.us/v1#", "http://127.0.0.1:1234/v1"} {
		bad := bytes.ReplaceAll(source, []byte("openai_base_url='https://momoapi.us/v1'"), []byte("openai_base_url='"+raw+"'"))
		if _, _, err := PlanCodexRoute(bad, options); err == nil {
			t.Fatal("unowned override detached")
		}
	}
}

func TestCodexRouteLockAndSymlinkRejection(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.toml")
	os.WriteFile(path, routeConfig(), 0600)
	o := CodexRouteOptions{Mode: "native"}
	p, err := PreviewCodexRouteFile(path, o)
	if err != nil {
		t.Fatal(err)
	}
	f, err := os.OpenFile(filepath.Join(dir, ".momo-codex-route.lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		t.Fatal(err)
	}
	if lockAssetLibrary(f) != nil {
		f.Close()
		t.Fatal("fixture lock")
	}
	if _, err := ApplyCodexRouteFile(path, o, p.Revision); err == nil {
		f.Close()
		t.Fatal("concurrent writer")
	}
	f.Close()
	linkdir := t.TempDir()
	link := filepath.Join(linkdir, "config.toml")
	if os.Symlink(path, link) != nil {
		t.Skip("symlinks unavailable for current Windows account")
	}
	if _, err := PreviewCodexRouteFile(link, o); err == nil {
		t.Fatal("symlink config read")
	}
}
