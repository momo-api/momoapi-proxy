package appcore

import (
	"encoding/json"
	"errors"
	"strings"
	"unicode/utf8"
)

var errVideo = errors.New("unsupported video request or response")

// URLs are delegated references only, not DNS/redirect/content validation or
// an SSRF-proof claim. No reading/uploading files, asset: IDs, audio/video refs,
// data URLs, alias controls, frame/reference mixing or guessed native multipart.
func buildVideoGeneration(data []byte, p videoProfile) ([]byte, error) {
	m, err := decodeVideoObject(data)
	if err != nil || !p.Available || m["model"] != p.ID || !only(m, "model", "prompt", "duration", "resolution", "aspect_ratio", "reference_images", "first_frame_image", "last_frame_image") {
		return nil, errVideo
	}
	prompt, ok := m["prompt"].(string)
	prompt = strings.TrimSpace(prompt)
	// Match Node's documented 7000 UTF-16 code-unit cap, not Go rune count.
	units := 0
	for _, r := range prompt {
		units++
		if r > 0xffff {
			units++
		}
	}
	if !ok || prompt == "" || !utf8.ValidString(prompt) || units > 7000 {
		return nil, errVideo
	}
	duration := p.defaultDuration
	if v, present := m["duration"]; present {
		duration, err = videoInteger(v)
		if err != nil {
			return nil, errVideo
		}
	}
	found := false
	for _, n := range p.Durations {
		if duration == n {
			found = true
		}
	}
	if !found {
		return nil, errVideo
	}
	resolution := p.defaultResolution
	if v, present := m["resolution"]; present {
		resolution, ok = v.(string)
		if !ok {
			return nil, errVideo
		}
	}
	if !includes(p.Resolutions, resolution) {
		return nil, errVideo
	}
	ratio := p.defaultRatio
	if v, present := m["aspect_ratio"]; present {
		ratio, ok = v.(string)
		if !ok || !includes(p.Ratios, ratio) {
			return nil, errVideo
		}
	}
	wire := map[string]any{"model": p.ID, "prompt": prompt, "duration": duration, "resolution": resolution}
	if ratio != "" {
		wire["aspect_ratio"] = ratio
	}
	references := []string{}
	if v, present := m["reference_images"]; present {
		list, ok := v.([]any)
		if !ok || len(list) > p.MaxReferences {
			return nil, errVideo
		}
		for _, v := range list {
			s, ok := v.(string)
			if !ok || !validMediaURL(s) {
				return nil, errVideo
			}
			references = append(references, s)
		}
	}
	frames := false
	for _, name := range []string{"first_frame_image", "last_frame_image"} {
		if v, present := m[name]; present {
			s, ok := v.(string)
			if !ok || !validMediaURL(s) {
				return nil, errVideo
			}
			wire[name] = s
			frames = true
		}
	}
	if frames && (len(references) > 0 || ratio != "" && ratio != "adaptive") || len(references) > 0 && p.ID == "seedance-2.5" && ratio != "adaptive" {
		return nil, errVideo
	}
	if len(references) > 0 {
		wire["image_urls"] = references
	}
	body, err := json.Marshal(wire)
	if err != nil || len(body) > MaxRequest {
		return nil, errVideo
	}
	return body, nil
}
