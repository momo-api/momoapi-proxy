//go:build appcheck && !nogui

package main

import "net/http"

func probeValidationRequest(r *http.Request) *http.Request {
	validation := r.Clone(r.Context())
	validation.URL.Path = "/app/state"
	// The report's fixed step label is not a production bridge query. Keep
	// method/origin/capability authentication, but validate a canonical route.
	validation.URL.RawQuery = ""
	validation.URL.ForceQuery = false
	validation.URL.RawPath = ""
	return validation
}

func probeFailureStep(step string) string {
	for _, phase := range []string{"passthrough", "routing"} {
		for _, stage := range []string{"enabled", "action", "state", "render"} {
			if step == phase+"-start-"+stage {
				return step
			}
		}
	}
	for _, candidate := range []string{"initial", "nav-videos", "video-catalog", "video-generate", "video-task", "nav-images", "image-catalog", "image-generate", "image-task", "image-preview", "image-reference-select", "image-reference-preview", "image-save", "nav-routing", "nav-settings", "diagnostics-refresh", "diagnostics-clear", "nav-overview", "nav-integrations", "skill-copy", "mcp-copy", "image-mcp-copy", "video-mcp-copy", "codex-copy", "codex-catalog-copy", "configure", "load", "quota-refresh", "models-refresh", "start", "check-proxy", "check-native-stop", "check-routing", "check-stall", "stop", "check-done"} {
		if step == candidate {
			return step
		}
	}
	return "unknown"
}
