package appcore

import (
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"
)

func TestLocalImageSaveStrictByteExactFormatsAndNoForeignFields(t *testing.T) {
	for _, mime := range []string{"image/png", "image/jpeg", "image/gif", "image/webp"} {
		reference := "data:image/webp;base64,UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA"
		if mime != "image/webp" {
			reference = inlineFixture(t, mime)
		}
		_, encoded, _ := strings.Cut(reference, ",")
		raw, _ := json.Marshal(map[string]any{"confirmed": true, "mime_type": mime, "b64_json": encoded})
		gotMime, data, err := DecodeLocalImageSave(raw)
		want, _ := base64.StdEncoding.DecodeString(encoded)
		if err != nil || gotMime != mime || string(data) != string(want) || LocalImageExtension(mime) == "" {
			t.Fatal("save format/bytes", mime)
		}
	}
	for _, raw := range []string{`{}`, `{"confirmed":null,"mime_type":"image/png","b64_json":"AA=="}`, `{"confirmed":true,"mime_type":"image/png","b64_json":"AA==","url":"https://images.example/a"}`, `{"confirmed":true,"confirmed":false,"mime_type":"image/png","b64_json":"AA=="}`, `{"confirmed":true,"mime_type":"image/png","b64_json":"AA=="}{}`, string([]byte{0xff}), strings.Repeat(" ", MaxResponse+1)} {
		if _, _, err := DecodeLocalImageSave([]byte(raw)); err == nil {
			t.Fatal("save invalid accepted")
		}
	}
	if LocalImageExtension("image/svg+xml") != "" {
		t.Fatal("active format")
	}
}
