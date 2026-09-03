# MOMO Codex Bridge - Native Windows System Tray Companion
[CmdletBinding()]
param(
  [int]$Port = 18789,
  [string]$Endpoint = "https://momoapi.us"
)

$ErrorActionPreference = "SilentlyContinue"

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$InstallDir = Split-Path -Parent $ScriptDir
$BridgeBin = [System.IO.Path]::Combine($ScriptDir, "momo-codex-bridge.mjs")
$PkgJsonPath = [System.IO.Path]::Combine($InstallDir, "package.json")
$Version = "v0.7.4"
if (Test-Path $PkgJsonPath) {
  try {
    $pkg = Get-Content $PkgJsonPath -Raw | ConvertFrom-Json
    if ($pkg.version) { $Version = "v" + $pkg.version }
  } catch {}
}

# Single-instance mutex
$mutexName = "Global\MomoCodexBridgeTrayMutex"
$createdNew = $false
$mutex = New-Object System.Threading.Mutex($true, $mutexName, [ref]$createdNew)
if (-not $createdNew) {
  exit 0
}

function Create-MomoIcon([bool]$active) {
  $size = 32
  $bmp = New-Object System.Drawing.Bitmap $size, $size
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias

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
    $req.Timeout = 1500
    $resp = $req.GetResponse()
    $resp.Close()
    return $true
  } catch {
    return $false
  }
}

function Start-DaemonProcess {
  if (-not (Check-BridgeRunning)) {
    Start-Process -FilePath "node" -ArgumentList @($BridgeBin, "serve") -WindowStyle Hidden
    Start-Sleep -Milliseconds 600
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

$updateItem = $contextMenu.Items.Add("Check for Updates (Version: $Version)")
$updateItem.add_Click({
  $output = & node "$BridgeBin" update 2>&1 | Out-String
  $notifyIcon.ShowBalloonTip(4000, "MOMO API Proxy Update", $output.Trim(), [System.Windows.Forms.ToolTipIcon]::Info)
})

$doctorItem = $contextMenu.Items.Add("Run Doctor Diagnostics")
$doctorItem.add_Click({
  $output = & node "$BridgeBin" doctor 2>&1 | Out-String
  [System.Windows.Forms.MessageBox]::Show($output, "MOMO Codex Bridge - Doctor", [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Information)
})

$syncItem = $contextMenu.Items.Add("Sync Models Now")
$syncItem.add_Click({
  $output = & node "$BridgeBin" sync 2>&1 | Out-String
  $notifyIcon.ShowBalloonTip(3000, "MOMO Model Sync", $output.Trim(), [System.Windows.Forms.ToolTipIcon]::Info)
})

$modelsItem = $contextMenu.Items.Add("View Available Models")
$modelsItem.add_Click({
  $output = & node "$BridgeBin" models 2>&1 | Out-String
  [System.Windows.Forms.MessageBox]::Show($output, "MOMO Codex Bridge - Models", [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Information)
})

$logsItem = $contextMenu.Items.Add("View Bridge Logs (bridge.log)")
$logsItem.add_Click({
  $logFile = [System.IO.Path]::Combine($env:USERPROFILE, ".momo-codex-bridge", "bridge.log")
  if (Test-Path $logFile) {
    Start-Process "notepad.exe" -ArgumentList $logFile
  } else {
    [System.Windows.Forms.MessageBox]::Show("Log file is empty or not yet created: " + $logFile, "Notice", [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Information)
  }
})

$configItem = $contextMenu.Items.Add("Open config.toml")
$configItem.add_Click({
  $cfgPath = [System.IO.Path]::Combine($env:USERPROFILE, ".codex", "config.toml")
  if (Test-Path $cfgPath) {
    Start-Process "notepad.exe" -ArgumentList $cfgPath
  } else {
    [System.Windows.Forms.MessageBox]::Show("Config not found: " + $cfgPath, "Notice", [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Warning)
  }
})

[void]$contextMenu.Items.Add("-")

$portalItem = $contextMenu.Items.Add("Open MOMO API Portal")
$portalItem.add_Click({
  Start-Process "https://momoapi.us"
})

[void]$contextMenu.Items.Add("-")

$restartItem = $contextMenu.Items.Add("Restart Bridge Daemon")
$restartItem.add_Click({
  try {
    Get-CimInstance Win32_Process -Filter "CommandLine LIKE '%momo-codex-bridge.mjs serve%'" -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  } catch {}
  Start-DaemonProcess
  $notifyIcon.ShowBalloonTip(2000, "MOMO Codex Bridge", "Service restarted", [System.Windows.Forms.ToolTipIcon]::Info)
})

$exitItem = $contextMenu.Items.Add("Exit Tray")
$exitItem.add_Click({
  $notifyIcon.Visible = $false
  $notifyIcon.Dispose()
  [System.Windows.Forms.Application]::Exit()
})

$notifyIcon.ContextMenuStrip = $contextMenu

# Periodic Polling Timer (Every 4s)
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 4000
$timer.add_Tick({
  $running = Check-BridgeRunning
  if ($running) {
    $notifyIcon.Icon = $activeIcon
    $notifyIcon.Text = "MOMO API Proxy $Version: Running (:18789)"
    $titleItem.Text = "MOMO API Proxy $Version (Running)"
  } else {
    $notifyIcon.Icon = $inactiveIcon
    $notifyIcon.Text = "MOMO API Proxy $Version: Stopped"
    $titleItem.Text = "MOMO API Proxy $Version (Stopped)"
  }
})
$timer.Start()

# Welcome Notification
$notifyIcon.ShowBalloonTip(3000, "MOMO API Proxy $Version", "Listening on http://127.0.0.1:18789/v1 (ChatGPT Desktop & Codex ready)", [System.Windows.Forms.ToolTipIcon]::Info)

# Run Form Loop
[System.Windows.Forms.Application]::Run()
