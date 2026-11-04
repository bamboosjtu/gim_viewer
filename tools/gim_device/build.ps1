param(
    [string]$Python = 'python',
    [switch]$SkipInstall
)
$ErrorActionPreference = 'Stop'
$toolRoot = $PSScriptRoot
$venvPython = Join-Path $toolRoot '.venv/Scripts/python.exe'
if (-not (Test-Path -LiteralPath $venvPython)) {
    & $Python -m venv (Join-Path $toolRoot '.venv')
    if ($LASTEXITCODE -ne 0) { throw 'Failed to create project Python environment' }
}
if (-not $SkipInstall) {
    & $venvPython -m pip install --disable-pip-version-check --index-url https://pypi.org/simple -r (Join-Path $toolRoot 'requirements-build.txt')
    if ($LASTEXITCODE -ne 0) { throw 'Failed to install packaging dependencies' }
}
& $venvPython -c 'import PyInstaller, PySide6, py7zr, PySide6.QtWebEngineWidgets'
if ($LASTEXITCODE -ne 0) { throw 'Packaging dependencies missing; rerun without -SkipInstall' }
& $venvPython -m PyInstaller --noconfirm --clean --workpath (Join-Path $toolRoot '_build') --distpath (Join-Path $toolRoot 'dist') (Join-Path $toolRoot 'viewer.spec')
if ($LASTEXITCODE -ne 0) { throw 'PyInstaller build failed' }
$exe = Join-Path $toolRoot 'dist/GIM设备查看器.exe'
if (-not (Test-Path -LiteralPath $exe)) { throw 'Incomplete package: missing dist/GIM设备查看器.exe' }
Copy-Item -LiteralPath $exe -Destination (Join-Path $toolRoot 'GIM设备查看器.exe') -Force
Write-Output $exe
