$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '../../build-paths.ps1')

function Assert-Rejected {
    param([scriptblock]$Action, [string]$Message)
    $rejected = $false
    try { & $Action } catch { $rejected = $true }
    if (-not $rejected) { throw "Expected rejection: $Message" }
}

$tempParent = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../../../tmp/tests/gim_blender-build-safety'))
New-Item -ItemType Directory -Path $tempParent -Force | Out-Null
$env:TEMP = $tempParent; $env:TMP = $tempParent; $env:TMPDIR = $tempParent
$root = Join-Path $tempParent ('gim-build-safety-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $root -Force | Out-Null
try {
    $tool = Join-Path $root 'tool with spaces'
    $outside = Join-Path $root 'outside'
    New-Item -ItemType Directory -Path $tool, $outside | Out-Null
    $dist = Join-Path $tool 'dist'
    New-Item -ItemType Directory -Path $dist | Out-Null
    Assert-Rejected { Assert-GimBuildChild -Path (Join-Path $tool '../outside') -Parent $tool } 'parent traversal'
    Assert-Rejected { Assert-GimBuildChild -Path $outside -Parent $tool } 'sibling path'
    $linked = Join-Path $tool '_build'
    New-Item -ItemType Junction -Path $linked -Target $outside | Out-Null
    Assert-Rejected { Assert-GimBuildChild -Path $linked -Parent $tool } 'linked output directory'
    $nested = Join-Path $dist 'old-bundle'
    New-Item -ItemType Directory -Path $nested | Out-Null
    New-Item -ItemType Junction -Path (Join-Path $nested 'nested-link') -Target $outside | Out-Null
    Assert-Rejected { Assert-GimBuildTree -Path $nested } 'nested link in old output'
    Write-Output 'PASS: path boundaries and linked outputs'
} finally {
    # Remove links themselves before recursive cleanup, including on Windows PS 5.1.
    foreach ($link in @((Join-Path $root 'tool with spaces/_build'), (Join-Path $root 'tool with spaces/dist/old-bundle/nested-link'))) {
        if (Test-Path -LiteralPath $link) { [IO.Directory]::Delete($link) }
    }
    Assert-GimBuildChild -Path $root -Parent $tempParent
    Assert-GimBuildTree -Path $root
    Remove-Item -LiteralPath $root -Recurse -Force
}
