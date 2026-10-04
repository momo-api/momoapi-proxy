// fixture is an offline test runner. It never reads profiles or opens sockets.
package main

import (
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
	if err != nil {
		fail()
	}
	result, err := protocol.Convert(data)
	if err != nil {
		fail()
	}
	if _, err := os.Stdout.Write(result); err != nil {
		os.Exit(1)
	}
}
func fail() { fmt.Fprintln(os.Stderr, "experimental protocol fixture rejected"); os.Exit(2) }
