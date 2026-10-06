//go:build !nogui

package main

import (
	"bytes"
	"context"
	"errors"
	"github.com/momo-api/momoapi-proxy/experimental/go-app/internal/appcore"
	"github.com/momo-api/momoapi-proxy/experimental/go-app/internal/integration"
	"github.com/momo-api/momoapi-proxy/experimental/go-app/internal/ui"
	"github.com/momo-api/momoapi-proxy/experimental/go-app/internal/vault"
	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
	"image"
	"image/color"
	"image/png"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"runtime"
	"sync"
)

func desktop() error {
	return desktopConfigured(nil)
}

// Test-only code can observe the same construction; no normal route/CLI seam.
func desktopConfigured(configure func(*application.Options, *appcore.Core)) error {
	core, err := appcore.New()
	if err != nil {
		return err
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	var shutdownOnce sync.Once
	var shutdownErr error
	shutdown := func() {
		shutdownOnce.Do(func() { cancel(); shutdownErr = <-done })
	}
	ready := make(chan string, 1)
	go func() { done <- core.Serve(ctx, func(endpoint string) { ready <- endpoint }) }()
	select {
	case <-ready:
	case err := <-done:
		return err
	}
	defer shutdown()
	origin := "wails://localhost"
	if runtime.GOOS == "windows" {
		origin = "http://wails.localhost"
	}
	var app *application.App
	var pendingRoute struct {
		path, revision string
		options        integration.CodexRouteOptions
	}
	store := vault.System() // construction does not read the credential store
	assets := ui.HandlerWithActions(origin, core, ui.Actions{
		PreviewCodexRoute: func(ctx context.Context, options integration.CodexRouteOptions) (integration.CodexRoutePreview, error) {
			pendingRoute.path = ""
			pendingRoute.revision = ""
			if options.Mode == "direct" {
				state := core.State()
				if !state.Configured {
					return integration.CodexRoutePreview{}, errors.New("configure explicit upstream first")
				}
				options.Endpoint = state.Endpoint
			}
			if options.Mode == "proxy" {
				state := core.State()
				if !state.Running {
					return integration.CodexRoutePreview{}, errors.New("start gateway first")
				}
				options.Endpoint = state.LocalEndpoint
			}
			path, err := app.Dialog.OpenFile().AddFilter("Codex user-level config.toml", "*.toml").SetMessage("选择 user-level config.toml；仅预览，不读取登录文件").PromptForSingleSelection()
			if err != nil || path == "" || ctx.Err() != nil || filepath.Base(path) != "config.toml" {
				return integration.CodexRoutePreview{}, errors.New("route selection cancelled")
			}
			preview, err := integration.PreviewCodexRouteFile(path, options)
			if err != nil {
				return integration.CodexRoutePreview{}, err
			}
			pendingRoute.path = path
			pendingRoute.revision = preview.Revision
			pendingRoute.options = options
			return preview, nil
		},
		ApplyCodexRoute: func(revision string) (integration.CodexRoutePreview, error) {
			path, expected, options := pendingRoute.path, pendingRoute.revision, pendingRoute.options
			pendingRoute.path = ""
			pendingRoute.revision = ""
			if path == "" || revision != expected {
				return integration.CodexRoutePreview{}, errors.New("preview expired")
			}
			state := core.State()
			if options.Mode == "proxy" && (!state.Running || state.LocalEndpoint != options.Endpoint) || options.Mode == "direct" && (!state.Configured || state.Endpoint != options.Endpoint) {
				return integration.CodexRoutePreview{}, errors.New("gateway changed")
			}
			return integration.ApplyCodexRouteFile(path, options, revision)
		},
		SaveImage: func(ctx context.Context, mime string, data []byte) (bool, error) {
			if ctx.Err() != nil {
				return false, errors.New("save cancelled")
			}
			ext := appcore.LocalImageExtension(mime)
			if ext == "" {
				return false, errors.New("image type unavailable")
			}
			path, err := app.Dialog.SaveFile().SetFilename("momo-image"+ext).AddFilter("Image", "*"+ext).AllowsOtherFileTypes(false).SetMessage("选择新文件；不会覆盖现有文件").PromptForSingleSelection()
			// Pinned Wails beta.24 Windows adapter returns its internal sentinel
			// as this exact error; macOS/Linux cancellation returns empty path.
			if runtime.GOOS == "windows" && err != nil && err.Error() == "cancelled by user" {
				return false, nil
			}
			if err != nil {
				return false, errors.New("image dialog unavailable")
			}
			if path == "" {
				return false, nil
			}
			if err := writeSelectedImage(ctx, path, mime, data); err != nil {
				return false, err
			}
			return true, nil
		},
		SaveProfile: store.Save, LoadProfile: store.Load, ForgetProfile: store.Forget,
		AllowOpaqueOrigin: runtime.GOOS != "windows",
		CopyConnection: func() error {
			if !app.Clipboard.SetText(core.ConnectionJSON()) {
				return errors.New("clipboard unavailable")
			}
			return nil
		},
		Quit: func() { go app.Quit() },
		CopySkill: func() error {
			if !app.Clipboard.SetText(integration.Skill) {
				return errors.New("clipboard unavailable")
			}
			return nil
		},
		CopyMCPConfig: func() error {
			exe, err := os.Executable()
			if err != nil {
				return errors.New("executable unavailable")
			}
			if !app.Clipboard.SetText(integration.MCPConfig(exe)) {
				return errors.New("clipboard unavailable")
			}
			return nil
		},
		CopyCodexConfig: func() error {
			text, err := integration.CodexProviderConfig(core.State().LocalEndpoint)
			if err != nil || !app.Clipboard.SetText(text) {
				return errors.New("client clipboard unavailable")
			}
			return nil
		},
		CopyCodexCatalog: func() error {
			text, err := integration.CodexTextToolsCatalog("gpt-5.5")
			if err != nil || !app.Clipboard.SetText(text) {
				return errors.New("client catalog clipboard unavailable")
			}
			return nil
		},
		CopyImageMCPConfig: func() error {
			exe, err := os.Executable()
			if err != nil {
				return errors.New("executable unavailable")
			}
			text, err := integration.ImageMCPConfig(exe, core.State().LocalEndpoint)
			if err != nil || !app.Clipboard.SetText(text) {
				return errors.New("image MCP clipboard unavailable")
			}
			return nil
		},
		CopyVideoMCPConfig: func() error {
			exe, err := os.Executable()
			if err != nil {
				return errors.New("executable unavailable")
			}
			text, err := integration.VideoMCPConfig(exe, core.State().LocalEndpoint)
			if err != nil || !app.Clipboard.SetText(text) {
				return errors.New("video MCP clipboard unavailable")
			}
			return nil
		},
	})
	options := application.Options{Name: "MOMO API Preview", Description: "Go Responses and Chat passthrough preview", Logger: slog.New(slog.NewTextHandler(io.Discard, nil)), Assets: application.AssetOptions{Handler: assets, DisableLogging: true}, OnShutdown: shutdown, Linux: application.LinuxOptions{DisableQuitOnLastWindowClosed: true}}
	if configure != nil {
		configure(&options, core)
	}
	app = application.New(options)
	window := app.Window.NewWithOptions(application.WebviewWindowOptions{Title: "MOMO · 本地网关", Width: 1080, Height: 820, URL: "/"})
	var mu sync.Mutex
	initial, cancelInitial := false, false
	window.RegisterHook(events.Common.WindowClosing, func(e *application.WindowEvent) {
		// Not every Linux desktop has a system tray. Close must remain an exit.
		if runtime.GOOS == "linux" {
			go app.Quit()
			return
		}
		e.Cancel()
		application.InvokeSync(func() { mu.Lock(); cancelInitial = true; window.Hide(); mu.Unlock() })
	})
	if runtime.GOOS == "windows" {
		window.OnWindowEvent(events.Windows.WebViewNavigationCompleted, func(*application.WindowEvent) {
			application.InvokeSync(func() {
				mu.Lock()
				defer mu.Unlock()
				if !initial && !cancelInitial {
					initial = true
					window.Show()
				}
			})
		})
	}
	menu := app.NewMenu()
	menu.Add("打开 MOMO").OnClick(func(*application.Context) { window.Show() })
	menu.Add("复制客户端连接配置（含本地 Key）").OnClick(func(*application.Context) { _ = app.Clipboard.SetText(core.ConnectionJSON()) })
	menu.Add("停止代理").OnClick(func(*application.Context) { core.Stop() })
	menu.Add("退出并停止本程序代理").OnClick(func(*application.Context) { cancel(); app.Quit() })
	icon := image.NewRGBA(image.Rect(0, 0, 32, 32))
	for y := 4; y < 28; y++ {
		for x := 4; x < 28; x++ {
			icon.Set(x, y, color.RGBA{50, 110, 220, 255})
		}
	}
	var encoded bytes.Buffer
	_ = png.Encode(&encoded, icon)
	tray := app.SystemTray.New()
	tray.SetTooltip("MOMO 本地代理 Preview")
	if runtime.GOOS == "darwin" {
		tray.SetTemplateIcon(encoded.Bytes())
	} else {
		tray.SetIcon(encoded.Bytes())
	}
	tray.SetMenu(menu)
	tray.OnClick(func() { window.Show() })
	err = app.Run()
	shutdown()
	if err != nil || shutdownErr != nil {
		return errors.New("desktop stopped with an error")
	}
	return nil
}
