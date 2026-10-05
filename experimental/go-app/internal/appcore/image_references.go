package appcore

import "strings"

const MaxDesktopReferenceBytes = 700 << 10

type ImageReferenceMetadata struct {
	MIME   string `json:"mime_type"`
	Bytes  int    `json:"bytes"`
	Width  int    `json:"width"`
	Height int    `json:"height"`
}

// Pure local validation of user-selected bytes; no Core/session/catalog,
// network/DNS/file reads, storage or billing. Shares the edit input gate.
// Metadata only: no image bytes/name/path/auth returned or retained.
func ValidateLocalImageReferences(data []byte) ([]ImageReferenceMetadata, error) {
	p, err := decodeVideoObject(data)
	if err != nil || len(data) > MaxRequest || !only(p, "reference_images") {
		return nil, errImage
	}
	refs, ok := p["reference_images"].([]any)
	if !ok || len(refs) < 1 || len(refs) > 16 {
		return nil, errImage
	}
	budget := &imageBudget{}
	metadata := make([]ImageReferenceMetadata, 0, len(refs))
	for _, v := range refs {
		s, ok := v.(string)
		if !ok || !strings.HasPrefix(s, "data:") {
			return nil, errImage
		}
		before := budget.bytes
		image, err := parseRouteImage(map[string]any{"type": "input_image", "image_url": s}, "gpt-edit", budget)
		if err != nil || budget.bytes > MaxDesktopReferenceBytes {
			return nil, errImage
		}
		metadata = append(metadata, ImageReferenceMetadata{image.mime, budget.bytes - before, image.width, image.height})
	}
	return metadata, nil
}
