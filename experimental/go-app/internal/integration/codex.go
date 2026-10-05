package integration

import (
	"errors"
	"net"
	"net/url"
	"strconv"
)

// CodexProviderConfig exports no token/model/account/config-file contents.
// It does not inspect or modify any client profile or select a user's model.
func CodexProviderConfig(endpoint string) (string, error) {
	u, err := url.Parse(endpoint)
	if err != nil || u.Scheme != "http" || u.Hostname() != "127.0.0.1" || u.User != nil || u.Path != "" || u.RawPath != "" || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || u.Opaque != "" {
		return "", errors.New("local endpoint unavailable")
	}
	port, err := strconv.Atoi(u.Port())
	if err != nil || port < 1 || port > 65535 || endpoint != "http://"+net.JoinHostPort("127.0.0.1", strconv.Itoa(port)) {
		return "", errors.New("local endpoint unavailable")
	}
	// Documented user-level Codex provider fields. No inline bearer token and
	// no client retries/WebSocket claims; neither proves real agent acceptance.
	return "# Manual user-level Codex config snippet; NOT a full config file.\n" +
		"# Back up and review your own config; MOMO does not read/write it.\n" +
		"# Put this top-level selector before existing TOML table headers.\n" +
		"# Keep your own model selection; routing preview is not full Codex compatibility.\n" +
		"# Set MOMO_LOCAL_API_KEY privately from the separately copied local connection.\n" +
		"# Never use the upstream account key here. Port changes after app relaunch.\n" +
		"model_provider = \"momo-local-preview\"\n\n" +
		"[model_providers.momo-local-preview]\n" +
		"name = \"MOMO local preview\"\n" +
		"base_url = \"" + endpoint + "/v1\"\n" +
		"env_key = \"MOMO_LOCAL_API_KEY\"\n" +
		"wire_api = \"responses\"\n" +
		"requires_openai_auth = false\n" +
		"supports_websockets = false\n" +
		"request_max_retries = 0\n" +
		"stream_max_retries = 0\n", nil
}
