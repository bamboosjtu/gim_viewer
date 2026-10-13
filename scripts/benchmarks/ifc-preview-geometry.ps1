param([string[]]$Modes=@('baseline','instances','adaptive'),[string]$Suffix='current-1')
$ErrorActionPreference='Stop'
$workspace=(Get-Location).Path
$out=Join-Path $workspace 'output/ifc-geometry-breakthrough'
$exe=Join-Path $out 'current.exe'
if(-not(Test-Path -LiteralPath $exe)){throw 'Build current Tauri debug EXE first'}
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS='--remote-debugging-port=9352'
foreach($mode in $Modes){
  $label="$mode-$Suffix"
  $native=Start-Process $exe -PassThru -RedirectStandardOutput (Join-Path $out "$label-native.out") -RedirectStandardError (Join-Path $out "$label-native.err")
  $script='scripts/benchmarks/ifc-preview-geometry.mjs'
  $observer=Start-Process node -ArgumentList @($script,$mode,$label) -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $out "$label-observer.out") -RedirectStandardError (Join-Path $out "$label-observer.err")
  $cpu=@()
  while(-not $observer.HasExited){
    $inventory=Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId
    $ids=[System.Collections.Generic.HashSet[int]]::new();[void]$ids.Add($native.Id)
    do{$added=$false;foreach($item in $inventory){if($ids.Contains([int]$item.ParentProcessId) -and $ids.Add([int]$item.ProcessId)){$added=$true}}}while($added)
    $processes=@($ids | ForEach-Object {Get-Process -Id $_ -ErrorAction SilentlyContinue})
    $cpu+=@{atWall=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds();rss=($processes|Measure-Object WorkingSet64 -Sum).Sum;cpuMs=($processes|ForEach-Object {$_.TotalProcessorTime.TotalMilliseconds}|Measure-Object -Sum).Sum;pids=@($ids)}
    Start-Sleep -Milliseconds 1000;$observer.Refresh()
  }
  $observer.WaitForExit();$requested=$native.CloseMainWindow();$exited=$native.WaitForExit(15000)
  @{pid=$native.Id;observerExit=$observer.ExitCode;normalCloseRequested=$requested;exited=$exited;budgetMs=15000;exeSha=(Get-FileHash $exe).Hash} | ConvertTo-Json | Set-Content (Join-Path $out "$label-exit.json") -Encoding utf8
  $cpu | ConvertTo-Json -Depth 5 | Set-Content (Join-Path $out "$label-cpu.json") -Encoding utf8
  if(-not $exited){throw 'Normal process close failed; preserve evidence without extending the budget'}
  Write-Output "$label exit=$($observer.ExitCode)"
}
