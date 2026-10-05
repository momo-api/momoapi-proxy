package appcore

import (
	"errors"
	"net/http"
)

// Never echo the client's grammar or other request contents in errors.
func routedPayloadError(w http.ResponseWriter, err error) {
	if errors.Is(err, errUnsupportedToolFormat) {
		http.Error(w, "unsupported_tool_format", http.StatusBadRequest)
		return
	}
	http.Error(w, "unsupported routed Responses payload", http.StatusBadRequest)
}
