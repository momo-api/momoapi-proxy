package integration

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"path/filepath"
	"sort"
	"strings"
	"unicode/utf8"

	"github.com/pelletier/go-toml/v2"
	"github.com/pelletier/go-toml/v2/unstable"
)

const codexConfigLimit = 1 << 20
const codexDirectID = "momo-go-direct"
const codexProxyID = "momo-go-proxy"

// The caller explicitly selects a USER-LEVEL config.toml. No profile/auth/history
// discovery. Endpoint contains no credentials. Catalog removal requires consent.
type CodexRouteOptions struct {
	Mode              string `json:"mode"`
	Endpoint          string `json:"endpoint,omitempty"`
	ClearCatalog      bool   `json:"clear_catalog,omitempty"`
	ClearMomoOverride bool   `json:"clear_momo_override,omitempty"`
}

// Public preview deliberately excludes file contents, provider URLs and keys.
type CodexRoutePreview struct {
	Mode     string   `json:"mode"`
	Changed  bool     `json:"changed"`
	Revision string   `json:"revision"`
	Changes  []string `json:"changes"`
	Warnings []string `json:"warnings"`
}

type routeEdit struct {
	start, end int
	text       string
}
type rootString struct {
	start, end, lineStart, lineEnd int
	value                          string
}

var errCodexRoute = errors.New("Codex route rejected; review user-level configuration, profile and endpoint (no files changed)")

func routeRevision(data []byte, options CodexRouteOptions) string {
	raw, _ := json.Marshal(options)
	h := sha256.New()
	h.Write(data)
	h.Write([]byte{0})
	h.Write(raw)
	return hex.EncodeToString(h.Sum(nil))
}

func routeRootStrings(data []byte) (map[string]rootString, error) {
	var p unstable.Parser
	p.Reset(data)
	roots := map[string]rootString{}
	for p.NextExpression() {
		n := p.Expression()
		if n.Kind == unstable.Table || n.Kind == unstable.ArrayTable {
			break
		}
		if n.Kind != unstable.KeyValue {
			continue
		}
		keys := n.Key()
		var names []string
		var first int
		for keys.Next() {
			k := keys.Node()
			if len(names) == 0 {
				first = int(k.Raw.Offset)
			}
			names = append(names, string(k.Data))
		}
		if len(names) != 1 {
			continue
		}
		v := n.Value()
		if v.Kind != unstable.String {
			continue
		}
		start, end := int(v.Raw.Offset), int(v.Raw.Offset+v.Raw.Length)
		if start < first || end > len(data) {
			return nil, errCodexRoute
		}
		lineStart := bytes.LastIndexByte(data[:first], '\n') + 1
		lineEnd := end
		if next := bytes.IndexByte(data[end:], '\n'); next >= 0 {
			lineEnd = end + next + 1
		} else {
			lineEnd = len(data)
		}
		roots[names[0]] = rootString{start, end, lineStart, lineEnd, string(v.Data)}
	}
	if p.Error() != nil {
		return nil, errCodexRoute
	}
	return roots, nil
}

func routeProvider(root map[string]any, id string) map[string]any {
	providers, _ := root["model_providers"].(map[string]any)
	provider, _ := providers[id].(map[string]any)
	return provider
}

func routeOfficialURL(raw string) bool {
	u, err := url.Parse(raw)
	return err == nil && u.Scheme == "https" && u.Host == "api.openai.com" && (u.Path == "/v1" || u.Path == "/v1/") && u.User == nil && u.RawQuery == "" && !u.ForceQuery && u.Fragment == "" && !strings.Contains(raw, "#")
}

func codexRouteTable(options CodexRouteOptions) (string, string, error) {
	id, envKey, name := codexDirectID, "MOMO_API_KEY", "MOMO direct"
	if options.Mode == "proxy" {
		if ValidateLocalEndpoint(options.Endpoint) != nil {
			return "", "", errCodexRoute
		}
		id, envKey, name = codexProxyID, "MOMO_LOCAL_API_KEY", "MOMO local proxy"
	} else {
		u, err := url.Parse(options.Endpoint)
		// Explicit HTTPS origin only, never a URL with credentials/query/path.
		if err != nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.ForceQuery || strings.ContainsAny(options.Endpoint, "#\r\n\x00") || (u.Port() != "" && u.Port() != "443") {
			return "", "", errCodexRoute
		}
		if strings.ContainsAny(u.Hostname(), "\"\\ ") {
			return "", "", errCodexRoute
		}
	}
	q := func(s string) string { b, _ := json.Marshal(s); return string(b) }
	table := "[model_providers." + id + "]\nname = " + q(name) + "\nbase_url = " + q(options.Endpoint+"/v1") + "\nenv_key = " + q(envKey) + "\nwire_api = \"responses\"\nrequires_openai_auth = false\nsupports_websockets = false\nrequest_max_retries = 0\nstream_max_retries = 0\n"
	return id, table, nil
}

func routeMomoProvider(root map[string]any, id string) bool {
	if id == codexDirectID || id == codexProxyID || id == "momo-local-preview" {
		return true
	}
	// Node legacy aliases are recognized only when they actually target MOMO or
	// a loopback proxy. Arbitrary third-party providers are never taken over.
	p := routeProvider(root, id)
	raw, _ := p["base_url"].(string)
	u, err := url.Parse(raw)
	known := id == "momo-route" || id == "momoapi-proxy" || id == "momo-codex-bridge" || id == "momo-switch" || id == "momo"
	return err == nil && u.User == nil && u.RawQuery == "" && u.Fragment == "" && (u.Path == "/v1" || u.Path == "/v1/") && ((u.Scheme == "https" && u.Host == "momoapi.us") || (known && u.Scheme == "http" && u.Hostname() == "127.0.0.1" && u.Port() != ""))
}

// Pure source-preserving plan: the TOML parser validates the entire document;
// AST value ranges change ONLY root routing strings. No whole-file marshal.
// Existing provider tables stay for old threads; no login/credential mutation.
func PlanCodexRoute(data []byte, options CodexRouteOptions) (CodexRoutePreview, []byte, error) {
	preview := CodexRoutePreview{Mode: options.Mode, Revision: routeRevision(data, options), Changes: []string{}, Warnings: []string{
		"Start a new Codex session after switching; old threads may retain their provider.",
		"Login, model availability and real request routing are not verified by this configuration change.",
		"Launch-time --profile/-c and environment overrides may supersede this file; they are not inspected or modified.",
	}}
	fail := func() (CodexRoutePreview, []byte, error) { return CodexRoutePreview{}, nil, errCodexRoute }
	if len(data) > codexConfigLimit || !utf8.Valid(data) || (options.Mode != "native" && options.Mode != "direct" && options.Mode != "proxy") {
		return fail()
	}
	if options.Mode == "native" && options.Endpoint != "" {
		return fail()
	}
	var root map[string]any
	if toml.Unmarshal(data, &root) != nil {
		return fail()
	}
	// Codex reserves built-in provider IDs; do not label this file native if
	// a user table attempts to redefine the official provider.
	if routeProvider(root, "openai") != nil {
		return fail()
	}
	roots, err := routeRootStrings(data)
	if err != nil {
		return fail()
	}
	for _, key := range []string{"profile", "model_provider", "openai_base_url", "chatgpt_base_url", "experimental_realtime_ws_base_url", "model_catalog_json"} {
		if _, present := root[key]; present {
			if _, ok := roots[key]; !ok {
				return fail()
			}
		}
	}
	// Root profiles and launch-time --profile/-c/env overrides are not silently
	// counteracted. A selected profile must be reviewed by the owner first.
	if roots["profile"].value != "" {
		return fail()
	}
	current := roots["model_provider"].value
	if current != "" && current != "openai" && !routeMomoProvider(root, current) {
		return fail()
	}
	var edits []routeEdit
	for _, key := range []string{"openai_base_url", "chatgpt_base_url", "experimental_realtime_ws_base_url"} {
		if value, exists := roots[key]; exists && !routeOfficialURL(value.value) {
			if key != "openai_base_url" || !options.ClearMomoOverride {
				return fail()
			}
			u, parseErr := url.Parse(value.value)
			if parseErr != nil {
				return fail()
			}
			momoOrigin := u.Scheme == "https" && u.Host == "momoapi.us"
			providerURL, _ := routeProvider(root, current)["base_url"].(string)
			// A loopback override is owned only when this document selects an
			// identified MOMO provider at exactly that URL; not any local tool.
			momoLocal := current != "" && current != "openai" && routeMomoProvider(root, current) && providerURL == value.value && u.Scheme == "http" && u.Hostname() == "127.0.0.1" && u.Port() != ""
			if (!momoOrigin && !momoLocal) || u.Path != "/v1" || u.User != nil || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || strings.Contains(value.value, "#") {
				return fail()
			}
			edits = append(edits, routeEdit{value.lineStart, value.lineEnd, "# MOMO route: explicitly detached legacy MOMO base URL.\n"})
			preview.Changes = append(preview.Changes, "detach-legacy-momo-base-url")
		}
	}
	var prepend, appendText string
	if options.ClearCatalog {
		if value, exists := roots["model_catalog_json"]; exists {
			edits = append(edits, routeEdit{value.lineStart, value.lineEnd, "# MOMO route: custom model catalog detached; file preserved.\n"})
			preview.Changes = append(preview.Changes, "detach-model-catalog")
		}
	} else if _, exists := roots["model_catalog_json"]; exists && options.Mode == "native" {
		// A custom catalog can hide official models or advertise routed tools.
		return fail()
	}
	if _, exists := roots["model_catalog_json"]; exists && !options.ClearCatalog {
		preview.Warnings = append(preview.Warnings, "Existing custom catalog retained; it is not proof of this route's capabilities.")
	}
	id := "openai"
	if options.Mode != "native" {
		var table string
		id, table, err = codexRouteTable(options)
		if err != nil {
			return fail()
		}
		if old := routeProvider(root, id); old != nil {
			var generated map[string]any
			if toml.Unmarshal([]byte(table), &generated) != nil {
				return fail()
			}
			// Do not replace a previously generated table if the user changed it or
			// this session's proxy port changed. Preserve history and request review.
			a, _ := json.Marshal(old)
			b, _ := json.Marshal(routeProvider(generated, id))
			if !bytes.Equal(a, b) {
				return fail()
			}
		} else {
			appendText = "\n# MOMO route provider; retained for existing threads.\n" + table
			preview.Changes = append(preview.Changes, "add-provider-definition")
		}
		if options.Mode == "proxy" {
			preview.Warnings = append(preview.Warnings, "Proxy must be running; relaunch may change its port. Changed provider definitions require manual review.")
		}
	}
	if value, exists := roots["model_provider"]; exists {
		if value.value != id {
			raw, _ := json.Marshal(id)
			edits = append(edits, routeEdit{value.start, value.end, string(raw)})
			preview.Changes = append(preview.Changes, "select-model-provider")
		}
	} else {
		prepend = "model_provider = \"" + id + "\"\n"
		preview.Changes = append(preview.Changes, "select-model-provider")
	}
	sort.Slice(edits, func(i, j int) bool { return edits[i].start > edits[j].start })
	result := append([]byte(nil), data...)
	for _, e := range edits {
		result = append(append(append([]byte(nil), result[:e.start]...), []byte(e.text)...), result[e.end:]...)
	}
	result = append(append([]byte(prepend), result...), []byte(appendText)...)
	var check map[string]any
	if len(result) > codexConfigLimit || toml.Unmarshal(result, &check) != nil || check["model_provider"] != id {
		return fail()
	}
	preview.Changed = !bytes.Equal(result, data)
	preview.Warnings = append(preview.Warnings, "Existing model/effort, MCP, Skills, project settings and provider tables are preserved; a non-native model selection may need changing in Codex.")
	return preview, result, nil
}

func validateCodexRoutePath(path string) error {
	if !filepath.IsAbs(path) || filepath.Base(path) != "config.toml" || strings.ContainsAny(path, "\r\n\x00") || !localAssetDirectory(filepath.Dir(path)) {
		return fmt.Errorf("select an absolute local user-level config.toml")
	}
	return nil
}
