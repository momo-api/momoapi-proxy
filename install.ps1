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
  
  Write-Step "Downloading latest release package..."
  $urls = @(
    "$Endpoint/install/packages/momo-api-codex-bridge-latest.tgz",
    "$Endpoint/install/packages/momo-api-codex-bridge-0.8.4.tgz",
    "$Endpoint/install/packages/momo-api-codex-bridge-0.8.3.tgz",
    "$Endpoint/install/packages/momo-api-codex-bridge-0.8.2.tgz",
    "$Endpoint/install/packages/momo-api-codex-bridge-0.8.1.tgz",
    "$Endpoint/install/packages/momo-api-codex-bridge-0.8.0.tgz",
    "$Endpoint/install/packages/momo-api-codex-bridge-0.7.7.tgz",
    "$Endpoint/install/packages/momo-api-codex-bridge-0.7.6.tgz",
    "$Endpoint/install/packages/momo-api-codex-bridge-0.7.5.tgz",
    "$Endpoint/install/packages/momo-api-codex-bridge-0.7.4.tgz",
    "$Endpoint/install/packages/momo-api-codex-bridge-0.7.3.tgz",
    "$Endpoint/install/packages/momo-api-codex-bridge-0.7.2.tgz",
    "$Endpoint/install/packages/momo-api-codex-bridge-0.7.1.tgz",
    "https://momoapi.us/install/packages/momo-api-codex-bridge-latest.tgz",
    "https://github.com/momo-api/momo-codex-bridge/releases/download/v0.8.4/momo-api-codex-bridge-0.8.4.tgz",
    "https://github.com/momo-api/momo-codex-bridge/releases/download/v0.8.3/momo-api-codex-bridge-0.8.3.tgz",
    "https://github.com/momo-api/momo-codex-bridge/releases/download/v0.8.2/momo-api-codex-bridge-0.8.2.tgz",
    "https://github.com/momo-api/momo-codex-bridge/releases/download/v0.8.1/momo-api-codex-bridge-0.8.1.tgz",
    "https://github.com/momo-api/momo-codex-bridge/releases/download/v0.8.0/momo-api-codex-bridge-0.8.0.tgz",
    "https://github.com/momo-api/momo-codex-bridge/releases/download/v0.7.7/momo-api-codex-bridge-0.7.7.tgz",
    "https://github.com/momo-api/momo-codex-bridge/releases/download/v0.7.6/momo-api-codex-bridge-0.7.6.tgz",
    "https://github.com/momo-api/momo-codex-bridge/releases/download/v0.7.5/momo-api-codex-bridge-0.7.5.tgz",
    "https://github.com/momo-api/momo-codex-bridge/releases/download/v0.7.4/momo-api-codex-bridge-0.7.4.tgz",
    "https://github.com/momo-api/momo-codex-bridge/releases/download/v0.7.3/momo-api-codex-bridge-0.7.3.tgz",
    "https://github.com/momo-api/momo-codex-bridge/releases/download/v0.7.2/momo-api-codex-bridge-0.7.2.tgz",
    "https://github.com/momo-api/momo-codex-bridge/releases/download/v0.7.1/momo-api-codex-bridge-0.7.1.tgz",
    "https://ghproxy.net/https://github.com/momo-api/momo-codex-bridge/releases/download/v0.8.4/momo-api-codex-bridge-0.8.4.tgz",
    "https://ghproxy.net/https://github.com/momo-api/momo-codex-bridge/releases/download/v0.8.3/momo-api-codex-bridge-0.8.3.tgz",
    "https://ghproxy.net/https://github.com/momo-api/momo-codex-bridge/releases/download/v0.8.2/momo-api-codex-bridge-0.8.2.tgz",
    "https://ghproxy.net/https://github.com/momo-api/momo-codex-bridge/releases/download/v0.8.1/momo-api-codex-bridge-0.8.1.tgz",
    "https://ghproxy.net/https://github.com/momo-api/momo-codex-bridge/releases/download/v0.8.0/momo-api-codex-bridge-0.8.0.tgz",
    "https://ghproxy.net/https://github.com/momo-api/momo-codex-bridge/releases/download/v0.7.7/momo-api-codex-bridge-0.7.7.tgz",
    "https://ghproxy.net/https://github.com/momo-api/momo-codex-bridge/releases/download/v0.7.6/momo-api-codex-bridge-0.7.6.tgz",
    "https://ghproxy.net/https://github.com/momo-api/momo-codex-bridge/releases/download/v0.7.5/momo-api-codex-bridge-0.7.5.tgz",
    "https://ghproxy.net/https://github.com/momo-api/momo-codex-bridge/releases/download/v0.7.4/momo-api-codex-bridge-0.7.4.tgz",
    "https://ghproxy.net/https://github.com/momo-api/momo-codex-bridge/releases/download/v0.7.3/momo-api-codex-bridge-0.7.3.tgz",
    "https://ghproxy.net/https://github.com/momo-api/momo-codex-bridge/releases/download/v0.7.2/momo-api-codex-bridge-0.7.2.tgz",
    "https://ghproxy.net/https://github.com/momo-api/momo-codex-bridge/releases/download/v0.7.1/momo-api-codex-bridge-0.7.1.tgz"
  )
  $tgzPath = [System.IO.Path]::Combine($HOME, ".momo-codex-bridge", "package.tgz")

  $downloaded = $false
  foreach ($url in $urls) {
    try {
      Invoke-WebRequest -Uri $url -OutFile $tgzPath -UseBasicParsing -TimeoutSec 15
      if ((Test-Path $tgzPath) -and (Get-Item $tgzPath).Length -gt 1000) {
        $downloaded = $true
        break
      }
    } catch {}
  }

  if ($downloaded) {
    tar -xzf $tgzPath -C $installDir --strip-components=1
    Remove-Item $tgzPath -Force -ErrorAction SilentlyContinue
  } else {
    Write-Step "Direct download failed, falling back to git clone..."
    git clone https://github.com/momo-api/momo-codex-bridge.git $installDir
  }

# 4. Generate Windows CLI wrappers in bin & compile Native Tray EXE
$binDir = [System.IO.Path]::Combine($installDir, "bin")
$bridgeBin = [System.IO.Path]::Combine($binDir, "momo-codex-bridge.mjs")
$momoapiCmd = [System.IO.Path]::Combine($binDir, "momoapi.cmd")
$momoCmd    = [System.IO.Path]::Combine($binDir, "momo.cmd")
$bridgeCmd = [System.IO.Path]::Combine($binDir, "momo-codex-bridge.cmd")
$switchCmd = [System.IO.Path]::Combine($binDir, "momo-codex-switch.cmd")
$trayExe   = [System.IO.Path]::Combine($binDir, "momoapi-tray.exe")
$trayCs    = [System.IO.Path]::Combine($installDir, "src-tray", "TrayApp.cs")

# If tray.exe is not present but C# source exists, compile it natively using Windows built-in csc.exe
if ((-not (Test-Path $trayExe)) -and (Test-Path $trayCs)) {
  $cscCandidates = @(
    "C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe",
    "C:\Windows\Microsoft.NET\Framework\v4.0.30319\csc.exe"
  )
  foreach ($csc in $cscCandidates) {
    if (Test-Path $csc) {
      & $csc /target:winexe /optimize+ /nologo /out:$trayExe $trayCs /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.dll 2>$null
      if (Test-Path $trayExe) { break }
    }
  }
}

# Clean up any legacy .ps1 CLI wrappers to prevent PowerShell ExecutionPolicy restrictions
Remove-Item -Path (Join-Path $binDir "momo-codex-bridge.ps1") -Force -ErrorAction SilentlyContinue
Remove-Item -Path (Join-Path $binDir "momo-codex-switch.ps1") -Force -ErrorAction SilentlyContinue
Remove-Item -Path (Join-Path $binDir "momoapi.ps1") -Force -ErrorAction SilentlyContinue
Remove-Item -Path (Join-Path $binDir "momo.ps1") -Force -ErrorAction SilentlyContinue

"@echo off`r`nnode `"%~dp0momo-codex-bridge.mjs`" %*" | Set-Content -Path $momoapiCmd -Encoding Ascii
"@echo off`r`nnode `"%~dp0momo-codex-bridge.mjs`" %*" | Set-Content -Path $momoCmd -Encoding Ascii
"@echo off`r`nnode `"%~dp0momo-codex-bridge.mjs`" %*" | Set-Content -Path $bridgeCmd -Encoding Ascii
"@echo off`r`nnode `"%~dp0momo-codex-switch.mjs`" %*" | Set-Content -Path $switchCmd -Encoding Ascii

# 5. Run Setup
Write-Step "Configuring Codex provider & syncing models..."
$setupArgs = @($bridgeBin, "install", "--api-key", $ApiKey, "--endpoint", $Endpoint, "--port", "$Port")
if ($NoAutostart) { $setupArgs += "--no-autostart" }

& node @setupArgs
if ($LASTEXITCODE -ne 0) {
  Write-Err "Setup failed with exit code $LASTEXITCODE"
  exit $LASTEXITCODE
}

# 6. Launch Background Service & System Tray EXE
Write-Step "Starting MOMO Codex Bridge daemon & Native Taskbar Tray..."
& node "$bridgeBin" restart
if (Test-Path $trayExe) {
  Start-Process -FilePath $trayExe -ArgumentList "-p $Port"
  
  # Also create Startup entry and Desktop shortcut
  try {
    $startupCmd = Join-Path ([Environment]::GetFolderPath("Startup")) "momoapi-tray.cmd"
    "@start `"`" `"$trayExe`" -p $Port`r`n" | Set-Content -Path $startupCmd -Encoding Ascii
    
    $desktopDir = [Environment]::GetFolderPath("Desktop")
    $wsh = New-Object -ComObject WScript.Shell
    $shortcut = $wsh.CreateShortcut((Join-Path $desktopDir "MOMO API Proxy.lnk"))
    $shortcut.TargetPath = $trayExe
    $shortcut.Arguments = "-p $Port"
    $shortcut.Description = "MOMO API Proxy Desktop Tray"
    $shortcut.Save()
  } catch {}
}

# 7. Register PATH, environment variables & current session function
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($userPath -notlike "*$binDir*") {
  [Environment]::SetEnvironmentVariable("Path", "$binDir;$userPath", "User")
}
if ($env:Path -notlike "*$binDir*") {
  $env:Path = "$binDir;$env:Path"
}

function global:momoapi { & node "$bridgeBin" @args }
function global:momo { & node "$bridgeBin" @args }
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
Write-Host "Commands available in this and new terminals (short alias 'momoapi' / 'momo'):"
Write-Host "  momoapi          - Start bridge in background (or check status)"
Write-Host "  momoapi status   - Check bridge running status"
Write-Host "  momoapi models   - List available models"
Write-Host "  momoapi restart  - Restart bridge daemon & taskbar tray"
Write-Host "  momoapi stop     - Stop bridge daemon"
Write-Host "  momoapi doctor   - Run health diagnostics"
Write-Host "  momoapi update   - Update to latest version"
Write-Host ""
