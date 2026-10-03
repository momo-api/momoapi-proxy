//go:build !nogui

package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"github.com/momo-api/momoapi-proxy/experimental/go-desktop/internal/control"
	"github.com/momo-api/momoapi-proxy/experimental/go-desktop/internal/desktopbridge"
	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
	"image"
	"image/color"
	"image/png"
	"runtime"
	"sync/atomic"
)

const page = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'"><title>MOMO Go spike</title><style>body{font:16px system-ui;margin:40px;max-width:650px}button{margin:8px;padding:12px}pre{white-space:pre-wrap}</style><h1>MOMO · Go + Wails v3</h1><p>实验原型：没有代理转发、Key、自启动或更新功能。</p><p>窗口关闭会隐藏；退出界面不停止独立 demo 服务。</p><button onclick="call('state')">读取状态</button><button onclick="call('start')">开始 demo</button><button onclick="call('stop')">停止 demo</button><pre id="state">等待操作</pre><script>async function call(action){try{const r=await fetch('/demo/'+action,{method:'POST'});document.getElementById('state').textContent=JSON.stringify(await r.json(),null,2)}catch{document.getElementById('state').textContent='服务不可用'}}call('state')</script></html>`

func desktop(s control.Session) error {
	return desktopConfigured(s, nil, nil)
}

// Unexported construction hooks let separate build-tagged tests exercise the
// actual desktop setup without adding CLI commands, routes or page test APIs.
func desktopConfigured(s control.Session, configure func(*application.Options), created func(*application.App, *application.WebviewWindow)) error {
	// Fail closed before constructing the UI if it is not our demo contract.
	if _, err := control.Call(context.Background(), s, "state"); err != nil {
		return err
	}
	origin := desktopOrigin()
	handler := desktopbridge.Handler(page, origin, func(ctx context.Context, action string) (control.State, error) { return control.Call(ctx, s, action) })
	id := sha256.Sum256([]byte(s.Endpoint))
	var activeWindow atomic.Pointer[application.WebviewWindow]
	options := application.Options{Name: "MOMO experimental", Description: "Isolated Go desktop spike", Assets: application.AssetOptions{Handler: handler}, Linux: application.LinuxOptions{DisableQuitOnLastWindowClosed: true}, SingleInstance: &application.SingleInstanceOptions{
		UniqueID: "us.momoapi.experimental." + hex.EncodeToString(id[:12]),
		OnSecondInstanceLaunch: func(application.SecondInstanceData) {
			// A relaunch is only a visibility hint, never a command or session.
			if window := activeWindow.Load(); window != nil {
				window.Show()
			}
		},
	}}
	if configure != nil {
		configure(&options)
	}
	app := application.New(options)
	window := app.Window.NewWithOptions(application.WebviewWindowOptions{Title: "MOMO experimental — NOT a proxy", Width: 760, Height: 540, URL: "/"})
	activeWindow.Store(window)
	hideOnClose(window, nil)
	menu := app.NewMenu()
	menu.Add("打开实验窗口").OnClick(func(*application.Context) { window.Show() })
	menu.Add("退出界面（不停止服务）").OnClick(func(*application.Context) { app.Quit() })
	icon := image.NewRGBA(image.Rect(0, 0, 32, 32))
	for y := 4; y < 28; y++ {
		for x := 4; x < 28; x++ {
			icon.Set(x, y, color.RGBA{50, 110, 220, 255})
		}
	}
	var encoded bytes.Buffer
	_ = png.Encode(&encoded, icon)
	tray := app.SystemTray.New()
	tray.SetTooltip("MOMO experimental")
	if runtime.GOOS == "darwin" {
		tray.SetTemplateIcon(encoded.Bytes())
	} else {
		tray.SetIcon(encoded.Bytes())
	}
	tray.SetMenu(menu)
	tray.OnClick(func() { window.Show() })
	if created != nil {
		created(app, window)
	}
	return app.Run()
}

func desktopOrigin() string {
	if runtime.GOOS == "windows" {
		return "http://wails.localhost"
	}
	return "wails://localhost"
}

func hideOnClose(window *application.WebviewWindow, observed func()) {
	window.RegisterHook(events.Common.WindowClosing, func(e *application.WindowEvent) {
		e.Cancel()
		window.Hide()
		if observed != nil {
			observed()
		}
	})
}
