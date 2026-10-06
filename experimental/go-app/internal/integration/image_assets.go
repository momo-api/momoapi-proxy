package integration

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"
)

const assetMaxEntries = 128
const assetMaxBytes = 64 << 20
const assetTTL = 24 * time.Hour

var errAsset = errors.New("local image asset unavailable; no automatic retry")

// The owner supplies the same bounded image validator used by native Save.
// Integration must not import appcore (appcore already imports integration).
type ImageAssetValidator func([]byte) (string, []byte, error)

type ImageAsset struct {
	ID        string    `json:"asset_id"`
	Reference string    `json:"reference"`
	Path      string    `json:"local_path"`
	MIME      string    `json:"mime_type"`
	Bytes     int       `json:"bytes"`
	SHA256    string    `json:"sha256"`
	Created   time.Time `json:"created_at"`
	Accessed  time.Time `json:"last_accessed_at"`
	Vision    bool      `json:"vision_available"`
}

type storedImageAsset struct {
	meta ImageAsset
	name string
	file os.FileInfo
}

// NewImageAssetStore is an explicit connector-owned SESSION store. A separate
// OpenImageAssetLibrary opt-in enables marked Go-library restart recovery, not
// Node sharing. Neither scans/imports/overwrites/automatically deletes files.
// Local paths are output only, never model-supplied input.
type ImageAssetStore struct {
	mu        sync.Mutex
	root      *os.Root
	directory string
	validate  ImageAssetValidator
	entries   map[string]storedImageAsset
	bytes     int
	slots     int
	now       func() time.Time
	library   *assetLibrary
}

func NewImageAssetStore(directory string, validate ImageAssetValidator) (*ImageAssetStore, error) {
	if validate == nil || !filepath.IsAbs(directory) || strings.ContainsAny(directory, "\x00\r\n") {
		return nil, errAsset
	}
	directory = filepath.Clean(directory)
	if !localAssetDirectory(directory) {
		return nil, errAsset
	}
	// Canonicalize only the explicitly chosen parent, never discover home/profile.
	parent, err := filepath.EvalSymlinks(filepath.Dir(directory))
	if err != nil {
		return nil, errAsset
	}
	directory = filepath.Join(parent, filepath.Base(directory))
	if !localAssetDirectory(directory) {
		return nil, errAsset
	}
	if os.Mkdir(directory, 0700) != nil {
		return nil, errAsset
	}
	root, err := os.OpenRoot(directory)
	if err != nil {
		return nil, errAsset
	}
	return &ImageAssetStore{root: root, directory: directory, validate: validate, entries: map[string]storedImageAsset{}, now: time.Now}, nil
}

func localAssetDirectory(path string) bool {
	if runtime.GOOS != "windows" {
		return true
	}
	// No UNC, extended device namespace, ADS, reserved or ambiguous Win paths.
	if len(filepath.VolumeName(path)) != 2 || strings.ContainsAny(path[2:], ":<>\"|?*") {
		return false
	}
	for _, part := range strings.FieldsFunc(path[2:], func(r rune) bool { return r == '/' || r == '\\' }) {
		stem, _, _ := strings.Cut(strings.ToUpper(part), ".")
		if strings.HasSuffix(part, " ") || strings.HasSuffix(part, ".") || stem == "CON" || stem == "PRN" || stem == "AUX" || stem == "NUL" || stem == "CONIN$" || stem == "CONOUT$" {
			return false
		}
		if (strings.HasPrefix(stem, "COM") || strings.HasPrefix(stem, "LPT")) && len([]rune(stem)) == 4 && strings.ContainsRune("123456789¹²³", []rune(stem)[3]) {
			return false
		}
	}
	return true
}

func (s *ImageAssetStore) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.root == nil {
		return nil
	}
	if s.library != nil {
		s.library.close()
		s.library = nil
	}
	err := s.root.Close()
	s.root = nil
	return err
}

func validAssetID(id string) bool {
	if len(id) != 68 || !strings.HasPrefix(id, "img_") {
		return false
	}
	for _, c := range id[4:] {
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return false
		}
	}
	return true
}

func assetExtension(mime string) string {
	switch mime {
	case "image/png":
		return ".png"
	case "image/jpeg":
		return ".jpg"
	case "image/webp":
		return ".webp"
	}
	return ""
}

func (s *ImageAssetStore) Save(mime, b64 string) (ImageAsset, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.root == nil || len(b64) > 16<<20 || assetExtension(mime) == "" {
		return ImageAsset{}, errAsset
	}
	raw, _ := json.Marshal(map[string]any{"confirmed": true, "mime_type": mime, "b64_json": b64})
	actual, data, err := s.validate(raw)
	if err != nil || actual != mime || len(data) == 0 || len(data) > assetMaxBytes {
		return ImageAsset{}, errAsset
	}
	sum := sha256.Sum256(data)
	digest := hex.EncodeToString(sum[:])
	id := "img_" + digest
	if existing, ok := s.entries[id]; ok {
		_, meta, err := s.read(existing)
		return meta, err
	}
	if s.slots >= assetMaxEntries || len(s.entries) >= assetMaxEntries || s.bytes+len(data) > assetMaxBytes {
		return ImageAsset{}, errAsset
	}
	name := id + assetExtension(mime)
	now := s.now().UTC()
	meta := ImageAsset{ID: id, Reference: "asset:" + id, Path: filepath.Join(s.directory, name), MIME: mime, Bytes: len(data), SHA256: digest, Created: now, Accessed: now}
	if s.library != nil {
		if err := s.library.append(assetJournalRecord{Kind: "reserve", ID: id, MIME: mime, Bytes: len(data), Created: now}); err != nil {
			return ImageAsset{}, err
		}
		// Durable reservations charge failures across restarts as well.
		s.slots++
		s.bytes += len(data)
	}
	f, err := s.root.OpenFile(name, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return ImageAsset{}, errAsset
	}
	// Charge even failed/partial writes against capacity. No unbounded orphan
	// files if the disk fails repeatedly; never remove user-visible files.
	if s.library == nil {
		s.slots++
		s.bytes += len(data)
	}
	n, writeErr := f.Write(data)
	syncErr := f.Sync()
	info, statErr := f.Stat()
	closeErr := f.Close()
	// A partial file is deliberately not deleted or registered; caller sees an
	// error. Never retry generation or pretend disk failure undid upstream work.
	if writeErr != nil || n != len(data) || syncErr != nil || statErr != nil || closeErr != nil || !info.Mode().IsRegular() {
		if s.library != nil {
			s.library.failed = true
		}
		return ImageAsset{}, errAsset
	}
	if s.library != nil {
		if err := s.library.append(assetJournalRecord{Kind: "commit", ID: id}); err != nil {
			return ImageAsset{}, err
		}
	}
	s.entries[id] = storedImageAsset{meta: meta, name: name, file: info}
	return meta, nil
}

// Both metadata queries and edit reuse verify the original regular file,
// bounded bytes, digest and MIME. Never follow user supplied paths or symlinks.
// This is not a security boundary against processes controlling the same OS
// account/directory; os.Root anchors traversal but does not prevent hard links.
func (s *ImageAssetStore) read(entry storedImageAsset) ([]byte, ImageAsset, error) {
	if s.root == nil || s.now().Sub(entry.meta.Created) >= assetTTL {
		return nil, ImageAsset{}, errAsset
	}
	info, err := s.root.Lstat(entry.name)
	if err != nil || !info.Mode().IsRegular() || !os.SameFile(entry.file, info) || info.Size() != int64(entry.meta.Bytes) {
		return nil, ImageAsset{}, errAsset
	}
	f, err := s.root.Open(entry.name)
	if err != nil {
		return nil, ImageAsset{}, errAsset
	}
	defer f.Close()
	opened, err := f.Stat()
	if err != nil || !opened.Mode().IsRegular() || !os.SameFile(entry.file, opened) {
		return nil, ImageAsset{}, errAsset
	}
	data, err := io.ReadAll(io.LimitReader(f, int64(entry.meta.Bytes)+1))
	sum := sha256.Sum256(data)
	if err != nil || len(data) != entry.meta.Bytes || hex.EncodeToString(sum[:]) != entry.meta.SHA256 {
		return nil, ImageAsset{}, errAsset
	}
	raw, _ := json.Marshal(map[string]any{"confirmed": true, "mime_type": entry.meta.MIME, "b64_json": base64.StdEncoding.EncodeToString(data)})
	actual, _, err := s.validate(raw)
	if err != nil || actual != entry.meta.MIME {
		return nil, ImageAsset{}, errAsset
	}
	entry.meta.Accessed = s.now().UTC()
	s.entries[entry.meta.ID] = entry
	return data, entry.meta, nil
}

func (s *ImageAssetStore) Get(id string) (ImageAsset, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	entry, ok := s.entries[id]
	if !validAssetID(id) || !ok {
		return ImageAsset{}, errAsset
	}
	_, meta, err := s.read(entry)
	return meta, err
}

func (s *ImageAssetStore) List(limit int) ([]ImageAsset, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.root == nil || limit < 1 || limit > assetMaxEntries {
		return nil, errAsset
	}
	entries := make([]storedImageAsset, 0, len(s.entries))
	for _, e := range s.entries {
		entries = append(entries, e)
	}
	sort.Slice(entries, func(i, j int) bool {
		if entries[i].meta.Created.Equal(entries[j].meta.Created) {
			return entries[i].meta.ID < entries[j].meta.ID
		}
		return entries[i].meta.Created.After(entries[j].meta.Created)
	})
	result := []ImageAsset{}
	for _, entry := range entries {
		if s.now().Sub(entry.meta.Created) >= assetTTL {
			continue
		}
		_, meta, err := s.read(entry)
		if err != nil {
			return nil, err
		}
		result = append(result, meta)
		if len(result) == limit {
			break
		}
	}
	return result, nil
}

func (s *ImageAssetStore) Resolve(reference string) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !strings.HasPrefix(reference, "asset:") {
		return "", errAsset
	}
	id := strings.TrimPrefix(reference, "asset:")
	entry, ok := s.entries[id]
	if !validAssetID(id) || !ok {
		return "", errAsset
	}
	data, meta, err := s.read(entry)
	if err != nil {
		return "", err
	}
	return "data:" + meta.MIME + ";base64," + base64.StdEncoding.EncodeToString(data), nil
}

func (s *ImageAssetStore) Scope() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.library != nil {
		return "explicit-local-library"
	}
	return "connector-session"
}
