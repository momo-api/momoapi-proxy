package integration

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestPluginAssetsListGetValidationURLTaskAndFailureIsolation(t *testing.T) {
	s := newTestAssets(t)
	sends := 0
	dispatch := func(_ context.Context, path string, body []byte) ([]byte, int) {
		sends++
		return []byte(`{"images":[{"url":"https://images.example/result.png"}],"terminal":true}`), 200
	}
	call := func(name, args string) string {
		t.Helper()
		var out bytes.Buffer
		if ServePluginImageAssetsMCP(context.Background(), strings.NewReader(videoCall("1", name, args)+"\n"), &out, dispatch, s) != nil {
			t.Fatal("serve")
		}
		return out.String()
	}
	for _, c := range [][2]string{{"image_asset_get", `{"asset_id":"../secret"}`}, {"image_asset_get", `{"asset_id":null}`}, {"image_asset_get", `{"asset_id":"img_"}`}, {"image_asset_list", `{"limit":0}`}, {"image_asset_list", `{"limit":129}`}, {"image_asset_list", `{"limit":null}`}, {"image_asset_list", `{"limit":1.5}`}, {"image_asset_list", `{"limit":1,"path":"private"}`}} {
		out := call(c[0], c[1])
		if !strings.Contains(out, "-32602") || strings.Contains(out, "private") {
			t.Fatal("invalid/no reflection")
		}
	}
	if !strings.Contains(call("image_asset_get", `{"asset_id":"img_`+strings.Repeat("0", 64)+`"}`), `"isError":true`) {
		t.Fatal("foreign ID")
	}
	if sends != 0 {
		t.Fatal("metadata network")
	}
	result := call("image_generate", `{"model":"chosen","prompt":"explicit"}`)
	var reply struct {
		Result struct{ Content []struct{ Text string } }
	}
	json.Unmarshal([]byte(result), &reply)
	if strings.Contains(reply.Result.Content[0].Text, "asset_id") || !strings.Contains(reply.Result.Content[0].Text, "https://images.example/result.png") || len(s.entries) != 0 || sends != 1 {
		t.Fatal("remote download/save")
	}
	dispatch = func(_ context.Context, path string, body []byte) ([]byte, int) {
		sends++
		return []byte(`{"images":[],"task_id":"one","terminal":false}`), 200
	}
	if !strings.Contains(call("image_generate", `{"model":"chosen","prompt":"explicit"}`), "one") || len(s.entries) != 0 || sends != 2 {
		t.Fatal("async task")
	}
	dispatch = func(_ context.Context, path string, body []byte) ([]byte, int) {
		sends++
		return []byte(`{"images":[{"b64_json":"` + base64.StdEncoding.EncodeToString([]byte("one")) + `","mime_type":"image/png"}],"terminal":true}`), 200
	}
	done := call("image_task_status", `{"task_id":"one"}`)
	json.Unmarshal([]byte(done), &reply)
	if !strings.Contains(reply.Result.Content[0].Text, "asset_id") || strings.Contains(reply.Result.Content[0].Text, "b64_json") || len(s.entries) != 1 || sends != 3 {
		t.Fatal("completed task persistence")
	}
	s.Close()
	if !strings.Contains(call("image_generate", `{"model":"chosen","prompt":"explicit"}`), `"isError":true`) || sends != 4 {
		t.Fatal("save failed retry")
	}
	if !strings.Contains(call("image_asset_list", "{}"), `"isError":true`) || sends != 4 {
		t.Fatal("closed metadata")
	}
	// Default mode still exposes no asset tools, even after asset mode is used.
	var out bytes.Buffer
	ServePluginImageMCP(context.Background(), strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"tools/list"}`+"\n"), &out, dispatch)
	if strings.Contains(out.String(), "image_asset_get") {
		t.Fatal("default mode broadened")
	}
}

func TestPluginAssetExpandedReferenceBudgetsAndCancellation(t *testing.T) {
	s := newTestAssets(t)
	a, err := s.Save("image/png", base64.StdEncoding.EncodeToString(bytes.Repeat([]byte("a"), 200<<10)))
	if err != nil {
		t.Fatal(err)
	}
	large, err := s.Save("image/png", base64.StdEncoding.EncodeToString(bytes.Repeat([]byte("b"), 800<<10)))
	if err != nil {
		t.Fatal(err)
	}
	sends := 0
	dispatch := func(_ context.Context, path string, body []byte) ([]byte, int) {
		sends++
		if len(body) <= ImageMCPLineLimit || len(body) > 1<<20 {
			t.Error("expanded body")
		}
		return []byte(`{"images":[],"task_id":"one","terminal":false}`), 200
	}
	for _, test := range []struct {
		ref      string
		accepted bool
	}{{a.Reference, true}, {large.Reference, false}} {
		args, _ := json.Marshal(map[string]any{"model": "explicit", "prompt": "edit", "reference_images": []string{test.ref}})
		before := sends
		var out bytes.Buffer
		ServePluginImageAssetsMCP(context.Background(), strings.NewReader(videoCall("1", "image_edit", string(args))+"\n"), &out, dispatch, s)
		if test.accepted {
			if sends != before+1 || strings.Contains(out.String(), `"isError":true`) {
				t.Fatal("bounded expansion rejected")
			}
		} else if sends != before || !strings.Contains(out.String(), `"isError":true`) {
			t.Fatal("oversize expansion sent")
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	var out bytes.Buffer
	before := len(s.entries)
	ServePluginImageAssetsMCP(ctx, strings.NewReader(videoCall("1", "image_generate", `{"model":"explicit","prompt":"generate"}`)+"\n"), &out, func(context.Context, string, []byte) ([]byte, int) {
		cancel()
		return []byte(`{"images":[{"b64_json":"b25l","mime_type":"image/png"}],"terminal":true}`), 200
	}, s)
	if out.Len() != 0 || len(s.entries) != before {
		t.Fatal("canceled call persisted result")
	}
}

func TestAssetConnectorBodyBudgetIsExplicitAndBounded(t *testing.T) {
	sends := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sends++
		if _, err := io.Copy(io.Discard, r.Body); err != nil {
			t.Error("mock body read")
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte("{}"))
	}))
	defer server.Close()
	ordinary, closeOrdinary, err := NewLocalImageDispatch(server.URL, syntheticLocalToken)
	if err != nil {
		t.Fatal(err)
	}
	defer closeOrdinary()
	assets, closeAssets, err := NewLocalImageAssetDispatch(server.URL, syntheticLocalToken)
	if err != nil {
		t.Fatal(err)
	}
	defer closeAssets()
	body := bytes.Repeat([]byte(" "), ImageMCPLineLimit+1)
	if _, status := ordinary(context.Background(), "/internal/images/edit", body); status != 400 || sends != 0 {
		t.Fatal("ordinary budget broadened")
	}
	if _, status := assets(context.Background(), "/internal/images/edit", body); status != 200 || sends != 1 {
		t.Fatal("explicit asset expansion")
	}
	if _, status := assets(context.Background(), "/internal/images/edit", bytes.Repeat([]byte(" "), (1<<20)+1)); status != 400 || sends != 1 {
		t.Fatal("asset budget unbounded")
	}
}
