$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
& (Join-Path $PSScriptRoot 'build-tray.ps1')
$compiler = @('C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe', 'C:\Windows\Microsoft.NET\Framework\v4.0.30319\csc.exe') | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
$testExe = Join-Path $repoRoot 'dist\TrayPresentationTests.exe'
& $compiler /nologo /target:exe ('/out:' + $testExe) ('/reference:' + (Join-Path $repoRoot 'dist\MomoApiProxyTray.exe')) (Join-Path $repoRoot 'test\TrayPresentationTests.cs')
if ($LASTEXITCODE -ne 0) { throw 'Tray tests compilation failed' }
& $testExe
if ($LASTEXITCODE -ne 0) { throw 'Tray tests failed' }
$editorExe = Join-Path $repoRoot 'dist\TrayEditorTests.exe'
& $compiler /nologo /target:exe ('/out:' + $editorExe) ('/reference:' + (Join-Path $repoRoot 'dist\MomoApiProxyTray.exe')) /reference:System.Windows.Forms.dll /reference:System.Drawing.dll (Join-Path $repoRoot 'test\TrayEditorTests.cs')
if ($LASTEXITCODE -ne 0) { throw 'Tray editor tests compilation failed' }
& $editorExe
if ($LASTEXITCODE -ne 0) { throw 'Tray editor tests failed' }
