param([Parameter(Mandatory=$true)][string]$Plan)
$ErrorActionPreference = 'Stop'
$p = Get-Content -Raw -LiteralPath $Plan | ConvertFrom-Json
$root = [IO.Path]::GetFullPath($p.root).TrimEnd('\') + '\'
function WorkspacePath([string]$path) {
  $resolved = [IO.Path]::GetFullPath($path)
  if (-not $resolved.StartsWith(($root + 'tmp\'), [StringComparison]::OrdinalIgnoreCase)) { throw 'outside-workspace-tmp' }
  $item = Get-Item -LiteralPath $resolved
  while ($item -and $item.FullName.Length -ge $root.Length) {
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'reparse-path' }
    if ($item -is [IO.FileInfo]) { $item = $item.Directory } else { $item = $item.Parent }
  }
  return $resolved
}
$folder = WorkspacePath $p.out
$profile = WorkspacePath $p.profile
if ((Get-FileHash -LiteralPath $profile -Algorithm SHA256).Hash.ToLowerInvariant() -ne $p.profileSha256) { throw 'profile-changed' }
if ((Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $p.helperSha256) { throw 'helper-changed' }
if ($p.instance -notmatch '^gim-[a-f0-9]{24}$' -or $p.durationMs -lt 1 -or $p.durationMs -gt 30000) { throw 'invalid-plan' }
$env:TEMP = $folder; $env:TMP = $folder; $env:TMPDIR = $folder; $env:_NT_SYMBOL_PATH = $folder
$wpr = Join-Path $env:WINDIR 'System32\wpr.exe'
$manifestPath = WorkspacePath $p.buildManifest
$manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
if ($manifest.sourceFingerprint -ne $p.buildFingerprint -or $manifest.executableSha256 -ne $p.executableSha256) { throw 'build-identity-changed' }
$binary = WorkspacePath (Join-Path (Split-Path -Parent $manifestPath) 'GIM-Reader.exe')
if ((Get-FileHash -LiteralPath $binary -Algorithm SHA256).Hash.ToLowerInvariant() -ne $p.executableSha256) { throw 'binary-changed' }
$controller = Get-Process -Id $p.controllerPid -ErrorAction Stop
if ([Math]::Abs(($controller.StartTime.ToUniversalTime() - [DateTime]::Parse($p.controllerStartedAt).ToUniversalTime()).TotalSeconds) -gt 2) { throw 'controller-identity-changed' }
function Invoke-OwnedWpr([string[]]$arguments,[string]$logName) {
  $info = New-Object Diagnostics.ProcessStartInfo
  $info.FileName = $wpr
  $info.Arguments = (($arguments | ForEach-Object { '"' + $_.Replace('"','\"') + '"' }) -join ' ')
  $info.UseShellExecute = $false; $info.CreateNoWindow = $true
  $info.RedirectStandardOutput = $true; $info.RedirectStandardError = $true
  $process = [Diagnostics.Process]::Start($info)
  $stdout = $process.StandardOutput.ReadToEndAsync(); $stderr = $process.StandardError.ReadToEndAsync()
  if (-not $process.WaitForExit(10000)) { $process.Kill(); $process.Dispose(); throw 'wpr-command-timeout' }
  $code = $process.ExitCode
  ($stdout.Result + $stderr.Result) | Set-Content -Encoding UTF8 -LiteralPath (Join-Path $folder ($logName + '.private.log'))
  $process.Dispose()
  return $code
}
$createdMutex = $false
$mutex = [Threading.Mutex]::new($true,('Local\' + $p.instance),([ref]$createdMutex))
if (-not $createdMutex) { $mutex.Dispose(); throw 'duplicate-system-helper' }
$started = $false
$result = @{status='unavailable';reason='wpr-start-failed';clockId='qpc';frequency=[Diagnostics.Stopwatch]::Frequency}
try {
  $startArgs = @('-start',($profile + '!GIM'))
  if ($p.gpu) { $startArgs += @('-start','GPU') }
  $startArgs += @('-recordtempto',$folder,'-instancename',$p.instance)
  $started = $true
  $code = Invoke-OwnedWpr $startArgs 'start'
  if ($code -ne 0) { throw 'wpr-start-failed' }
  $started = $true
  $result.startedQpc = [Diagnostics.Stopwatch]::GetTimestamp()
  $result | ConvertTo-Json | Set-Content -Encoding UTF8 -LiteralPath (Join-Path $folder 'started.private.json')
  $watch = [Diagnostics.Stopwatch]::StartNew()
  while ($watch.ElapsedMilliseconds -lt $p.durationMs) {
    if (Test-Path -LiteralPath (Join-Path $folder 'stop.request')) { break }
    if (-not (Get-Process -Id $p.controllerPid -ErrorAction SilentlyContinue)) { break }
    $lease = Get-Item -LiteralPath (Join-Path $folder 'lease') -ErrorAction SilentlyContinue
    if ($watch.ElapsedMilliseconds -gt 3000 -and (-not $lease -or ([DateTime]::UtcNow - $lease.LastWriteTimeUtc).TotalSeconds -gt 3)) { break }
    Start-Sleep -Milliseconds 100
  }
  $null = Invoke-OwnedWpr @('-status','-instancename',$p.instance) 'status'
  $code = Invoke-OwnedWpr @('-stop',(Join-Path $folder 'system.private.etl'),'-skipPdbGen','-instancename',$p.instance) 'stop'
  if ($code -ne 0) { throw 'wpr-stop-failed' }
  $started = $false
  $result.status = 'available'; $result.reason = $null
} catch {
  $result.status = 'unavailable'; $result.reason = 'system-capture-failed'
} finally {
  if ($started) { try { $null = Invoke-OwnedWpr @('-cancel','-instancename',$p.instance) 'cancel' } catch {} }
  $mutex.ReleaseMutex(); $mutex.Dispose()
  $result.endedQpc = [Diagnostics.Stopwatch]::GetTimestamp()
  $result.lossEvidence = 'unverified-see-private-status-log'
  $result.coverage = 'bounded-system-recording; process attribution requires verified export identities'
  $result | ConvertTo-Json | Set-Content -Encoding UTF8 -LiteralPath (Join-Path $folder 'finished.private.json')
}
