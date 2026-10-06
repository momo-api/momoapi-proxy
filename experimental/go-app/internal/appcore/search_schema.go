package appcore

import (
	"encoding/json"
	"math/big"
	"reflect"
	"strconv"
	"strings"
)

// Explicit, bounded JSON Schema type unions; no coercion or guessed keywords.
func schemaTypes(s map[string]any) (map[string]bool, error) {
	values, ok := s["type"].([]any)
	if !ok {
		values = []any{s["type"]}
	}
	if len(values) == 0 || len(values) > 7 {
		return nil, errUnsupportedSearchSchema
	}
	types := map[string]bool{}
	for _, value := range values {
		kind, ok := value.(string)
		if !ok || types[kind] {
			return nil, errUnsupportedSearchSchema
		}
		switch kind {
		case "object", "array", "string", "number", "integer", "boolean", "null":
		default:
			return nil, errUnsupportedSearchSchema
		}
		types[kind] = true
	}
	return types, nil
}

// Bounded, explicitly supported schema vocabulary, not arbitrary JSON Schema.
// Unsupported keywords are rejected; nothing is silently ignored.
func validateSearchSchema(schema map[string]any) error {
	nodes := 0
	var walk func(map[string]any, int) error
	walk = func(s map[string]any, depth int) error {
		nodes++
		if s == nil || depth > 16 || nodes > 2048 || !only(s, "type", "description", "properties", "required", "additionalProperties", "items", "enum", "minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems") {
			return errUnsupportedSearchSchema
		}
		if d, present := s["description"]; present {
			if _, ok := d.(string); !ok {
				return errUnsupportedSearchSchema
			}
		}
		types, err := schemaTypes(s)
		if err != nil {
			return err
		}
		if types["object"] {
			props := obj(s["properties"])
			if props == nil {
				return errUnsupportedSearchSchema
			}
			if v, present := s["additionalProperties"]; present {
				if _, ok := v.(bool); !ok {
					return errUnsupportedSearchSchema
				}
			}
			for _, v := range props {
				if err := walk(obj(v), depth+1); err != nil {
					return err
				}
			}
			if v, present := s["required"]; present {
				required, ok := v.([]any)
				if !ok {
					return errUnsupportedSearchSchema
				}
				seen := map[string]bool{}
				for _, v := range required {
					name, ok := v.(string)
					if !ok || seen[name] || props[name] == nil {
						return errUnsupportedSearchSchema
					}
					seen[name] = true
				}
			}
		}
		if types["array"] {
			if err := walk(obj(s["items"]), depth+1); err != nil {
				return err
			}
		}
		for _, k := range []string{"properties", "required", "additionalProperties"} {
			if _, ok := s[k]; ok && !types["object"] {
				return errUnsupportedSearchSchema
			}
		}
		if _, ok := s["items"]; ok && !types["array"] {
			return errUnsupportedSearchSchema
		}
		for _, pair := range [][3]string{{"minLength", "maxLength", "string"}, {"minItems", "maxItems", "array"}} {
			var min, max int64
			hasMax := false
			for i, k := range pair[:2] {
				if v, ok := s[k]; ok {
					n, valid := tokenCount(v)
					if !types[pair[2]] || !valid || n > MaxRequest {
						return errUnsupportedSearchSchema
					}
					if i == 0 {
						min = n
					} else {
						max = n
						hasMax = true
					}
				}
			}
			if hasMax && min > max {
				return errUnsupportedSearchSchema
			}
		}
		for _, k := range []string{"minimum", "maximum"} {
			if v, ok := s[k]; ok {
				if (!types["number"] && !types["integer"]) || numberRat(v) == nil {
					return errUnsupportedSearchSchema
				}
			}
		}
		if lo, hi := numberRat(s["minimum"]), numberRat(s["maximum"]); lo != nil && hi != nil && lo.Cmp(hi) > 0 {
			return errUnsupportedSearchSchema
		}
		if v, ok := s["enum"]; ok {
			values, ok := v.([]any)
			if !ok || len(values) == 0 || len(values) > 128 {
				return errUnsupportedSearchSchema
			}
			for _, v := range values {
				if obj(v) != nil {
					return errUnsupportedSearchSchema
				}
				if _, ok := v.([]any); ok {
					return errUnsupportedSearchSchema
				}
				withoutEnum := map[string]any{}
				for k, value := range s {
					if k != "enum" {
						withoutEnum[k] = value
					}
				}
				if validateSearchValue(withoutEnum, v) != nil {
					return errUnsupportedSearchSchema
				}
			}
		}
		return nil
	}
	return walk(schema, 0)
}

// A bounded local strict validator, not upstream constrained generation. Every
// object must reject extras and require all its declared properties. Conversion
// validates historical and generated arguments before accepting a call.
func validateStrictSchema(s map[string]any) error {
	types, err := schemaTypes(s)
	if err != nil {
		return err
	}
	if types["object"] {
		props := obj(s["properties"])
		required, _ := s["required"].([]any)
		if s["additionalProperties"] != false || len(required) != len(props) {
			return errUnsupportedSearchSchema
		}
		for _, child := range props {
			if err := validateStrictSchema(obj(child)); err != nil {
				return err
			}
		}
	}
	if types["array"] {
		return validateStrictSchema(obj(s["items"]))
	}
	return nil
}

func numberRat(v any) *big.Rat {
	n, ok := v.(json.Number)
	if !ok || len(n) > 128 {
		return nil
	}
	if i := strings.IndexAny(string(n), "eE"); i >= 0 {
		exponent, err := strconv.Atoi(string(n)[i+1:])
		if err != nil || exponent < -1024 || exponent > 1024 {
			return nil
		}
	}
	r, ok := new(big.Rat).SetString(string(n))
	if !ok {
		return nil
	}
	return r
}

func validateSearchValue(s map[string]any, v any) error {
	if values, ok := s["type"].([]any); ok {
		if _, err := schemaTypes(s); err != nil {
			return errRouted
		}
		branch := make(map[string]any, len(s))
		for k, value := range s {
			branch[k] = value
		}
		for _, kind := range values {
			branch["type"] = kind
			if validateSearchValue(branch, v) == nil {
				return nil
			}
		}
		return errRouted
	}
	if values, ok := s["enum"].([]any); ok {
		found := false
		for _, e := range values {
			if reflect.DeepEqual(e, v) {
				found = true
			}
			if a, b := numberRat(e), numberRat(v); a != nil && b != nil && a.Cmp(b) == 0 {
				found = true
			}
		}
		if !found {
			return errRouted
		}
	}
	switch s["type"] {
	case "object":
		m := obj(v)
		if m == nil {
			return errRouted
		}
		props := obj(s["properties"])
		if required, ok := s["required"].([]any); ok {
			for _, k := range required {
				if _, present := m[k.(string)]; !present {
					return errRouted
				}
			}
		}
		for k, v := range m {
			if p, ok := props[k]; ok {
				if err := validateSearchValue(obj(p), v); err != nil {
					return err
				}
			} else if s["additionalProperties"] == false {
				return errRouted
			}
		}
	case "array":
		vs, ok := v.([]any)
		if !ok {
			return errRouted
		}
		if !schemaSize(s, len(vs), "minItems", "maxItems") {
			return errRouted
		}
		for _, v := range vs {
			if err := validateSearchValue(obj(s["items"]), v); err != nil {
				return err
			}
		}
	case "string":
		text, ok := v.(string)
		if !ok || !schemaSize(s, len([]rune(text)), "minLength", "maxLength") {
			return errRouted
		}
	case "integer", "number":
		r := numberRat(v)
		if r == nil || s["type"] == "integer" && !r.IsInt() {
			return errRouted
		}
		if lo := numberRat(s["minimum"]); lo != nil && r.Cmp(lo) < 0 {
			return errRouted
		}
		if hi := numberRat(s["maximum"]); hi != nil && r.Cmp(hi) > 0 {
			return errRouted
		}
	case "boolean":
		if _, ok := v.(bool); !ok {
			return errRouted
		}
	case "null":
		if v != nil {
			return errRouted
		}
	default:
		return errRouted
	}
	return nil
}

func schemaSize(s map[string]any, n int, low, high string) bool {
	if v, ok := s[low]; ok {
		min, _ := tokenCount(v)
		if int64(n) < min {
			return false
		}
	}
	if v, ok := s[high]; ok {
		max, _ := tokenCount(v)
		if int64(n) > max {
			return false
		}
	}
	return true
}
