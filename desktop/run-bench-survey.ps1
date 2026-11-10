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
    # Windows PowerShell turns redirected native stderr into ErrorRecords.
    # Keep warnings in the captured log and judge native success by its exit code.
    $buildErrorPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $buildOutput = @(& npm run bench -- build 2>&1)
        $buildExitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $buildErrorPreference
    }
    $buildOutput | ForEach-Object { Write-Host $_ }

    $scriptErrors = @($buildOutput | Where-Object {
        $_ -is [System.Management.Automation.ErrorRecord] -and
        $_.FullyQualifiedErrorId -notlike 'NativeCommandError*'
    })
    if ($scriptErrors.Count -gt 0) { throw $scriptErrors[0] }

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
    $summaryArgs = [System.Collections.Generic.List[string]]::new()

    function Invoke-BenchBatch {
        param(
            [Parameter(Mandatory = $true)]
            [string]$SummaryGroup,
            [Parameter(Mandatory = $true)]
            [string[]]$BenchArgs
        )

        Write-Host "`n>>> npm run bench -- $($BenchArgs -join ' ')" -ForegroundColor Cyan
        $completion = $null
        & npm run bench -- @BenchArgs | ForEach-Object {
            Write-Host $_
            if ([string]$_ -like '{*') {
                try { $message = [string]$_ | ConvertFrom-Json -ErrorAction Stop }
                catch { return }
                if ($message.status -and $message.outcome -and $message.csv) { $completion = $message }
            }
        }
        $exitCode = $LASTEXITCODE
        $expectedExit = switch ($completion.outcome) { 'PASS' { 0 } 'PARTIAL' { 0 } 'FAIL' { 1 } 'INCONCLUSIVE' { 2 } default { -1 } }
        if ($completion.status -ne 'COMPLETE' -or $expectedExit -lt 0 -or $exitCode -ne $expectedExit) {
            throw "Benchmark batch did not complete normally (exit code $exitCode). No completed result was accepted."
        }
        $summaryArgs.Add($SummaryGroup)
        if ($completion.privateResults) { $summaryArgs.Add($completion.privateResults) } else { $summaryArgs.Add((Join-Path (Split-Path -Parent $completion.csv) 'results.json')) }
        Write-Host "Batch completed; recorded outcome: $($completion.outcome)" -ForegroundColor Cyan
    }

    # L1: substation registry
    Invoke-BenchBatch -SummaryGroup '--substation' -BenchArgs @(
        'batch',
        '--build', $manifestPath,
        '--registry', '..\benchmarks\l1\substation01-04.json',
        '--output', "../output/substation-survey-$Commit",
        '--preset', 'baseline',
        '--anonymize', 'false'
    )

    # L1: line registry
    Invoke-BenchBatch -SummaryGroup '--line' -BenchArgs @(
        'batch',
        '--build', $manifestPath,
        '--registry', '..\benchmarks\l1\line01-06.json',
        '--output', "../output/line-survey-$Commit",
        '--preset', 'baseline',
        '--anonymize', 'false'
    )

    # L0: local substation demo directory
    Invoke-BenchBatch -SummaryGroup '--substation' -BenchArgs @(
        'batch',
        '--build', $manifestPath,
        '--directory', '..\demo\变电站通用设计模型\',
        '--output', "../output/l0-survey-$Commit",
        '--preset', 'baseline',
        '--anonymize', 'false'
    )

    Write-Host "`n=== Benchmark survey completed; summary follows ===" -ForegroundColor Cyan
    Write-Host "L1 substation output: ../output/substation-survey-$Commit"
    Write-Host "L1 line output: ../output/line-survey-$Commit"
    Write-Host "L0 output: ../output/l0-survey-$Commit"
    & node (Join-Path $PSScriptRoot 'scripts/with-workspace-temp.mjs') (Join-Path $PSScriptRoot 'scripts/benchmarks/survey-summary.mjs') @summaryArgs
    if ($LASTEXITCODE -ne 0) { throw 'Unable to summarize the completed benchmark reports.' }
    exit 0
}
finally {
    Pop-Location
}
