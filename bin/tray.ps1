# MOMO API Proxy - Native Windows System Tray Companion
[CmdletBinding()]
param(
  [int]$Port = 18789,
  [string]$Endpoint = "https://momoapi.us"
)

$ErrorActionPreference = "SilentlyContinue"

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# Resolve exact absolute path for momoapi-proxy.mjs
$userHome = [System.Environment]::GetFolderPath([System.Environment+SpecialFolder]::UserProfile)
$global:MomoBin = [System.IO.Path]::Combine($userHome, ".momoapi-proxy", "app", "bin", "momoapi-proxy.mjs")
if (-not (Test-Path $global:MomoBin)) {
  $global:MomoBin = [System.IO.Path]::Combine($userHome, ".momoapi-proxy", "app", "bin", "momo-codex-bridge.mjs")
}
if (-not (Test-Path $global:MomoBin)) {
  $global:MomoBin = [System.IO.Path]::Combine($userHome, ".momo-codex-bridge", "app", "bin", "momoapi-proxy.mjs")
}
if (-not (Test-Path $global:MomoBin)) {
  $global:MomoBin = [System.IO.Path]::Combine($userHome, ".momo-codex-bridge", "app", "bin", "momo-codex-bridge.mjs")
}

$Version = "v0.9.0"

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
    $resp.Close()
    return $true
  } catch {
    return $false
  }
}

function Start-DaemonProcess {
  if (-not (Check-BridgeRunning)) {
    if (Test-Path $global:MomoBin) {
      Start-Process -FilePath "node" -ArgumentList @($global:MomoBin, "serve") -WindowStyle Hidden
      Start-Sleep -Milliseconds 600
    }
  }
}

# Ensure daemon running on tray startup
Start-DaemonProcess

# Setup System Tray NotifyIcon
$notifyIcon = New-Object System.Windows.Forms.NotifyIcon
$activeIcon = Create-MomoIcon $true
$inactiveIcon = Create-MomoIcon $false
$notifyIcon.Icon = $activeIcon
$notifyIcon.Text = "MOMO API Proxy $Version (:18789)"
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
  if (Test-Path $global:MomoBin) {
    $output = & node "$global:MomoBin" models 2>&1 | Out-String
    [System.Windows.Forms.MessageBox]::Show($output.Trim(), "MOMO API Proxy - Models", [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Information)
  }
})

$doctorItem = $contextMenu.Items.Add("运行健康诊断 (Doctor)")
$doctorItem.add_Click({
  if (Test-Path $global:MomoBin) {
    $output = & node "$global:MomoBin" doctor 2>&1 | Out-String
    [System.Windows.Forms.MessageBox]::Show($output.Trim(), "MOMO API Proxy - Doctor", [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Information)
  }
})

$logsItem = $contextMenu.Items.Add("查看代理日志 (Logs)")
$logsItem.add_Click({
  $logFiles = @(
    [System.IO.Path]::Combine($userHome, ".momoapi-proxy", "daemon.log"),
    [System.IO.Path]::Combine($userHome, ".momoapi-proxy", "proxy.log"),
    [System.IO.Path]::Combine($userHome, ".momo-codex-bridge", "daemon.log"),
    [System.IO.Path]::Combine($userHome, ".momo-codex-bridge", "bridge.log")
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
  if (Test-Path $global:MomoBin) {
    $output = & node "$global:MomoBin" update 2>&1 | Out-String
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
    $notifyIcon.Text = "MOMO API Proxy $Version (运行中 :18789)"
    $titleItem.Text = "MOMO API Proxy $Version (运行中 :18789)"
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
