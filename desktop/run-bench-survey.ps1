param(
    # Optional: override the current HEAD short hash, e.g. -Commit 104924c
    [string]$Commit
)

$ErrorActionPreference = 'Stop'

# Run all relative paths from the directory containing this script.
Push-Location -LiteralPath $PSScriptRoot
try {
    Write-Host "=== GIM Viewer benchmark survey ===" -ForegroundColor Cyan
    Write-Host "Working directory: $((Get-Location).Path)"

    # Resolve the commit used in output directory names.
    if ([string]::IsNullOrWhiteSpace($Commit)) {
        $Commit = (& git log -1 --format=%h).Trim()
        if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($Commit)) {
            throw 'Unable to read the current Git commit. Run this script inside the repository.'
        }
    }

    if ($Commit -notmatch '^[0-9a-fA-F]{7,40}$') {
        throw "Invalid commit hash '$Commit'. Expected 7-40 hexadecimal characters."
    }

    Write-Host "Commit: $Commit" -ForegroundColor Green

    # Warn when the working tree contains uncommitted changes.
    $gitStatus = & git status --porcelain
    if ($LASTEXITCODE -ne 0) {
        throw 'Unable to read Git working-tree status.'
    }
    if ($gitStatus) {
        Write-Warning 'The working tree has uncommitted changes. The output folder uses the HEAD commit hash, which does not identify those changes.'
    }

    # Build once and capture the acceptance manifest path from the build output.
    Write-Host "`n>>> npm run bench -- build" -ForegroundColor Cyan
    $buildOutput = & npm run bench -- build 2>&1
    $buildExitCode = $LASTEXITCODE
    $buildOutput | ForEach-Object { Write-Host $_ }

    if ($buildExitCode -ne 0) {
        throw "Benchmark build failed with exit code $buildExitCode. Batch runs were not started."
    }

    $buildText = ($buildOutput | ForEach-Object { [string]$_ }) -join [Environment]::NewLine
    $manifestMatch = [regex]::Match(
        $buildText,
        '(?im)Build manifest:\s*(.+?acceptance-build\.json)'
    )

    if (-not $manifestMatch.Success) {
        throw 'Build completed, but the acceptance-build.json path could not be found in its output.'
    }

    $manifestPath = $manifestMatch.Groups[1].Value.Trim().Trim('"')
    if (-not [System.IO.Path]::IsPathRooted($manifestPath)) {
        $manifestPath = Join-Path (Get-Location).Path $manifestPath
    }
    $manifestPath = [System.IO.Path]::GetFullPath($manifestPath)

    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
        throw "Build manifest does not exist: $manifestPath"
    }

    Write-Host "`nUsing build manifest: $manifestPath" -ForegroundColor Green

    function Invoke-BenchBatch {
        param(
            [Parameter(Mandatory = $true)]
            [string[]]$BenchArgs
        )

        Write-Host "`n>>> npm run bench -- $($BenchArgs -join ' ')" -ForegroundColor Cyan
        & npm run bench -- @BenchArgs
        $exitCode = $LASTEXITCODE
        if ($exitCode -ne 0) {
            throw "Benchmark batch failed with exit code $exitCode. Remaining batches were not started."
        }
    }

    # L1: substation registry
    Invoke-BenchBatch -BenchArgs @(
        'batch',
        '--build', $manifestPath,
        '--registry', '..\benchmarks\l1\substation01-04.json',
        '--output', "../output/substation-survey-$Commit",
        '--preset', 'baseline',
        '--anonymize', 'false'
    )

    # L1: line registry
    Invoke-BenchBatch -BenchArgs @(
        'batch',
        '--build', $manifestPath,
        '--registry', '..\benchmarks\l1\line01-06.json',
        '--output', "../output/substation-survey-$Commit",
        '--preset', 'baseline',
        '--anonymize', 'false'
    )

    # L0: local substation demo directory
    Invoke-BenchBatch -BenchArgs @(
        'batch',
        '--build', $manifestPath,
        '--directory', '..\demo\变电站通用设计模型\',
        '--output', "../output/l0-survey-$Commit",
        '--preset', 'baseline',
        '--anonymize', 'false'
    )

    Write-Host "`n=== All benchmark batches completed ===" -ForegroundColor Green
    Write-Host "L1 output: ../output/substation-survey-$Commit"
    Write-Host "L0 output: ../output/l0-survey-$Commit"
}
finally {
    Pop-Location
}
