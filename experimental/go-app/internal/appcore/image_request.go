package appcore

import (
	"encoding/json"
	"strconv"
	"strings"
	"unicode/utf8"
)

// Static transport implementations intersect token-scoped catalog permission.
// Unknown knobs reject, no model defaults/substitution or silently dropped controls.
func buildImageGeneration(data []byte, p imageProfile) ([]byte, int, error) {
	request, err := decodeObject(string(data))
	if err != nil || !utf8.Valid(data) || len(data) > MaxRequest || !p.Available || request["model"] != p.ID {
		return nil, 0, errImage
	}
	allowed := append([]string{"model"}, p.Parameters...)
	if !only(request, allowed...) {
		return nil, 0, errImage
	}
	prompt, ok := request["prompt"].(string)
	if !ok || !utf8.ValidString(prompt) || strings.TrimSpace(prompt) == "" || utf8.RuneCountInString(prompt) > 32000 {
		return nil, 0, errImage
	}
	n := 1
	if value, present := request["n"]; present {
		number, ok := value.(json.Number)
		if !ok {
			return nil, 0, errImage
		}
		n, err = strconv.Atoi(string(number))
		if err != nil {
			return nil, 0, errImage
		}
	}
	validN := false
	for _, v := range p.nValues {
		if v == n {
			validN = true
		}
	}
	if !validN {
		return nil, 0, errImage
	}
	body := map[string]any{"model": p.ID, "prompt": strings.TrimSpace(prompt), "n": n}
	if p.profile == "minimal" {
		encoded, err := json.Marshal(body)
		return encoded, n, err
	}
	ratio := ""
	if value, present := request["aspect_ratio"]; present {
		var ok bool
		ratio, ok = value.(string)
		if !ok || !includes(p.Ratios, ratio) {
			return nil, 0, errImage
		}
	}
	size := ""
	if value, present := request["size"]; present {
		var ok bool
		size, ok = value.(string)
		if !ok {
			return nil, 0, errImage
		}
	}
	if ratio != "" && size != "" && size != "auto" {
		return nil, 0, errImage
	}
	resolution := "1k"
	if value, present := request["resolution"]; present {
		var ok bool
		resolution, ok = value.(string)
		if !ok || !includes(p.Resolutions, resolution) {
			return nil, 0, errImage
		}
	}
	quality := ""
	if value, present := request["quality"]; present {
		var ok bool
		quality, ok = value.(string)
		if !ok || !includes(p.Qualities, quality) {
			return nil, 0, errImage
		}
	}
	switch p.profile {
	case "web":
		if size != "" && size != "auto" {
			if !validWebImageSize(size) {
				return nil, 0, errImage
			}
			body["size"] = size
		}
		if ratio != "" {
			body["size"] = ratio
		}
		if quality != "" {
			body["quality"] = quality
		}
	case "adobe":
		if ratio == "" {
			ratio = "1:1"
		}
		if !includes(p.Ratios, ratio) {
			return nil, 0, errImage
		}
		body["aspect_ratio"] = ratio
		if size != "" && size != "auto" {
			if !validNativeImageSize(size) {
				return nil, 0, errImage
			}
			body["size"] = size
		}
		if len(p.Resolutions) > 0 {
			if !includes(p.Resolutions, resolution) {
				return nil, 0, errImage
			}
			body["resolution"] = resolution
		}
		if len(p.Qualities) > 0 {
			if quality == "" {
				quality = "medium"
			}
			if !includes(p.Qualities, quality) {
				return nil, 0, errImage
			}
			body["quality"] = quality
		}
	case "apimart":
		if size == "" || size == "auto" {
			size = "auto"
			if ratio != "" {
				size = ratio
			}
		}
		if size != "auto" && !includes(p.Ratios, size) && !validNativeImageSize(size) {
			return nil, 0, errImage
		}
		if quality == "" {
			quality = "auto"
		}
		if !includes(p.Qualities, quality) || !includes(p.Resolutions, resolution) {
			return nil, 0, errImage
		}
		format, err := imageEnum(request, "output_format", []string{"png", "jpeg", "webp"}, "png")
		if err != nil {
			return nil, 0, err
		}
		background, err := imageEnum(request, "background", []string{"auto", "opaque", "transparent"}, "auto")
		if err != nil || background == "transparent" && format == "jpeg" {
			return nil, 0, errImage
		}
		moderation, err := imageEnum(request, "moderation", []string{"auto", "low"}, "low")
		if err != nil {
			return nil, 0, err
		}
		body["size"], body["resolution"], body["quality"], body["output_format"], body["background"], body["moderation"] = size, resolution, quality, format, background, moderation
		if value, present := request["output_compression"]; present {
			number, ok := value.(json.Number)
			if !ok || format == "png" {
				return nil, 0, errImage
			}
			v, err := strconv.Atoi(string(number))
			if err != nil || v < 0 || v > 100 {
				return nil, 0, errImage
			}
			body["output_compression"] = v
		}
	case "legacy", "gemini":
		if ratio == "" {
			ratio = "1:1"
		}
		if !includes(p.Ratios, ratio) || !includes(p.Resolutions, resolution) {
			return nil, 0, errImage
		}
		if p.profile == "gemini" {
			body["size"], body["quality"] = ratio, strings.ToUpper(resolution)
		} else {
			body["size"] = "1024x1024"
			switch ratio {
			case "3:2", "16:9":
				body["size"] = "1536x1024"
			case "2:3", "9:16":
				body["size"] = "1024x1536"
			}
			body["quality"] = "medium"
			if resolution == "1k" {
				body["quality"] = "low"
			} else if resolution == "4k" {
				body["quality"] = "high"
			}
		}
	default:
		return nil, 0, errImage
	}
	encoded, err := json.Marshal(body)
	// Check final wire values, including profile defaults and aliases. Otherwise
	// e.g. aspect_ratio can bypass a size enum, or default moderation violates
	// a narrowed catalog. Never silently override a user control.
	for key, constraint := range p.Controls {
		if value, present := body[key]; present && !constraint.accepts(value) {
			return nil, 0, errImage
		}
	}
	if len(encoded) > MaxRequest {
		return nil, 0, errImage
	}
	return encoded, n, err
}
func imageControlNumber(value any) (int, error) {
	switch v := value.(type) {
	case int:
		return v, nil
	case json.Number:
		n, err := strconv.Atoi(string(v))
		if err == nil && n >= 0 && n <= 1048576 {
			return n, nil
		}
	}
	return 0, errImage
}
func (c imageControl) accepts(value any) bool {
	if len(c.Allowed) > 0 {
		found := false
		for _, allowed := range c.Allowed {
			if s, ok := value.(string); ok {
				if allowed == s {
					found = true
				}
			} else {
				v, e := imageControlNumber(value)
				a, ae := imageControlNumber(allowed)
				if e == nil && ae == nil && v == a {
					found = true
				}
			}
		}
		if !found {
			return false
		}
	}
	if c.Minimum != nil || c.Maximum != nil {
		n, err := imageControlNumber(value)
		if err != nil || c.Minimum != nil && n < *c.Minimum || c.Maximum != nil && n > *c.Maximum {
			return false
		}
	}
	return true
}
func imageEnum(request map[string]any, key string, values []string, fallback string) (string, error) {
	value, present := request[key]
	if !present {
		return fallback, nil
	}
	s, ok := value.(string)
	if !ok || !includes(values, s) {
		return "", errImage
	}
	return s, nil
}
func imageDimensions(size string) (int, int, bool) {
	w, h, ok := strings.Cut(size, "x")
	if !ok || len(w) > 5 || len(h) > 5 {
		return 0, 0, false
	}
	width, ew := strconv.Atoi(w)
	height, eh := strconv.Atoi(h)
	return width, height, ew == nil && eh == nil && width > 0 && height > 0 && strconv.Itoa(width) == w && strconv.Itoa(height) == h
}
func validWebImageSize(s string) bool {
	w, h, ok := imageDimensions(s)
	return ok && w >= 10 && h >= 10 && w <= 99999 && h <= 99999
}
func validNativeImageSize(s string) bool {
	w, h, ok := imageDimensions(s)
	if !ok || w%16 != 0 || h%16 != 0 || w > 3840 || h > 3840 || w > h*3 || h > w*3 {
		return false
	}
	return w*h >= 655360 && w*h <= 8294400
}
