package appcore

import (
	"encoding/json"
	"strings"
)

// Fixed reviewed transports only. Catalogs can narrow permission/counts, never
// supply an endpoint or silently redirect to a different model/transport.
func configureImageEdit(p *imageProfile, row, parameters map[string]any, edit bool) error {
	cap, transport := 0, ""
	switch p.profile {
	case "web":
		cap, transport = 4, "images-edits-json-images"
	case "adobe":
		cap, transport = 4, "images-generations-reference"
	case "apimart":
		cap, transport = 16, "images-generations-image-urls"
	case "legacy":
		if p.ID == "gpt-image-2" {
			cap, transport = 1, "images-generations-reference"
		}
	}
	if value, present := parameters["max_reference_images"]; present {
		constraint := obj(value)
		if constraint == nil || !only(constraint, "allowed", "minimum", "maximum") || len(constraint) == 0 {
			return errImage
		}
		control := imageControl{}
		if value, present := constraint["allowed"]; present {
			list, ok := value.([]any)
			if !ok || len(list) == 0 || len(list) > 64 {
				return errImage
			}
			seen := map[int]bool{}
			for _, v := range list {
				n, err := imageControlNumber(v)
				if err != nil || seen[n] {
					return errImage
				}
				seen[n] = true
			}
			control.Allowed = list
		}
		for _, bound := range []struct {
			key  string
			dest **int
		}{{"minimum", &control.Minimum}, {"maximum", &control.Maximum}} {
			if value, present := constraint[bound.key]; present {
				n, err := imageControlNumber(value)
				if err != nil {
					return errImage
				}
				*bound.dest = &n
			}
		}
		if control.Minimum != nil && control.Maximum != nil && *control.Minimum > *control.Maximum {
			return errImage
		}
		p.referenceControl = control
	}
	if value, present := row["transports"]; present {
		transports := obj(value)
		if transports == nil {
			return errImage
		}
		if value, present := transports["edit"]; present {
			if value != nil {
				if _, ok := value.(string); !ok {
					return errImage
				}
			}
			if value != transport {
				edit = false
			}
		}
	}
	if !edit || cap == 0 {
		return nil
	}
	for n := 1; n <= cap; n++ {
		if p.referenceControl.accepts(n) {
			p.MaxReferences = n
		}
	}
	if p.MaxReferences == 0 {
		return nil
	}
	p.EditTransport = transport
	p.Operations = append(p.Operations, "edit")
	p.Parameters = append(p.Parameters, "reference_images")
	return nil
}

// Reference strings remain byte-exact and ordered. No URL fetching, local file
// access, multipart/upload indirection, masking, auto-polling or fallback.
func buildImageEdit(data []byte, p imageProfile) ([]byte, int, string, error) {
	request, err := decodeVideoObject(data)
	if err != nil || len(data) > MaxRequest || !p.Available || !includes(p.Operations, "edit") || p.MaxReferences < 1 {
		return nil, 0, "", errImage
	}
	refs, ok := request["reference_images"].([]any)
	if !ok || len(refs) < 1 || len(refs) > p.MaxReferences || !p.referenceControl.accepts(len(refs)) {
		return nil, 0, "", errImage
	}
	budget := &imageBudget{}
	references := make([]string, 0, len(refs))
	for _, reference := range refs {
		s, ok := reference.(string)
		if !ok || !strings.HasPrefix(s, "data:") && p.EditTransport != "images-generations-image-urls" {
			return nil, 0, "", errImage
		}
		if _, err := parseRouteImage(map[string]any{"type": "input_image", "image_url": s}, "gpt-edit", budget); err != nil {
			return nil, 0, "", errImage
		}
		references = append(references, s)
	}
	delete(request, "reference_images")
	raw, err := json.Marshal(request)
	if err != nil {
		return nil, 0, "", errImage
	}
	// Reuse the same control normalizer for an edit-only catalog without enabling
	// generation permission in the session. Unknown fields still fail closed.
	p.Operations = []string{"generate"}
	wire, n, err := buildImageGeneration(raw, p)
	if err != nil {
		return nil, 0, "", errImage
	}
	body, err := decodeVideoObject(wire)
	if err != nil {
		return nil, 0, "", errImage
	}
	path, field := "/v1/images/generations", "image_urls"
	switch p.EditTransport {
	case "images-edits-json-images":
		path, field = "/v1/images/edits", "images"
	case "images-generations-reference", "images-generations-image-urls":
	default:
		return nil, 0, "", errImage
	}
	body[field] = references
	wire, err = json.Marshal(body)
	if err != nil || len(wire) > MaxRequest {
		return nil, 0, "", errImage
	}
	return wire, n, path, nil
}
