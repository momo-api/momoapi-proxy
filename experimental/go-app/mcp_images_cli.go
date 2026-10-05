//go:build !appcheck && !routecheck

package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/signal"
	"syscall"
	"unicode/utf8"

	"github.com/momo-api/momoapi-proxy/experimental/go-app/internal/appcore"
	"github.com/momo-api/momoapi-proxy/experimental/go-app/internal/integration"
)

// First private stdin line is config, all later lines are MCP. Never read vault,
// environment, account files or argv credentials; never emit a local token.
func runImageMCP() error {
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	done := make(chan struct{})
	defer close(done)
	go func() {
		select {
		case <-ctx.Done():
			_ = os.Stdin.Close()
			_ = os.Stdout.Close() // unblock a peer that stopped reading replies
		case <-done:
		}
	}()
	reader := bufio.NewReaderSize(os.Stdin, 8194)
	config, err := readImageMCPConfig(reader)
	if ctx.Err() != nil {
		return nil
	}
	if err != nil {
		return err
	}
	core, err := appcore.New()
	if err != nil {
		return err
	}
	defer core.Close()
	if core.Configure(config) != nil {
		return errors.New("invalid private image MCP config")
	}
	config = appcore.Config{}
	if core.Start() != nil {
		return errors.New("image MCP unavailable")
	}
	// No Serve/listener: direct bounded dispatch through the owned Core.
	err = integration.ServeImageMCP(ctx, reader, os.Stdout, core.DesktopImages)
	if ctx.Err() != nil {
		return nil
	}
	return err
}

func readImageMCPConfig(reader *bufio.Reader) (appcore.Config, error) {
	var config appcore.Config
	data, err := reader.ReadSlice('\n')
	if err != nil || len(data) > 8193 || !utf8.Valid(data) || !json.Valid(data) {
		return config, errors.New("invalid private image MCP config")
	}
	// Reject duplicate/case-alias fields in the sensitive, flat prelude.
	check := json.NewDecoder(bytes.NewReader(data))
	first, _ := check.Token()
	if first != json.Delim('{') {
		return config, errors.New("invalid private image MCP config")
	}
	seen := map[string]bool{}
	for check.More() {
		key, err := check.Token()
		name, ok := key.(string)
		var value json.RawMessage
		if err != nil || !ok || seen[name] || (name != "Endpoint" && name != "APIKey" && name != "Mode") || check.Decode(&value) != nil || len(value) == 0 || value[0] != '"' {
			return config, errors.New("invalid private image MCP config")
		}
		seen[name] = true
	}
	d := json.NewDecoder(bytes.NewReader(data))
	d.DisallowUnknownFields()
	var trailing any
	if d.Decode(&config) != nil || d.Decode(&trailing) != io.EOF || appcore.ValidateConfig(config) != nil {
		return appcore.Config{}, errors.New("invalid private image MCP config")
	}
	return config, nil
}
