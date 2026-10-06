package main

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestSelectedImageExactBytesNoOverwriteOrPathReflection(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "synthetic.png")
	data := []byte("synthetic trusted validator output")
	if writeSelectedImage(context.Background(), path, "image/png", data) != nil {
		t.Fatal("new file")
	}
	got, err := os.ReadFile(path)
	if err != nil || string(got) != string(data) {
		t.Fatal("saved bytes")
	}
	if writeSelectedImage(context.Background(), path, "image/png", []byte("replacement")) == nil {
		t.Fatal("overwritten")
	}
	got, _ = os.ReadFile(path)
	if string(got) != string(data) {
		t.Fatal("existing changed")
	}
	for _, p := range []string{filepath.Join(dir, "secret.env"), "relative.png", filepath.Join(dir, "a.png:stream.png"), filepath.Join(dir, "bad\n.png")} {
		if writeSelectedImage(context.Background(), p, "image/png", data) == nil {
			t.Fatal("invalid selection")
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	if runtime.GOOS == "windows" {
		for _, name := range []string{"CON.png", "nul.png", "COM1.png", "LPT².png", "CONIN$.png"} {
			if writeSelectedImage(context.Background(), filepath.Join(dir, name), "image/png", data) == nil {
				t.Fatal("Windows device destination")
			}
		}
		for _, p := range []string{`\\server\share\image.png`, `\\?\C:\image.png`, `\\.\NUL.png`} {
			if writeSelectedImage(context.Background(), p, "image/png", data) == nil {
				t.Fatal("remote/device namespace")
			}
		}
	}
	cancel()
	cancelled := filepath.Join(dir, "cancelled.png")
	if writeSelectedImage(ctx, cancelled, "image/png", data) == nil {
		t.Fatal("cancelled write")
	}
	if _, err := os.Stat(cancelled); !os.IsNotExist(err) {
		t.Fatal("created after cancellation")
	}
	jpeg := filepath.Join(dir, "synthetic.jpeg")
	if writeSelectedImage(context.Background(), jpeg, "image/jpeg", data) != nil {
		t.Fatal("JPEG extension")
	}
	link := filepath.Join(dir, "link.png")
	if os.Symlink(path, link) == nil && writeSelectedImage(context.Background(), link, "image/png", data) == nil {
		t.Fatal("final symlink overwritten")
	}
}
