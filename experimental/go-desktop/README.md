# Experimental Go + Wails v3 spike

**DEMO ONLY, not a Go replacement for MOMO API Proxy.** No upstream requests,
real Key, installed profile access, protocol migration, autostart, updater or
release integration. The Node product remains unchanged.

Independent module: local Go 1.26.2, Wails pinned v3.0.0-beta.24 (not latest).
Wails itself declares Go 1.25 minimum, not Magpie's Go requirement.

## Process contract
CLI serve is an independent foreground process; reads random 32-byte hex Token
through private stdin, binds 127.0.0.1 random port, writes only Endpoint,
Protocol and Experimental to stdout. Desktop attaches via Endpoint/Token on
its private stdin. No secrets in argv, env, files, shell literals or logs.
There is no persisted session discovery and no detached process from UI.

Window close hides to tray. Tray opens the window or exits UI. UI quit/crash
does not stop the independent server. Owner stops foreground serve with Ctrl-C.
Demo start/stop toggles only an in-memory boolean, not proxy traffic or children.
CLI status/demo-start/demo-stop use the same private stdin session contract.
Go host keeps token; WebView gets only non-secret state.

## Build/test (inside this module)
go test -tags nogui -count=5 ./...
go vet -tags nogui ./...
go build -trimpath -ldflags "-s -w" -o <outside-repo-output> .
node smoke.mjs <absolute-binary-path>

Use -tags nogui for CLI-only build. Linux/macOS desktop require native
WebView/toolchain dependencies; Windows compilation does not validate those.
No published installer or signatures are created by this spike.

## Boundaries and remaining gates
Control accepts only authenticated non-browser requests; Origin/Sec-Fetch-Site
denied. No CORS. Wails asset handler bridges only fixed local demo actions,
not arbitrary paths/URLs/shell. Non-local asset Origins denied. HTTP deadlines,
bounded input, redirects denied, environment proxy disabled, protocol handshake.
This does not defend against hostile same-user processes.

Native UI clicking, startup, hide/tray/quit/crash lifecycle, Chinese/high-DPI,
Linux/macOS delivery, signatures, notarization, login/reboot are unverified gates.
Per-endpoint framework single-instance also needs native acceptance.
Next PR: secure user-scoped session discovery and native acceptance, then
incremental protocol adapters against shared fixtures. Existing 46 black-box
checks are a starting point, not complete Go migration acceptance.
