package appcore

import "strings"

// Same public API aliases and trailing-slash handling as Node route-dispatch.
// Only exact allowlisted API paths normalize. Never clean dot segments, duplicate
// internal slashes, escaped paths or internal management paths. Queries remain
// rejected by the authenticated Handler before this function is reached.
func canonicalPublicRoute(path string) string {
	switch strings.TrimRight(path, "/") {
	case "/models", "/v1/models":
		return "/v1/models"
	case "/chat/completions", "/v1/chat/completions":
		return "/v1/chat/completions"
	case "/responses", "/v1/responses":
		return "/v1/responses"
	case "/responses/compact", "/v1/responses/compact":
		return "/v1/responses/compact"
	default:
		return ""
	}
}
