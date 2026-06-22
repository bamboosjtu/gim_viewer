# Round 2: 引用链提取 + 完整性校验
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File ref-chain-and-integrity.ps1 -SampleId "demo-line" -SampleRoot "D:\path\to\demo-line"
# 输出 CSV：{sampleId}-cbm-refs.csv / {sampleId}-dev-refs.csv / {sampleId}-phm-refs.csv / {sampleId}-ref-integrity.csv

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
  # 大小写不敏感文件查找
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

$cbmDir = Get-GimDir $SampleRoot "CBM"
$devDir = Get-GimDir $SampleRoot "DEV"
$phmDir = Get-GimDir $SampleRoot "PHM"
$modDir = Get-GimDir $SampleRoot "MOD"

# ============================================================
# CBM 引用链
# ============================================================

Write-Host "=== CBM Reference Chain: $SampleId ==="

$cbmRefs = @()
$cbmFiles = Get-ChildItem $cbmDir -File -Filter *.cbm

foreach ($f in $cbmFiles) {
  $text = Read-TextFileLoose $f.FullName
  $lines = $text -split "`r?`n"
  $entityName = ""
  $objectModelPointer = ""

  # 第一遍：收集 ENTITYNAME
  foreach ($line in $lines) {
    $l = $line.Trim()
    if ($l -match "^ENTITYNAME=(.*)$") {
      $entityName = $Matches[1].Trim()
      break
    }
  }

  # 第二遍：收集引用键
  foreach ($line in $lines) {
    $l = $line.Trim()
    if ($l -notmatch "=") { continue }
    $kv = $l -split "=", 2
    $k = $kv[0].Trim()
    $v = $kv[1].Trim()

    if ($k -eq "OBJECTMODELPOINTER") {
      $cbmRefs += [PSCustomObject]@{
        sample = $SampleId
        source = $f.Name
        sourceExt = ".cbm"
        key = "OBJECTMODELPOINTER"
        target = $v
        targetExt = [System.IO.Path]::GetExtension($v).ToLower()
        entityName = $entityName
      }
    } elseif ($k -eq "BASEFAMILY") {
      $cbmRefs += [PSCustomObject]@{
        sample = $SampleId
        source = $f.Name
        sourceExt = ".cbm"
        key = "BASEFAMILY"
        target = $v
        targetExt = [System.IO.Path]::GetExtension($v).ToLower()
        entityName = $entityName
      }
    } elseif ($k -match "^SUBDEVICE(\d+)$") {
      $cbmRefs += [PSCustomObject]@{
        sample = $SampleId
        source = $f.Name
        sourceExt = ".cbm"
        key = $k
        target = $v
        targetExt = [System.IO.Path]::GetExtension($v).ToLower()
        entityName = $entityName
      }
    } elseif ($k -match "^(SUBSYSTEMS|SECTIONS|STRAINSECTIONS|GROUPS)(\d*)$") {
      $cbmRefs += [PSCustomObject]@{
        sample = $SampleId
        source = $f.Name
        sourceExt = ".cbm"
        key = $k
        target = $v
        targetExt = [System.IO.Path]::GetExtension($v).ToLower()
        entityName = $entityName
      }
    } elseif ($k -eq "IFCFILE") {
      $cbmRefs += [PSCustomObject]@{
        sample = $SampleId
        source = $f.Name
        sourceExt = ".cbm"
        key = "IFCFILE"
        target = $v
        targetExt = [System.IO.Path]::GetExtension($v).ToLower()
        entityName = $entityName
      }
    }
  }
}

$cbmRefsCsv = Join-Path $OutDir "$SampleId-cbm-refs.csv"
$cbmRefs | Export-Csv $cbmRefsCsv -NoTypeInformation -Encoding UTF8
Write-Host ("CBM refs CSV: {0}  ({1} rows)" -f $cbmRefsCsv, $cbmRefs.Count)
Write-Host ""

Write-Host "---- CBM refs by key ----"
$cbmRefs | Group-Object key | Sort-Object Count -Descending | Select-Object Count, Name | Format-Table -AutoSize

# ============================================================
# DEV 引用链
# ============================================================

Write-Host "=== DEV Reference Chain: $SampleId ==="

$devRefs = @()
$devFiles = Get-ChildItem $devDir -File -Filter *.dev

foreach ($f in $devFiles) {
  $text = Read-TextFileLoose $f.FullName
  $lines = $text -split "`r?`n"

  foreach ($line in $lines) {
    $l = $line.Trim()
    if ($l -notmatch "=") { continue }
    $kv = $l -split "=", 2
    $k = $kv[0].Trim()
    $v = $kv[1].Trim()

    if ($k -match "^SOLIDMODEL(\d+)$") {
      $devRefs += [PSCustomObject]@{
        sample = $SampleId
        source = $f.Name
        sourceExt = ".dev"
        key = $k
        target = $v
        targetExt = [System.IO.Path]::GetExtension($v).ToLower()
      }
    } elseif ($k -match "^SUBDEVICE(\d+)$") {
      $devRefs += [PSCustomObject]@{
        sample = $SampleId
        source = $f.Name
        sourceExt = ".dev"
        key = $k
        target = $v
        targetExt = [System.IO.Path]::GetExtension($v).ToLower()
      }
    }
  }
}

$devRefsCsv = Join-Path $OutDir "$SampleId-dev-refs.csv"
$devRefs | Export-Csv $devRefsCsv -NoTypeInformation -Encoding UTF8
Write-Host ("DEV refs CSV: {0}  ({1} rows)" -f $devRefsCsv, $devRefs.Count)
Write-Host ""

Write-Host "---- DEV refs by key ----"
$devRefs | Group-Object key | Sort-Object Count -Descending | Select-Object Count, Name | Format-Table -AutoSize

# ============================================================
# PHM 引用链
# ============================================================

Write-Host "=== PHM Reference Chain: $SampleId ==="

$phmRefs = @()
$phmFiles = Get-ChildItem $phmDir -File -Filter *.phm

foreach ($f in $phmFiles) {
  $text = Read-TextFileLoose $f.FullName
  $lines = $text -split "`r?`n"

  foreach ($line in $lines) {
    $l = $line.Trim()
    if ($l -notmatch "=") { continue }
    $kv = $l -split "=", 2
    $k = $kv[0].Trim()
    $v = $kv[1].Trim()

    if ($k -match "^SOLIDMODEL(\d+)$") {
      $phmRefs += [PSCustomObject]@{
        sample = $SampleId
        source = $f.Name
        sourceExt = ".phm"
        key = $k
        target = $v
        targetExt = [System.IO.Path]::GetExtension($v).ToLower()
      }
    }
  }
}

$phmRefsCsv = Join-Path $OutDir "$SampleId-phm-refs.csv"
$phmRefs | Export-Csv $phmRefsCsv -NoTypeInformation -Encoding UTF8
Write-Host ("PHM refs CSV: {0}  ({1} rows)" -f $phmRefsCsv, $phmRefs.Count)
Write-Host ""

Write-Host "---- PHM refs by key ----"
$phmRefs | Group-Object key | Sort-Object Count -Descending | Select-Object Count, Name | Format-Table -AutoSize

# ============================================================
# 引用完整性校验
# ============================================================

Write-Host "=== Reference Integrity: $SampleId ==="

$allRefs = @()
$allRefs += $cbmRefs | Select-Object sample, source, sourceExt, key, target, targetExt
$allRefs += $devRefs | Select-Object sample, source, sourceExt, key, target, targetExt
$allRefs += $phmRefs | Select-Object sample, source, sourceExt, key, target, targetExt

$integrity = @()
foreach ($r in $allRefs) {
  $target = $r.target
  $targetExt = $r.targetExt
  $exists = $false
  $targetDir = $null

  if ($targetExt -eq ".dev") { $targetDir = $devDir }
  elseif ($targetExt -eq ".phm") { $targetDir = $phmDir }
  elseif ($targetExt -eq ".mod") { $targetDir = $modDir }
  elseif ($targetExt -eq ".cbm") { $targetDir = $cbmDir }
  elseif ($targetExt -eq ".fam") {
    $famDirCbm = Join-Path $cbmDir "FAM"
    $famDirDev = Join-Path $devDir "FAM"
    if (Test-Path $famDirCbm) { $targetDir = $famDirCbm }
    elseif (Test-Path $famDirDev) { $targetDir = $famDirDev }
    else { $targetDir = $cbmDir }
  }
  elseif ($targetExt -eq ".stl") { $targetDir = $modDir }
  elseif ($targetExt -eq ".ifc") { $targetDir = $devDir }

  if ($targetDir) {
    $exists = Find-FileCI $targetDir $target
  }

  $integrity += [PSCustomObject]@{
    sample = $SampleId
    source = $r.source
    sourceExt = $r.sourceExt
    key = $r.key
    target = $target
    targetExt = $targetExt
    exists = $exists
  }
}

$integrityCsv = Join-Path $OutDir "$SampleId-ref-integrity.csv"
$integrity | Export-Csv $integrityCsv -NoTypeInformation -Encoding UTF8
Write-Host ("Integrity CSV: {0}  ({1} rows)" -f $integrityCsv, $integrity.Count)
Write-Host ""

Write-Host "---- Integrity summary ----"
$integrity | Group-Object sourceExt, targetExt, exists |
  Sort-Object Name |
  Select-Object Count, Name |
  Format-Table -AutoSize

$missing = $integrity | Where-Object { -not $_.exists }
if ($missing) {
  Write-Host ("Missing targets: {0}" -f $missing.Count)
  $missing | Group-Object sourceExt, targetExt | Select-Object Count, Name | Format-Table -AutoSize
} else {
  Write-Host "PASS: all reference targets exist (hard-missing = 0)"
}
