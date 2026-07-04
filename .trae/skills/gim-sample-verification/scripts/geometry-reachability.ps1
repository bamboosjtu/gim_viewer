# Round 3: 几何可达性 + 孤儿溯源
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File geometry-reachability.ps1 -SampleId "demo-line" -SampleRoot "D:\path\to\demo-line"
# 输出 CSV：{sampleId}-geometry-reachability.csv / {sampleId}-orphan-trace.csv

param(
  [Parameter(Mandatory = $true)]
  [string]$SampleId,
  [Parameter(Mandatory = $true)]
  [string]$SampleRoot,
  [string]$OutDir = ""
)

if (-not (Test-Path -LiteralPath $SampleRoot)) {
  throw "Sample root not found: $SampleRoot"
}

if ($OutDir -eq "") {
  $OutDir = Join-Path $PSScriptRoot $SampleId
}
New-Item -ItemType Directory -Force $OutDir | Out-Null

function Get-GimDir($root, $name) {
  $dir = Get-ChildItem $root -Directory |
    Where-Object { $_.Name -ieq $name } |
    Select-Object -First 1
  if (-not $dir) { throw "Cannot find directory: $name under $root" }
  return $dir.FullName
}

function Read-TextFileLoose($path) {
  $bytes = [System.IO.File]::ReadAllBytes($path)
  if ($bytes.Length -eq 0) { return "" }
  if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
    $bytes = $bytes[3..($bytes.Length - 1)]
  }
  try { return [System.Text.Encoding]::UTF8.GetString($bytes) }
  catch { return [System.Text.Encoding]::Default.GetString($bytes) }
}

function Find-FileCI($root, $relPath) {
  $candidate = Join-Path $root $relPath
  if (Test-Path -LiteralPath $candidate) { return $true }
  $dir = Split-Path $candidate -Parent
  $file = Split-Path $candidate -Leaf
  if (-not (Test-Path -LiteralPath $dir)) { return $false }
  $match = Get-ChildItem -LiteralPath $dir -File |
    Where-Object { $_.Name -ieq $file } |
    Select-Object -First 1
  return $null -ne $match
}

function Resolve-FilePathCI($root, $relPath) {
  $candidate = Join-Path $root $relPath
  if (Test-Path -LiteralPath $candidate) { return $candidate }
  $dir = Split-Path $candidate -Parent
  $file = Split-Path $candidate -Leaf
  if (-not (Test-Path -LiteralPath $dir)) { return $null }
  $match = Get-ChildItem -LiteralPath $dir -File |
    Where-Object { $_.Name -ieq $file } |
    Select-Object -First 1
  if ($match) { return $match.FullName }
  return $null
}

$cbmDir = Get-GimDir $SampleRoot "CBM"
$devDir = Get-GimDir $SampleRoot "DEV"
$phmDir = Get-GimDir $SampleRoot "PHM"
$modDir = Get-GimDir $SampleRoot "MOD"

# ============================================================
# Step 1: 提取所有 CBM → DEV 引用
# ============================================================

Write-Host "=== Geometry Reachability: $SampleId ==="

$cbmDevs = @{}  # DEV 文件名 → CBM 源（第一个引用它的 CBM）
$cbmFiles = Get-ChildItem $cbmDir -File -Filter *.cbm

foreach ($f in $cbmFiles) {
  $text = Read-TextFileLoose $f.FullName
  $lines = $text -split "`r?`n"
  foreach ($line in $lines) {
    $l = $line.Trim()
    if ($l -match "^OBJECTMODELPOINTER=(.+\.dev)$") {
      $dev = $Matches[1].Trim()
      if (-not $cbmDevs.ContainsKey($dev)) {
        $cbmDevs[$dev] = $f.Name
      }
    }
  }
}
Write-Host ("CBM → DEV entries: {0}" -f $cbmDevs.Count)

# ============================================================
# Step 2: 提取所有 DEV → PHM / DEV 引用
# ============================================================

$devPhms = @{}      # DEV → PHM list
$devSubDevs = @{}   # DEV → 子 DEV list
$devFiles = Get-ChildItem $devDir -File -Filter *.dev

foreach ($f in $devFiles) {
  $text = Read-TextFileLoose $f.FullName
  $lines = $text -split "`r?`n"
  $phms = @()
  $subDevs = @()
  foreach ($line in $lines) {
    $l = $line.Trim()
    if ($l -match "^SOLIDMODEL\d+=(.+)$") {
      $target = $Matches[1].Trim()
      $ext = [System.IO.Path]::GetExtension($target).ToLower()
      if ($ext -eq ".phm") { $phms += $target }
      elseif ($ext -eq ".dev") { $subDevs += $target }
    }
    if ($l -match "^SUBDEVICE\d+=(.+)$") {
      $subDevs += $Matches[1].Trim()
    }
  }
  $devPhms[$f.Name] = $phms
  $devSubDevs[$f.Name] = $subDevs
}
Write-Host ("DEV files: {0}" -f $devFiles.Count)

# ============================================================
# Step 3: 提取所有 PHM → MOD/STL 引用
# ============================================================

$phmMods = @{}      # PHM → MOD/STL list
$phmFiles = Get-ChildItem $phmDir -File -Filter *.phm

foreach ($f in $phmFiles) {
  $text = Read-TextFileLoose $f.FullName
  $lines = $text -split "`r?`n"
  $mods = @()
  foreach ($line in $lines) {
    $l = $line.Trim()
    if ($l -match "^SOLIDMODEL\d+=(.+)$") {
      $target = $Matches[1].Trim()
      $ext = [System.IO.Path]::GetExtension($target).ToLower()
      if ($ext -eq ".mod" -or $ext -eq ".stl") {
        $mods += $target
      }
    }
  }
  $phmMods[$f.Name] = $mods
}
Write-Host ("PHM files: {0}" -f $phmFiles.Count)

# ============================================================
# Step 4: 几何可达性分类
# ============================================================

Write-Host ""
Write-Host "=== Reachability Classification ==="

# CBM 可达的 DEV 集合
$reachableDevs = @{}
$queue = @()
foreach ($dev in $cbmDevs.Keys) {
  $reachableDevs[$dev] = $true
  $queue += $dev
}

# 递归：DEV → 子 DEV
while ($queue.Count -gt 0) {
  $current = $queue[0]
  $queue = $queue[1..($queue.Count - 1)]
  if ($devSubDevs.ContainsKey($current)) {
    foreach ($sub in $devSubDevs[$current]) {
      if (-not $reachableDevs.ContainsKey($sub)) {
        $reachableDevs[$sub] = $true
        $queue += $sub
      }
    }
  }
}

# 可达的 PHM 集合
$reachablePhms = @{}
foreach ($dev in $reachableDevs.Keys) {
  if ($devPhms.ContainsKey($dev)) {
    foreach ($phm in $devPhms[$dev]) {
      $reachablePhms[$phm] = $true
    }
  }
}

# 可达的 MOD/STL 集合
$reachableMods = @{}
foreach ($phm in $reachablePhms.Keys) {
  if ($phmMods.ContainsKey($phm)) {
    foreach ($mod in $phmMods[$phm]) {
      $reachableMods[$mod] = $true
    }
  }
}

Write-Host ("Reachable DEV:  {0} / {1}" -f $reachableDevs.Count, $devFiles.Count)
Write-Host ("Reachable PHM:  {0} / {1}" -f $reachablePhms.Count, $phmFiles.Count)

$modFiles = Get-ChildItem $modDir -File | Where-Object { $_.Extension -in @(".mod", ".stl") }
Write-Host ("Reachable MOD/STL: {0} / {1}" -f $reachableMods.Count, $modFiles.Count)
Write-Host ""

# 孤儿资源
$orphanDevs = $devFiles | Where-Object { -not $reachableDevs.ContainsKey($_.Name) }
$orphanPhms = $phmFiles | Where-Object { -not $reachablePhms.ContainsKey($_.Name) }
$orphanMods = $modFiles | Where-Object { -not $reachableMods.ContainsKey($_.Name) }

Write-Host ("Orphan DEV:  {0}" -f $orphanDevs.Count)
Write-Host ("Orphan PHM:  {0}" -f $orphanPhms.Count)
Write-Host ("Orphan MOD/STL: {0}" -f $orphanMods.Count)
Write-Host ""

# 孤儿 MOD 溯源
Write-Host "=== Orphan MOD Trace ==="

$orphanTrace = @()
foreach ($mod in $orphanMods) {
  $modName = $mod.Name

  # 反查：哪个 PHM 引用了这个 MOD？
  $parentPhms = @()
  foreach ($phm in $phmFiles) {
    if ($phmMods.ContainsKey($phm.Name) -and $phmMods[$phm.Name] -contains $modName) {
      $parentPhms += $phm.Name
    }
  }

  $parentDevs = @()
  foreach ($dev in $devFiles) {
    if ($devPhms.ContainsKey($dev.Name)) {
      foreach ($phm in $parentPhms) {
        if ($devPhms[$dev.Name] -contains $phm -and $parentDevs -notcontains $dev.Name) {
          $parentDevs += $dev.Name
        }
      }
    }
  }

  $isCbmReachable = $false
  foreach ($dev in $parentDevs) {
    if ($reachableDevs.ContainsKey($dev)) {
      $isCbmReachable = $true
      break
    }
  }

  $orphanTrace += [PSCustomObject]@{
    sample = $SampleId
    orphan = $modName
    orphanType = $mod.Extension.ToLower()
    parentPhms = ($parentPhms -join ";")
    parentDevs = ($parentDevs -join ";")
    isCbmReachable = $isCbmReachable
  }
}

$orphanCsv = Join-Path $OutDir "$SampleId-orphan-trace.csv"
$orphanTrace | Export-Csv $orphanCsv -NoTypeInformation -Encoding UTF8
Write-Host ("Orphan trace CSV: {0}  ({1} rows)" -f $orphanCsv, $orphanTrace.Count)

# 几何可达性 CSV
$reachCsv = Join-Path $OutDir "$SampleId-geometry-reachability.csv"
$reachRows = @()

$reachRows += [PSCustomObject]@{
  sample = $SampleId
  resource = "DEV"
  total = $devFiles.Count
  reachable = $reachableDevs.Count
  orphan = $orphanDevs.Count
  reachRate = if ($devFiles.Count -gt 0) { ($reachableDevs.Count / $devFiles.Count).ToString("F4") } else { "0" }
}
$reachRows += [PSCustomObject]@{
  sample = $SampleId
  resource = "PHM"
  total = $phmFiles.Count
  reachable = $reachablePhms.Count
  orphan = $orphanPhms.Count
  reachRate = if ($phmFiles.Count -gt 0) { ($reachablePhms.Count / $phmFiles.Count).ToString("F4") } else { "0" }
}
$reachRows += [PSCustomObject]@{
  sample = $SampleId
  resource = "MOD/STL"
  total = $modFiles.Count
  reachable = $reachableMods.Count
  orphan = $orphanMods.Count
  reachRate = if ($modFiles.Count -gt 0) { ($reachableMods.Count / $modFiles.Count).ToString("F4") } else { "0" }
}

$reachRows | Export-Csv $reachCsv -NoTypeInformation -Encoding UTF8
Write-Host ("Reachability CSV: {0}" -f $reachCsv)
Write-Host ""

Write-Host "---- Summary ----"
$reachRows | Format-Table -AutoSize

# ============================================================
# DEV 图分析：根 / 子 / 深度 / 环
# ============================================================

Write-Host "=== DEV Graph Analysis ==="

$childDevs = @{}
foreach ($dev in $devSubDevs.Keys) {
  foreach ($sub in $devSubDevs[$dev]) {
    if (-not $childDevs.ContainsKey($sub)) { $childDevs[$sub] = @() }
    $childDevs[$sub] += $dev
  }
}

$rootDevs = $devFiles | Where-Object { -not $childDevs.ContainsKey($_.Name) }
Write-Host ("Root DEV: {0} / {1}" -f $rootDevs.Count, $devFiles.Count)
Write-Host ("Child DEV: {0} / {1}" -f $childDevs.Count, $devFiles.Count)

# 最大深度（DFS）
$visited = @{}
$maxDepth = 0

function Get-Depth($dev, $currentDepth, $path) {
  if ($path -contains $dev) { return -1 }  # 检测环
  if ($visited.ContainsKey($dev)) { return $visited[$dev] }
  $newPath = $path + $dev
  $subDevs = $devSubDevs[$dev]
  if (-not $subDevs -or $subDevs.Count -eq 0) {
    $visited[$dev] = $currentDepth
    return $currentDepth
  }
  $maxChildDepth = 0
  foreach ($sub in $subDevs) {
    $d = Get-Depth $sub ($currentDepth + 1) $newPath
    if ($d -eq -1) { return -1 }
    if ($d -gt $maxChildDepth) { $maxChildDepth = $d }
  }
  $visited[$dev] = $maxChildDepth
  return $maxChildDepth
}

foreach ($root in $rootDevs) {
  $d = Get-Depth $root.Name 0 @()
  if ($d -eq -1) {
    Write-Host "WARN: cycle detected in DEV graph"
    $maxDepth = -1
    break
  }
  if ($d -gt $maxDepth) { $maxDepth = $d }
}

Write-Host ("Max depth: {0}" -f $maxDepth)
