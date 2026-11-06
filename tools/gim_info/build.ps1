param(
    [string]$Python = 'python',
    [switch]$SkipInstall,
    [switch]$NoVenv,
    [switch]$Publish,
    [string]$SmokeDir = ''
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '../build-common.ps1')

Invoke-GimToolBuild -ToolRoot $PSScriptRoot -SpecName 'reader.spec' -ExeName 'GIM信息阅读器.exe' `
    -RequiredImports 'import PyInstaller, PySide6' -SmokeDir $SmokeDir `
    -Python $Python -SkipInstall:$SkipInstall -NoVenv:$NoVenv -Publish:$Publish
