# Round 5: PHM 与 MOD 变换链分析
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File transform-chain-analysis.ps1 -SampleId "demo-substation" -SampleRoot "D:\path\to\demo-substation"
# 输出：PHM 矩阵分类 / MOD Entity 矩阵分类 / 两级变换抽样 / 线路 MOD 矩阵字段检测

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

$Eps = 1e-6

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

function Parse-Matrix($raw) {
  if (-not $raw) { return $null }
  $s = $raw.Trim()
  $parts = $s -split ',' |
    Where-Object { $_ -ne "" } |
    ForEach-Object { $_.Trim() }
  if ($parts.Count -ne 16) { return $null }
  $vals = @()
  foreach ($p in $parts) {
    $v = 0.0
    if ([double]::TryParse($p, [ref]$v)) { $vals += $v } else { return $null }
  }
  return $vals
}

function Classify-Matrix($m) {
  # GIM 矩阵采用列主序存储（Three.js / OpenGL 风格）
  # 平移在 m[12], m[13], m[14]
  if (-not $m -or $m.Count -ne 16) { return "INVALID" }

  $isIdentity = $true
  for ($i = 0; $i -lt 16; $i++) {
    $expected = 0.0
    if ($i -eq 0 -or $i -eq 5 -or $i -eq 10 -or $i -eq 15) { $expected = 1.0 }
    if ([Math]::Abs($m[$i] - $expected) -gt $Eps) { $isIdentity = $false; break }
  }
  if ($isIdentity) { return "IDENTITY" }

  $tx = $m[12]; $ty = $m[13]; $tz = $m[14]
  $hasTranslation = ([Math]::Abs($tx) -gt $Eps) -or ([Math]::Abs($ty) -gt $Eps) -or ([Math]::Abs($tz) -gt $Eps)

  $rotScaleUnit = $true
  $rotScaleIdx = @(0, 1, 2, 4, 5, 6, 8, 9, 10)
  foreach ($i in $rotScaleIdx) {
    $expected = 0.0
    if ($i -eq 0 -or $i -eq 5 -or $i -eq 10) { $expected = 1.0 }
    if ([Math]::Abs($m[$i] - $expected) -gt $Eps) { $rotScaleUnit = $false; break }
  }

  if (-not $hasTranslation -and -not $rotScaleUnit) { return "ROTSCALE_ONLY" }
  if ($hasTranslation -and -not $rotScaleUnit) { return "TRANSLATION+ROTSCALE" }
  if ($hasTranslation -and $rotScaleUnit) { return "TRANSLATION_ONLY" }
  return "OTHER"
}

function Extract-Translation($m) {
  return [PSCustomObject]@{
    X = $m[12]
    Y = $m[13]
    Z = $m[14]
  }
}

# ============================================================
# PHM 矩阵分析
# ============================================================

Write-Host "=== PHM Matrix Analysis: $SampleId ==="

$phmDir = Get-GimDir $SampleRoot "PHM"
$phmFiles = Get-ChildItem $phmDir -File -Filter *.phm

$kindCounts = @{}
foreach ($k in @("IDENTITY", "TRANSLATION_ONLY", "TRANSLATION+ROTSCALE", "ROTSCALE_ONLY", "OTHER", "INVALID")) {
  $kindCounts[$k] = 0
}

$totalSolidModel = 0
$totalTransform = 0
$totalColor = 0
$filesMismatch = 0
$modCount = 0
$stlCount = 0
$nonIdentitySamples = @()

foreach ($f in $phmFiles) {
  $text = Read-TextFileLoose $f.FullName
  $lines = $text -split "`r?`n"

  $solidModels = @{}
  $transforms = @{}
  $colors = @{}

  foreach ($line in $lines) {
    $l = $line.Trim()
    if ($l -notmatch "=") { continue }
    $kv = $l -split "=", 2
    $k = $kv[0].Trim()
    $v = $kv[1].Trim()

    if ($k -eq "SOLIDMODELS.NUM") { continue }
    if ($k -match "^SOLIDMODEL(\d+)$") { $solidModels[[int]$Matches[1]] = $v; continue }
    if ($k -match "^TRANSFORMMATRIX(\d+)$") { $transforms[[int]$Matches[1]] = $v; continue }
    if ($k -match "^COLOR(\d+)$") { $colors[[int]$Matches[1]] = $v; continue }
  }

  $totalSolidModel += $solidModels.Count
  $totalTransform += $transforms.Count
  $totalColor += $colors.Count

  if ($solidModels.Count -ne $transforms.Count) { $filesMismatch++ }

  foreach ($idx in $solidModels.Keys) {
    $target = $solidModels[$idx]
    $ext = [System.IO.Path]::GetExtension($target).ToLower()
    if ($ext -eq ".mod") { $modCount++ } elseif ($ext -eq ".stl") { $stlCount++ }

    if (-not $transforms.ContainsKey($idx)) {
      $kindCounts["INVALID"]++
      continue
    }
    $m = Parse-Matrix $transforms[$idx]
    if (-not $m) {
      $kindCounts["INVALID"]++
      continue
    }
    $kind = Classify-Matrix $m
    $kindCounts[$kind]++

    if ($kind -ne "IDENTITY" -and $nonIdentitySamples.Count -lt 10) {
      $t = Extract-Translation $m
      $nonIdentitySamples += [PSCustomObject]@{
        File = $f.Name
        Target = $target
        Kind = $kind
        Tx = $t.X; Ty = $t.Y; Tz = $t.Z
        Raw = $transforms[$idx]
      }
    }
  }
}

Write-Host ("PHM files:                  {0}" -f $phmFiles.Count)
Write-Host ("SOLIDMODEL refs:            {0}" -f $totalSolidModel)
Write-Host ("TRANSFORMMATRIX fields:     {0}" -f $totalTransform)
Write-Host ("COLOR fields:               {0}" -f $totalColor)
Write-Host ("Mismatched files:           {0}" -f $filesMismatch)
Write-Host ("SOLIDMODEL → .mod:          {0}" -f $modCount)
Write-Host ("SOLIDMODEL → .stl:          {0}" -f $stlCount)
Write-Host ""
Write-Host "---- PHM Matrix Kind ----"
foreach ($k in @("IDENTITY", "TRANSLATION_ONLY", "ROTSCALE_ONLY", "TRANSLATION+ROTSCALE", "OTHER", "INVALID")) {
  $pct = if ($totalTransform -gt 0) { ($kindCounts[$k] / $totalTransform * 100).ToString("F2") } else { "0.00" }
  Write-Host ("  {0,-30} {1,8}  ({2}%)" -f $k, $kindCounts[$k], $pct)
}
Write-Host ""

# ============================================================
# 变电样本：MOD XML Entity 矩阵分析
# ============================================================

$isSubstation = $false
foreach ($f in (Get-ChildItem $SampleRoot -Directory | Where-Object { $_.Name -ieq "CBM" })) {
  # 检查 CBM 文件中是否含 IFCFILE 字段
  $sampleCbm = Get-ChildItem $f.FullName -File -Filter *.cbm | Select-Object -First 1
  if ($sampleCbm) {
    $text = Read-TextFileLoose $sampleCbm.FullName
    if ($text -match "(?m)^IFCFILE=") { $isSubstation = $true }
  }
  break
}

if ($isSubstation) {
  Write-Host "=== Substation MOD XML Entity Matrix: $SampleId ==="

  $modDir = Get-GimDir $SampleRoot "MOD"
  $modFiles = Get-ChildItem $modDir -File -Filter *.mod

  $entityTotal = 0
  $entityWithMatrix = 0
  $entityKindCounts = @{}
  foreach ($k in @("IDENTITY", "TRANSLATION_ONLY", "ROTSCALE_ONLY", "TRANSLATION+ROTSCALE", "OTHER", "INVALID")) {
    $entityKindCounts[$k] = 0
  }
  $visibleTrue = 0
  $visibleFalse = 0

  foreach ($f in $modFiles) {
    $text = Read-TextFileLoose $f.FullName
    $trimmed = $text.TrimStart()
    if ($trimmed -notmatch "<Entity") { continue }

    try { $xml = [xml]$text } catch { continue }
    $entities = $xml.SelectNodes("//Entity")
    foreach ($e in $entities) {
      $entityTotal++
      $vis = $e.GetAttribute("Visible")
      if ($vis -eq "False") { $visibleFalse++ } else { $visibleTrue++ }

      $tmNode = $e.SelectSingleNode("TransformMatrix")
      if (-not $tmNode) { continue }
      $entityWithMatrix++
      $raw = $tmNode.GetAttribute("Value")
      $m = Parse-Matrix $raw
      if (-not $m) { $entityKindCounts["INVALID"]++; continue }
      $kind = Classify-Matrix $m
      $entityKindCounts[$kind]++
    }
  }

  Write-Host ("Entity total:              {0}" -f $entityTotal)
  Write-Host ("Entity with Matrix:        {0}" -f $entityWithMatrix)
  Write-Host ("Visible=True:              {0}" -f $visibleTrue)
  Write-Host ("Visible=False:             {0}" -f $visibleFalse)
  Write-Host ""
  Write-Host "---- MOD Entity Matrix Kind ----"
  foreach ($k in @("IDENTITY", "TRANSLATION_ONLY", "ROTSCALE_ONLY", "TRANSLATION+ROTSCALE", "OTHER", "INVALID")) {
    $pct = if ($entityWithMatrix -gt 0) { ($entityKindCounts[$k] / $entityWithMatrix * 100).ToString("F2") } else { "0.00" }
    Write-Host ("  {0,-30} {1,8}  ({2}%)" -f $k, $entityKindCounts[$k], $pct)
  }
  Write-Host ""

  # 两级变换抽样
  Write-Host "=== Two-Level Transform Sampling ==="
  $pairs = @()
  foreach ($f in $phmFiles) {
    if ($pairs.Count -ge 20) { break }
    $text = Read-TextFileLoose $f.FullName
    $lines = $text -split "`r?`n"
    $solidModels = @{}
    $transforms = @{}
    foreach ($line in $lines) {
      $l = $line.Trim()
      if ($l -notmatch "=") { continue }
      $kv = $l -split "=", 2
      $k = $kv[0].Trim(); $v = $kv[1].Trim()
      if ($k -match "^SOLIDMODEL(\d+)$") { $solidModels[[int]$Matches[1]] = $v }
      elseif ($k -match "^TRANSFORMMATRIX(\d+)$") { $transforms[[int]$Matches[1]] = $v }
    }
    foreach ($idx in $solidModels.Keys | Sort-Object) {
      if ($pairs.Count -ge 20) { break }
      $target = $solidModels[$idx]
      $ext = [System.IO.Path]::GetExtension($target).ToLower()
      if ($ext -ne ".mod") { continue }
      if (-not $transforms.ContainsKey($idx)) { continue }
      $phmM = Parse-Matrix $transforms[$idx]
      if (-not $phmM) { continue }
      $modPath = Join-Path $modDir $target
      if (-not (Test-Path -LiteralPath $modPath)) { continue }
      $modText = Read-TextFileLoose $modPath
      if ($modText.TrimStart() -notmatch "<Entity") { continue }
      try { $modXml = [xml]$modText } catch { continue }
      $entities = $modXml.SelectNodes("//Entity")
      if ($entities.Count -eq 0) { continue }
      $first = $entities[0]
      $tmNode = $first.SelectSingleNode("TransformMatrix")
      if (-not $tmNode) { continue }
      $modM = Parse-Matrix $tmNode.GetAttribute("Value")
      if (-not $modM) { continue }
      $pairs += [PSCustomObject]@{
        PhmFile = $f.Name
        ModFile = $target
        PhmKind = Classify-Matrix $phmM
        ModKind = Classify-Matrix $modM
      }
    }
  }

  $bothId = ($pairs | Where-Object { $_.PhmKind -eq "IDENTITY" -and $_.ModKind -eq "IDENTITY" }).Count
  $phmIdModNon = ($pairs | Where-Object { $_.PhmKind -eq "IDENTITY" -and $_.ModKind -ne "IDENTITY" }).Count
  $phmNonModId = ($pairs | Where-Object { $_.PhmKind -ne "IDENTITY" -and $_.ModKind -eq "IDENTITY" }).Count
  $bothNon = ($pairs | Where-Object { $_.PhmKind -ne "IDENTITY" -and $_.ModKind -ne "IDENTITY" }).Count

  Write-Host ("Sample pairs: {0}" -f $pairs.Count)
  Write-Host ("  PHM=Id  + MOD=Id:    {0}" -f $bothId)
  Write-Host ("  PHM=Id  + MOD=NonId: {0}" -f $phmIdModNon)
  Write-Host ("  PHM=NonId + MOD=Id:  {0}" -f $phmNonModId)
  Write-Host ("  PHM=NonId + MOD=NonId: {0}" -f $bothNon)
} else {
  # ============================================================
  # 线路样本：MOD 是否含 TransformMatrix 字段
  # ============================================================

  Write-Host "=== Line MOD TransformMatrix Field Check: $SampleId ==="

  $modDir = Get-GimDir $SampleRoot "MOD"
  $modFiles = Get-ChildItem $modDir -File -Filter *.mod

  $patterns = @("TRANSFORMMATRIX", "TransformMatrix", "Matrix", "MATRIX", "<TransformMatrix")
  $totalHasMatrixField = 0

  foreach ($f in $modFiles) {
    $text = Read-TextFileLoose $f.FullName
    $hasMatrixField = $false
    foreach ($p in $patterns) {
      if ($text -match "(?m)^" + [regex]::Escape($p) -or $text -match "<TransformMatrix") {
        $hasMatrixField = $true
        break
      }
    }
    if ($hasMatrixField) { $totalHasMatrixField++ }
  }

  Write-Host ("Total MOD: {0}" -f $modFiles.Count)
  Write-Host ("Files with matrix field: {0}" -f $totalHasMatrixField)
  if ($totalHasMatrixField -eq 0) {
    Write-Host "PASS: line MOD files do not contain TransformMatrix field (expected)"
  } else {
    Write-Host "WARN: some line MOD files contain TransformMatrix field"
  }
}

Write-Host ""
Write-Host "=== Verification ==="
if ($totalTransform -gt 0) {
  $idCount = $kindCounts["IDENTITY"]
  $idRate = ($idCount / $totalTransform * 100).ToString("F2")
  if ($idCount -eq $totalTransform) {
    Write-Host ("PASS: PHM matrices 100% IDENTITY ({0} / {1})" -f $idCount, $totalTransform)
  } else {
    Write-Host ("INFO: PHM matrix IDENTITY rate = {0}% ({1} / {2})" -f $idRate, $idCount, $totalTransform)
  }
}
