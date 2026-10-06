package appcore

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/momo-api/momoapi-proxy/experimental/go-app/internal/integration"
)

func TestPluginAssetsConnectedGenerateLookupReuseAndNoRetry(t *testing.T) {
	model := "momoapi-gpt-image-2-5-flare"
	reference := inlineFixture(t, "image/png")
	b64 := strings.Split(reference, ",")[1]
	var sends, generate, edit atomic.Int32
	c, endpoint, _, _ := testCore(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sends.Add(1)
		w.Header().Set("Content-Type", "application/json")
		if r.Header.Get("Authorization") != "Bearer "+syntheticKey {
			t.Error("auth")
		}
		switch r.URL.Path {
		case "/agent/media-capabilities":
			io.WriteString(w, fixtureImageCatalog(model))
		case "/v1/images/generations":
			generate.Add(1)
			io.WriteString(w, `{"data":[{"b64_json":"`+b64+`","mime_type":"image/png"}]}`)
		case "/v1/images/edits":
			edit.Add(1)
			var body map[string]any
			json.NewDecoder(r.Body).Decode(&body)
			refs, ok := body["images"].([]any)
			if !ok || len(refs) != 2 || refs[0] != reference || refs[1] != reference || body["prompt"] != "explicit edit" {
				t.Error("asset references order/bytes")
			}
			io.WriteString(w, `{"data":[{"b64_json":"`+b64+`","mime_type":"image/png"}]}`)
		default:
			t.Error("unexpected request", r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	dispatch, closeClient, err := integration.NewLocalImageAssetDispatch(endpoint, c.token)
	if err != nil {
		t.Fatal(err)
	}
	defer closeClient()
	directory := filepath.Join(t.TempDir(), "explicit-new-assets")
	store, err := integration.NewImageAssetStore(directory, DecodeLocalImageSave)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	call := func(name string, args any) map[string]any {
		t.Helper()
		raw, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": map[string]any{"name": name, "arguments": args}})
		var out bytes.Buffer
		if integration.ServePluginImageAssetsMCP(context.Background(), bytes.NewReader(append(raw, '\n')), &out, dispatch, store) != nil {
			t.Fatal("serve")
		}
		if strings.Contains(out.String(), syntheticKey) || strings.Contains(out.String(), c.token) {
			t.Fatal("secret reflection")
		}
		var reply struct{ Result map[string]any }
		if json.Unmarshal(out.Bytes(), &reply) != nil {
			t.Fatal("reply")
		}
		return reply.Result
	}
	text := func(result map[string]any) map[string]any {
		t.Helper()
		if result["isError"] == true {
			t.Fatal("unexpected tool error")
		}
		var decoded map[string]any
		content := result["content"].([]any)[0].(map[string]any)["text"].(string)
		if json.Unmarshal([]byte(content), &decoded) != nil {
			t.Fatal("json result")
		}
		return decoded
	}
	if call("image_generate", map[string]any{"model": model, "prompt": "no catalog"})["isError"] != true || sends.Load() != 0 {
		t.Fatal("catalog gate")
	}
	cap := text(call("image_capabilities", map[string]any{}))
	if cap["asset_storage"].(map[string]any)["reopen"] != false {
		t.Fatal("scope")
	}
	result := text(call("image_generate", map[string]any{"model": model, "prompt": "explicit generation"}))
	image := result["images"].([]any)[0].(map[string]any)
	id := image["asset_id"].(string)
	ref := image["reference"].(string)
	path := image["local_path"].(string)
	if image["b64_json"] != nil || image["vision_available"] != false || result["asset_scope"] != "connector-session" {
		t.Fatal("compact/scope")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	_, expected, err := DecodeLocalImageSave(mustJSON(map[string]any{"confirmed": true, "mime_type": "image/png", "b64_json": b64}))
	if err != nil || !bytes.Equal(data, expected) {
		t.Fatal("disk readback")
	}
	if text(call("image_asset_get", map[string]any{"asset_id": id}))["asset_id"] != id {
		t.Fatal("get")
	}
	if len(text(call("image_asset_list", map[string]any{}))["assets"].([]any)) != 1 {
		t.Fatal("list")
	}
	if sends.Load() != 2 {
		t.Fatal("metadata called upstream")
	}
	call("image_edit", map[string]any{"model": model, "prompt": "explicit edit", "reference_images": []string{ref, reference}})
	if sends.Load() != 3 || generate.Load() != 1 || edit.Load() != 1 {
		t.Fatal("one send")
	}
	// Corrupt local bytes: opaque ref rejected before any additional billed send.
	os.WriteFile(path, []byte("tampered"), 0600)
	if call("image_edit", map[string]any{"model": model, "prompt": "explicit edit", "reference_images": []string{ref}})["isError"] != true || sends.Load() != 3 {
		t.Fatal("tamper sent upstream")
	}
	// Generation succeeded upstream but save/dedupe now fails. Exactly ONE send,
	// never retry generation, and don't leak base64 as a disguised save success.
	failed := call("image_generate", map[string]any{"model": model, "prompt": "explicit generation"})
	if failed["isError"] != true || sends.Load() != 4 || generate.Load() != 2 {
		t.Fatal("disk failure retries")
	}
	if !c.State().Running {
		t.Fatal("connector stopped owner")
	}
	c.Stop()
	if call("image_generate", map[string]any{"model": model, "prompt": "stopped"})["isError"] != true || sends.Load() != 4 {
		t.Fatal("Stop gate")
	}
}

func TestPluginAssetsRealDecoderRejectsUnsupportedAndInvalid(t *testing.T) {
	store, err := integration.NewImageAssetStore(filepath.Join(t.TempDir(), "new"), DecodeLocalImageSave)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	png := strings.Split(inlineFixture(t, "image/png"), ",")[1]
	for _, pair := range [][2]string{{"image/jpeg", png}, {"image/png", "bm90LWFuLWltYWdl"}, {"image/png", "%%%"}, {"image/gif", strings.Split(inlineFixture(t, "image/gif"), ",")[1]}} {
		if _, err := store.Save(pair[0], pair[1]); err == nil {
			t.Fatal("invalid save accepted")
		}
	}
}
