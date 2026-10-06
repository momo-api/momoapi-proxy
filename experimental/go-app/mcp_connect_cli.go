//go:build !appcheck && !routecheck

package main

import (
	"context"
	"errors"
	"io"
	"os"
	"os/signal"
	"syscall"

	"github.com/momo-api/momoapi-proxy/experimental/go-app/internal/appcore"
	"github.com/momo-api/momoapi-proxy/experimental/go-app/internal/integration"
)

func runConnectedImageMCP(endpoint string) error {
	return runConnectedMediaMCP(endpoint, false)
}

func runConnectedVideoMCP(endpoint string) error {
	return runConnectedMediaMCP(endpoint, true)
}

func runConnectedMediaMCP(endpoint string, video bool) error {
	return runConnectedMediaMode(endpoint, video, false)
}

func runConnectedPluginMCP(endpoint string, video bool) error {
	return runConnectedMediaMode(endpoint, video, true)
}

func runConnectedMediaMode(endpoint string, video, plugin bool) error {
	return runConnectedMediaAssetsMode(endpoint, video, plugin, "")
}

func runConnectedMediaAssetsMode(endpoint string, video, plugin bool, assetDirectory string) error {
	return runConnectedMediaStoreMode(endpoint, video, plugin, assetDirectory, false)
}
func runConnectedMediaLibraryMode(endpoint, directory string) error {
	return runConnectedMediaStoreMode(endpoint, false, true, directory, true)
}
func runConnectedMediaStoreMode(endpoint string, video, plugin bool, assetDirectory string, persistent bool) error {
	if integration.ValidateLocalEndpoint(endpoint) != nil {
		return errors.New("local MCP endpoint unavailable")
	}
	// Explicit mode reads exactly this intentional local session env value, never
	// upstream keys, client/account files or system credential stores. No echo.
	connect := integration.NewLocalImageDispatch
	serve := integration.ServeImageMCP
	if video {
		connect, serve = integration.NewLocalVideoDispatch, integration.ServeVideoMCP
	}
	if assetDirectory != "" && !video && plugin {
		connect = integration.NewLocalImageAssetDispatch
	}
	if plugin {
		serve = integration.ServePluginImageMCP
		if video {
			serve = integration.ServePluginVideoMCP
		}
	}
	dispatch, closeClient, err := connect(endpoint, os.Getenv(integration.LocalMCPKeyEnv))
	if err != nil {
		return err
	}
	defer closeClient()
	if assetDirectory != "" {
		if video || !plugin {
			return errors.New("image asset mode unavailable")
		}
		openStore := integration.NewImageAssetStore
		if persistent {
			openStore = integration.OpenImageAssetLibrary
		}
		store, err := openStore(assetDirectory, appcore.DecodeLocalImageSave)
		if err != nil {
			return err
		}
		defer store.Close()
		serve = func(ctx context.Context, input io.Reader, output io.Writer, dispatch integration.ImageDispatch) error {
			return integration.ServePluginImageAssetsMCP(ctx, input, output, dispatch, store)
		}
	}
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
	err = serve(ctx, input, output, dispatch)
	if ctx.Err() != nil {
		return nil
	}
	return err
}
