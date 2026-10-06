//go:build windows && !appcheck && !routecheck

package main

import "os"

// Windows file Close cancels the pending stdio IO; packaged signal test covers it.
func imageMCPStreams() (*os.File, *os.File, error) { return os.Stdin, os.Stdout, nil }
