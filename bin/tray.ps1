# MOMO API Proxy - Native Windows System Tray Companion
[CmdletBinding()]
param(
  [int]$Port = 18789,
  [string]$Endpoint = "https://momoapi.us"
)

$ErrorActionPreference = "SilentlyContinue"

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

function Get-MomoBinPath {
  $homeDir = if ($env:USERPROFILE) { $env:USERPROFILE } else { [System.Environment]::GetFolderPath([System.Environment+SpecialFolder]::UserProfile) }
  $paths = @(
    [System.IO.Path]::Combine($homeDir, ".momoapi-proxy", "app", "bin", "momoapi-proxy.mjs"),
    [System.IO.Path]::Combine($homeDir, ".momoapi-proxy", "app", "bin", "momo-codex-bridge.mjs"),
    [System.IO.Path]::Combine($homeDir, ".momo-codex-bridge", "app", "bin", "momoapi-proxy.mjs"),
    [System.IO.Path]::Combine($homeDir, ".momo-codex-bridge", "app", "bin", "momo-codex-bridge.mjs")
  )
  foreach ($p in $paths) {
    if (Test-Path $p) { return $p }
  }
  return [System.IO.Path]::Combine($homeDir, ".momoapi-proxy", "app", "bin", "momoapi-proxy.mjs")
}

function Get-InstalledVersion {
  try {
    $packagePath = Join-Path (Split-Path -Parent (Split-Path -Parent (Get-MomoBinPath))) 'package.json'
    $packageVersion = (Get-Content -LiteralPath $packagePath -Raw | ConvertFrom-Json).version
    if ($packageVersion -match '^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$') { return "v$packageVersion" }
  } catch {}
  return '版本未知'
}
$script:Version = Get-InstalledVersion

# Single-instance mutex
$mutexName = "Local\MomoApiProxyTrayMutex_" + [System.Environment]::UserName
$createdNew = $false
try {
  $mutex = New-Object System.Threading.Mutex($true, $mutexName, [ref]$createdNew)
  if (-not $createdNew) {
    exit 0
  }
} catch {}

function Create-MomoIcon([bool]$active) {
  $size = 32
  $bmp = New-Object System.Drawing.Bitmap $size, $size
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.Clear([System.Drawing.Color]::Transparent)

  $bgColor = if ($active) { [System.Drawing.Color]::FromArgb(255, 99, 102, 241) } else { [System.Drawing.Color]::FromArgb(255, 100, 116, 139) }
  $brush = New-Object System.Drawing.SolidBrush($bgColor)
  $g.FillEllipse($brush, 2, 2, 28, 28)

  $font = New-Object System.Drawing.Font("Segoe UI", 13, [System.Drawing.FontStyle]::Bold)
  $textBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
  $format = New-Object System.Drawing.StringFormat
  $format.Alignment = [System.Drawing.StringAlignment]::Center
  $format.LineAlignment = [System.Drawing.StringAlignment]::Center
  $rect = New-Object System.Drawing.RectangleF(0, 1, 32, 30)
  $g.DrawString("M", $font, $textBrush, $rect, $format)

  $dotColor = if ($active) { [System.Drawing.Color]::FromArgb(255, 16, 185, 129) } else { [System.Drawing.Color]::FromArgb(255, 239, 68, 68) }
  $dotBrush = New-Object System.Drawing.SolidBrush($dotColor)
  $g.FillEllipse($dotBrush, 20, 20, 10, 10)
  $whitePen = New-Object System.Drawing.Pen([System.Drawing.Color]::White, 1.5)
  $g.DrawEllipse($whitePen, 20, 20, 10, 10)

  $g.Dispose()
  $hIcon = $bmp.GetHicon()
  return [System.Drawing.Icon]::FromHandle($hIcon)
}

function Check-BridgeRunning {
  try {
    $req = [System.Net.WebRequest]::Create("http://127.0.0.1:" + $Port + "/healthz")
    $req.Timeout = 1200
    $resp = $req.GetResponse()
    $reader = New-Object System.IO.StreamReader($resp.GetResponseStream())
    $health = $reader.ReadToEnd() | ConvertFrom-Json
    $reader.Dispose()
    $resp.Close()
    $script:Version = if ($health.version -match '^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$') { 'v' + $health.version } else { '版本未知' }
    return $true
  } catch {
    $script:Version = Get-InstalledVersion
    return $false
  }
}

function Start-DaemonProcess {
  if (-not (Check-BridgeRunning)) {
    $bin = Get-MomoBinPath
    if (Test-Path $bin) {
      Start-Process -FilePath "node" -ArgumentList @($bin, "serve") -WindowStyle Hidden
      Start-Sleep -Milliseconds 600
    }
  }
}

function Get-CodexRouteMode {
  try {
    $homeDir = if ($env:USERPROFILE) { $env:USERPROFILE } else { [System.Environment]::GetFolderPath([System.Environment+SpecialFolder]::UserProfile) }
    $configPath = [System.IO.Path]::Combine($homeDir, ".codex", "config.toml")
    if (-not (Test-Path -LiteralPath $configPath)) { return 'unconfigured' }
    $content = Get-Content -LiteralPath $configPath -Raw
    if ($content -match '(?m)^# MOMOAPI_ROUTE_MODE=(direct|proxy)$') { return $Matches[1] }
    if ($content -match 'base_url\s*=\s*["'']https://momoapi\.us(?:/v1)?/?["'']') { return 'direct' }
    if ($content -match 'base_url\s*=\s*["'']http://(?:127\.0\.0\.1|localhost):\d+/v1/?["'']') { return 'proxy' }
  } catch {}
  return 'custom'
}

function Invoke-CodexRoute([string]$mode) {
  $bin = Get-MomoBinPath
  if (-not (Test-Path -LiteralPath $bin)) { return $false }
  if ($mode -eq 'proxy') {
    Start-DaemonProcess
    if (-not (Check-BridgeRunning)) {
      [void][System.Windows.Forms.MessageBox]::Show("本地代理未能启动，Codex 路由保持不变。", "MOMO API Proxy", [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Error)
      return $false
    }
  }
  $output = & node "$bin" route $mode 2>&1 | Out-String
  if ($LASTEXITCODE -ne 0) {
    [void][System.Windows.Forms.MessageBox]::Show($output.Trim(), "MOMO API Proxy - Codex Route", [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Error)
    return $false
  }
  return $true
}

# Ensure daemon running on tray startup
Start-DaemonProcess

# Setup System Tray NotifyIcon
$notifyIcon = New-Object System.Windows.Forms.NotifyIcon
$activeIcon = Create-MomoIcon $true
$inactiveIcon = Create-MomoIcon $false
$notifyIcon.Icon = $activeIcon
$notifyIcon.Text = "MOMO API Proxy $Version (:$Port)"
$notifyIcon.Visible = $true

# Context Menu
$contextMenu = New-Object System.Windows.Forms.ContextMenuStrip

$titleItem = $contextMenu.Items.Add("MOMO API Proxy $Version (Running)")
$titleItem.Enabled = $false
$titleItem.Font = New-Object System.Drawing.Font($contextMenu.Font, [System.Drawing.FontStyle]::Bold)

[void]$contextMenu.Items.Add("-")

$portalItem = $contextMenu.Items.Add("打开 MOMO 控制台 (momoapi.us)")
$portalItem.add_Click({
  Start-Process "https://momoapi.us"
})

$modelsItem = $contextMenu.Items.Add("查看可用模型列表 (Models)")
$modelsItem.add_Click({
  $bin = Get-MomoBinPath
  if (Test-Path $bin) {
    $output = & node "$bin" models 2>&1 | Out-String
    [System.Windows.Forms.MessageBox]::Show($output.Trim(), "MOMO API Proxy - Models", [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Information)
  }
})

$syncItem = $contextMenu.Items.Add("同步模型列表 (Sync)")
$syncItem.add_Click({
  $bin = Get-MomoBinPath
  if (Test-Path $bin) {
    $output = & node "$bin" sync 2>&1 | Out-String
    [System.Windows.Forms.MessageBox]::Show($output.Trim(), "MOMO API Proxy - Sync", [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Information)
  }
})

$routeItem = New-Object System.Windows.Forms.ToolStripMenuItem("Codex 路由：正在检测...")
[void]$contextMenu.Items.Add($routeItem)
$routeDirectItem = New-Object System.Windows.Forms.ToolStripMenuItem("使用 MOMO 直连")
$routeProxyItem = New-Object System.Windows.Forms.ToolStripMenuItem("使用本地 Proxy")
$restoreRouteItem = New-Object System.Windows.Forms.ToolStripMenuItem("恢复切换前配置")
[void]$routeItem.DropDownItems.Add($routeDirectItem)
[void]$routeItem.DropDownItems.Add($routeProxyItem)
[void]$routeItem.DropDownItems.Add("-")
[void]$routeItem.DropDownItems.Add($restoreRouteItem)

$refreshRouteMenu = {
  $mode = Get-CodexRouteMode
  $routeDirectItem.Checked = $mode -eq 'direct'
  $routeProxyItem.Checked = $mode -eq 'proxy'
  $routeItem.Text = switch ($mode) {
    'direct' { 'Codex 路由：MOMO 直连' }
    'proxy' { 'Codex 路由：本地 Proxy' }
    'unconfigured' { 'Codex 路由：尚未配置' }
    default { 'Codex 路由：自定义' }
  }
}
$routeItem.add_DropDownOpening($refreshRouteMenu)
& $refreshRouteMenu

$routeDirectItem.add_Click({
  if (Invoke-CodexRoute 'direct') {
    & $refreshRouteMenu
    $notifyIcon.ShowBalloonTip(3500, "Codex 路由已切换", "当前模式：MOMO 直连。请重启已打开的 Codex 会话。", [System.Windows.Forms.ToolTipIcon]::Info)
  }
})
$routeProxyItem.add_Click({
  if (Invoke-CodexRoute 'proxy') {
    & $refreshRouteMenu
    $notifyIcon.ShowBalloonTip(3500, "Codex 路由已切换", "当前模式：本地 Proxy。请重启已打开的 Codex 会话。", [System.Windows.Forms.ToolTipIcon]::Info)
  }
})
$restoreRouteItem.add_Click({
  $bin = Get-MomoBinPath
  $output = if (Test-Path -LiteralPath $bin) { & node "$bin" route restore 2>&1 | Out-String } else { "找不到 MOMO API Proxy CLI。" }
  if ($LASTEXITCODE -eq 0 -and (Test-Path -LiteralPath $bin)) {
    & $refreshRouteMenu
    [void][System.Windows.Forms.MessageBox]::Show("已恢复切换前的 Codex 配置。请重启已打开的 Codex 会话。", "MOMO API Proxy", [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Information)
  } else {
    [void][System.Windows.Forms.MessageBox]::Show($output.Trim(), "MOMO API Proxy - Codex Route", [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Warning)
  }
})

$doctorItem = $contextMenu.Items.Add("运行健康诊断 (Doctor)")
$doctorItem.add_Click({
  $bin = Get-MomoBinPath
  if (Test-Path $bin) {
    $output = & node "$bin" doctor 2>&1 | Out-String
    [System.Windows.Forms.MessageBox]::Show($output.Trim(), "MOMO API Proxy - Doctor", [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Information)
  }
})

$logsItem = $contextMenu.Items.Add("查看代理日志 (Logs)")
$logsItem.add_Click({
  $homeDir = if ($env:USERPROFILE) { $env:USERPROFILE } else { [System.Environment]::GetFolderPath([System.Environment+SpecialFolder]::UserProfile) }
  $logFiles = @(
    [System.IO.Path]::Combine($homeDir, ".momoapi-proxy", "daemon.log"),
    [System.IO.Path]::Combine($homeDir, ".momoapi-proxy", "proxy.log"),
    [System.IO.Path]::Combine($homeDir, ".momo-codex-bridge", "daemon.log"),
    [System.IO.Path]::Combine($homeDir, ".momo-codex-bridge", "bridge.log")
  )
  $opened = $false
  foreach ($lf in $logFiles) {
    if (Test-Path $lf) {
      Start-Process "notepad.exe" -ArgumentList $lf
      $opened = $true
      break
    }
  }
  if (-not $opened) {
    [System.Windows.Forms.MessageBox]::Show("暂无日志记录", "MOMO API Proxy", [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Information)
  }
})

[void]$contextMenu.Items.Add("-")

$updateItem = $contextMenu.Items.Add("检查并更新版本 (Update)")
$updateItem.add_Click({
  $bin = Get-MomoBinPath
  if (Test-Path $bin) {
    $output = & node "$bin" update 2>&1 | Out-String
    $notifyIcon.ShowBalloonTip(4000, "MOMO API Proxy", $output.Trim(), [System.Windows.Forms.ToolTipIcon]::Info)
  }
})

$restartItem = $contextMenu.Items.Add("重启代理服务 (Restart)")
$restartItem.add_Click({
  try {
    Get-CimInstance Win32_Process -Filter "CommandLine LIKE '%momoapi-proxy.mjs%'" -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Get-CimInstance Win32_Process -Filter "CommandLine LIKE '%momo-codex-bridge.mjs%'" -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  } catch {}
  Start-Sleep -Milliseconds 400
  Start-DaemonProcess
  $notifyIcon.ShowBalloonTip(2000, "MOMO API Proxy", "服务正在重启...", [System.Windows.Forms.ToolTipIcon]::Info)
})

[void]$contextMenu.Items.Add("-")

$exitItem = $contextMenu.Items.Add("退出托盘与服务 (Exit)")
$exitItem.add_Click({
  $notifyIcon.Visible = $false
  $notifyIcon.Dispose()
  try {
    Get-CimInstance Win32_Process -Filter "CommandLine LIKE '%momoapi-proxy.mjs%'" -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Get-CimInstance Win32_Process -Filter "CommandLine LIKE '%momo-codex-bridge.mjs%'" -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  } catch {}
  [System.Windows.Forms.Application]::Exit()
})

$notifyIcon.ContextMenuStrip = $contextMenu

# Periodic Polling Timer (Every 3s)
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 3000
$timer.add_Tick({
  $running = Check-BridgeRunning
  if ($running) {
    $notifyIcon.Icon = $activeIcon
    $notifyIcon.Text = "MOMO API Proxy $Version (运行中 :$Port)"
    $titleItem.Text = "MOMO API Proxy $Version (运行中 :$Port)"
  } else {
    $notifyIcon.Icon = $inactiveIcon
    $notifyIcon.Text = "MOMO API Proxy $Version (已停止)"
    $titleItem.Text = "MOMO API Proxy $Version (已停止)"
  }
})
$timer.Start()

# Welcome Notification
$notifyIcon.ShowBalloonTip(3000, "MOMO API Proxy $Version", "代理服务已就绪: http://127.0.0.1:18789/v1", [System.Windows.Forms.ToolTipIcon]::Info)

# Run Form Loop
[System.Windows.Forms.Application]::Run()
