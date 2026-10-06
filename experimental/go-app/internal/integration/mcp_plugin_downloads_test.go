package integration

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"
)

func TestPluginDownloadsTaskMetadataInlineAndFailureNoReplay(t *testing.T) {
	s := newTestAssets(t)
	sends, gets := 0, 0
	mode := "url"
	dispatch := func(_ context.Context, path string, body []byte) ([]byte, int) {
		sends++
		switch mode {
		case "pending":
			return []byte(`{"images":[],"task_id":"one","terminal":false}`), 200
		case "inline":
			return []byte(`{"images":[{"b64_json":"b25l","mime_type":"image/png","url":"https://images.example/unused"}],"terminal":true}`), 200
		default:
			return []byte(`{"images":[{"url":"https://images.example/result?signed=synthetic-only"}],"terminal":true}`), 200
		}
	}
	fail := false
	down := func(ctx context.Context, url string) (string, string, error) {
		gets++
		if fail {
			return "", "", errAsset
		}
		if url != "https://images.example/result?signed=synthetic-only" {
			t.Error("normalized output only")
		}
		return "image/png", base64.StdEncoding.EncodeToString([]byte("one")), nil
	}
	call := func(name, args string) map[string]any {
		t.Helper()
		var out bytes.Buffer
		if ServePluginImageDownloadsMCP(context.Background(), strings.NewReader(videoCall("1", name, args)+"\n"), &out, dispatch, s, down) != nil {
			t.Fatal("serve")
		}
		if strings.Contains(out.String(), "signed=") || strings.Contains(out.String(), "b25l") {
			t.Fatal("URL/base64 reflection")
		}
		var result struct{ Result map[string]any }
		if json.Unmarshal(out.Bytes(), &result) != nil {
			t.Fatal("reply")
		}
		return result.Result
	}
	if call("image_asset_list", "{}")["isError"] == true || sends != 0 || gets != 0 {
		t.Fatal("metadata network")
	}
	mode = "pending"
	call("image_generate", `{"model":"explicit","prompt":"explicit"}`)
	if sends != 1 || gets != 0 {
		t.Fatal("pending auto poll/download")
	}
	mode = "url"
	result := call("image_task_status", `{"task_id":"one"}`)
	if result["isError"] == true || sends != 2 || gets != 1 || len(s.entries) != 1 {
		t.Fatal("manual completed task save")
	}
	mode = "inline"
	call("image_edit", `{"model":"explicit","prompt":"explicit","reference_images":["https://external.example/reference"]}`)
	if sends != 3 || gets != 1 {
		t.Fatal("inline precedence/reference downloaded")
	}
	mode = "url"
	fail = true
	if call("image_generate", `{"model":"explicit","prompt":"explicit"}`)["isError"] != true || sends != 4 || gets != 2 || len(s.entries) != 1 {
		t.Fatal("failed download replay")
	}
	// No general fetch tool is added by download mode.
	call("image_asset_download", `{"url":"https://images.example/arbitrary"}`)
	if sends != 4 || gets != 2 {
		t.Fatal("arbitrary fetch dispatched")
	}
}
