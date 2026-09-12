[CmdletBinding()]
param([switch]$Embed)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$trayDist = Join-Path $repoRoot 'dist'
New-Item -ItemType Directory -Path $trayDist -Force | Out-Null
$package = Get-Content -LiteralPath (Join-Path $repoRoot 'package.json') -Raw | ConvertFrom-Json
$version = [string]$package.version
if ($version -notmatch '^(\d+\.\d+\.\d+)(?:-[A-Za-z0-9.-]+)?$') { throw 'Invalid package version' }
$fileVersion = $Matches[1] + '.0'
$compiler = @('C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe', 'C:\Windows\Microsoft.NET\Framework\v4.0.30319\csc.exe') | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $compiler) { throw 'Windows .NET Framework C# compiler not found' }
$metadata = Join-Path $trayDist 'TrayAssemblyInfo.cs'
# Generated build metadata, never a separately maintained version constant.
$attributes = @(
  'using System.Reflection;',
  '[assembly: AssemblyTitle("MOMO API Proxy Tray")]',
  '[assembly: AssemblyDescription("MOMO API Proxy desktop companion")]',
  '[assembly: AssemblyProduct("MOMO API Proxy")]',
  '[assembly: AssemblyCompany("MOMO API")]',
  ('[assembly: AssemblyVersion("' + $fileVersion + '")]'),
  ('[assembly: AssemblyFileVersion("' + $fileVersion + '")]'),
  ('[assembly: AssemblyInformationalVersion("' + $version + '")]')
)
[IO.File]::WriteAllLines($metadata, $attributes)
$output = Join-Path $trayDist 'MomoApiProxyTray.exe'
& $compiler /nologo /target:winexe /optimize+ ('/out:' + $output) (Join-Path $repoRoot 'src-tray\TrayApp.cs') $metadata /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.dll /reference:System.Core.dll /reference:Microsoft.CSharp.dll
if ($LASTEXITCODE -ne 0) { throw 'Tray compilation failed' }
if ($Embed) {
  & node (Join-Path $PSScriptRoot 'embed-tray.mjs')
  if ($LASTEXITCODE -ne 0) { throw 'Tray embedding failed' }
}
$stream = [IO.File]::OpenRead($output)
$sha256 = [Security.Cryptography.SHA256]::Create()
try {
  $digest = ([BitConverter]::ToString($sha256.ComputeHash($stream))).Replace('-', '').ToLowerInvariant()
} finally {
  $sha256.Dispose()
  $stream.Dispose()
}
[pscustomobject]@{ path=$output; version=$version; sha256=$digest } | ConvertTo-Json
