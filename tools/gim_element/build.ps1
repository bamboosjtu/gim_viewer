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
& $venvPython -c 'import PyInstaller, PySide6, py7zr'
if ($LASTEXITCODE -ne 0) { throw 'Packaging dependencies missing; rerun without -SkipInstall' }
& $venvPython -m PyInstaller --clean -y --workpath (Join-Path $toolRoot '_build') --distpath (Join-Path $toolRoot 'dist') (Join-Path $toolRoot '_build/GIM实体盘点器.spec')
if ($LASTEXITCODE -ne 0) { throw 'PyInstaller build failed' }
$bundle = Join-Path $toolRoot 'dist/GIM实体盘点器'
foreach ($entry in @('GIM实体盘点器.exe', '_internal/catalog.json', '_internal/PySide6/plugins/platforms/qwindows.dll')) {
    if (-not (Test-Path -LiteralPath (Join-Path $bundle $entry))) { throw "Incomplete package: $entry" }
}
if (Test-Path -LiteralPath (Join-Path $bundle '_internal/icuuc.dll')) { throw 'Incompatible PATH ICU was bundled instead of the Windows native ICU API' }
Write-Output (Join-Path $bundle 'GIM实体盘点器.exe')
