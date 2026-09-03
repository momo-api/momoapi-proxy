[CmdletBinding()]
param(
  [string]$ApiKey = "",
  [string]$Endpoint = "https://momoapi.us",
  [int]$Port = 18789,
  [switch]$NoAutostart
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

function Write-Step([string]$Message) {
  Write-Host "[momo-codex-bridge] $Message" -ForegroundColor Cyan
}

function Write-Success([string]$Message) {
  Write-Host "[momo-codex-bridge] $Message" -ForegroundColor Green
}

function Write-Err([string]$Message) {
  Write-Host "[momo-codex-bridge] ERROR: $Message" -ForegroundColor Red
}

# 1. Check Node.js
Write-Step "Checking Node.js environment..."
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  $winget = Get-Command winget -ErrorAction SilentlyContinue
  if ($winget) {
    Write-Step "Installing Node.js LTS via winget..."
    & $winget.Source install --id OpenJS.NodeJS.LTS --exact --source winget --accept-package-agreements --accept-source-agreements
    $nodeDir = [System.IO.Path]::Combine($env:ProgramFiles, "nodejs")
    if (Test-Path ([System.IO.Path]::Combine($nodeDir, "node.exe"))) {
      $env:Path = "$nodeDir;$env:Path"
    }
    $node = Get-Command node -ErrorAction SilentlyContinue
  }
}

if (-not $node) {
  Write-Err "Node.js 18+ is required. Please download and install Node.js from https://nodejs.org/"
  exit 1
}

$nodeVer = (& $node.Source --version).Trim().TrimStart("v")
$major = [int]($nodeVer.Split(".")[0])
if ($major -lt 18) {
  Write-Err "Node.js version must be >= 18; found v$nodeVer. Please update Node.js."
  exit 1
}
Write-Step "Found Node.js v$nodeVer"

# 2. Resolve API Key
if (-not $ApiKey) {
  $ApiKey = $env:MOMO_API_KEY
}
if (-not $ApiKey) {
  $ApiKey = Read-Host "Enter your MOMO API Key (e.g. sk-momo-...)"
}
if (-not $ApiKey) {
  Write-Err "MOMO API Key is required."
  exit 1
}

# 3. Download / Install to ~/.momo-codex-bridge
$installDir = [System.IO.Path]::Combine($HOME, ".momo-codex-bridge", "app")
if (Test-Path $installDir) {
  Remove-Item -Recurse -Force $installDir
}
  New-Item -ItemType Directory -Path $installDir -Force | Out-Null
  
  Write-Step "Downloading latest release package from GitHub..."
  $tgzUrl = "https://github.com/momo-api/momo-codex-bridge/releases/download/v0.5.9/momo-api-codex-bridge-0.5.9.tgz"
  $tgzPath = [System.IO.Path]::Combine($HOME, ".momo-codex-bridge", "package.tgz")

try {
  Invoke-WebRequest -Uri $tgzUrl -OutFile $tgzPath -UseBasicParsing
  tar -xzf $tgzPath -C $installDir --strip-components=1
  Remove-Item $tgzPath -Force
} catch {
  Write-Step "Direct download failed, falling back to git clone..."
  git clone https://github.com/momo-api/momo-codex-bridge.git $installDir
}

# 4. Generate Windows CLI wrappers in bin
$binDir = [System.IO.Path]::Combine($installDir, "bin")
$bridgeBin = [System.IO.Path]::Combine($binDir, "momo-codex-bridge.mjs")
$bridgeCmd = [System.IO.Path]::Combine($binDir, "momo-codex-bridge.cmd")
$bridgePs1 = [System.IO.Path]::Combine($binDir, "momo-codex-bridge.ps1")
$switchCmd = [System.IO.Path]::Combine($binDir, "momo-codex-switch.cmd")
$switchPs1 = [System.IO.Path]::Combine($binDir, "momo-codex-switch.ps1")
$trayPs1   = [System.IO.Path]::Combine($binDir, "tray.ps1")

"@echo off`r`nnode `"%~dp0momo-codex-bridge.mjs`" %*" | Set-Content -Path $bridgeCmd -Encoding Ascii
"& node `"`$PSScriptRoot\\momo-codex-bridge.mjs`" @args" | Set-Content -Path $bridgePs1 -Encoding Utf8
"@echo off`r`nnode `"%~dp0momo-codex-switch.mjs`" %*" | Set-Content -Path $switchCmd -Encoding Ascii
"& node `"`$PSScriptRoot\\momo-codex-switch.mjs`" @args" | Set-Content -Path $switchPs1 -Encoding Utf8

# 5. Run Setup
Write-Step "Configuring Codex provider & syncing models..."
$setupArgs = @($bridgeBin, "install", "--api-key", $ApiKey, "--endpoint", $Endpoint, "--port", "$Port")
if ($NoAutostart) { $setupArgs += "--no-autostart" }

& node @setupArgs
if ($LASTEXITCODE -ne 0) {
  Write-Err "Setup failed with exit code $LASTEXITCODE"
  exit $LASTEXITCODE
}

# 6. Launch Background Service & System Tray Companion
Write-Step "Stopping any existing MOMO Codex Bridge instance on port $Port..."
try {
  $conns = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
  foreach ($conn in $conns) {
    Stop-Process -Id $conn.OwningProcess -Force -ErrorAction SilentlyContinue
  }
} catch {}

Write-Step "Starting MOMO Codex Bridge daemon & Taskbar Tray..."
Start-Process -FilePath "node" -ArgumentList @($bridgeBin, "serve") -WindowStyle Hidden
if (Test-Path $trayPs1) {
  Start-Process -FilePath "powershell.exe" -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", $trayPs1) -WindowStyle Hidden
}

# 7. Register PATH, environment variables & current session function
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($userPath -notlike "*$binDir*") {
  [Environment]::SetEnvironmentVariable("Path", "$binDir;$userPath", "User")
}
if ($env:Path -notlike "*$binDir*") {
  $env:Path = "$binDir;$env:Path"
}

function global:momo-codex-bridge { & node "$bridgeBin" @args }
function global:momo-codex-switch { & node "$bridgeBin" @args }

Start-Sleep -Milliseconds 600

Write-Success "=========================================================="
Write-Success "  MOMO Codex Bridge installed and running successfully!   "
Write-Success "=========================================================="
Write-Host ""
Write-Host "Local Bridge is listening on: http://127.0.0.1:$Port/v1" -ForegroundColor Yellow
Write-Host "Taskbar System Tray Icon (Indigo M badge with Green Dot) is active." -ForegroundColor Green
Write-Host "Codex CLI & ChatGPT Desktop have been configured with requires_openai_auth=false" -ForegroundColor Yellow
Write-Host "Synced models are ready. Restart Codex App to use." -ForegroundColor Yellow
Write-Host ""
Write-Host "Health Status:" -ForegroundColor Cyan
& node "$bridgeBin" status
Write-Host ""
Write-Host "Commands available in this and new terminals:"
Write-Host "  momo-codex-bridge status   - Check bridge running status"
Write-Host "  momo-codex-bridge models   - List available models"
Write-Host "  momo-codex-bridge doctor   - Run health diagnostics"
Write-Host "  momo-codex-bridge tray     - Launch System Tray Companion"
Write-Host "  momo-codex-bridge rollback - Restore previous config"
Write-Host ""
