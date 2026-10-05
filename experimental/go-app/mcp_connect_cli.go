//go:build !appcheck && !routecheck

package main

import (
	"context"
	"errors"
	"os"
	"os/signal"
	"syscall"

	"github.com/momo-api/momoapi-proxy/experimental/go-app/internal/integration"
)

func runConnectedImageMCP(endpoint string) error {
	if integration.ValidateLocalEndpoint(endpoint) != nil {
		return errors.New("local MCP endpoint unavailable")
	}
	// Explicit mode reads exactly this intentional local session env value, never
	// upstream keys, client/account files or system credential stores. No echo.
	dispatch, closeClient, err := integration.NewLocalImageDispatch(endpoint, os.Getenv(integration.LocalMCPKeyEnv))
	if err != nil {
		return err
	}
	defer closeClient()
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	input, output, err := imageMCPStreams()
	if err != nil {
		return err
	}
	defer input.Close()
	defer output.Close()
	done := make(chan struct{})
	defer close(done)
	go func() {
		select {
		case <-ctx.Done():
			input.Close()
			output.Close()
		case <-done:
		}
	}()
	err = integration.ServeImageMCP(ctx, input, output, dispatch)
	if ctx.Err() != nil {
		return nil
	}
	return err
}
