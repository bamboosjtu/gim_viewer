# Shared Windows build workflow; dot-source from each tool's build.ps1.
function Assert-GimBuildChild {
    param([string]$Path, [string]$Parent)
    $fullPath = [IO.Path]::GetFullPath($Path)
    $fullParent = [IO.Path]::GetFullPath($Parent).TrimEnd('\', '/')
    if ([IO.Path]::GetDirectoryName($fullPath) -ne $fullParent) {
        throw "Build path must be a direct child of ${fullParent}: $fullPath"
    }
    if (Test-Path -LiteralPath $fullPath) {
        if ((Get-Item -LiteralPath $fullPath -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
            throw "Refusing to modify a linked build path: $fullPath"
        }
    }
}

function Assert-GimBuildTree {
    param([string]$Path)
    $pending = New-Object 'System.Collections.Generic.Stack[string]'
    $pending.Push($Path)
    while ($pending.Count -gt 0) {
        $item = Get-Item -LiteralPath $pending.Pop() -Force
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
            throw "Refusing to move or delete a linked build entry: $($item.FullName)"
        }
        if ($item.PSIsContainer) {
            foreach ($child in Get-ChildItem -LiteralPath $item.FullName -Force) {
                $pending.Push($child.FullName)
            }
        }
    }
}

function Invoke-GimToolBuild {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$ToolRoot,
        [Parameter(Mandatory = $true)][string]$SpecName,
        [Parameter(Mandatory = $true)][string]$ExeName,
        [Parameter(Mandatory = $true)][string]$RequiredImports,
        [string]$Python = 'python',
        [switch]$SkipInstall,
        [switch]$NoVenv,
        [switch]$Publish,
        [string]$SmokeDir = '',
        [string]$VerifyScript = ''
    )
    $ErrorActionPreference = 'Stop'
    $toolRoot = (Get-Item -LiteralPath $ToolRoot).FullName
    $spec = Join-Path $toolRoot $SpecName
    $requirements = Join-Path $toolRoot 'requirements-build.txt'
    foreach ($path in @($spec, $requirements)) {
        Assert-GimBuildChild -Path $path -Parent $toolRoot
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Required build source missing: $path" }
    }
    if ($SmokeDir -ne '') {
        $SmokeDir = (Get-Item -LiteralPath $SmokeDir).FullName
        if (-not (Test-Path -LiteralPath $SmokeDir -PathType Container)) {
            throw "Smoke input must be an unpacked GIM directory: $SmokeDir"
        }
    }
    if ($VerifyScript -ne '') {
        Assert-GimBuildChild -Path $VerifyScript -Parent $toolRoot
        if (-not (Test-Path -LiteralPath $VerifyScript -PathType Leaf)) { throw "Verifier missing: $VerifyScript" }
    }
    $venv = Join-Path $toolRoot '.venv'
    $work = Join-Path $toolRoot '_build'
    $dist = Join-Path $toolRoot 'dist'
    foreach ($path in @($venv, $work, $dist)) {
        Assert-GimBuildChild -Path $path -Parent $toolRoot
        if ((Test-Path -LiteralPath $path) -and -not (Test-Path -LiteralPath $path -PathType Container)) {
            throw "Expected a build directory: $path"
        }
    }
    $buildPython = $Python
    if (-not $NoVenv) {
        $buildPython = Join-Path $venv 'Scripts/python.exe'
        if (-not (Test-Path -LiteralPath $buildPython -PathType Leaf)) {
            if ($SkipInstall) { throw 'Project environment missing; rerun without -SkipInstall' }
            & $Python -m venv $venv
            if ($LASTEXITCODE -ne 0) { throw 'Failed to create project Python environment' }
        }
        if (-not $SkipInstall) {
            # Public PyPI, wheels only, no stale cached downloads. Retry once.
            $pipArgs = @(
                '-m', 'pip', '--isolated', 'install', '--disable-pip-version-check',
                '--index-url', 'https://pypi.org/simple', '--no-cache-dir',
                '--only-binary', ':all:', '-r', $requirements
            )
            & $buildPython @pipArgs
            if ($LASTEXITCODE -ne 0) {
                Write-Warning 'Dependency install failed; retrying once without the pip cache'
                & $buildPython @pipArgs
            }
            if ($LASTEXITCODE -ne 0) { throw 'Failed to install packaging dependencies' }
        }
    }
    & $buildPython -c $RequiredImports
    if ($LASTEXITCODE -ne 0) { throw 'Packaging dependencies missing; install requirements-build.txt first' }

    New-Item -ItemType Directory -Path $work, $dist -Force | Out-Null
    $exe = Join-Path $dist $ExeName
    $bundle = Join-Path $dist ([IO.Path]::GetFileNameWithoutExtension($ExeName))
    $zip = [IO.Path]::ChangeExtension($exe, '.zip')
    $previous = Join-Path $work ('previous-' + [Guid]::NewGuid().ToString('N'))
    Assert-GimBuildChild -Path $previous -Parent $work
    $oldOutputs = @($exe, $bundle, $zip, (Join-Path $dist '_internal'))
    foreach ($path in $oldOutputs) {
        Assert-GimBuildChild -Path $path -Parent $dist
        if (Test-Path -LiteralPath $path) { Assert-GimBuildTree -Path $path }
    }
    $unexpected = @(Get-ChildItem -LiteralPath $dist -Filter '*.exe' -File -Force | Where-Object Name -ne $ExeName)
    if ($unexpected.Count -ne 0) { throw "Unexpected executables in ${dist}: $($unexpected.Name -join ', ')" }
    foreach ($path in $oldOutputs) {
        if (Test-Path -LiteralPath $path) {
            New-Item -ItemType Directory -Path $previous -Force | Out-Null
            Move-Item -LiteralPath $path -Destination $previous
        }
    }
    try {
        $oldConfigDir = $env:PYINSTALLER_CONFIG_DIR
        try {
            $env:PYINSTALLER_CONFIG_DIR = Join-Path $work '.pyinstaller-cache'
            & $buildPython -m PyInstaller --noconfirm --clean --workpath $work --distpath $dist $spec
            $buildExitCode = $LASTEXITCODE
        } finally { $env:PYINSTALLER_CONFIG_DIR = $oldConfigDir }
        if ($buildExitCode -ne 0) { throw 'PyInstaller build failed' }
        $exes = @(Get-ChildItem -LiteralPath $dist -Filter '*.exe' -File -Force)
        if ($exes.Count -ne 1 -or $exes[0].Name -ne $ExeName -or $exes[0].Length -lt 10MB) {
            throw "Expected one complete single-file executable: $exe"
        }
        foreach ($path in @($bundle, (Join-Path $dist '_internal'))) {
            if (Test-Path -LiteralPath $path) { throw "Unexpected onedir output: $path" }
        }
        if ($VerifyScript -ne '') {
            & $buildPython $VerifyScript $exe
            if ($LASTEXITCODE -ne 0) { throw 'Packaged archive verification failed' }
        }
        # Exercise the actual bootloader and imports, including TEMP creation.
        $process = Start-Process -FilePath $exe -ArgumentList '--self-check' -WindowStyle Hidden -PassThru
        $null = $process.Handle
        try {
            if (-not $process.WaitForExit(60000)) {
                $process.Kill()
                throw 'Packaged startup check timed out; check TEMP permissions and Windows integrity labels'
            }
            if ($process.ExitCode -ne 0) {
                throw "Packaged startup check failed (exit $($process.ExitCode)); see tools/README.md"
            }
        } finally { $process.Dispose() }
        if ($SmokeDir -ne '') {
            & $exe --smoke $SmokeDir
            if ($LASTEXITCODE -ne 0) { throw "Frozen --smoke failed: $SmokeDir" }
        }
        if ($Publish) {
            Compress-Archive -LiteralPath $exe -DestinationPath $zip -CompressionLevel Optimal -Force
            Write-Output "Published: $zip"
        }
    } catch {
        throw "Build failed. Previous outputs, if any, are in ${previous}. $($_.Exception.Message)"
    }
    if (Test-Path -LiteralPath $previous) {
        Assert-GimBuildChild -Path $previous -Parent $work
        Assert-GimBuildTree -Path $previous
        Remove-Item -LiteralPath $previous -Recurse -Force
    }
    Write-Output "Built and startup-checked: $exe"
}
