package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/momo-api/momoapi-proxy/experimental/go-app/internal/appcore"
)

// path comes only from an explicit native dialog (tests use a temp directory).
// Refuse overwrite, including final symlinks, via O_EXCL. Parent directory/path
// redirection by the local OS/user is not a sandbox guarantee. Never log paths.
// No cleanup on failure: a partial file may remain, which the UI discloses.
func writeSelectedImage(ctx context.Context, path, mime string, data []byte) error {
	ext := appcore.LocalImageExtension(mime)
	if ext == "" || len(data) == 0 || len(data) > appcore.MaxResponse || !filepath.IsAbs(path) || strings.ContainsAny(path, "\x00\r\n") || strings.Contains(filepath.Base(path), ":") {
		return errors.New("invalid image save selection")
	}
	// No UNC/device/extended namespace or network share. A native dialog is not
	// authorization to contact a remote filesystem with ambient OS credentials.
	if runtime.GOOS == "windows" && (len(filepath.VolumeName(path)) != 2 || strings.Contains(path[2:], ":") || strings.ContainsAny(strings.TrimSuffix(filepath.Base(path), filepath.Ext(path)), "<>\"|?*")) {
		return errors.New("local image destination required")
	}
	if runtime.GOOS == "windows" {
		name := filepath.Base(path)
		stem, _, _ := strings.Cut(strings.ToUpper(name), ".")
		stem = strings.TrimRight(stem, " .")
		reserved := stem == "CON" || stem == "PRN" || stem == "AUX" || stem == "NUL" || stem == "CONIN$" || stem == "CONOUT$"
		if len(stem) == 4 && (strings.HasPrefix(stem, "COM") || strings.HasPrefix(stem, "LPT")) && stem[3] >= '1' && stem[3] <= '9' {
			reserved = true
		}
		if (strings.HasPrefix(stem, "COM") || strings.HasPrefix(stem, "LPT")) && strings.ContainsAny(strings.TrimPrefix(strings.TrimPrefix(stem, "COM"), "LPT"), "¹²³") {
			reserved = true
		}
		if reserved || strings.HasSuffix(name, " ") || strings.HasSuffix(name, ".") {
			return errors.New("local image destination required")
		}
	}
	got := strings.ToLower(filepath.Ext(path))
	if got != ext && !(mime == "image/jpeg" && got == ".jpeg") {
		return errors.New("image extension mismatch")
	}
	if err := ctx.Err(); err != nil {
		return errors.New("image save cancelled")
	}
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return errors.New("image destination unavailable")
	}
	defer f.Close()
	for len(data) > 0 {
		if ctx.Err() != nil {
			return errors.New("image save interrupted")
		}
		size := len(data)
		if size > 64<<10 {
			size = 64 << 10
		}
		n, err := f.Write(data[:size])
		if err != nil || n != size {
			return errors.New("image write failed")
		}
		data = data[size:]
	}
	if f.Sync() != nil {
		return errors.New("image sync failed")
	}
	if f.Close() != nil {
		return errors.New("image close failed")
	}
	return nil
}
