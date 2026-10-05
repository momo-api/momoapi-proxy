//go:build !appcheck && !routecheck

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/momo-api/momoapi-proxy/experimental/go-app/internal/appcore"
	"github.com/momo-api/momoapi-proxy/experimental/go-app/internal/integration"
	"io"
	"os"
	"os/signal"
	"syscall"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
func run() error {
	if len(os.Args) == 2 && os.Args[1] == "mcp-images" {
		return runImageMCP()
	}
	if len(os.Args) == 2 && os.Args[1] == "mcp" {
		return integration.ServeMCP(os.Stdin, os.Stdout)
	}
	if len(os.Args) == 2 && os.Args[1] == "--version" {
		fmt.Println(appcore.Version)
		return nil // no GUI, listener, keyring read or config input
	}
	if len(os.Args) == 1 {
		return desktop()
	}
	if len(os.Args) != 2 || os.Args[1] != "serve" {
		return errors.New("MOMO preview: desktop (no args) | --version | mcp (read-only stdio) | mcp-images (opt-in private config line then stdio) | serve (upstream config on private stdin)")
	}
	data, err := io.ReadAll(io.LimitReader(os.Stdin, 8193))
	_ = os.Stdin.Close()
	if err != nil || len(data) > 8192 {
		return errors.New("invalid private config input")
	}
	var config appcore.Config
	d := json.NewDecoder(bytes.NewReader(data))
	d.DisallowUnknownFields()
	if d.Decode(&config) != nil {
		return errors.New("invalid private config input")
	}
	var trailing any
	if d.Decode(&trailing) != io.EOF {
		return errors.New("invalid private config input")
	}
	core, err := appcore.New()
	if err != nil {
		return err
	}
	defer core.Close()
	if err = core.Configure(config); err != nil {
		return err
	}
	config = appcore.Config{}
	if err = core.Start(); err != nil {
		return err
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	// Deliberate private stdout handoff, contains local token; never log/tee it.
	return core.Serve(ctx, func(string) { fmt.Fprintln(os.Stdout, core.ConnectionJSON()) })
}
