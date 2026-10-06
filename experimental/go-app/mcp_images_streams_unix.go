//go:build (linux || darwin) && !appcheck && !routecheck

package main

import (
	"errors"
	"os"
	"time"

	"golang.org/x/sys/unix"
)

// Inherited os.Stdin/Stdout are blocking kindNewFile descriptors on Unix.
// Close cannot interrupt an already blocked syscall.Read/Write. Own duplicated
// nonblocking descriptors registered with Go's poller BEFORE any operation.
// This mode requires pipes/sockets, not terminal/files. No polling goroutines,
// leaked blocked reads, detached execution or signal-driven os.Exit.
func imageMCPStreams() (*os.File, *os.File, error) {
	input, err := pollableMCPStream(os.Stdin, true)
	if err != nil {
		return nil, nil, err
	}
	output, err := pollableMCPStream(os.Stdout, false)
	if err != nil {
		input.Close()
		return nil, nil, err
	}
	return input, output, nil
}

func pollableMCPStream(source *os.File, read bool) (*os.File, error) {
	fail := errors.New("image MCP requires cancellable private stdio pipes")
	info, err := source.Stat()
	if err != nil || info.Mode()&(os.ModeNamedPipe|os.ModeSocket) == 0 {
		return nil, fail
	}
	fd, err := unix.FcntlInt(source.Fd(), unix.F_DUPFD_CLOEXEC, 0)
	if err != nil {
		return nil, fail
	}
	if unix.SetNonblock(fd, true) != nil {
		unix.Close(fd)
		return nil, fail
	}
	file := os.NewFile(uintptr(fd), "momo-private-stdio")
	if file == nil {
		unix.Close(fd)
		return nil, fail
	}
	if read {
		err = file.SetReadDeadline(time.Time{})
	} else {
		err = file.SetWriteDeadline(time.Time{})
	}
	if err != nil {
		file.Close()
		return nil, fail
	}
	return file, nil
}
