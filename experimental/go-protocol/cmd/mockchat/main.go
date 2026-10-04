// mockchat is test-only, restricted to loopback; never a daemon or real proxy.
package main

import (
	"context"
	"fmt"
	protocol "github.com/momo-api/momoapi-proxy/experimental/go-protocol"
	"io"
	"os"
)

func main() {
	if len(os.Args) != 1 {
		fail()
	}
	data, err := io.ReadAll(io.LimitReader(os.Stdin, protocol.MaxInput+1))
	_ = os.Stdin.Close()
	if err != nil {
		fail()
	}
	out, err := protocol.RunMock(context.Background(), data)
	if err != nil {
		fail()
	}
	if _, err := os.Stdout.Write(out); err != nil {
		os.Exit(1)
	}
}
func fail() { fmt.Fprintln(os.Stderr, "experimental mock stream rejected"); os.Exit(2) }
