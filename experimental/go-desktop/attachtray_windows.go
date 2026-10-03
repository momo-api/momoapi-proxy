//go:build attachcheck && !nativecheck && windows && !nogui

package main

import (
	"os"
	"time"
	"unsafe"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/w32"
	"golang.org/x/sys/windows"
)

// Pinned beta24 Win32 event-path regression, NOT a physical shell mouse click.
// No handle addresses, arbitrary command IDs or other process data are logged.
func trayNativeCheck(window *application.WebviewWindow, className string) bool {
	find := windows.NewLazySystemDLL("user32.dll").NewProc("FindWindowExW")
	name, err := windows.UTF16PtrFromString(className)
	if err != nil {
		return false
	}
	unique := func() (w32.HWND, bool) {
		var candidate w32.HWND
		var after uintptr
		count := 0
		for i := 0; i < 32; i++ {
			h, _, _ := find.Call(uintptr(w32.HWND_MESSAGE), after, uintptr(unsafe.Pointer(name)), 0)
			if h == 0 {
				return candidate, count == 1
			}
			after = h
			hwnd := w32.HWND(h)
			_, pid := w32.GetWindowThreadProcessId(hwnd)
			if pid == os.Getpid() && w32.GetClassName(hwnd) == className && w32.GetWindowText(hwnd) == "" {
				candidate = hwnd
				count++
			}
		}
		return 0, false // Exhausted enumeration cannot establish uniqueness.
	}
	var tray w32.HWND
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) && tray == 0 {
		application.InvokeSync(func() {
			if candidate, ok := unique(); ok {
				tray = candidate
			}
		})
		if tray == 0 {
			time.Sleep(20 * time.Millisecond)
		}
	}
	post := func(msg uint32, param uintptr, event uintptr) bool {
		posted := false
		// Validate and enqueue on the UI thread owning the tray so it cannot be
		// destroyed/reused by this app between the two operations.
		application.InvokeSync(func() {
			if candidate, ok := unique(); ok && candidate == tray {
				posted = w32.PostMessage(tray, msg, param, event)
			}
		})
		return posted
	}
	if !post(w32.WM_COMMAND, 0, 0) {
		return false
	} // Unknown menu ID must leave no final visible state/callback count change.
	application.InvokeSync(func() {}) // Drain the posted command before observation.
	if window.IsVisible() {
		return false
	}
	// Actual windowsSystemTray.wndProc -> clickHandler -> shared window.Show.
	if !post(w32.WM_USER+1, 0, uintptr(w32.WM_LBUTTONUP)) || !waitVisible(window, true) {
		return false
	}
	window.Close()
	if !waitVisible(window, false) {
		return false
	}
	// Pinned Win32Menu mapping uses MenuItemMsgID + position (open=1, quit=2).
	if !post(w32.WM_COMMAND, uintptr(application.MenuItemMsgID+1), 0) || !waitVisible(window, true) {
		return false
	}
	// Callback counters plus PostShutdown confirm the quit command was executed.
	return post(w32.WM_COMMAND, uintptr(application.MenuItemMsgID+2), 0)
}
