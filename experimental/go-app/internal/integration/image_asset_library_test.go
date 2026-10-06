package integration

import (
	"encoding/base64"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestAssetLibraryReopenOriginalIDBytesDedupeAndAbsoluteTTL(t *testing.T) {
	directory := filepath.Join(t.TempDir(), "library")
	s, err := OpenImageAssetLibrary(directory, testAssetValidator)
	if err != nil {
		t.Fatal(err)
	}
	b64 := base64.StdEncoding.EncodeToString([]byte("owned-content"))
	a, err := s.Save("image/png", b64)
	if err != nil {
		t.Fatal(err)
	}
	if s.Scope() != "explicit-local-library" {
		t.Fatal("scope")
	}
	s.Close()
	if _, err := NewImageAssetStore(directory, testAssetValidator); err == nil {
		t.Fatal("session imported library")
	}
	// An unrelated file isn't enumerated/read/deleted or mistaken for an asset.
	extra := filepath.Join(directory, "unrelated.txt")
	os.WriteFile(extra, []byte("leave untouched"), 0600)
	s, err = OpenImageAssetLibrary(directory, testAssetValidator)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	recovered, err := s.Get(a.ID)
	if err != nil || recovered.ID != a.ID || recovered.Path != a.Path || !recovered.Created.Equal(a.Created) {
		t.Fatal("reopen metadata", err)
	}
	ref, err := s.Resolve(a.Reference)
	if err != nil || ref != "data:image/png;base64,"+b64 {
		t.Fatal("reopen bytes")
	}
	before, _ := os.ReadFile(filepath.Join(directory, "library.journal"))
	duplicate, err := s.Save("image/png", b64)
	after, _ := os.ReadFile(filepath.Join(directory, "library.journal"))
	if err != nil || duplicate.ID != a.ID || string(before) != string(after) || s.bytes != a.Bytes || s.slots != 1 {
		t.Fatal("reopen dedupe")
	}
	if data, _ := os.ReadFile(extra); string(data) != "leave untouched" {
		t.Fatal("unrelated changed")
	}
	s.now = func() time.Time { return a.Created.Add(assetTTL) }
	if _, err := s.Get(a.ID); err == nil {
		t.Fatal("TTL renewed")
	}
	if list, err := s.List(20); err != nil || len(list) != 0 {
		t.Fatal("expired list")
	}
	s.Close()
	s, err = OpenImageAssetLibrary(directory, testAssetValidator)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	s.now = func() time.Time { return a.Created.Add(assetTTL) }
	if _, err := s.Resolve(a.Reference); err == nil {
		t.Fatal("restart renewed TTL")
	}
	if _, err := os.Stat(a.Path); err != nil {
		t.Fatal("expiry deleted file")
	}
}

func TestAssetLibraryRejectsUnmarkedCorruptAndLinkedControlFiles(t *testing.T) {
	for _, kind := range []string{"unmarked", "marker", "journal-truncated", "journal-duplicate", "journal-unknown", "journal-traversal", "journal-commit-first", "journal-overlimit", "image-tamper", "image-symlink", "marker-symlink", "journal-symlink", "lock-symlink"} {
		t.Run(kind, func(t *testing.T) {
			parent := t.TempDir()
			directory := filepath.Join(parent, "library")
			s, err := OpenImageAssetLibrary(directory, testAssetValidator)
			if err != nil {
				t.Fatal(err)
			}
			a, err := s.Save("image/png", base64.StdEncoding.EncodeToString([]byte("content")))
			if err != nil {
				t.Fatal(err)
			}
			s.Close()
			marker := filepath.Join(directory, "library.marker")
			journal := filepath.Join(directory, "library.journal")
			switch kind {
			case "unmarked":
				err = os.Rename(marker, marker+".kept")
			case "marker":
				err = os.WriteFile(marker, []byte("other-library\n"), 0600)
			case "journal-truncated":
				raw, _ := os.ReadFile(journal)
				err = os.WriteFile(journal, raw[:len(raw)-1], 0600)
			case "journal-duplicate":
				err = os.WriteFile(journal, []byte(`{"kind":"reserve","kind":"commit","id":"`+a.ID+`"}`+"\n"), 0600)
			case "journal-unknown":
				err = os.WriteFile(journal, []byte(`{"kind":"commit","id":"`+a.ID+`","path":"secret"}`+"\n"), 0600)
			case "journal-traversal":
				err = os.WriteFile(journal, []byte(`{"kind":"commit","id":"../../secret"}`+"\n"), 0600)
			case "journal-commit-first":
				err = os.WriteFile(journal, []byte(`{"kind":"commit","id":"`+a.ID+`"}`+"\n"), 0600)
			case "journal-overlimit":
				err = os.WriteFile(journal, []byte(strings.Repeat(" ", assetJournalLimit+1)), 0600)
			case "image-tamper":
				err = os.WriteFile(a.Path, []byte("changed"), 0600)
			default:
				target := a.Path
				if kind != "image-symlink" {
					target = filepath.Join(directory, strings.TrimSuffix(kind, "-symlink")+".invalid")
					if kind == "marker-symlink" {
						target = marker
					}
					if kind == "journal-symlink" {
						target = journal
					}
					if kind == "lock-symlink" {
						target = filepath.Join(directory, "library.lock")
					}
				}
				original, readErr := os.ReadFile(target)
				if readErr != nil {
					t.Fatal(readErr)
				}
				outside := filepath.Join(parent, "outside")
				os.WriteFile(outside, original, 0600)
				err = os.Rename(target, target+".kept")
				if err == nil {
					err = os.Symlink(outside, target)
				}
				if err != nil {
					t.Skip("OS symlink creation unavailable")
				}
			}
			if err != nil {
				t.Fatal(err)
			}
			reopened, err := OpenImageAssetLibrary(directory, testAssetValidator)
			if kind == "image-tamper" && err == nil {
				defer reopened.Close()
				if _, e := reopened.Get(a.ID); e == nil {
					t.Fatal("tamper accepted")
				}
				if _, e := reopened.Resolve(a.Reference); e == nil {
					t.Fatal("tamper reused")
				}
				return
			}
			if err == nil {
				reopened.Close()
				t.Fatal("invalid library accepted", kind)
			}
		})
	}
}

func TestAssetLibraryUncommittedReservationsStayChargedAndInvisible(t *testing.T) {
	directory := filepath.Join(t.TempDir(), "library")
	s, err := OpenImageAssetLibrary(directory, testAssetValidator)
	if err != nil {
		t.Fatal(err)
	}
	id := "img_" + strings.Repeat("0", 64)
	if s.library.append(assetJournalRecord{Kind: "reserve", ID: id, MIME: "image/png", Bytes: 16 << 20, Created: time.Now().UTC()}) != nil {
		t.Fatal("reserve")
	}
	s.Close()
	s, err = OpenImageAssetLibrary(directory, testAssetValidator)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if s.slots != 1 || s.bytes != 16<<20 || len(s.entries) != 0 {
		t.Fatal("lost failed-write reservation")
	}
	if _, err := s.Get(id); err == nil {
		t.Fatal("uncommitted visible")
	}
	if s.library.append(assetJournalRecord{Kind: "reserve", ID: id, MIME: "image/png", Bytes: 1, Created: time.Now()}) == nil {
		t.Fatal("duplicate reservation")
	}
}

// New test subprocesses only use generated temp roots, never account profiles.
func TestAssetLibraryProcessHelper(t *testing.T) {
	directory := os.Getenv("MOMO_SYNTHETIC_LIBRARY_TEST_DIR")
	mode := os.Getenv("MOMO_SYNTHETIC_LIBRARY_TEST_MODE")
	if directory == "" {
		return
	}
	s, err := OpenImageAssetLibrary(directory, testAssetValidator)
	if mode == "locked" {
		if err != nil {
			os.Exit(0)
		}
		s.Close()
		os.Exit(2)
	}
	if err != nil {
		os.Exit(3)
	}
	if _, err := s.Save("image/png", base64.StdEncoding.EncodeToString([]byte("process-content"))); err != nil {
		os.Exit(4)
	}
	os.Exit(0) // intentionally no Close: OS process exit must release lock
}

func TestAssetLibraryCommitFailureInvisibleAndCapacityPersists(t *testing.T) {
	directory := filepath.Join(t.TempDir(), "library")
	s, err := OpenImageAssetLibrary(directory, testAssetValidator)
	if err != nil {
		t.Fatal(err)
	}
	// Force a commit I/O failure after a fully written image. A complete file
	// without durable commit must stay invisible; no retry or orphan import.
	id := "img_" + strings.Repeat("1", 64)
	r := assetJournalRecord{Kind: "reserve", ID: id, MIME: "image/png", Bytes: 3, Created: time.Now().UTC()}
	if s.library.append(r) != nil {
		t.Fatal("reserve")
	}
	os.WriteFile(filepath.Join(directory, id+".png"), []byte("one"), 0600)
	s.library.journal.Close()
	if s.library.append(assetJournalRecord{Kind: "commit", ID: id}) == nil {
		t.Fatal("failed journal accepted")
	}
	s.Close()
	s, err = OpenImageAssetLibrary(directory, testAssetValidator)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if len(s.entries) != 0 || s.slots != 1 || s.bytes != 3 {
		t.Fatal("uncommitted full image imported")
	}
	for i := 1; i < assetMaxEntries; i++ {
		next := strings.Repeat("0", 62) + string("0123456789abcdef"[i/16]) + string("0123456789abcdef"[i%16])
		if s.library.append(assetJournalRecord{Kind: "reserve", ID: "img_" + next, MIME: "image/png", Bytes: 1, Created: time.Now().UTC()}) != nil {
			t.Fatal("reservation")
		}
	}
	s.Close()
	s, err = OpenImageAssetLibrary(directory, testAssetValidator)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if s.slots != assetMaxEntries || s.bytes != 130 {
		t.Fatal("restart lost capacity")
	}
	if _, err := s.Save("image/png", base64.StdEncoding.EncodeToString([]byte("new"))); err == nil {
		t.Fatal("restart bypassed capacity")
	}
}
func TestAssetLibraryCrossProcessLockAndAbruptExitRecovery(t *testing.T) {
	directory := filepath.Join(t.TempDir(), "library")
	s, err := OpenImageAssetLibrary(directory, testAssetValidator)
	if err != nil {
		t.Fatal(err)
	}
	command := func(mode string) *exec.Cmd {
		c := exec.Command(os.Args[0], "-test.run=^TestAssetLibraryProcessHelper$")
		c.Env = append(os.Environ(), "MOMO_SYNTHETIC_LIBRARY_TEST_DIR="+directory, "MOMO_SYNTHETIC_LIBRARY_TEST_MODE="+mode)
		return c
	}
	if err := command("locked").Run(); err != nil {
		s.Close()
		t.Fatal("second process wasn't rejected", err)
	}
	s.Close()
	if err := command("write-exit").Run(); err != nil {
		t.Fatal("helper write", err)
	}
	s, err = OpenImageAssetLibrary(directory, testAssetValidator)
	if err != nil {
		t.Fatal("process lock wasn't released", err)
	}
	defer s.Close()
	list, err := s.List(20)
	if err != nil || len(list) != 1 {
		t.Fatal("abrupt process exit lost committed asset", err)
	}
}
