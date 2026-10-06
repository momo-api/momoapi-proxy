package integration

import (
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// Synthetic validator here isolates filesystem semantics; real decoder tested
// through Core/TLS lifecycle tests in appcore, not claimed by this stub.
func testAssetValidator(raw []byte) (string, []byte, error) {
	var p struct {
		MIME string `json:"mime_type"`
		B64  string `json:"b64_json"`
	}
	if json.Unmarshal(raw, &p) != nil || p.MIME != "image/png" {
		return "", nil, errAsset
	}
	data, err := base64.StdEncoding.Strict().DecodeString(p.B64)
	if err != nil || len(data) == 0 {
		return "", nil, errAsset
	}
	return p.MIME, data, nil
}

func newTestAssets(t *testing.T) *ImageAssetStore {
	t.Helper()
	s, err := NewImageAssetStore(filepath.Join(t.TempDir(), "new-assets"), testAssetValidator)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	return s
}

func TestAssetExplicitNewRootSaveDedupeReadbackAndClose(t *testing.T) {
	parent := t.TempDir()
	directory := filepath.Join(parent, "assets")
	if _, err := NewImageAssetStore("relative", testAssetValidator); err == nil {
		t.Fatal("relative root")
	}
	if _, err := NewImageAssetStore(directory, nil); err == nil {
		t.Fatal("nil validator")
	}
	if runtime.GOOS == "windows" {
		for _, path := range []string{`\\example.invalid\share\assets`, `\\?\C:\assets`, `C:\assets:stream`, `C:\CON\assets`, `C:\new.\assets`, `C:\LPT1\assets`} {
			if _, err := NewImageAssetStore(path, testAssetValidator); err == nil {
				t.Fatal("remote/device root")
			}
		}
	}
	s, err := NewImageAssetStore(directory, testAssetValidator)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if _, err := NewImageAssetStore(directory, testAssetValidator); err == nil {
		t.Fatal("existing directory import")
	}
	b64 := base64.StdEncoding.EncodeToString([]byte("synthetic-content"))
	a, err := s.Save("image/png", b64)
	if err != nil || a.Reference != "asset:"+a.ID || !validAssetID(a.ID) || a.Vision || a.Bytes != 17 {
		t.Fatal("metadata", err)
	}
	if data, err := os.ReadFile(a.Path); err != nil || string(data) != "synthetic-content" {
		t.Fatal("bytes")
	}
	duplicate, err := s.Save("image/png", b64)
	if err != nil || duplicate.ID != a.ID || len(s.entries) != 1 || s.bytes != 17 {
		t.Fatal("dedupe")
	}
	value, err := s.Resolve(a.Reference)
	if err != nil || value != "data:image/png;base64,"+b64 {
		t.Fatal("resolve")
	}
	if meta, err := s.Get(a.ID); err != nil || meta.SHA256 != a.SHA256 {
		t.Fatal("get")
	}
	list, err := s.List(20)
	if err != nil || len(list) != 1 || list[0].ID != a.ID {
		t.Fatal("list")
	}
	for _, ref := range []string{a.Path, "asset:../" + a.ID, "asset:" + strings.ToUpper(a.ID), "asset:" + a.ID + ".png", "asset:img_" + strings.Repeat("0", 64)} {
		if _, err := s.Resolve(ref); err == nil {
			t.Fatal("foreign/path accepted")
		}
	}
	for _, limit := range []int{-1, 0, 129} {
		if _, err := s.List(limit); err == nil {
			t.Fatal("list bound")
		}
	}
	for _, mime := range []string{"image/gif", "text/plain", "image/png\n"} {
		if _, err := s.Save(mime, b64); err == nil {
			t.Fatal("mime")
		}
	}
	if _, err := s.Save("image/png", "%%%bad"); err == nil {
		t.Fatal("bad base64")
	}
	s.Close()
	if _, err := s.Get(a.ID); err == nil {
		t.Fatal("closed")
	}
	if _, err := os.Stat(a.Path); err != nil {
		t.Fatal("Close deleted saved file")
	}
	if _, err := NewImageAssetStore(directory, testAssetValidator); err == nil {
		t.Fatal("reopen/import")
	}
}

func TestAssetAbsoluteTTLAndCapacityNeverEvict(t *testing.T) {
	s := newTestAssets(t)
	now := time.Date(2026, 10, 6, 0, 0, 0, 0, time.UTC)
	s.now = func() time.Time { return now }
	a, err := s.Save("image/png", base64.StdEncoding.EncodeToString([]byte("one")))
	if err != nil {
		t.Fatal(err)
	}
	now = now.Add(23 * time.Hour)
	if _, err := s.Get(a.ID); err != nil {
		t.Fatal("early expiry")
	}
	now = now.Add(time.Hour)
	if _, err := s.Resolve(a.Reference); err == nil {
		t.Fatal("sliding expiry")
	}
	if list, err := s.List(20); err != nil || len(list) != 0 {
		t.Fatal("expired list")
	}
	if _, err := os.Stat(a.Path); err != nil {
		t.Fatal("TTL deletes files")
	}
	if _, err := s.Save("image/png", base64.StdEncoding.EncodeToString([]byte("one"))); err == nil {
		t.Fatal("expired dedupe renewal")
	}
	s.bytes = assetMaxBytes
	if _, err := s.Save("image/png", base64.StdEncoding.EncodeToString([]byte("two"))); err == nil {
		t.Fatal("byte capacity")
	}
	s.bytes = 3
	for i := 0; i < assetMaxEntries; i++ {
		s.entries[string(rune(i))] = storedImageAsset{}
	}
	if _, err := s.Save("image/png", base64.StdEncoding.EncodeToString([]byte("two"))); err == nil {
		t.Fatal("entry capacity")
	}
}

func TestAssetTamperReplacementSymlinkAndNoOverwrite(t *testing.T) {
	for _, kind := range []string{"content", "size", "replace", "symlink"} {
		t.Run(kind, func(t *testing.T) {
			s := newTestAssets(t)
			a, err := s.Save("image/png", base64.StdEncoding.EncodeToString([]byte("original")))
			if err != nil {
				t.Fatal(err)
			}
			switch kind {
			case "content":
				err = os.WriteFile(a.Path, []byte("tampered"), 0600)
			case "size":
				err = os.WriteFile(a.Path, []byte("short"), 0600)
			case "replace":
				err = os.Rename(a.Path, a.Path+".original")
				if err == nil {
					err = os.WriteFile(a.Path, []byte("original"), 0600)
				}
			case "symlink":
				target := filepath.Join(t.TempDir(), "unrelated.png")
				os.WriteFile(target, []byte("original"), 0600)
				err = os.Rename(a.Path, a.Path+".original")
				if err == nil {
					err = os.Symlink(target, a.Path)
				}
				if err != nil {
					t.Skip("OS symlink creation unavailable")
				}
			}
			if err != nil {
				t.Fatal(err)
			}
			if _, err := s.Get(a.ID); err == nil {
				t.Fatal("tampered metadata")
			}
			if _, err := s.Resolve(a.Reference); err == nil {
				t.Fatal("tampered reuse")
			}
			if _, err := s.List(20); err == nil {
				t.Fatal("tampered listing")
			}
			if _, err := s.Save("image/png", base64.StdEncoding.EncodeToString([]byte("original"))); err == nil {
				t.Fatal("overwrite tamper")
			}
		})
	}
}
