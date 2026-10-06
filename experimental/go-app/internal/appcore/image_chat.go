package appcore

import (
	"encoding/json"
	"strings"
)

// A finished Chat JSON image message, not recursive text/URL extraction, SSE,
// arbitrary metadata, Gemini-native candidates or a text-to-image fallback.
// Provider prose is discarded, never regex-scanned for data URLs or returned.
func parseChatImageResult(data []byte, n int) (imageResult, error) {
	empty := imageResult{Images: []imageOutput{}}
	if len(data) > MaxResponse {
		return empty, errImage
	}
	p, err := decodeVideoObject(data)
	if err != nil || p["error"] != nil {
		return empty, errImage
	}
	choices, ok := p["choices"].([]any)
	if !ok || len(choices) != 1 {
		return empty, errImage
	}
	choice := obj(choices[0])
	if choice == nil || choice["finish_reason"] != "stop" || choice["delta"] != nil {
		return empty, errImage
	}
	if index, present := choice["index"]; present {
		if value, err := imageControlNumber(index); err != nil || value != 0 {
			return empty, errImage
		}
	}
	message := obj(choice["message"])
	if message == nil || message["role"] != "assistant" || message["refusal"] != nil || message["tool_calls"] != nil || message["function_call"] != nil {
		return empty, errImage
	}
	rows := []any{}
	add := func(v any) error {
		part := obj(v)
		if part == nil || !only(part, "type", "image_url") || part["type"] != "image_url" {
			return errImage
		}
		image := obj(part["image_url"])
		if image == nil || !only(image, "url") {
			return errImage
		}
		url, ok := image["url"].(string)
		if !ok || url == "" {
			return errImage
		}
		row := map[string]any{}
		if strings.HasPrefix(url, "data:") {
			meta, encoded, found := strings.Cut(url, ",")
			mime := strings.TrimSuffix(strings.TrimPrefix(meta, "data:"), ";base64")
			if !found || meta != "data:"+mime+";base64" || !imageMIME(mime) {
				return errImage
			}
			row["b64_json"], row["mime_type"] = encoded, mime
		} else {
			if !validMediaURL(url) {
				return errImage
			}
			row["url"] = url
		}
		rows = append(rows, row)
		if len(rows) > n || len(rows) > 4 {
			return errImage
		}
		return nil
	}
	if images, present := message["images"]; present {
		list, ok := images.([]any)
		if !ok || len(list) > 4 {
			return empty, errImage
		}
		for _, v := range list {
			if add(v) != nil {
				return empty, errImage
			}
		}
	}
	if content, present := message["content"]; present && content != nil {
		switch v := content.(type) {
		case string: // Known prose is ignored, never interpreted as an image.
		case []any:
			if len(v) > 32 {
				return empty, errImage
			}
			for _, item := range v {
				part := obj(item)
				if part == nil {
					return empty, errImage
				}
				if part["type"] == "text" {
					if !only(part, "type", "text") {
						return empty, errImage
					}
					if _, ok := part["text"].(string); !ok {
						return empty, errImage
					}
					continue
				}
				if add(part) != nil {
					return empty, errImage
				}
			}
		default:
			return empty, errImage
		}
	}
	if len(rows) == 0 {
		return empty, errImage
	}
	raw, err := json.Marshal(map[string]any{"data": rows})
	if err != nil {
		return empty, errImage
	}
	return parseImageResult(raw, "", n)
}
