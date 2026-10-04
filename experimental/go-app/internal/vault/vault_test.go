package vault

import (
	"errors"
	"github.com/momo-api/momoapi-proxy/experimental/go-app/internal/appcore"
	"github.com/zalando/go-keyring"
	"strings"
	"testing"
)

type memoryBackend struct {
	value string
	fail  bool
	calls int
}

func (m *memoryBackend) Set(s, a, v string) error {
	m.calls++
	if s != service || a != account {
		panic("scope")
	}
	if m.fail {
		return errors.New("synthetic backend secret")
	}
	m.value = v
	return nil
}
func (m *memoryBackend) Get(s, a string) (string, error) {
	m.calls++
	if m.fail {
		return "", errors.New("synthetic backend secret")
	}
	if m.value == "" {
		return "", keyring.ErrNotFound
	}
	return m.value, nil
}
func (m *memoryBackend) Delete(s, a string) error {
	m.calls++
	if m.fail {
		return errors.New("synthetic backend secret")
	}
	m.value = ""
	return nil
}
func TestExplicitStoreRoundtripAndBounds(t *testing.T) {
	m := &memoryBackend{}
	v := New(m)
	if m.calls != 0 {
		t.Fatal("construction read credentials")
	}
	c := appcore.Config{Endpoint: "https://mock.example/", APIKey: "synthetic-key-only"}
	if v.Save(c) != nil {
		t.Fatal("save")
	}
	loaded, err := v.Load()
	if err != nil || loaded.Endpoint != "https://mock.example" || loaded.APIKey != c.APIKey {
		t.Fatal("roundtrip")
	}
	before := m.value
	for _, bad := range []appcore.Config{{Endpoint: "http://127.0.0.1", APIKey: "synthetic"}, {Endpoint: "https://mock.example", APIKey: strings.Repeat("x", 3000)}} {
		if v.Save(bad) == nil || m.value != before {
			t.Fatal("invalid profile overwrote saved")
		}
	}
	if v.Forget() != nil || v.Forget() != nil {
		t.Fatal("forget")
	}
	if _, err := v.Load(); !errors.Is(err, ErrMissing) {
		t.Fatal("missing")
	}
	for _, bad := range []string{"null", "{}", `{"Endpoint":"https://mock.example","APIKey":"synthetic","unknown":true}`, `{"Endpoint":"http://localhost","APIKey":"synthetic"}`, strings.Repeat("x", maxRecord+1)} {
		m.value = bad
		if _, err := v.Load(); !errors.Is(err, ErrUnavailable) {
			t.Fatal("malformed accepted")
		}
	}
	m.fail = true
	if v.Save(c) != ErrUnavailable || v.Forget() != ErrUnavailable {
		t.Fatal("backend error leaked")
	}
	if _, err := v.Load(); err != ErrUnavailable {
		t.Fatal("backend error leaked")
	}
}
