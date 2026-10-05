package appcore

import (
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"
)

func TestLocalImageReferencesPureMetadataAndBounds(t *testing.T) {
	for _, mime := range []string{"image/png", "image/jpeg", "image/gif", "image/webp"} {
		reference := "data:image/webp;base64,UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA"
		width := 1
		if mime != "image/webp" {
			reference = inlineFixture(t, mime)
			width = 2
		}
		data, _ := json.Marshal(map[string]any{"reference_images": []string{reference, reference}})
		metadata, err := ValidateLocalImageReferences(data)
		if err != nil || len(metadata) != 2 || metadata[0].MIME != mime || metadata[0].Bytes < 1 || metadata[0].Width != width || metadata[0].Height != width || metadata[0] != metadata[1] {
			t.Fatal("reference metadata", mime, err)
		}
		encoded, _ := json.Marshal(metadata)
		if strings.Contains(string(encoded), "base64") || strings.Contains(string(encoded), "data:") {
			t.Fatal("reference echo")
		}
	}
	reference := inlineFixture(t, "image/png")
	for _, raw := range []string{
		`{}`, `{"reference_images":[]}`, `{"reference_images":null}`, `{"reference_images":[null]}`,
		`{"reference_images":["https://images.example/a.png"]}`,
		`{"reference_images":["file:///private"]}`,
		`{"reference_images":["data:image/png;base64,AA=="]}`,
		`{"reference_images":[],"reference_images":[` + strconvQuote(reference) + `]}`,
		`{"reference_images":[` + strconvQuote(reference) + `],"filename":"private.png"}`,
		`{"reference_images":[` + strconvQuote(strings.Replace(reference, "image/png", "image/jpeg", 1)) + `]}`,
	} {
		if _, err := ValidateLocalImageReferences([]byte(raw)); err == nil {
			t.Fatal("invalid reference batch accepted")
		}
	}
	refs := make([]string, 17)
	for i := range refs {
		refs[i] = reference
	}
	raw, _ := json.Marshal(map[string]any{"reference_images": refs})
	if _, err := ValidateLocalImageReferences(raw); err == nil {
		t.Fatal("count17")
	}
	// Header-only validator deliberately does not claim complete PNG integrity.
	// Preserve all appended bytes and enforce aggregate count before pixel decode.
	bytes, _ := base64.StdEncoding.DecodeString(strings.Split(reference, ",")[1])
	large := append(append([]byte{}, bytes...), make([]byte, (MaxDesktopReferenceBytes/2)-len(bytes)+1)...)
	largeRef := "data:image/png;base64," + base64.StdEncoding.EncodeToString(large)
	raw, _ = json.Marshal(map[string]any{"reference_images": []string{largeRef}})
	metadata, err := ValidateLocalImageReferences(raw)
	if err != nil || metadata[0].Bytes != len(large) || len(raw) < 160<<10 {
		t.Fatal("bounded desktop large input", err)
	}
	raw, _ = json.Marshal(map[string]any{"reference_images": []string{largeRef, largeRef}})
	if _, err := ValidateLocalImageReferences(raw); err == nil {
		t.Fatal("aggregate >700KiB")
	}
	if _, err := ValidateLocalImageReferences([]byte(strings.Repeat(" ", MaxRequest+1))); err == nil {
		t.Fatal("request limit")
	}
	if _, err := ValidateLocalImageReferences([]byte("{\"reference_images\":[\"\xff\"]}")); err == nil {
		t.Fatal("UTF8")
	}
}
