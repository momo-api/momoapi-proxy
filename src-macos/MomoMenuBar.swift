import AppKit

// The companion never reads or edits settings.json. Credential rotation and
// service lifecycle are delegated to the installed CLI via a protected pipe.
@main
struct MomoMenuBar {
    static func main() {
        let app = NSApplication.shared
        let delegate = Companion()
        app.delegate = delegate
        app.setActivationPolicy(.accessory)
        app.run()
        _ = delegate
    }
}

final class Companion: NSObject, NSApplicationDelegate, NSWindowDelegate {
    private var statusItem: NSStatusItem!
    private var statusLabel = NSMenuItem(title: "MOMO API Proxy", action: nil, keyEquivalent: "")
    private var timer: Timer?
    private var busy = false
    private var keyWindow: NSWindow?
    private var keyField: NSSecureTextField?
    private var saveButton: NSButton?
    private let home = FileManager.default.homeDirectoryForCurrentUser

    func applicationDidFinishLaunching(_ notification: Notification) {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.image = NSImage(systemSymbolName: "m.circle.fill", accessibilityDescription: "MOMO API Proxy")
        statusItem.button?.toolTip = "MOMO API Proxy"
        let menu = NSMenu()
        statusLabel.isEnabled = false
        menu.addItem(statusLabel)
        menu.addItem(.separator())
        item(menu, "修改 API Key…", #selector(showKeyEditor))
        item(menu, "启动服务", #selector(startService))
        item(menu, "停止服务", #selector(stopService))
        item(menu, "重启服务", #selector(restartService))
        item(menu, "启用登录自启动", #selector(enableAutostart))
        item(menu, "关闭登录自启动", #selector(disableAutostart))
        menu.addItem(.separator())
        item(menu, "健康诊断", #selector(doctor))
        item(menu, "查看脱敏日志", #selector(logs))
        item(menu, "打开 MOMO 控制台", #selector(portal))
        item(menu, "退出菜单栏（后台继续运行）", #selector(quit))
        statusItem.menu = menu
        refreshStatus()
        timer = Timer.scheduledTimer(withTimeInterval: 15, repeats: true) { [weak self] _ in self?.refreshStatus() }
    }

    private func item(_ menu: NSMenu, _ title: String, _ action: Selector) {
        let entry = NSMenuItem(title: title, action: action, keyEquivalent: "")
        entry.target = self
        menu.addItem(entry)
    }

    private func cli() throws -> (URL, [String]) {
        // Installer wrapper pins the absolute Node executable; launchd PATH
        // need not include Homebrew or /usr/local/bin.
        for name in ["momoapi", "momoapi-proxy", "momo-codex-bridge"] {
            let path = home.appendingPathComponent(".local/bin/" + name)
            if FileManager.default.isExecutableFile(atPath: path.path) { return (path, []) }
        }
        for directory in [".momoapi-proxy", ".momo-codex-bridge"] {
            let script = home.appendingPathComponent(directory + "/app/bin/momoapi-proxy.mjs")
            if !FileManager.default.fileExists(atPath: script.path) { continue }
            for node in ["/opt/homebrew/bin/node", "/usr/local/bin/node"] {
                if FileManager.default.isExecutableFile(atPath: node) { return (URL(fileURLWithPath: node), [script.path]) }
            }
        }
        throw NSError(domain: "MOMO", code: 1, userInfo: [NSLocalizedDescriptionKey: "请先在终端安装 MOMO API Proxy。"])
    }

    private func run(_ args: [String], secret: String? = nil, completion: @escaping (Bool, String) -> Void) {
        DispatchQueue.global(qos: .utility).async {
            do {
                let (executable, prefix) = try self.cli()
                let process = Process()
                process.executableURL = executable
                process.arguments = prefix + args
                let stdin = Pipe(), stdout = Pipe()
                process.standardInput = stdin
                process.standardOutput = stdout
                process.standardError = FileHandle.nullDevice
                try process.run()
                if let secret = secret { stdin.fileHandleForWriting.write(Data((secret + "\n").utf8)) }
                try? stdin.fileHandleForWriting.close()
                let deadline = DispatchWorkItem { if process.isRunning { process.terminate() } }
                DispatchQueue.global().asyncAfter(deadline: .now() + 30, execute: deadline)
                let data = stdout.fileHandleForReading.readDataToEndOfFile()
                process.waitUntilExit()
                deadline.cancel()
                let text = secret == nil ? String(data: data, encoding: .utf8) ?? "" : ""
                DispatchQueue.main.async { completion(process.terminationStatus == 0, String(text.prefix(12000))) }
            } catch { DispatchQueue.main.async { completion(false, "无法执行本地代理命令，请检查安装。") } }
        }
    }

    private func refreshStatus() {
        guard !busy else { return }
        run(["status"]) { ok, text in
            let data = text.data(using: .utf8) ?? Data()
            let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            let running = json?["running"] as? Bool ?? false
            self.statusLabel.title = ok && running ? "MOMO API Proxy · 运行中" : "MOMO API Proxy · 已停止／待安装"
        }
    }

    private func alert(_ message: String) {
        let alert = NSAlert()
        alert.messageText = "MOMO API Proxy"
        alert.informativeText = message
        NSApp.activate(ignoringOtherApps: true)
        alert.runModal()
    }

    private func command(_ args: [String]) {
        guard !busy else { return }
        busy = true
        run(args) { ok, text in
            self.busy = false
            self.alert(ok ? (text.isEmpty ? "操作完成。" : text) : "操作未完成，请运行 momoapi doctor 检查。")
            self.refreshStatus()
        }
    }

    @objc private func showKeyEditor() {
        guard !busy else { return }
        if let window = keyWindow { window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true); return }
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 460, height: 170), styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.title = "修改 MOMO API Key"
        window.delegate = self
        window.isReleasedWhenClosed = false
        let label = NSTextField(labelWithString: "输入新 Key，验证成功后保存；取消不改变现有配置。")
        label.frame = NSRect(x: 20, y: 125, width: 420, height: 25)
        let input = NSSecureTextField(frame: NSRect(x: 20, y: 85, width: 420, height: 28))
        let save = NSButton(title: "验证并保存", target: self, action: #selector(saveKey))
        save.frame = NSRect(x: 205, y: 25, width: 130, height: 32)
        let cancel = NSButton(title: "取消", target: self, action: #selector(cancelKey))
        cancel.frame = NSRect(x: 345, y: 25, width: 95, height: 32)
        for view in [label, input, save, cancel] as [NSView] { window.contentView?.addSubview(view) }
        keyField = input; saveButton = save; keyWindow = window
        window.center(); window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    @objc private func saveKey() {
        guard !busy, let key = keyField?.stringValue.trimmingCharacters(in: .whitespacesAndNewlines), !key.isEmpty, key.utf8.count <= 4096 else { return }
        busy = true; saveButton?.isEnabled = false; keyField?.stringValue = ""
        run(["key", "change", "--api-key-stdin"], secret: key) { ok, _ in
            self.busy = false; self.saveButton?.isEnabled = true
            if ok { self.keyWindow?.close(); self.keyWindow = nil }
            self.alert(ok ? "API Key 已验证并保存。已打开的直连客户端可能需要重启。" : "Key 修改未完成。请检查网络与 Key；终端 momoapi key change 可查看具体原因。")
            self.refreshStatus()
        }
    }
    @objc private func cancelKey() { guard !busy else { return }; keyField?.stringValue = ""; keyWindow?.close(); keyWindow = nil }
    func windowWillClose(_ notification: Notification) { keyField?.stringValue = ""; keyWindow = nil }
    @objc private func startService() { command(["service", "start"]) }
    @objc private func stopService() { command(["service", "stop"]) }
    @objc private func restartService() { command(["service", "restart"]) }
    @objc private func enableAutostart() { command(["autostart", "on"]) }
    @objc private func disableAutostart() { command(["autostart", "off"]) }
    @objc private func doctor() { command(["doctor"]) }
    @objc private func logs() { command(["logs", "--lines", "50"]) }
    @objc private func portal() { NSWorkspace.shared.open(URL(string: "https://momoapi.us/console/token")!) }
    @objc private func quit() { guard !busy else { return }; NSApp.terminate(nil) }
}
