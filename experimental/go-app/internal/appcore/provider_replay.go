package appcore

import "net/http"

// Explicit permission to re-encode a local canonical transcript for a different
// converted model. No opaque native state, signatures, automatic provider
// selection, account change or model-equivalence promise.
func providerReplayRequested(r *http.Request) (bool, bool) {
	values := r.Header.Values("X-MOMO-History")
	if len(values) == 0 {
		return false, true
	}
	return true, len(values) == 1 && values[0] == "replay-v1" && r.Method == "POST" && r.URL.Path == "/v1/responses"
}
