[CmdletBinding()]
param(
  [string]$ApiKey = "",
  [string]$Endpoint = "https://momoapi.us",
  [int]$Port = 18789,
  [switch]$NoAutostart,
  [switch]$NoImagePlugin
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
  Write-Err "Node.js 22+ is required. Please download and install Node.js from https://nodejs.org/"
  exit 1
}

$nodeVer = (& $node.Source --version).Trim().TrimStart("v")
$major = [int]($nodeVer.Split(".")[0])
if ($major -lt 22) {
  Write-Err "Node.js version must be >= 22; found v$nodeVer. Please update Node.js."
  exit 1
}
Write-Step "Found Node.js v$nodeVer"

# 2. Resolve API Key
$installRoot = [System.IO.Path]::Combine($HOME, ".momoapi-proxy")
$installDir = [System.IO.Path]::Combine($installRoot, "app")
$savedSettingsPath = [System.IO.Path]::Combine($installRoot, "settings.json")
if (-not $ApiKey) {
  $ApiKey = $env:MOMO_API_KEY
}
if (-not $ApiKey -and (Test-Path -LiteralPath $savedSettingsPath)) {
  try {
    $savedSettings = Get-Content -LiteralPath $savedSettingsPath -Raw | ConvertFrom-Json
    if ($savedSettings.apiKey) { $ApiKey = [string]$savedSettings.apiKey }
  } catch {}
}
if (-not $ApiKey) {
  $ApiKey = Read-Host "Enter your MOMO API Key (e.g. sk-momo-...)"
}
if (-not $ApiKey) {
  Write-Err "MOMO API Key is required."
  exit 1
}

# 3. Download and verify an immutable package from the official manifest.
$stagingDir = [System.IO.Path]::Combine($installRoot, ".momoapi-proxy-update-install-" + [guid]::NewGuid().ToString("N"))
$tgzPath = [System.IO.Path]::Combine($installRoot, "package.tgz")
New-Item -ItemType Directory -Path $installRoot, $stagingDir -Force | Out-Null
Write-Step "Reading and verifying the official release manifest..."
$manifestPath = [System.IO.Path]::Combine($installRoot, "bridge-latest.json")
Invoke-WebRequest -Uri "https://momoapi.us/install/bridge-latest.json" -OutFile $manifestPath -UseBasicParsing -TimeoutSec 20
$manifest = Get-Content -Raw $manifestPath | ConvertFrom-Json
if ($manifest.version -notmatch '^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$' -or $manifest.sha256 -notmatch '^[a-fA-F0-9]{64}$') { throw "Official release manifest is invalid or missing SHA-256." }
$version = [string]$manifest.version
$expectedSha = ([string]$manifest.sha256).ToLowerInvariant()
$urls = @("https://momoapi.us/install/packages/momoapi-proxy-$version.tgz", "https://github.com/momo-api/momoapi-proxy/releases/download/v$version/momoapi-proxy-$version.tgz")
$downloaded = $false
foreach ($url in $urls) {
  try {
    Invoke-WebRequest -Uri $url -OutFile $tgzPath -UseBasicParsing -TimeoutSec 60
    if ((Get-FileHash -Algorithm SHA256 -LiteralPath $tgzPath).Hash.ToLowerInvariant() -eq $expectedSha) { $downloaded = $true; break }
  } catch {}
}
if (-not $downloaded) { throw "Unable to download a release package matching the official SHA-256." }
tar -xzf $tgzPath -C $stagingDir --strip-components=1 --no-same-owner --no-same-permissions
$package = Get-Content -Raw (Join-Path $stagingDir "package.json") | ConvertFrom-Json
if ([string]$package.version -ne $version) { throw "Package version does not match the verified manifest." }
if (Test-Path -LiteralPath $installDir) {
  $previousPackage = Get-Content -LiteralPath (Join-Path $installDir "package.json") -Raw | ConvertFrom-Json
  $previousVersion = [string]$previousPackage.version
  if ($previousVersion -notmatch '^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$') { throw "Existing proxy package version is invalid." }
  $supervisorPath = [System.IO.Path]::Combine($installRoot, ".momoapi-proxy-install-supervisor-" + [guid]::NewGuid().ToString("N") + ".mjs")
  Copy-Item -LiteralPath (Join-Path $stagingDir "src\update-supervisor.mjs") -Destination $supervisorPath -Force
  Write-Step "Safely upgrading existing MOMO API Proxy v$previousVersion to v$version..."
  $supervisorArgs = @(
    $supervisorPath,
    "--root", $installDir,
    "--staging", $stagingDir,
    "--backup", ($installDir + ".update-backup"),
    "--target", $version,
    "--previous", $previousVersion,
    "--port", "$Port",
    "--parent-pid", "0"
  )
  if ($NoImagePlugin) { $supervisorArgs += "--no-image-plugin" }
  & node @supervisorArgs
  $supervisorExit = $LASTEXITCODE
  Remove-Item -LiteralPath $supervisorPath -Force -ErrorAction SilentlyContinue
  if ($supervisorExit -ne 0) { throw "Existing proxy upgrade failed safely; the previous version was restored." }
  $activatedPackage = Get-Content -LiteralPath (Join-Path $installDir "package.json") -Raw | ConvertFrom-Json
  if ([string]$activatedPackage.version -ne $version) { throw "Existing proxy upgrade did not activate the verified target version." }
} else {
  Move-Item -LiteralPath $stagingDir -Destination $installDir
}
Remove-Item $tgzPath, $manifestPath -Force -ErrorAction SilentlyContinue

# 4. Generate Windows CLI wrappers in bin & compile Native Tray EXE
$binDir = [System.IO.Path]::Combine($installDir, "bin")
$bridgeBin = [System.IO.Path]::Combine($binDir, "momoapi-proxy.mjs")
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
if ($NoImagePlugin) { $setupArgs += "--no-image-plugin" }

& node @setupArgs
if ($LASTEXITCODE -ne 0) {
  Write-Err "Setup failed with exit code $LASTEXITCODE"
  exit $LASTEXITCODE
}

# 6. Launch Background Service & System Tray EXE
Write-Step "Starting MOMO Codex Bridge daemon & Native Taskbar Tray..."
& node "$bridgeBin" restart
$cleanTrayExe = [System.IO.Path]::Combine($HOME, ".momoapi-proxy", "bin", "MomoApiProxyTray.exe")
if (Test-Path $cleanTrayExe) {
  Start-Process -FilePath $cleanTrayExe -ArgumentList "-p $Port"
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
if (-not $NoImagePlugin) {
  Write-Host "MOMO Image plugin is installed automatically. Start a new Codex conversation to load it." -ForegroundColor Yellow
}
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
