param(
    [string]$Python = 'python',
    [switch]$SkipInstall,
    [switch]$NoVenv,
    [switch]$Publish
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '../build-common.ps1')

Invoke-GimToolBuild -ToolRoot $PSScriptRoot -SpecName 'viewer.spec' -ExeName 'GIM设备查看器.exe' `
    -RequiredImports 'import PyInstaller, PySide6, py7zr, PySide6.QtWebEngineWidgets' `
    -Python $Python -SkipInstall:$SkipInstall -NoVenv:$NoVenv -Publish:$Publish
