package appcore

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"image"
	"strings"
)

type imageOutput struct {
	URL    string `json:"url,omitempty"`
	Base64 string `json:"b64_json,omitempty"`
	MIME   string `json:"mime_type,omitempty"`
}
type imageResult struct {
	Images   []imageOutput `json:"images"`
	TaskID   string        `json:"task_id,omitempty"`
	Status   string        `json:"raw_status,omitempty"`
	Terminal bool          `json:"terminal"`
	Error    string        `json:"error,omitempty"`
}

// Explicit known JSON envelopes, not recursive regex extraction from arbitrary
// text/SSE/partial outputs. No fetching URLs, echoed upstream errors/metadata or
// storing images. Base64 checks headers plus static GIF/WebP framing only,
// not complete PNG/JPEG framing, pixels/safety/integrity.
func parseImageResult(data []byte, expectedID string, maxN int) (imageResult, error) {
	result := imageResult{Images: []imageOutput{}}
	p, err := decodeObject(string(data))
	if err != nil || len(data) > MaxResponse {
		return result, errImage
	}
	if code, present := p["code"]; present {
		number, ok := code.(json.Number)
		if !ok || string(number) != "200" {
			return result, errImage
		}
	}
	rows := []map[string]any{p}
	if value, present := p["data"]; present {
		switch v := value.(type) {
		case map[string]any:
			rows = append(rows, v)
		case []any:
			if len(v) > 8 {
				return result, errImage
			}
			for _, item := range v {
				row := obj(item)
				if row == nil {
					return result, errImage
				}
				rows = append(rows, row)
			}
		default:
			return result, errImage
		}
	}
	bytesTotal := 0
	hasError := false
	add := func(row map[string]any) error {
		var out imageOutput
		if value, present := row["url"]; present {
			s, ok := value.(string)
			if !ok {
				return errImage
			}
			if !validMediaURL(s) {
				return errImage
			}
			out.URL = s
		}
		if value, present := row["b64_json"]; present {
			s, ok := value.(string)
			if !ok || s == "" || strings.ContainsAny(s, "\r\n\t ") || len(s) > MaxResponse {
				return errImage
			}
			decoded, err := base64.StdEncoding.Strict().DecodeString(s)
			if err != nil || len(decoded) == 0 || base64.StdEncoding.EncodeToString(decoded) != s {
				return errImage
			}
			bytesTotal += len(decoded)
			if bytesTotal > MaxResponse {
				return errImage
			}
			cfg, format, err := image.DecodeConfig(bytes.NewReader(decoded))
			if err != nil || cfg.Width < 1 || cfg.Height < 1 || cfg.Width > 16384 || cfg.Height > 16384 || int64(cfg.Width)*int64(cfg.Height) > 32_000_000 || !imageMIME("image/"+format) {
				return errImage
			}
			if format == "gif" && !singleFrameGIF(decoded) || format == "webp" && !staticWebP(decoded) {
				return errImage
			}
			out.Base64, out.MIME = s, "image/"+format
			if declared, present := row["mime_type"]; present && declared != out.MIME {
				return errImage
			}
		}
		if out.URL != "" || out.Base64 != "" {
			for _, prior := range result.Images {
				if prior == out {
					return nil
				}
			}
			result.Images = append(result.Images, out)
			if len(result.Images) > maxN || len(result.Images) > 4 {
				return errImage
			}
		}
		return nil
	}
	for _, row := range rows {
		if value, present := row["task_id"]; present {
			id, ok := value.(string)
			if !ok || !validImageTaskID(id) || result.TaskID != "" && result.TaskID != id {
				return result, errImage
			}
			result.TaskID = id
		}
		if expectedID != "" {
			if value, present := row["id"]; present {
				if value != expectedID {
					return result, errImage
				}
			}
		}
		if value, present := row["status"]; present {
			s, ok := value.(string)
			if !ok {
				return result, errImage
			}
			s = strings.ToLower(s)
			if !includes([]string{"submitted", "queued", "pending", "processing", "running", "in_progress", "completed", "success", "succeeded", "failed", "error", "cancelled", "canceled", "expired"}, s) || result.Status != "" && result.Status != s {
				return result, errImage
			}
			result.Status = s
		}
		if value, present := row["error"]; present && value != nil {
			hasError = true
		}
		if err := add(row); err != nil {
			return result, err
		}
		if value, present := row["result"]; present {
			inner := obj(value)
			if inner == nil {
				return result, errImage
			}
			if err := add(inner); err != nil {
				return result, err
			}
			if list, present := inner["images"]; present {
				images, ok := list.([]any)
				if !ok || len(images) > 4 {
					return result, errImage
				}
				for _, value := range images {
					row := obj(value)
					if row == nil {
						return result, errImage
					}
					if urls, ok := row["url"].([]any); ok {
						if len(urls) > 4 {
							return result, errImage
						}
						for _, url := range urls {
							if err := add(map[string]any{"url": url}); err != nil {
								return result, err
							}
						}
					} else if err := add(row); err != nil {
						return result, err
					}
				}
			}
		}
	}
	if expectedID != "" {
		if result.Status == "" && len(result.Images) == 0 {
			return result, errImage
		}
		if result.TaskID != "" && result.TaskID != expectedID {
			return result, errImage
		}
		result.TaskID = expectedID
	}
	failure := includes([]string{"failed", "error", "cancelled", "canceled", "expired"}, result.Status)
	if hasError && !failure {
		return result, errImage
	}
	if failure {
		if len(result.Images) != 0 {
			return result, errImage
		}
		result.Terminal = true
		result.Error = "image task ended without output"
	} else if includes([]string{"completed", "success", "succeeded"}, result.Status) {
		if len(result.Images) == 0 {
			return result, errImage
		}
		result.Terminal = true
	} else if len(result.Images) > 0 {
		if result.Status != "" {
			return result, errImage
		}
		result.Terminal = true
	} else if result.TaskID == "" {
		return result, errImage
	}
	return result, nil
}
