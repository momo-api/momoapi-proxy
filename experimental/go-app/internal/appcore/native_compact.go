package appcore

import "net/http"

// Request-scoped opt-in; no remembered capability or automatic fallback. The
// private local header never reaches the upstream. All provider JSON stays exact.
func nativeCompactRequested(r *http.Request) (bool, bool) {
	values := r.Header.Values("X-MOMO-Compact")
	if len(values) == 0 {
		return false, true
	}
	if r.URL.Path != "/v1/responses/compact" || len(values) != 1 || values[0] != "native" {
		return false, false
	}
	return true, true
}

// Validate framing, not encrypted contents/provider semantics. We cannot decode,
// fabricate or turn a native compaction envelope into local cross-provider state.
func validateNativeCompactResponse(data []byte) bool {
	p, err := decodeObject(string(data))
	if err != nil || p["object"] != "response.compaction" {
		return false
	}
	output, ok := p["output"].([]any)
	if !ok || len(output) == 0 {
		return false
	}
	for _, value := range output {
		item := obj(value)
		if item == nil || str(item["type"]) == "" {
			return false
		}
		if item["type"] == "compaction" {
			if str(item["encrypted_content"]) == "" {
				return false
			}
		}
	}
	return true
}
