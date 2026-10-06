// Package vault stores only an explicitly submitted profile in the OS keyring.
// No plaintext fallback, files, environment discovery or credential enumeration.
package vault

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"strings"

	"github.com/momo-api/momoapi-proxy/experimental/go-app/internal/appcore"
	"github.com/zalando/go-keyring"
)

const service = "us.momoapi.go.preview.profile.v1"
const account = "explicit-user-profile"
const maxRecord = 2400 // portable Windows credential blob/macOS stdin limit
var ErrUnavailable = errors.New("system credential store unavailable")
var ErrMissing = errors.New("no saved profile")

type Backend interface {
	Set(service, account, value string) error
	Get(service, account string) (string, error)
	Delete(service, account string) error
}
type systemBackend struct{}

func (systemBackend) Set(s, a, v string) error        { return keyring.Set(s, a, v) }
func (systemBackend) Get(s, a string) (string, error) { return keyring.Get(s, a) }
func (systemBackend) Delete(s, a string) error        { return keyring.Delete(s, a) }

type Store struct{ backend Backend }

func System() *Store { return &Store{systemBackend{}} }

// New is dependency injection for synthetic tests, not a runtime configuration.
func New(b Backend) *Store { return &Store{b} }

func (s *Store) Save(c appcore.Config) error {
	if appcore.ValidateConfig(c) != nil || len(c.Endpoint) > 256 {
		return errors.New("invalid portable saved profile")
	}
	data, err := json.Marshal(c)
	if err != nil || len(data) > maxRecord {
		return errors.New("profile too large for portable secure storage")
	}
	if s.backend.Set(service, account, string(data)) != nil {
		return ErrUnavailable
	}
	return nil
}
func (s *Store) Load() (appcore.Config, error) {
	var c appcore.Config
	value, err := s.backend.Get(service, account)
	if errors.Is(err, keyring.ErrNotFound) {
		return c, ErrMissing
	}
	if err != nil {
		return c, ErrUnavailable
	}
	if len(value) > maxRecord {
		return c, ErrUnavailable
	}
	d := json.NewDecoder(bytes.NewBufferString(value))
	d.DisallowUnknownFields()
	if d.Decode(&c) != nil {
		return appcore.Config{}, ErrUnavailable
	}
	var extra any
	if d.Decode(&extra) != io.EOF || appcore.ValidateConfig(c) != nil || len(c.Endpoint) > 256 {
		return appcore.Config{}, ErrUnavailable
	}
	c.Endpoint = strings.TrimSuffix(c.Endpoint, "/")
	return c, nil
}
func (s *Store) Forget() error {
	err := s.backend.Delete(service, account)
	if err != nil && !errors.Is(err, keyring.ErrNotFound) {
		return ErrUnavailable
	}
	return nil
}
