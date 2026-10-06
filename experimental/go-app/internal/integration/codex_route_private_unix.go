//go:build linux || darwin

package integration

import "os"

func secureRouteFile(f *os.File) error { return f.Chmod(0600) }
