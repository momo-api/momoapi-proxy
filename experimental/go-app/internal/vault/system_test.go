package vault

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"github.com/zalando/go-keyring"
	"os"
	"testing"
)

// Opt-in: touches only a uniquely named synthetic record created by this test.
// Never calls System().Load or enumerates existing credential records.
func TestSystemBackendSyntheticRoundtrip(t *testing.T) {
	if os.Getenv("MOMO_TEST_SYSTEM_VAULT") != "1" {
		t.Skip("explicit native credential-store test only")
	}
	var id [16]byte
	if _, err := rand.Read(id[:]); err != nil {
		t.Fatal("random scope")
	}
	service := "us.momoapi.go.preview.synthetic-test." + hex.EncodeToString(id[:])
	account := "synthetic-only"
	backend := systemBackend{}
	value := "synthetic-test-only-中文"
	if backend.Set(service, account, value) != nil {
		t.Fatal("native secure store write failed")
	}
	t.Cleanup(func() {
		if err := backend.Delete(service, account); err != nil && !errors.Is(err, keyring.ErrNotFound) {
			t.Error("synthetic record cleanup failed")
		}
	})
	got, err := backend.Get(service, account)
	if err != nil || got != value {
		t.Fatal("native secure store roundtrip failed")
	}
	if backend.Set(service, account, "synthetic-replacement") != nil {
		t.Fatal("native update failed")
	}
	got, err = backend.Get(service, account)
	if err != nil || got != "synthetic-replacement" {
		t.Fatal("native update roundtrip failed")
	}
	if backend.Delete(service, account) != nil {
		t.Fatal("native delete failed")
	}
	if _, err := backend.Get(service, account); !errors.Is(err, keyring.ErrNotFound) {
		t.Fatal("native record not removed")
	}
	t.Log("PASS synthetic OS credential store create/read/update/delete; no existing records accessed")
}
