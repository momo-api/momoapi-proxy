package appcore

import (
	"bytes"
	"encoding/json"
	"unicode/utf8"
)

// Bounded duplicate-free JSON for explicit video controls and envelopes. The
// passthrough path stays byte-exact; this policy is not imposed on other APIs.
func decodeVideoObject(data []byte) (map[string]any, error) {
	if !utf8.Valid(data) || !json.Valid(data) {
		return nil, errVideo
	}
	d := json.NewDecoder(bytes.NewReader(data))
	d.UseNumber()
	var walk func(int) bool
	walk = func(depth int) bool {
		if depth > 64 {
			return false
		}
		token, err := d.Token()
		if err != nil {
			return false
		}
		delim, ok := token.(json.Delim)
		if !ok {
			return true
		}
		switch delim {
		case '{':
			seen := map[string]bool{}
			for d.More() {
				k, err := d.Token()
				if err != nil {
					return false
				}
				key, ok := k.(string)
				if !ok || seen[key] {
					return false
				}
				seen[key] = true
				if !walk(depth + 1) {
					return false
				}
			}
		case '[':
			for d.More() {
				if !walk(depth + 1) {
					return false
				}
			}
		default:
			return false
		}
		_, err = d.Token()
		return err == nil
	}
	if !walk(0) {
		return nil, errVideo
	}
	return decodeObject(string(data))
}
