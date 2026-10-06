package integration

import (
	"bytes"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const assetLibraryMarker = "momo-go-image-library-v1\n"
const assetJournalLimit = 128 << 10

type assetJournalRecord struct {
	Kind    string    `json:"kind"`
	ID      string    `json:"id"`
	MIME    string    `json:"mime,omitempty"`
	Bytes   int       `json:"bytes,omitempty"`
	Created time.Time `json:"created,omitempty"`
}
type assetLibrary struct {
	lock, journal *os.File
	journalBytes  int
	failed        bool
	reserved      map[string]bool
}

func (l *assetLibrary) close() { l.journal.Close(); l.lock.Close() }

// Append-only reserve/commit protocol: Sync reserve BEFORE file creation and
// Sync commit AFTER complete image Sync+Close. Torn/invalid journal rejects the
// entire reopen (no truncation/repair/deletion/import). Reservations without a
// commit remain charged but invisible. Same-account mutation is not a sandbox.
func (l *assetLibrary) append(record assetJournalRecord) error {
	if l.failed {
		return errAsset
	}
	if record.Kind == "reserve" && l.reserved[record.ID] {
		return errAsset
	}
	raw, err := json.Marshal(record)
	raw = append(raw, '\n')
	if err != nil || l.journalBytes+len(raw) > assetJournalLimit {
		l.failed = true
		return errAsset
	}
	n, err := l.journal.Write(raw)
	if err != nil || n != len(raw) || l.journal.Sync() != nil {
		l.failed = true
		return errAsset
	}
	l.journalBytes += len(raw)
	if record.Kind == "reserve" {
		l.reserved[record.ID] = true
	}
	return nil
}

// Explicitly creates a NEW library or reopens ONLY this format's marked root.
// Reads fixed control filenames and journal-listed generated image names only,
// never enumerates a directory, reads paths from metadata, or imports old stores.
// Lifetime single-writer OS lock fails immediately; no stale-lock deletion.
func OpenImageAssetLibrary(directory string, validate ImageAssetValidator) (*ImageAssetStore, error) {
	if validate == nil || !filepath.IsAbs(directory) || !localAssetDirectory(directory) || strings.ContainsAny(directory, "\x00\r\n") {
		return nil, errAsset
	}
	directory = filepath.Clean(directory)
	info, err := os.Lstat(directory)
	fresh := os.IsNotExist(err)
	var s *ImageAssetStore
	if fresh {
		s, err = NewImageAssetStore(directory, validate)
	} else {
		if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return nil, errAsset
		}
		canonical, e := filepath.EvalSymlinks(directory)
		if e != nil || !localAssetDirectory(canonical) {
			return nil, errAsset
		}
		root, e := os.OpenRoot(canonical)
		if e != nil {
			return nil, errAsset
		}
		s = &ImageAssetStore{root: root, directory: canonical, validate: validate, entries: map[string]storedImageAsset{}, now: time.Now}
	}
	if err != nil {
		return nil, errAsset
	}
	ok := false
	defer func() {
		if !ok {
			s.Close()
		}
	}()
	if !fresh && verifyAssetMarker(s.root) != nil {
		return nil, errAsset
	}
	if fresh {
		if writeAssetControl(s.root, "library.lock", nil) != nil {
			return nil, errAsset
		}
	}
	lock, err := openAssetControl(s.root, "library.lock", os.O_RDWR, 1)
	if err != nil {
		return nil, errAsset
	}
	if lockAssetLibrary(lock) != nil {
		lock.Close()
		return nil, errAsset
	}
	installed := false
	defer func() {
		if !installed {
			lock.Close()
		}
	}()
	if fresh {
		if writeAssetControl(s.root, "library.marker", []byte(assetLibraryMarker)) != nil || writeAssetControl(s.root, "library.journal", nil) != nil {
			return nil, errAsset
		}
	}
	if verifyAssetMarker(s.root) != nil {
		return nil, errAsset
	}
	journal, err := openAssetControl(s.root, "library.journal", os.O_RDWR|os.O_APPEND, assetJournalLimit)
	if err != nil {
		return nil, errAsset
	}
	raw, err := io.ReadAll(io.LimitReader(journal, assetJournalLimit+1))
	l := &assetLibrary{lock: lock, journal: journal, journalBytes: len(raw), reserved: map[string]bool{}}
	s.library = l
	installed = true
	if err != nil || len(raw) > assetJournalLimit || s.restoreAssetJournal(raw) != nil {
		return nil, errAsset
	}
	ok = true
	return s, nil
}

func verifyAssetMarker(root *os.Root) error {
	f, err := openAssetControl(root, "library.marker", os.O_RDONLY, int64(len(assetLibraryMarker)))
	if err != nil {
		return errAsset
	}
	raw, err := io.ReadAll(io.LimitReader(f, int64(len(assetLibraryMarker))+1))
	f.Close()
	if err != nil || string(raw) != assetLibraryMarker {
		return errAsset
	}
	return nil
}

func writeAssetControl(root *os.Root, name string, data []byte) error {
	f, err := root.OpenFile(name, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return errAsset
	}
	n, werr := f.Write(data)
	serr := f.Sync()
	cerr := f.Close()
	if werr != nil || n != len(data) || serr != nil || cerr != nil {
		return errAsset
	}
	return nil
}
func openAssetControl(root *os.Root, name string, flags int, max int64) (*os.File, error) {
	info, err := root.Lstat(name)
	if err != nil || !info.Mode().IsRegular() || info.Size() > max {
		return nil, errAsset
	}
	f, err := root.OpenFile(name, flags, 0)
	if err != nil {
		return nil, errAsset
	}
	opened, err := f.Stat()
	if err != nil || !opened.Mode().IsRegular() || !os.SameFile(info, opened) || opened.Size() > max {
		f.Close()
		return nil, errAsset
	}
	return f, nil
}
func (s *ImageAssetStore) restoreAssetJournal(raw []byte) error {
	if len(raw) == 0 {
		return nil
	}
	if raw[len(raw)-1] != '\n' {
		return errAsset
	}
	records := bytes.Split(raw[:len(raw)-1], []byte{'\n'})
	if len(records) > assetMaxEntries*2 {
		return errAsset
	}
	reserved := map[string]assetJournalRecord{}
	committed := map[string]bool{}
	for _, line := range records {
		if len(line) > 2048 || !strictMCPJSON(line) {
			return errAsset
		}
		var r assetJournalRecord
		d := json.NewDecoder(bytes.NewReader(line))
		d.DisallowUnknownFields()
		if d.Decode(&r) != nil || !validAssetID(r.ID) {
			return errAsset
		}
		switch r.Kind {
		case "reserve":
			if _, exists := reserved[r.ID]; exists || assetExtension(r.MIME) == "" || r.Bytes < 1 || r.Bytes > 16<<20 || r.Created.IsZero() || r.Created.After(s.now().Add(time.Minute)) {
				return errAsset
			}
			reserved[r.ID] = r
			s.library.reserved[r.ID] = true
			s.slots++
			s.bytes += r.Bytes
			if s.slots > assetMaxEntries || s.bytes > assetMaxBytes {
				return errAsset
			}
		case "commit":
			if _, exists := reserved[r.ID]; !exists || committed[r.ID] || r.MIME != "" || r.Bytes != 0 || !r.Created.IsZero() {
				return errAsset
			}
			committed[r.ID] = true
		default:
			return errAsset
		}
	}
	for id := range committed {
		r := reserved[id]
		name := id + assetExtension(r.MIME)
		info, err := s.root.Lstat(name)
		if err != nil || !info.Mode().IsRegular() || info.Size() != int64(r.Bytes) {
			return errAsset
		}
		meta := ImageAsset{ID: id, Reference: "asset:" + id, Path: filepath.Join(s.directory, name), MIME: r.MIME, Bytes: r.Bytes, SHA256: id[4:], Created: r.Created, Accessed: r.Created}
		entry := storedImageAsset{meta: meta, name: name, file: info}
		// Expired committed records still consume capacity; defer content reading
		// until a live metadata/reuse query. No TTL reset at startup.
		s.entries[id] = entry
	}
	return nil
}
