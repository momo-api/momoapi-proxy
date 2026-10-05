package appcore

import (
	"errors"
	"net/http"
)

// Never echo the client's grammar or other request contents in errors.
func routedPayloadError(w http.ResponseWriter, err error) {
	for _, candidate := range []error{errUnsupportedToolLoading, errUnsupportedSearchSchema, errUnsupportedImage} {
		if errors.Is(err, candidate) {
			http.Error(w, candidate.Error(), http.StatusBadRequest)
			return
		}
	}
	if errors.Is(err, errUnsupportedToolFormat) {
		http.Error(w, "unsupported_tool_format", http.StatusBadRequest)
		return
	}
	http.Error(w, "unsupported routed Responses payload", http.StatusBadRequest)
}
