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
	store := vault.System() // construction does not read the credential store
	assets := ui.HandlerWithActions(origin, core, ui.Actions{
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
