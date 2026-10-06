package integration

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"path/filepath"
)

var errRouteFile = errors.New("Codex route file unavailable or changed; no automatic retry (private backup/temp may remain)")

func openCodexRoot(path string) (*os.Root, error) {
	if validateCodexRoutePath(path) != nil {
		return nil, errRouteFile
	}
	// Refuse symlink/reparse ancestors. os.Root also confines subsequent fixed
	// names; same-account concurrent directory replacement is not a sandbox.
	for dir := filepath.Dir(path); ; dir = filepath.Dir(dir) {
		info, err := os.Lstat(dir)
		if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return nil, errRouteFile
		}
		if parent := filepath.Dir(dir); parent == dir {
			break
		}
	}
	root, err := os.OpenRoot(filepath.Dir(path))
	if err != nil {
		return nil, errRouteFile
	}
	return root, nil
}

func readCodexConfig(root *os.Root) ([]byte, os.FileInfo, error) {
	before, err := root.Lstat("config.toml")
	if err != nil || !before.Mode().IsRegular() || before.Size() > codexConfigLimit {
		return nil, nil, errRouteFile
	}
	f, err := root.Open("config.toml")
	if err != nil {
		return nil, nil, errRouteFile
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() || !os.SameFile(before, info) {
		return nil, nil, errRouteFile
	}
	data, err := io.ReadAll(io.LimitReader(f, codexConfigLimit+1))
	if err != nil || len(data) > codexConfigLimit {
		return nil, nil, errRouteFile
	}
	return data, info, nil
}

func PreviewCodexRouteFile(path string, options CodexRouteOptions) (CodexRoutePreview, error) {
	root, err := openCodexRoot(path)
	if err != nil {
		return CodexRoutePreview{}, err
	}
	defer root.Close()
	data, _, err := readCodexConfig(root)
	if err != nil {
		return CodexRoutePreview{}, err
	}
	preview, _, err := PlanCodexRoute(data, options)
	return preview, err
}

func writePrivateRouteFile(root *os.Root, name string, data []byte) error {
	f, err := root.OpenFile(name, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return errRouteFile
	}
	defer f.Close()
	if secureRouteFile(f) != nil {
		return errRouteFile
	}
	n, err := f.Write(data)
	if err != nil || n != len(data) || f.Sync() != nil || f.Close() != nil {
		return errRouteFile
	}
	return nil
}

// Explicit revision-bound apply. No auth.json/settings/profile/history reads.
// Both old bytes and replacement are privately saved before same-dir rename.
// Backup is local only; neither content nor its name is returned to clients.
func ApplyCodexRouteFile(path string, options CodexRouteOptions, revision string) (CodexRoutePreview, error) {
	root, err := openCodexRoot(path)
	if err != nil {
		return CodexRoutePreview{}, err
	}
	defer root.Close()
	lockInfo, statErr := root.Lstat(".momo-codex-route.lock")
	if statErr == nil && !lockInfo.Mode().IsRegular() || statErr != nil && !os.IsNotExist(statErr) {
		return CodexRoutePreview{}, errRouteFile
	}
	lock, err := root.OpenFile(".momo-codex-route.lock", os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return CodexRoutePreview{}, errRouteFile
	}
	defer lock.Close()
	actual, err := lock.Stat()
	if err != nil || !actual.Mode().IsRegular() || statErr == nil && !os.SameFile(lockInfo, actual) || lockAssetLibrary(lock) != nil {
		return CodexRoutePreview{}, errRouteFile
	}
	data, identity, err := readCodexConfig(root)
	if err != nil {
		return CodexRoutePreview{}, err
	}
	preview, next, err := PlanCodexRoute(data, options)
	if err != nil {
		return CodexRoutePreview{}, err
	}
	if revision == "" || revision != preview.Revision {
		return CodexRoutePreview{}, errRouteFile
	}
	if !preview.Changed {
		return preview, nil
	}
	var random [16]byte
	if _, err := rand.Read(random[:]); err != nil {
		return CodexRoutePreview{}, errRouteFile
	}
	suffix := hex.EncodeToString(random[:])
	if writePrivateRouteFile(root, "config.toml.momo-"+suffix+".bak", data) != nil {
		return CodexRoutePreview{}, errRouteFile
	}
	temp := ".momo-config-" + suffix + ".tmp"
	if writePrivateRouteFile(root, temp, next) != nil {
		return CodexRoutePreview{}, errRouteFile
	}
	now, info, err := readCodexConfig(root)
	if err != nil || !os.SameFile(identity, info) || !bytes.Equal(now, data) {
		return CodexRoutePreview{}, errRouteFile
	}
	// Cooperative writer lock + last identity/content check. No claim to stop an
	// unrelated same-user editor racing the final rename, or power-loss durability.
	if root.Rename(temp, "config.toml") != nil {
		return CodexRoutePreview{}, errRouteFile
	}
	return preview, nil
}
