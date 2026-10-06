package ui

import (
	"net/http"

	"github.com/momo-api/momoapi-proxy/experimental/go-app/internal/appcore"
)

func serveImageSave(w http.ResponseWriter, r *http.Request, actions Actions, data []byte) {
	mime, bytes, err := appcore.DecodeLocalImageSave(data)
	if err != nil {
		http.Error(w, "local image save rejected", 400)
		return
	}
	if r.Context().Err() != nil {
		http.Error(w, "save cancelled before dialog", 400)
		return
	}
	if actions.SaveImage == nil {
		http.Error(w, "native save unavailable", 503)
		return
	}
	saved, err := actions.SaveImage(r.Context(), mime, bytes)
	if err != nil {
		// A partial file may remain; no automatic overwrite/delete/retry.
		http.Error(w, "save failed; a partial file may remain", 503)
		return
	}
	result := []byte(`{"saved":false}`)
	if saved {
		result = []byte(`{"saved":true}`)
	}
	w.Header().Set("Content-Type", "application/json")
	if n, err := w.Write(result); err != nil || n != len(result) {
		panic(http.ErrAbortHandler)
	}
}
