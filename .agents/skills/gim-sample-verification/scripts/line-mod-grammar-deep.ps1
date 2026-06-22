# Round 7: 线路 MOD 4 类文本格式族深度分析（grammar 与 parser 边界）
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File line-mod-grammar-deep.ps1 -SampleId "demo-line" -SampleRoot "D:\path\to\demo-line"
# 输出：文本报告 + 4 个 CSV（text-hnum-summary / text-point-line-summary / text-section-kv-summary / text-key-value-summary）

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
  # 去除 UTF-8 BOM
  if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
    $bytes = $bytes[3..($bytes.Length - 1)]
  }
  try { return [System.Text.Encoding]::UTF8.GetString($bytes) }
  catch { return [System.Text.Encoding]::Default.GetString($bytes) }
}

function Classify-ModText($text) {
  if ($null -eq $text -or $text.Trim().Length -eq 0) { return "EMPTY" }
  $trimmed = $text.TrimStart()
  if ($trimmed -match "^<\?xml" -or $trimmed -match "^<Device") {
    if ($trimmed -match "<Entities\s*/>") { return "XML_EMPTY_DEVICE" }
    if ($trimmed -match "<Entity") { return "XML_WITH_ENTITIES" }
    return "XML_OTHER"
  }
  if ($text -match "(?m)^CODE\s*=" -and $text -match "(?m)^POINTNUM\s*=" -and $text -match "(?m)^LINENUM\s*=") {
    return "TEXT_POINT_LINE"
  }
  if ($text -match "(?m)^HNum\s*,") { return "TEXT_HNUM_COMMA_RECORD" }
  $lines = $text -split "`r?`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne "" }
  if ($lines.Count -eq 0) { return "EMPTY" }
  $firstLine = $lines[0]
  $kvLineCount = ($lines | Where-Object { $_ -match "^[A-Za-z0-9_.-]+\s*=" }).Count
  if ($firstLine -notmatch "=" -and $kvLineCount -gt 0) { return "TEXT_SECTION_KV_RECORD" }
  if ($kvLineCount -gt 0) { return "TEXT_KEY_VALUE" }
  if ($text -match "," -and $text -match "[0-9]") { return "TEXT_COMMA_NUMERIC" }
  return "TEXT_UNKNOWN"
}

$modDir = Get-GimDir $SampleRoot "Mod"
$modFiles = Get-ChildItem $modDir -File -Filter *.mod

Write-Host "=== Line MOD Grammar Deep Analysis: $SampleId ==="
Write-Host ("MOD files: {0}" -f $modFiles.Count)
Write-Host ""

# ============ Pass 1: classify ============
$kindFiles = @{}
foreach ($f in $modFiles) {
  $text = Read-TextFileLoose $f.FullName
  $kind = Classify-ModText $text
  if (-not $kindFiles.ContainsKey($kind)) { $kindFiles[$kind] = @() }
  $kindFiles[$kind] += $f
}

Write-Host "---- Kind distribution ----"
$kindFiles.GetEnumerator() | Sort-Object Value -Descending | ForEach-Object {
  Write-Host ("  {0,-30} {1}" -f $_.Key, $_.Value.Count)
}
Write-Host ""

# ============ TEXT_HNUM_COMMA_RECORD ============
Write-Host "============================================================"
Write-Host "  TEXT_HNUM_COMMA_RECORD deep analysis"
Write-Host "============================================================"

$hnumFiles = $kindFiles["TEXT_HNUM_COMMA_RECORD"]
if (-not $hnumFiles) { $hnumFiles = @() }
Write-Host ("Files: {0}" -f $hnumFiles.Count)

$hnumStats = @()
$hHeaderDist = @{}
$bodyCountDist = @{}
$legCountDist = @{}
$hBodyRecordCount = @{}
$pRecordCount = @()
$rRecordCount = @()
$gRecordCount = @()
$rFieldCounts = @{}
$gFieldCounts = @{}
$otherRecordTypes = @{}
$globalXMin = [double]::MaxValue; $globalXMax = [double]::MinValue
$globalYMin = [double]::MaxValue; $globalYMax = [double]::MinValue
$globalZMin = [double]::MaxValue; $globalZMax = [double]::MinValue

foreach ($f in $hnumFiles) {
  $text = Read-TextFileLoose $f.FullName
  $lines = $text -split "`r?`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne "" }

  $hNum = 0
  $hRecords = @()
  $bodySections = @()
  $currentBody = $null
  $pCount = 0
  $rCount = 0
  $gCount = 0
  $otherCount = @{}
  $bodyHBody = @{}

  foreach ($line in $lines) {
    if ($line -match "^HNum\s*,\s*(\d+)") {
      $hNum = [int]$matches[1]
      continue
    }
    if ($line -match "^H\s*,\s*(\d+)\s*,\s*(Body\d+)\s*,\s*(Leg\d+)") {
      $hRecords += [PSCustomObject]@{ h = [int]$matches[1]; body = $matches[2]; leg = $matches[3] }
      continue
    }
    if ($line -match "^(Body\d+)$") {
      if ($currentBody) { $bodySections += $currentBody }
      $currentBody = [PSCustomObject]@{ name = $matches[1]; hbody = $null; pCount = 0; rCount = 0; gCount = 0; otherCount = @{} }
      continue
    }
    if ($line -match "^(HBody\d+)\s*,\s*(.+)$" -and $currentBody) {
      $currentBody.hbody = $matches[2]
      continue
    }
    if ($line -match "^P\s*,\s*(\d+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)") {
      $pCount++
      if ($currentBody) { $currentBody.pCount++ }
      $x = [double]$matches[2]; $y = [double]$matches[3]; $z = [double]$matches[4]
      if ($x -lt $globalXMin) { $globalXMin = $x }
      if ($x -gt $globalXMax) { $globalXMax = $x }
      if ($y -lt $globalYMin) { $globalYMin = $y }
      if ($y -gt $globalYMax) { $globalYMax = $y }
      if ($z -lt $globalZMin) { $globalZMin = $z }
      if ($z -gt $globalZMax) { $globalZMax = $z }
      continue
    }
    if ($line -match "^R\s*,") {
      $rCount++
      if ($currentBody) { $currentBody.rCount++ }
      $tokens = ($line -split ",")
      $tc = $tokens.Count
      if (-not $rFieldCounts.ContainsKey($tc)) { $rFieldCounts[$tc] = 0 }
      $rFieldCounts[$tc]++
      continue
    }
    if ($line -match "^G\s*,") {
      $gCount++
      if ($currentBody) { $currentBody.gCount++ }
      $tokens = ($line -split ",")
      $tc = $tokens.Count
      if (-not $gFieldCounts.ContainsKey($tc)) { $gFieldCounts[$tc] = 0 }
      $gFieldCounts[$tc]++
      continue
    }
    # other records
    if ($line -match "^([A-Za-z][A-Za-z0-9_]*)\s*[,=]") {
      $recType = $matches[1]
      if ($recType -ne "H" -and $recType -ne "P" -and $recType -ne "R" -and $recType -ne "G" -and $recType -ne "HNum" -and $recType -notmatch "^Body\d+" -and $recType -notmatch "^HBody\d+") {
        if (-not $otherCount.ContainsKey($recType)) { $otherCount[$recType] = 0 }
        $otherCount[$recType]++
        if (-not $otherRecordTypes.ContainsKey($recType)) { $otherRecordTypes[$recType] = 0 }
        $otherRecordTypes[$recType]++
      }
    }
  }
  if ($currentBody) { $bodySections += $currentBody }

  $bodyCount = ($hRecords | ForEach-Object { $_.body } | Sort-Object -Unique).Count
  $legCount = $hRecords.Count

  $hnumStats += [PSCustomObject]@{
    file = $f.Name
    hNum = $hNum
    bodyCount = $bodyCount
    legCount = $legCount
    bodySections = $bodySections.Count
    pCount = $pCount
    rCount = $rCount
    gCount = $gCount
  }
}

$hnumCsv = Join-Path $OutDir "$SampleId-text-hnum-summary.csv"
$hnumStats | Export-Csv $hnumCsv -NoTypeInformation -Encoding UTF8
Write-Host ("HNum summary CSV: {0}" -f $hnumCsv)
Write-Host ""

if ($hnumFiles.Count -gt 0) {
  $hNumVals = $hnumStats | ForEach-Object { $_.hNum }
  $bodyCountVals = $hnumStats | ForEach-Object { $_.bodyCount }
  $legCountVals = $hnumStats | ForEach-Object { $_.legCount }
  $pCountVals = $hnumStats | ForEach-Object { $_.pCount }
  $rCountVals = $hnumStats | ForEach-Object { $_.rCount }
  $gCountVals = $hnumStats | ForEach-Object { $_.gCount }

  Write-Host "---- HNum value distribution ----"
  $hnumStats | Group-Object hNum | Sort-Object Name | ForEach-Object {
    Write-Host ("  HNum={0}: {1} files" -f $_.Name, $_.Count)
  }
  Write-Host ""
  Write-Host "---- Body / Leg count distribution ----"
  Write-Host ("  bodyCount: min={0}, max={1}, mean={2:F2}" -f ($bodyCountVals | Measure-Object -Minimum).Minimum, ($bodyCountVals | Measure-Object -Maximum).Maximum, ($bodyCountVals | Measure-Object -Average).Average)
  Write-Host ("  legCount:  min={0}, max={1}, mean={2:F2}" -f ($legCountVals | Measure-Object -Minimum).Minimum, ($legCountVals | Measure-Object -Maximum).Maximum, ($legCountVals | Measure-Object -Average).Average)
  Write-Host ""
  Write-Host "---- Per-file P / R / G counts ----"
  Write-Host ("  P count: min={0}, max={1}, mean={2:F2}, total={3}" -f ($pCountVals | Measure-Object -Minimum).Minimum, ($pCountVals | Measure-Object -Maximum).Maximum, ($pCountVals | Measure-Object -Average).Average, ($pCountVals | Measure-Object -Sum).Sum)
  Write-Host ("  R count: min={0}, max={1}, mean={2:F2}, total={3}" -f ($rCountVals | Measure-Object -Minimum).Minimum, ($rCountVals | Measure-Object -Maximum).Maximum, ($rCountVals | Measure-Object -Average).Average, ($rCountVals | Measure-Object -Sum).Sum)
  Write-Host ("  G count: min={0}, max={1}, mean={2:F2}, total={3}" -f ($gCountVals | Measure-Object -Minimum).Minimum, ($gCountVals | Measure-Object -Maximum).Maximum, ($gCountVals | Measure-Object -Average).Average, ($gCountVals | Measure-Object -Sum).Sum)
  Write-Host ""

  Write-Host "---- R record token count distribution ----"
  $rFieldCounts.GetEnumerator() | Sort-Object Name | ForEach-Object {
    Write-Host ("  tokens={0}: {1} records" -f $_.Key, $_.Value)
  }
  Write-Host ""
  Write-Host "---- G record token count distribution ----"
  $gFieldCounts.GetEnumerator() | Sort-Object Name | ForEach-Object {
    Write-Host ("  tokens={0}: {1} records" -f $_.Key, $_.Value)
  }
  Write-Host ""

  Write-Host "---- P record coordinate range ----"
  if ($globalXMax -gt [double]::MinValue) {
    Write-Host ("  X range: {0:F2} ~ {1:F2}" -f $globalXMin, $globalXMax)
    Write-Host ("  Y range: {0:F2} ~ {1:F2}" -f $globalYMin, $globalYMax)
    Write-Host ("  Z range: {0:F2} ~ {1:F2}" -f $globalZMin, $globalZMax)
  }
  Write-Host ""

  Write-Host "---- Other record types observed ----"
  if ($otherRecordTypes.Count -gt 0) {
    $otherRecordTypes.GetEnumerator() | Sort-Object Value -Descending | ForEach-Object {
      Write-Host ("  {0}: {1}" -f $_.Key, $_.Value)
    }
  } else {
    Write-Host "  (none)"
  }
  Write-Host ""

  # Sample R/G records
  Write-Host "---- Sample R / G records (first 3 files, first 5 each) ----"
  foreach ($f in ($hnumFiles | Select-Object -First 3)) {
    Write-Host ("  --- {0} ---" -f $f.Name)
    $text = Read-TextFileLoose $f.FullName
    $lines = $text -split "`r?`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne "" }
    $rSampled = 0
    $gSampled = 0
    foreach ($line in $lines) {
      if ($line -match "^R\s*,") {
        Write-Host ("    R: {0}" -f $line)
        $rSampled++
        if ($rSampled -ge 5) { break }
      }
    }
    foreach ($line in $lines) {
      if ($line -match "^G\s*,") {
        Write-Host ("    G: {0}" -f $line)
        $gSampled++
        if ($gSampled -ge 5) { break }
      }
    }
  }
  Write-Host ""
}

# ============ TEXT_POINT_LINE ============
Write-Host "============================================================"
Write-Host "  TEXT_POINT_LINE deep analysis"
Write-Host "============================================================"

$plFiles = $kindFiles["TEXT_POINT_LINE"]
if (-not $plFiles) { $plFiles = @() }
Write-Host ("Files: {0}" -f $plFiles.Count)

$plStats = @()
$codeDist = @{}
$pointNumDist = @{}
$lineNumDist = @{}
$pointTypeDist = @{}
$pointTokenCountDist = @{}
$lineTokenCountDist = @{}
$latMin = [double]::MaxValue; $latMax = [double]::MinValue
$lonMin = [double]::MaxValue; $lonMax = [double]::MinValue
$altMin = [double]::MaxValue; $altMax = [double]::MinValue

foreach ($f in $plFiles) {
  $text = Read-TextFileLoose $f.FullName
  $lines = $text -split "`r?`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne "" }

  $code = ""; $pointNum = 0; $lineNum = 0
  $pointCount = 0; $lineCount = 0

  foreach ($line in $lines) {
    if ($line -match "^CODE\s*=\s*(\S+)") {
      $code = $matches[1]
      continue
    }
    if ($line -match "^POINTNUM\s*=\s*(\d+)") {
      $pointNum = [int]$matches[1]
      continue
    }
    if ($line -match "^LINENUM\s*=\s*(\d+)") {
      $lineNum = [int]$matches[1]
      continue
    }
    if ($line -match "^POINT(\d+)\s*=\s*(.+)") {
      $pointCount++
      $val = $matches[2]
      $tokens = $val -split ","
      $tc = $tokens.Count
      if (-not $pointTokenCountDist.ContainsKey($tc)) { $pointTokenCountDist[$tc] = 0 }
      $pointTokenCountDist[$tc]++
      # POINT 格式: id,lat,lon,alt,type
      if ($tc -ge 5) {
        $type = $tokens[4].Trim()
        if (-not $pointTypeDist.ContainsKey($type)) { $pointTypeDist[$type] = 0 }
        $pointTypeDist[$type]++
        $lat = 0.0; $lon = 0.0; $alt = 0.0
        if ([double]::TryParse($tokens[1].Trim(), [ref]$lat) -and
            [double]::TryParse($tokens[2].Trim(), [ref]$lon) -and
            [double]::TryParse($tokens[3].Trim(), [ref]$alt)) {
          if ($lat -lt $latMin) { $latMin = $lat }
          if ($lat -gt $latMax) { $latMax = $lat }
          if ($lon -lt $lonMin) { $lonMin = $lon }
          if ($lon -gt $lonMax) { $lonMax = $lon }
          if ($alt -lt $altMin) { $altMin = $alt }
          if ($alt -gt $altMax) { $altMax = $alt }
        }
      }
      continue
    }
    if ($line -match "^LINE(\d+)\s*=\s*(.+)") {
      $lineCount++
      $val = $matches[2]
      $tokens = $val -split ","
      $tc = $tokens.Count
      if (-not $lineTokenCountDist.ContainsKey($tc)) { $lineTokenCountDist[$tc] = 0 }
      $lineTokenCountDist[$tc]++
      continue
    }
  }

  if (-not $codeDist.ContainsKey($code)) { $codeDist[$code] = 0 }
  $codeDist[$code]++
  if (-not $pointNumDist.ContainsKey($pointNum)) { $pointNumDist[$pointNum] = 0 }
  $pointNumDist[$pointNum]++
  if (-not $lineNumDist.ContainsKey($lineNum)) { $lineNumDist[$lineNum] = 0 }
  $lineNumDist[$lineNum]++

  $plStats += [PSCustomObject]@{
    file = $f.Name
    code = $code
    pointNum = $pointNum
    lineNum = $lineNum
    pointCount = $pointCount
    lineCount = $lineCount
  }
}

$plCsv = Join-Path $OutDir "$SampleId-text-point-line-summary.csv"
$plStats | Export-Csv $plCsv -NoTypeInformation -Encoding UTF8
Write-Host ("POINT_LINE summary CSV: {0}" -f $plCsv)
Write-Host ""

if ($plFiles.Count -gt 0) {
  Write-Host "---- CODE distribution ----"
  $codeDist.GetEnumerator() | Sort-Object Name | ForEach-Object {
    Write-Host ("  CODE={0}: {1} files" -f $_.Key, $_.Value)
  }
  Write-Host ""
  Write-Host "---- POINTNUM distribution ----"
  $pointNumDist.GetEnumerator() | Sort-Object Name | ForEach-Object {
    Write-Host ("  POINTNUM={0}: {1} files" -f $_.Key, $_.Value)
  }
  Write-Host ""
  Write-Host "---- LINENUM distribution ----"
  $lineNumDist.GetEnumerator() | Sort-Object Name | ForEach-Object {
    Write-Host ("  LINENUM={0}: {1} files" -f $_.Key, $_.Value)
  }
  Write-Host ""
  Write-Host "---- POINT record token count distribution ----"
  $pointTokenCountDist.GetEnumerator() | Sort-Object Name | ForEach-Object {
    Write-Host ("  tokens={0}: {1} records" -f $_.Key, $_.Value)
  }
  Write-Host ""
  Write-Host "---- LINE record token count distribution ----"
  $lineTokenCountDist.GetEnumerator() | Sort-Object Name | ForEach-Object {
    Write-Host ("  tokens={0}: {1} records" -f $_.Key, $_.Value)
  }
  Write-Host ""
  Write-Host "---- POINT type field distribution (5th token) ----"
  $pointTypeDist.GetEnumerator() | Sort-Object Value -Descending | ForEach-Object {
    Write-Host ("  type={0}: {1} records" -f $_.Key, $_.Value)
  }
  Write-Host ""
  Write-Host "---- Lat / Lon / Alt global range ----"
  if ($latMax -gt [double]::MinValue) {
    Write-Host ("  Lat range: {0:F6} ~ {1:F6}" -f $latMin, $latMax)
    Write-Host ("  Lon range: {0:F6} ~ {1:F6}" -f $lonMin, $lonMax)
    Write-Host ("  Alt range: {0:F6} ~ {1:F6}" -f $altMin, $altMax)
  }
  Write-Host ""
}

# ============ TEXT_SECTION_KV_RECORD ============
Write-Host "============================================================"
Write-Host "  TEXT_SECTION_KV_RECORD deep analysis"
Write-Host "============================================================"

$secFiles = $kindFiles["TEXT_SECTION_KV_RECORD"]
if (-not $secFiles) { $secFiles = @() }
Write-Host ("Files: {0}" -f $secFiles.Count)

$secStats = @()
$sectionHeaderDist = @{}
$boltNumDist = @{}
$boltFieldCountDist = @{}      # 逗号分隔后 token 数
$boltSemicolonCountDist = @{}  # 分号分隔后段数
$boltSampleByFieldCount = @{}

foreach ($f in $secFiles) {
  $text = Read-TextFileLoose $f.FullName
  $lines = $text -split "`r?`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne "" }

  $sectionHeader = ""
  $boltNum = 0
  $boltRecords = @()
  $otherKVs = @{}

  foreach ($line in $lines) {
    if ($line -match "^[A-Za-z][A-Za-z0-9_]*\s*=") {
      # key = value
      $parts = $line -split "=", 2
      $k = $parts[0].Trim(); $v = $parts[1].Trim()
      if ($k -eq "BoltNum") {
        $boltNum = [int]$v
        continue
      }
      if ($k -match "^Bolt(\d+)$") {
        $boltRecords += [PSCustomObject]@{ idx = [int]$matches[1]; value = $v }
        continue
      }
      if (-not $otherKVs.ContainsKey($k)) { $otherKVs[$k] = 0 }
      $otherKVs[$k]++
      continue
    }
    # section header（不含 =）
    if ($line -notmatch "=" -and $line -match "^[A-Za-z][A-Za-z0-9_]*$") {
      $sectionHeader = $line
      if (-not $sectionHeaderDist.ContainsKey($sectionHeader)) { $sectionHeaderDist[$sectionHeader] = 0 }
      $sectionHeaderDist[$sectionHeader]++
      continue
    }
  }

  if (-not $boltNumDist.ContainsKey($boltNum)) { $boltNumDist[$boltNum] = 0 }
  $boltNumDist[$boltNum]++

  foreach ($b in $boltRecords) {
    $commaTokens = $b.value -split ","
    $tc = $commaTokens.Count
    if (-not $boltFieldCountDist.ContainsKey($tc)) { $boltFieldCountDist[$tc] = 0 }
    $boltFieldCountDist[$tc]++

    $semiTokens = $b.value -split ";"
    $sc = $semiTokens.Count
    if (-not $boltSemicolonCountDist.ContainsKey($sc)) { $boltSemicolonCountDist[$sc] = 0 }
    $boltSemicolonCountDist[$sc]++

    if (-not $boltSampleByFieldCount.ContainsKey($tc)) {
      $boltSampleByFieldCount[$tc] = $b.value
    }
  }

  $secStats += [PSCustomObject]@{
    file = $f.Name
    sectionHeader = $sectionHeader
    boltNum = $boltNum
    boltRecordCount = $boltRecords.Count
    otherKvKeys = ($otherKVs.Keys -join ";")
  }
}

$secCsv = Join-Path $OutDir "$SampleId-text-section-kv-summary.csv"
$secStats | Export-Csv $secCsv -NoTypeInformation -Encoding UTF8
Write-Host ("Section_KV summary CSV: {0}" -f $secCsv)
Write-Host ""

if ($secFiles.Count -gt 0) {
  Write-Host "---- Section header distribution ----"
  $sectionHeaderDist.GetEnumerator() | Sort-Object Value -Descending | ForEach-Object {
    Write-Host ("  {0}: {1} files" -f $_.Key, $_.Value)
  }
  Write-Host ""
  Write-Host "---- BoltNum distribution ----"
  $boltNumDist.GetEnumerator() | Sort-Object Name | ForEach-Object {
    Write-Host ("  BoltNum={0}: {1} files" -f $_.Key, $_.Value)
  }
  Write-Host ""
  Write-Host "---- Bolt record comma-token count distribution ----"
  $boltFieldCountDist.GetEnumerator() | Sort-Object Name | ForEach-Object {
    Write-Host ("  tokens={0}: {1} records" -f $_.Key, $_.Value)
  }
  Write-Host ""
  Write-Host "---- Bolt record semicolon-segment count distribution ----"
  $boltSemicolonCountDist.GetEnumerator() | Sort-Object Name | ForEach-Object {
    Write-Host ("  segments={0}: {1} records" -f $_.Key, $_.Value)
  }
  Write-Host ""
  Write-Host "---- Bolt sample per token count ----"
  $boltSampleByFieldCount.GetEnumerator() | Sort-Object Name | ForEach-Object {
    Write-Host ("  tokens={0}: {1}" -f $_.Key, $_.Value)
  }
  Write-Host ""
  Write-Host "---- Sample Bolt records (first 3 files) ----"
  foreach ($f in ($secFiles | Select-Object -First 3)) {
    Write-Host ("  --- {0} ---" -f $f.Name)
    $text = Read-TextFileLoose $f.FullName
    $lines = $text -split "`r?`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne "" }
    $sampled = 0
    foreach ($line in $lines) {
      if ($line -match "^Bolt(\d+)\s*=\s*(.+)") {
        Write-Host ("    Bolt{0}: {1}" -f $matches[1], $matches[2])
        $sampled++
        if ($sampled -ge 2) { break }
      }
    }
  }
  Write-Host ""
  Write-Host "---- Other KV keys observed (excluding BoltN / BoltNum) ----"
  $otherKeyAgg = @{}
  foreach ($s in $secStats) {
    if ($s.otherKvKeys) {
      foreach ($k in ($s.otherKvKeys -split ";")) {
        if ($k) {
          if (-not $otherKeyAgg.ContainsKey($k)) { $otherKeyAgg[$k] = 0 }
          $otherKeyAgg[$k]++
        }
      }
    }
  }
  if ($otherKeyAgg.Count -gt 0) {
    $otherKeyAgg.GetEnumerator() | Sort-Object Value -Descending | ForEach-Object {
      Write-Host ("  {0}: {1}" -f $_.Key, $_.Value)
    }
  } else {
    Write-Host "  (none)"
  }
  Write-Host ""
}

# ============ TEXT_KEY_VALUE ============
Write-Host "============================================================"
Write-Host "  TEXT_KEY_VALUE deep analysis"
Write-Host "============================================================"

$kvFiles = $kindFiles["TEXT_KEY_VALUE"]
if (-not $kvFiles) { $kvFiles = @() }
Write-Host ("Files: {0}" -f $kvFiles.Count)

$kvStats = @()
$allKeySetDist = @{}  # 按 key 集合签名分组

foreach ($f in $kvFiles) {
  $text = Read-TextFileLoose $f.FullName
  $lines = $text -split "`r?`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne "" }

  $keys = @()
  $firstValues = @{}
  foreach ($line in $lines) {
    if ($line -match "^([A-Za-z][A-Za-z0-9_]*)\s*=\s*(.*)$") {
      $k = $matches[1]
      $v = $matches[2]
      if ($keys -notcontains $k) {
        $keys += $k
        $firstValues[$k] = $v
      }
    }
  }

  $sig = $keys -join ","
  if (-not $allKeySetDist.ContainsKey($sig)) { $allKeySetDist[$sig] = 0 }
  $allKeySetDist[$sig]++

  $kvStats += [PSCustomObject]@{
    file = $f.Name
    keyCount = $keys.Count
    keySignature = $sig
  }
}

$kvCsv = Join-Path $OutDir "$SampleId-text-key-value-summary.csv"
$kvStats | Export-Csv $kvCsv -NoTypeInformation -Encoding UTF8
Write-Host ("Key_Value summary CSV: {0}" -f $kvCsv)
Write-Host ""

if ($kvFiles.Count -gt 0) {
  Write-Host "---- Key set signatures (top 20 by file count) ----"
  $allKeySetDist.GetEnumerator() | Sort-Object Value -Descending | Select-Object -First 20 | ForEach-Object {
    Write-Host ("  count={0}: {1}" -f $_.Value, $_.Key)
  }
  Write-Host ""

  Write-Host "---- Sample file per key set signature (first 5 signatures) ----"
  $sigSampled = @{}
  foreach ($f in $kvFiles) {
    $text = Read-TextFileLoose $f.FullName
    $lines = $text -split "`r?`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne "" }
    $keys = @()
    foreach ($line in $lines) {
      if ($line -match "^([A-Za-z][A-Za-z0-9_]*)\s*=\s*(.*)$") {
        $k = $matches[1]
        if ($keys -notcontains $k) { $keys += $k }
      }
    }
    $sig = $keys -join ","
    if (-not $sigSampled.ContainsKey($sig)) {
      $sigSampled[$sig] = $f.Name
      Write-Host ("  --- signature: {0} ---" -f $sig)
      Write-Host ("    file: {0}" -f $f.Name)
      $sampled = 0
      foreach ($line in $lines) {
        if ($line -match "^[A-Za-z][A-Za-z0-9_]*\s*=") {
          Write-Host ("    {0}" -f $line)
          $sampled++
          if ($sampled -ge 12) { break }
        }
      }
      Write-Host ""
      if ($sigSampled.Count -ge 5) { break }
    }
  }
}

Write-Host ""
Write-Host "=== Analysis complete ==="
