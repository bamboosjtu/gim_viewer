param(
    [string]$Python = 'python',
    [switch]$SkipInstall,
    [switch]$NoVenv,
    [switch]$Publish
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '../build-common.ps1')

Invoke-GimToolBuild -ToolRoot $PSScriptRoot -SpecName 'element.spec' -ExeName 'GIM实体盘点器.exe' `
    -RequiredImports 'import PyInstaller, PySide6, py7zr' `
    -VerifyScript (Join-Path $PSScriptRoot 'verify_package.py') `
    -Python $Python -SkipInstall:$SkipInstall -NoVenv:$NoVenv -Publish:$Publish
