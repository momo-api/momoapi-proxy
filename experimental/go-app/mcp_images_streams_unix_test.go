//go:build (linux || darwin) && !appcheck && !routecheck

package main

import (
	"os"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

func TestImageMCPUnixPollerCloseInterruptsInheritedPipe(t *testing.T) {
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal("pipe")
	}
	defer r.Close()
	defer w.Close()
	// Simulate a freshly inherited blocking os.NewFile (not os.Pipe's poller).
	fd, err := unix.Dup(int(r.Fd()))
	if err != nil {
		t.Fatal("dup")
	}
	borrowed := os.NewFile(uintptr(fd), "synthetic-inherited")
	defer borrowed.Close()
	input, err := pollableMCPStream(borrowed, true)
	if err != nil {
		t.Fatal("pollable")
	}
	done := make(chan error, 1)
	go func() { var b [1]byte; _, err := input.Read(b[:]); done <- err }()
	select {
	case <-done:
		t.Fatal("read did not block")
	case <-time.After(20 * time.Millisecond):
	}
	if input.Close() != nil {
		t.Fatal("close")
	}
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("read success")
		}
	case <-time.After(time.Second):
		t.Fatal("blocked read survived Close")
	}
	file, err := os.CreateTemp(t.TempDir(), "regular")
	if err != nil {
		t.Fatal("temp")
	}
	defer file.Close()
	if stream, err := pollableMCPStream(file, true); err == nil {
		stream.Close()
		t.Fatal("regular file accepted")
	}
}
