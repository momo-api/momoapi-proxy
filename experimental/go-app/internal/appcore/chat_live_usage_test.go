package appcore

import (
	"context"
	"net/http"
	"strings"
	"testing"
)

// Synthetic reconstruction of the live MOMO metadata keys; no captured payload.
func TestChatLiveZeroCacheWriteDetails(t *testing.T) {
	for _, details := range []string{`{"cache_write_tokens":0}`, `{"cached_creation_tokens":0}`, `{"cache_write_tokens":0,"cached_creation_tokens":0,"cached_tokens":1}`} {
		raw := ` {"prompt_tokens":4,"completion_tokens":2,"total_tokens":6,"prompt_tokens_details":` + details + `}`
		u, err := decodeObject(raw)
		if err != nil {
			t.Fatal(err)
		}
		mapped, err := chatTokenUsage(u)
		if err != nil || mapped["input_tokens"] != int64(4) || mapped["total_tokens"] != int64(6) {
			t.Fatal("live zero-valued cache metadata rejected")
		}
		d := obj(mapped["input_tokens_details"])
		if len(d) != 1 || (strings.Contains(details, `"cached_tokens":1`) && d["cached_tokens"] != int64(1)) {
			t.Fatal("cache mapping changed")
		}
	}
	for _, field := range []string{"cache_write_tokens", "cached_creation_tokens"} {
		for _, value := range []string{"1", "-1", "null", `"0"`, "false", "{}", "0.5"} {
			u, _ := decodeObject(`{"prompt_tokens":4,"completion_tokens":2,"total_tokens":6,"prompt_tokens_details":{"` + field + `":` + value + `}}`)
			if _, err := chatTokenUsage(u); err == nil {
				t.Fatal("unverified/non-count cache semantics accepted")
			}
		}
	}
	for _, raw := range []string{
		`{"prompt_tokens":4,"completion_tokens":2,"total_tokens":6,"prompt_tokens_details":{"unknown":0}}`,
		`{"prompt_tokens":4,"completion_tokens":2,"total_tokens":6,"completion_tokens_details":{"cache_write_tokens":0}}`,
		`{"prompt_tokens":4,"completion_tokens":2,"total_tokens":7,"prompt_tokens_details":{"cache_write_tokens":0}}`,
	} {
		u, _ := decodeObject(raw)
		if _, err := chatTokenUsage(u); err == nil {
			t.Fatal("existing strict boundary weakened")
		}
	}
}

func TestChatLiveZeroCacheUsageTrailerCompletes(t *testing.T) {
	stream := "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"MOMO_OK\"},\"finish_reason\":null}]}\n\n" +
		"data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n" +
		"data: {\"choices\":[],\"usage\":{\"prompt_tokens\":4,\"completion_tokens\":2,\"total_tokens\":6,\"prompt_tokens_details\":{\"cache_write_tokens\":0,\"cached_creation_tokens\":0}}}\n\ndata: [DONE]\n\n"
	w := &jsonProbeWriter{header: make(http.Header), mode: "ok"}
	if err := convertChatStream(context.Background(), w, strings.NewReader(stream), &chatPlan{model: "synthetic-model"}); err != nil || w.writes != 1 {
		t.Fatal("valid live-shaped trailer aborted completion")
	}
}
