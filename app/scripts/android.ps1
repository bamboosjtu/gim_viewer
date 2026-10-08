param([ValidateSet('init','dev','build')][string]$Task='build',[string]$SdkRoot=$env:ANDROID_HOME,[string]$NdkRoot=$env:NDK_HOME,[string]$JdkRoot=$env:JAVA_HOME,[switch]$Debug,[ValidateSet('aarch64','x86_64')][string]$Target='aarch64')
$ErrorActionPreference='Stop'
if (-not $SdkRoot) { throw '请设置 ANDROID_HOME 或传入 -SdkRoot' }
if (-not $NdkRoot) { $versions=Get-ChildItem -LiteralPath (Join-Path $SdkRoot 'ndk') -Directory | Sort-Object Name; if ($versions.Count) { $NdkRoot=$versions[-1].FullName } }
if (-not $NdkRoot -or -not (Test-Path -LiteralPath (Join-Path $NdkRoot 'source.properties'))) { throw '请安装 Android NDK 28 或更高版本并设置 NDK_HOME' }
if (-not $JdkRoot) { throw '请设置 JAVA_HOME（JDK 17 或更高）' }
$env:ANDROID_HOME=$SdkRoot
$env:ANDROID_SDK_ROOT=$SdkRoot
$env:NDK_HOME=$NdkRoot
$env:JAVA_HOME=$JdkRoot
$env:PATH="$JdkRoot/bin;$SdkRoot/platform-tools;$SdkRoot/cmdline-tools/latest/bin;$env:PATH"
Push-Location (Split-Path $PSScriptRoot -Parent)
try {
    if ($Task -eq 'init') { & npx tauri android init --ci --skip-targets-install }
    elseif ($Task -eq 'dev') { & npx tauri android dev }
    elseif ($Debug) { & npx tauri android build --target $Target --apk --debug }
    else { & npx tauri android build --target $Target --apk }
    if ($LASTEXITCODE) { throw "Android $Task 失败：$LASTEXITCODE" }
} finally { Pop-Location }
