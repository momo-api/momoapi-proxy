package appcore

import (
	"encoding/json"
	"errors"
	"strconv"
	"strings"
	"time"
)

const imageCatalogTTL = 5 * time.Minute
const maxImageTasks = 64
const imageTaskTTL = 30 * time.Minute

type imageSession struct {
	profiles   map[string]imageProfile
	checked    time.Time
	tasks      map[string]imageTask
	pending    int
	refreshing bool
}

func (s *imageSession) clear() { *s = imageSession{} }

type imageTask struct {
	expires time.Time
	maxN    int
}

func (s *imageSession) expire(now time.Time) {
	for id, task := range s.tasks {
		if !now.Before(task.expires) {
			delete(s.tasks, id)
		}
	}
}

type imageProfile struct {
	ID             string   `json:"id"`
	Available      bool     `json:"available"`
	Operations     []string `json:"operations"`
	Parameters     []string `json:"parameters"`
	MaxN           int      `json:"max_n"`
	AllowedN       []int    `json:"allowed_n"`
	Qualities      []string `json:"qualities,omitempty"`
	Ratios         []string `json:"aspect_ratios,omitempty"`
	Resolutions    []string `json:"resolutions,omitempty"`
	Availability   string   `json:"availability"`
	ProtocolStatus string   `json:"protocol_status"`
	profile        string
	nValues        []int
	Controls       map[string]imageControl `json:"constraints,omitempty"`
}

type imageControl struct {
	Allowed []any `json:"allowed,omitempty"`
	Minimum *int  `json:"minimum,omitempty"`
	Maximum *int  `json:"maximum,omitempty"`
}

var imageRatios = []string{"1:1", "3:2", "2:3", "4:3", "3:4", "5:4", "4:5", "16:9", "9:16", "2:1", "1:2", "21:9", "9:21", "3:1", "1:3"}
var imageIDs = []string{"momoapi-gpt-image-2-5-flare", "momoapi-gpt-image-2-5-sunburst", "momoapi-gpt-image-2-5-prism", "momoapi-gpt-image-2", "momoapi-gemini-nano-banana-3", "gpt-image-2.5-flare", "gpt-image-2.5-sunburst", "gpt-image-2", "gpt-image-2-momoapi", "gemini-3.1-flash-image"}
var errImage = errors.New("unsupported image request or response")

func imageBaseProfile(id string) (imageProfile, bool) {
	p := imageProfile{ID: id, Operations: []string{"generate"}, MaxN: 1, Ratios: append([]string{}, imageRatios...), Resolutions: []string{"1k", "2k", "4k"}, Availability: "media_catalog", ProtocolStatus: "implemented_not_live_verified"}
	switch id {
	case "momoapi-gpt-image-2-5-flare", "momoapi-gpt-image-2-5-sunburst":
		p.profile = "web"
		p.MaxN = 4
		p.Resolutions = nil
		p.Qualities = []string{"auto", "low", "medium", "high"}
		p.Parameters = []string{"prompt", "n", "aspect_ratio", "size", "quality"}
	case "momoapi-gpt-image-2-5-prism", "momoapi-gpt-image-2":
		p.profile = "adobe"
		p.MaxN = 4
		p.Resolutions = nil
		p.Qualities = []string{"low", "medium", "high"}
		p.Parameters = []string{"prompt", "n", "aspect_ratio", "size", "quality"}
	case "momoapi-gemini-nano-banana-3":
		p.profile = "adobe"
		p.Parameters = []string{"prompt", "n", "aspect_ratio", "size", "resolution"}
	case "gpt-image-2.5-flare", "gpt-image-2.5-sunburst":
		p.profile = "apimart"
		p.MaxN = 4
		p.Qualities = []string{"auto", "low", "medium", "high", "xhigh", "max"}
		p.Parameters = []string{"prompt", "n", "aspect_ratio", "size", "resolution", "quality", "output_format", "output_compression", "background", "moderation"}
	case "gpt-image-2":
		p.profile = "legacy"
		p.Parameters = []string{"prompt", "n", "aspect_ratio", "resolution"}
	case "gpt-image-2-momoapi":
		p.profile = "legacy"
		p.MaxN = 4
		p.Parameters = []string{"prompt", "n", "aspect_ratio", "resolution"}
	case "gemini-3.1-flash-image":
		p.profile = "gemini"
		p.Parameters = []string{"prompt", "n", "aspect_ratio", "resolution"}
	default:
		return p, false
	}
	for i := 1; i <= p.MaxN; i++ {
		p.nValues = append(p.nValues, i)
	}
	p.AllowedN = append([]int{}, p.nValues...)
	return p, true
}
func includes(values []string, s string) bool {
	for _, v := range values {
		if v == s {
			return true
		}
	}
	return false
}

// Catalog supplies route permission and N/enum constraints, never executable
// endpoints, arbitrary controls, account metadata, defaults or fallback models.
// Missing controls use this proxy's documented static profile, NOT a live proof.
func parseImageCatalog(data []byte) (map[string]imageProfile, error) {
	p, err := decodeObject(string(data))
	if err != nil {
		return nil, errImage
	}
	models, ok := p["models"].([]any)
	if !ok || len(models) > 128 {
		return nil, errImage
	}
	profiles := map[string]imageProfile{}
	for _, value := range models {
		row := obj(value)
		if row == nil {
			return nil, errImage
		}
		id := str(row["id"])
		profile, known := imageBaseProfile(id)
		if !known || row["modality"] != "image" {
			continue
		}
		if _, duplicate := profiles[id]; duplicate {
			return nil, errImage
		}
		available, ok := row["available"].(bool)
		if !ok {
			return nil, errImage
		}
		operations, ok := row["operations"].([]any)
		if !ok || len(operations) > 4 {
			return nil, errImage
		}
		generate := false
		for _, op := range operations {
			if op == "generate" {
				generate = true
			}
		}
		profile.Available = available && generate
		parameters := obj(row["parameters"])
		if parameters == nil {
			return nil, errImage
		}
		profile.Controls = map[string]imageControl{}
		for _, key := range []string{"size", "output_format", "background", "moderation", "output_compression", "n"} {
			value, present := parameters[key]
			if !present {
				continue
			}
			constraint := obj(value)
			if constraint == nil {
				return nil, errImage
			}
			control := imageControl{}
			if value, present := constraint["allowed"]; present {
				list, ok := value.([]any)
				if !ok || len(list) == 0 || len(list) > 64 {
					return nil, errImage
				}
				for _, value := range list {
					if key == "n" || key == "output_compression" {
						if _, err := imageControlNumber(value); err != nil {
							return nil, errImage
						}
					} else {
						if s, ok := value.(string); !ok || s == "" || len(s) > 64 {
							return nil, errImage
						}
						s := value.(string)
						if key == "size" {
							if s != "auto" && !includes(imageRatios, s) && !validNativeImageSize(s) && !(profile.profile == "web" && validWebImageSize(s)) {
								return nil, errImage
							}
						} else {
							values := map[string][]string{"output_format": {"png", "jpeg", "webp"}, "background": {"auto", "opaque", "transparent"}, "moderation": {"auto", "low"}}
							if !includes(values[key], s) {
								return nil, errImage
							}
						}
					}
				}
				control.Allowed = list
			}
			for _, bound := range []struct {
				key  string
				dest **int
			}{{"minimum", &control.Minimum}, {"maximum", &control.Maximum}} {
				if value, present := constraint[bound.key]; present {
					if key != "n" && key != "output_compression" {
						return nil, errImage
					}
					n, err := imageControlNumber(value)
					if err != nil {
						return nil, errImage
					}
					*bound.dest = &n
				}
			}
			if control.Minimum != nil && control.Maximum != nil && *control.Minimum > *control.Maximum {
				return nil, errImage
			}
			profile.Controls[key] = control
		}
		if n, present := parameters["n"]; present {
			constraint := obj(n)
			if constraint == nil {
				return nil, errImage
			}
			if values, present := constraint["allowed"]; present {
				list, ok := values.([]any)
				if !ok || len(list) > 64 {
					return nil, errImage
				}
				profile.nValues = nil
				for _, value := range list {
					number, ok := value.(json.Number)
					if !ok {
						return nil, errImage
					}
					v, err := strconv.Atoi(string(number))
					if err != nil || v < 1 {
						return nil, errImage
					}
					if v <= profile.MaxN {
						profile.nValues = append(profile.nValues, v)
					}
				}
			} else if maximum, present := constraint["maximum"]; present {
				number, ok := maximum.(json.Number)
				if !ok {
					return nil, errImage
				}
				max, err := strconv.Atoi(string(number))
				if err != nil || max < 1 {
					return nil, errImage
				}
				kept := []int{}
				for _, n := range profile.nValues {
					if n <= max {
						kept = append(kept, n)
					}
				}
				profile.nValues = kept
			} else {
				return nil, errImage
			}
			if len(profile.nValues) == 0 {
				return nil, errImage
			}
			kept := []int{}
			for _, n := range profile.nValues {
				if profile.Controls["n"].accepts(n) {
					exists := false
					for _, prior := range kept {
						if prior == n {
							exists = true
						}
					}
					if !exists {
						kept = append(kept, n)
					}
				}
			}
			profile.nValues = kept
			if len(kept) == 0 {
				return nil, errImage
			}
			profile.MaxN = 0
			for _, n := range profile.nValues {
				if n > profile.MaxN {
					profile.MaxN = n
				}
			}
		}
		for _, field := range []struct {
			key    string
			values *[]string
		}{{"quality", &profile.Qualities}, {"aspect_ratio", &profile.Ratios}, {"resolution", &profile.Resolutions}} {
			if value, present := parameters[field.key]; present {
				constraint := obj(value)
				if constraint == nil {
					return nil, errImage
				}
				list, ok := constraint["allowed"].([]any)
				if !ok || len(list) > 64 {
					return nil, errImage
				}
				kept := []string{}
				for _, value := range list {
					v, ok := value.(string)
					if !ok {
						return nil, errImage
					}
					if includes(*field.values, v) && !includes(kept, v) {
						kept = append(kept, v)
					}
				}
				if len(kept) == 0 {
					return nil, errImage
				}
				*field.values = kept
			}
		}
		profile.AllowedN = append([]int{}, profile.nValues...)
		profiles[id] = profile
	}
	return profiles, nil
}
func fallbackImageCatalog(data []byte) (map[string]imageProfile, error) {
	ids, err := parseModelIDs(data)
	if err != nil {
		return nil, errImage
	}
	profiles := map[string]imageProfile{}
	for _, id := range ids {
		if id != "momoapi-gpt-image-2-5-flare" && id != "momoapi-gpt-image-2-5-sunburst" {
			continue
		}
		p, _ := imageBaseProfile(id)
		p.Available = true
		p.profile = "minimal"
		p.MaxN = 1
		p.nValues = []int{1}
		p.AllowedN = []int{1}
		p.Qualities = nil
		p.Ratios = nil
		p.Resolutions = nil
		p.Parameters = []string{"prompt", "n"}
		p.Availability = "token_model_list_minimal"
		profiles[id] = p
	}
	return profiles, nil
}
func publicImageCatalog(profiles map[string]imageProfile, checked time.Time) map[string]any {
	models := []imageProfile{}
	for _, id := range imageIDs {
		if p, ok := profiles[id]; ok {
			models = append(models, p)
		}
	}
	return map[string]any{"version": 1, "models": models, "checked_at": checked, "expires_at": checked.Add(imageCatalogTTL), "catalog_status": "available", "notes": "Generate only; explicitly select model. Catalog permission/controls are not live inference proof. No automatic fallback, edits, downloads, persistence or video. Query again after Stop/reconfigure or five minutes.", "limits": map[string]any{"request_bytes": MaxRequest, "response_bytes": MaxResponse, "active": 4, "generate_timeout_seconds": 300, "max_session_tasks": maxImageTasks, "task_ttl_seconds": int(imageTaskTTL.Seconds())}}
}

func validImageTaskID(id string) bool {
	if id == "" || len(id) > 256 || id == "." || id == ".." {
		return false
	}
	for _, r := range id {
		if r > 127 || !strings.ContainsRune("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._:-", r) {
			return false
		}
	}
	return true
}
func imageRoute(path, method string) (bool, bool) {
	if path == "/internal/images/capabilities" {
		return true, method == "GET"
	}
	if path == "/internal/images/generate" {
		return true, method == "POST"
	}
	if id, ok := strings.CutPrefix(path, "/internal/images/tasks/"); ok && validImageTaskID(id) {
		return true, method == "GET"
	}
	return false, false
}
