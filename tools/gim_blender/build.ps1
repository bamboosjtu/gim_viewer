param([string]$Python='python',[switch]$SkipInstall,[switch]$NoVenv,[switch]$Publish,[string]$BlenderDirectory='')
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'build-paths.ps1')
$workspace=Split-Path (Split-Path $PSScriptRoot)
$taskTemp=Join-Path $workspace 'tmp/tool-build/gim-blender'
New-Item -ItemType Directory -Force -Path $taskTemp | Out-Null
$env:TEMP=$taskTemp; $env:TMP=$taskTemp; $env:TMPDIR=$taskTemp
$env:npm_config_cache=Join-Path $taskTemp 'npm-cache'
$env:PYTHONDONTWRITEBYTECODE='1'
Assert-GimBuildChild -Path (Join-Path $PSScriptRoot '.venv') -Parent $PSScriptRoot
Push-Location $PSScriptRoot
try {
    if(-not $SkipInstall) { & npm ci --no-audit --no-fund; if($LASTEXITCODE -ne 0){throw 'npm ci failed'} }
    & npm run build
    if($LASTEXITCODE -ne 0){throw 'Standalone engine build failed'}
    $runtime=Join-Path $PSScriptRoot 'assets/runtime'
    New-Item -ItemType Directory -Force -Path $runtime | Out-Null
    Copy-Item -LiteralPath (Get-Command node.exe -ErrorAction Stop).Source -Destination (Join-Path $runtime 'node.exe')
    $buildPython=$Python
    if(-not $NoVenv) {
        $buildPython=Join-Path $PSScriptRoot '.venv/Scripts/python.exe'
        if(-not (Test-Path -LiteralPath $buildPython)) {
            if($SkipInstall){throw 'Tool environment missing'}
            & $Python -m venv (Join-Path $PSScriptRoot '.venv')
            if($LASTEXITCODE -ne 0){throw 'venv creation failed'}
        }
        if(-not $SkipInstall) {
            & $buildPython -m pip --isolated install --disable-pip-version-check --no-cache-dir --only-binary :all: -r (Join-Path $PSScriptRoot 'requirements-build.txt')
            if($LASTEXITCODE -ne 0){throw 'Python dependency installation failed'}
        }
    }
    $dist=Join-Path $PSScriptRoot 'dist'
    $bundle=Join-Path $dist 'gim_blender'
    foreach($p in @($dist,(Join-Path $PSScriptRoot '.venv'))) { Assert-GimBuildChild -Path $p -Parent $PSScriptRoot }
    New-Item -ItemType Directory -Force -Path $dist | Out-Null
    Assert-GimBuildChild -Path $bundle -Parent $dist
    $previous=Join-Path $taskTemp ('previous-'+[Guid]::NewGuid().ToString('N'))
    Assert-GimBuildChild -Path $previous -Parent $taskTemp
    if(Test-Path -LiteralPath $bundle) { Assert-GimBuildTree -Path $bundle; Move-Item -LiteralPath $bundle -Destination $previous }
    try {
        $env:PYINSTALLER_CONFIG_DIR=Join-Path $taskTemp 'pyinstaller-cache'
        & $buildPython -m PyInstaller --noconfirm --clean --workpath (Join-Path $taskTemp 'build') --distpath $dist (Join-Path $PSScriptRoot 'tool.spec')
        if($LASTEXITCODE -ne 0){throw 'PyInstaller failed'}
        & $buildPython (Join-Path $PSScriptRoot 'package_assets.py')
        if($LASTEXITCODE -ne 0){throw 'Independent service packaging failed'}
        if($BlenderDirectory) {
            $blenderRoot=(Get-Item -LiteralPath $BlenderDirectory).FullName
            if(-not (Test-Path -LiteralPath (Join-Path $blenderRoot 'blender.exe'))){throw 'Blender directory has no blender.exe'}
            $blenderRuntime=Join-Path $bundle 'runtime'
            New-Item -ItemType Directory -Force -Path $blenderRuntime | Out-Null
            Copy-Item -LiteralPath $blenderRoot -Destination (Join-Path $blenderRuntime 'blender') -Recurse
        }
        & $buildPython (Join-Path $PSScriptRoot 'package_notices.py')
        if($LASTEXITCODE -ne 0){throw 'Runtime notice collection failed'}
        # Use CreateProcess directly; do not use shell activation for GUI startup checks.
        $info=New-Object System.Diagnostics.ProcessStartInfo
        $info.FileName=Join-Path $bundle 'gim_blender.exe'
        $info.Arguments='--self-check'; $info.UseShellExecute=$false; $info.CreateNoWindow=$true
        $check=[Diagnostics.Process]::Start($info)
        try {
            if(-not $check.WaitForExit(30000)){ $check.Kill(); throw 'Startup check timed out' }
            if($check.ExitCode -ne 0){throw 'Startup check failed; see workspace tmp/tool-build/gim-blender/gim-blender-startup-error.txt'}
        } finally { $check.Dispose() }
        if($Publish) {
            $zip=Join-Path $dist 'gim_blender.zip'
            Assert-GimBuildChild -Path $zip -Parent $dist
            if(Test-Path -LiteralPath $zip){Assert-GimBuildTree -Path $zip}
            & $buildPython (Join-Path $PSScriptRoot 'package_zip.py') --out $zip
            if($LASTEXITCODE -ne 0){throw 'Directory package publication failed'}
            $hash=(Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
            $sha=Join-Path $dist 'gim_blender.zip.sha256'
            Assert-GimBuildChild -Path $sha -Parent $dist
            Set-Content -LiteralPath $sha -Value "$hash  gim_blender.zip" -Encoding ascii
            Write-Output "Published: $zip"
        }
    } catch { throw "Build failed. Previous build preserved at ${previous}. $_" }
    Write-Output "Built and startup-checked: $bundle/gim_blender.exe"
} finally { Pop-Location }
