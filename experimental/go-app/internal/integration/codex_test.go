package integration

import (
	"strings"
	"testing"
)

func TestCodexProviderConfigIsLocalAndCredentialFree(t *testing.T) {
	if text, err := CodexProviderConfig("http://127.0.0.1:1234#"); err == nil || text != "" {
		t.Fatal("empty fragment delimiter changed exported base URL")
	}
	for _, endpoint := range []string{"", "http://localhost:1234", "http://127.0.0.1", "http://127.0.0.1:0", "http://127.0.0.1:65536", "http://127.0.0.1:01234", "http://user:secret@127.0.0.1:1234", "https://127.0.0.1:1234", "http://127.0.0.1:1234/", "http://127.0.0.1:1234/v1", "http://127.0.0.1:1234?", "http://127.0.0.1:1234#fragment", "http://127.0.0.1:1234/\"\napi_key=\"secret"} {
		if text, err := CodexProviderConfig(endpoint); err == nil || text != "" {
			t.Fatal("unsafe client endpoint accepted")
		}
	}
	for _, endpoint := range []string{"http://127.0.0.1:1", "http://127.0.0.1:12345", "http://127.0.0.1:65535"} {
		text, err := CodexProviderConfig(endpoint)
		if err != nil || !strings.Contains(text, "base_url = \""+endpoint+"/v1\"") {
			t.Fatal("valid local endpoint rejected")
		}
		for _, required := range []string{"model_provider = \"momo-local-preview\"", "[model_providers.momo-local-preview]", "env_key = \"MOMO_LOCAL_API_KEY\"", "wire_api = \"responses\"", "requires_openai_auth = false", "supports_websockets = false", "request_max_retries = 0", "stream_max_retries = 0"} {
			if !strings.Contains(text, required) {
				t.Fatal("missing provider contract")
			}
		}
		if !strings.Contains(text, "# http_headers = { \"X-MOMO-Client-Policy\" = \"text-tools-v1\" }") {
			t.Fatal("optional policy disclosure missing")
		}
		for _, line := range strings.Split(text, "\n") {
			if strings.HasPrefix(line, "http_headers") {
				t.Fatal("lossy policy enabled by default")
			}
		}
		for _, forbidden := range []string{"experimental_bearer_token", "api_key =", "model =", "auth.json", "approval_policy", "sandbox_mode"} {
			if strings.Contains(text, forbidden) {
				t.Fatal("client export exceeded scope")
			}
		}
	}
}
