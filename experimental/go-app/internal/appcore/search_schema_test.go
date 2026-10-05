package appcore

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

func TestSearchSchemaBoundedVocabulary(t *testing.T) {
	for _, text := range []string{
		`{"type":"object","properties":{"s":{"type":"string","minLength":1,"maxLength":2},"a":{"type":"array","items":{"type":"integer","minimum":0,"maximum":9007199254740993},"minItems":1,"maxItems":2},"b":{"type":"boolean"},"z":{"type":"null"}},"required":["s","a","b","z"],"additionalProperties":false}`,
		`{"type":"number","enum":[1,1.0,1e0],"minimum":0,"maximum":2}`,
		`{"type":"object","properties":{}}`,
	} {
		if err := validateSearchSchema(mustSearchObject(text)); err != nil {
			t.Fatal("valid bounded schema", err)
		}
	}
	for _, text := range []string{
		`{"type":"object"}`, `{"type":"object","properties":{},"required":["missing"]}`,
		`{"type":"object","properties":{"s":{"type":"string"}},"required":["s","s"]}`,
		`{"type":"object","properties":{},"additionalProperties":{}}`,
		`{"type":"string","pattern":".*"}`, `{"type":"string","enum":[1]}`,
		`{"type":"integer","enum":[1.5]}`, `{"type":"null","enum":[false]}`,
		`{"type":"string","enum":[]}`, `{"type":"array","items":{"type":"string"},"enum":[[]]}`,
		`{"type":"array"}`, `{"type":"string","minLength":2,"maxLength":1}`,
		`{"type":"string","maxLength":-1}`, `{"type":"string","maxLength":1.5}`,
		`{"type":"integer","minimum":2,"maximum":1}`, `{"type":"number","minimum":1e1025}`,
		`{"type":"string","minimum":1}`, `{"type":"number","items":{"type":"number"}}`,
		`{"type":"string","properties":{}}`, `{"type":["string","null"]}`,
	} {
		if validateSearchSchema(mustSearchObject(text)) == nil {
			t.Fatal("unsupported schema accepted", text)
		}
	}
	deep := map[string]any{"type": "string"}
	for i := 0; i < 17; i++ {
		deep = map[string]any{"type": "array", "items": deep}
	}
	if validateSearchSchema(deep) == nil {
		t.Fatal("schema depth exceeded")
	}
	props := map[string]any{}
	for i := 0; i < 2048; i++ {
		props[fmt.Sprint(i)] = map[string]any{"type": "string"}
	}
	if validateSearchSchema(map[string]any{"type": "object", "properties": props}) == nil {
		t.Fatal("schema nodes exceeded")
	}
	if numberRat(json.Number("1e"+strings.Repeat("9", 100))) != nil || numberRat(json.Number(strings.Repeat("1", 129))) != nil {
		t.Fatal("unbounded numeric allocation")
	}
}

func TestSearchValuePrecisionAndLimits(t *testing.T) {
	s := mustSearchObject(`{"type":"object","properties":{"s":{"type":"string","minLength":1,"maxLength":2},"a":{"type":"array","items":{"type":"integer","minimum":0,"maximum":9007199254740993},"minItems":1,"maxItems":2},"b":{"type":"boolean"},"z":{"type":"null"}},"required":["s","a","b","z"],"additionalProperties":false}`)
	if validateSearchSchema(s) != nil {
		t.Fatal("fixture")
	}
	for _, text := range []string{
		`{"s":"中🙂","a":[9007199254740993],"b":true,"z":null}`,
		`{"s":"a","a":[0,1e0],"b":false,"z":null}`,
	} {
		if validateSearchValue(s, mustSearchObject(text)) != nil {
			t.Fatal("valid bounded value", text)
		}
	}
	for _, text := range []string{
		`{"s":"abc","a":[1],"b":true,"z":null}`, `{"s":"","a":[1],"b":true,"z":null}`,
		`{"s":1,"a":[1],"b":true,"z":null}`, `{"s":"a","a":[],"b":true,"z":null}`,
		`{"s":"a","a":[1,2,3],"b":true,"z":null}`, `{"s":"a","a":[1.1],"b":true,"z":null}`,
		`{"s":"a","a":[9007199254740994],"b":true,"z":null}`, `{"s":"a","a":[-1],"b":true,"z":null}`,
		`{"s":"a","a":[1],"b":1,"z":null}`, `{"s":"a","a":[1],"b":true,"z":false}`,
		`{"s":"a","a":[1],"b":true}`, `{"s":"a","a":[1],"b":true,"z":null,"extra":1}`,
	} {
		if validateSearchValue(s, mustSearchObject(text)) == nil {
			t.Fatal("invalid bounded value", text)
		}
	}
	enum := mustSearchObject(`{"type":"number","enum":[1]}`)
	if validateSearchValue(enum, json.Number("1.0")) != nil || validateSearchValue(enum, json.Number("1e0")) != nil || validateSearchValue(enum, json.Number("2")) == nil {
		t.Fatal("enum mathematical equality")
	}
}
