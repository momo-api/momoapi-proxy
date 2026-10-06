package appcore

import (
	"encoding/base64"
	"strings"
)

// Explicit native-only save input, never a remote URL/path or provider query.
// Same bounded header/static-framing checks as the image result, not full image
// integrity/content-safety proof. No persistence, session or network here.
func DecodeLocalImageSave(raw []byte) (string, []byte, error) {
	if len(raw) > MaxResponse {
		return "", nil, errImage
	}
	p, err := decodeVideoObject(raw)
	if err != nil || len(p) != 3 || !only(p, "confirmed", "mime_type", "b64_json") || p["confirmed"] != true {
		return "", nil, errImage
	}
	declared, ok := p["mime_type"].(string)
	if !ok || !imageMIME(declared) {
		return "", nil, errImage
	}
	result, err := parseImageResult(raw, "", 1)
	if err != nil || len(result.Images) != 1 || result.Images[0].MIME != declared || result.Images[0].Base64 == "" {
		return "", nil, errImage
	}
	data, err := base64.StdEncoding.Strict().DecodeString(result.Images[0].Base64)
	if err != nil {
		return "", nil, errImage
	}
	return declared, data, nil
}

func LocalImageExtension(mime string) string {
	switch strings.TrimSpace(mime) {
	case "image/png":
		return ".png"
	case "image/jpeg":
		return ".jpg"
	case "image/gif":
		return ".gif"
	case "image/webp":
		return ".webp"
	}
	return ""
}
