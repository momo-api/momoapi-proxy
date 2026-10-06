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
	if len(os.Args) == 7 && os.Args[1] == "mcp" && os.Args[2] == "image" && os.Args[3] == "--endpoint" && os.Args[5] == "--asset-library" && os.Args[6] != "" {
		return runConnectedMediaLibraryMode(os.Args[4], os.Args[6])
	}
	// Explicit NEW directory; never choose a home/profile/default library.
	if len(os.Args) == 7 && os.Args[1] == "mcp" && os.Args[2] == "image" && os.Args[3] == "--endpoint" && os.Args[5] == "--asset-dir" && os.Args[6] != "" {
		return runConnectedMediaAssetsMode(os.Args[4], false, true, os.Args[6])
	}
	// Explicit compatibility launcher; no Node/profile/endpoint discovery.
	if len(os.Args) == 5 && os.Args[1] == "mcp" && (os.Args[2] == "image" || os.Args[2] == "video") && os.Args[3] == "--endpoint" {
		return runConnectedPluginMCP(os.Args[4], os.Args[2] == "video")
	}
	if len(os.Args) == 5 && os.Args[1] == "plugin-mcp-config" && (os.Args[2] == "image" || os.Args[2] == "video") && os.Args[3] == "--endpoint" {
		executable, err := os.Executable()
		if err != nil {
			return errors.New("plugin executable unavailable")
		}
		config, err := integration.PluginMCPConfig(executable, os.Args[4], os.Args[2] == "video")
		if err != nil {
			return err
		}
		n, err := io.WriteString(os.Stdout, config+"\n")
		if err != nil || n != len(config)+1 {
			return errors.New("plugin config output unavailable")
		}
		return nil
	}
	if len(os.Args) == 2 && os.Args[1] == "diagnostics" {
		return writeDiagnostics(os.Stdout) // offline allowlisted report only
	}
	if len(os.Args) == 4 && os.Args[1] == "codex-text-tools-catalog" && os.Args[2] == "--model" {
		catalog, err := integration.CodexTextToolsCatalog(os.Args[3])
		if err != nil {
			return err
		}
		n, err := io.WriteString(os.Stdout, catalog)
		if err != nil || n != len(catalog) {
			return errors.New("client catalog output unavailable")
		}
		return nil // no GUI/listener/credential input/env or client file access
	}
	if len(os.Args) == 4 && os.Args[1] == "mcp-videos-connect" && os.Args[2] == "--endpoint" {
		return runConnectedVideoMCP(os.Args[3])
	}
	if len(os.Args) == 4 && os.Args[1] == "mcp-images-connect" && os.Args[2] == "--endpoint" {
		return runConnectedImageMCP(os.Args[3])
	}
	if len(os.Args) == 2 && os.Args[1] == "mcp-images" {
		return runImageMCP()
	}
	if len(os.Args) == 2 && os.Args[1] == "mcp-videos" {
		return runVideoMCP()
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
		return errors.New("MOMO preview: desktop (no args) | --version | diagnostics (offline, not running app health) | codex-text-tools-catalog --model gpt-5.5 | mcp (read-only stdio) | mcp image|video --endpoint <local-origin> (explicit flat plugin subset; image optionally --asset-dir <absolute NEW directory> or --asset-library <absolute Go library directory>) | plugin-mcp-config image|video --endpoint <local-origin> (secret-free launcher override) | mcp-videos | mcp-videos-connect --endpoint <local-origin> | mcp-images | mcp-images-connect --endpoint <local-origin> | serve (upstream config on private stdin)")
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
