# Round 1.4 + Round 2: MOD 静态分类
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File mod-static-profile.ps1 -SampleId "demo-line" -SampleRoot "D:\path\to\demo-line"
# 输出 CSV：{sampleId}-mod-kind.csv / {sampleId}-mod-key-survey.csv

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
$total = $modFiles.Count

Write-Host "=== MOD Static Profile: $SampleId ==="
Write-Host ("Total .mod files: {0}" -f $total)
Write-Host ""

# 分类
$kindCounts = @{}
$keyCounts = @{}
$codeCounts = @{}
$firstLineSamples = @{}
$headerSamples = @{}
$entityTotal = 0
$visibleTrue = 0
$visibleFalse = 0
$primitiveCounts = @{}

$kindCsv = Join-Path $OutDir "$SampleId-mod-kind.csv"
$kindRows = @()

foreach ($f in $modFiles) {
  $text = Read-TextFileLoose $f.FullName
  $kind = Classify-ModText $text
  if (-not $kindCounts.ContainsKey($kind)) { $kindCounts[$kind] = 0 }
  $kindCounts[$kind]++

  $kindRows += [PSCustomObject]@{
    sample = $SampleId
    relativePath = $f.Name
    kind = $kind
    length = $f.Length
  }

  $lines = $text -split "`r?`n"
  $firstNonEmpty = $lines | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne "" } | Select-Object -First 1
  if (-not $firstLineSamples.ContainsKey($kind)) { $firstLineSamples[$kind] = @() }
  if ($firstLineSamples[$kind].Count -lt 3) { $firstLineSamples[$kind] += $firstNonEmpty }

  if ($kind -eq "TEXT_SECTION_KV_RECORD") {
    if (-not $headerSamples.ContainsKey($firstNonEmpty)) { $headerSamples[$firstNonEmpty] = 0 }
    $headerSamples[$firstNonEmpty]++
  }

  foreach ($line in $lines) {
    if ($line -match "^([A-Z][A-Z0-9_]*?)(\d*)\s*=") {
      $key = $matches[1]
      if (-not $keyCounts.ContainsKey($key)) { $keyCounts[$key] = 0 }
      $keyCounts[$key]++
      if ($key -eq "CODE") {
        $val = ($line -split "=", 2)[1].Trim()
        if (-not $codeCounts.ContainsKey($val)) { $codeCounts[$val] = 0 }
        $codeCounts[$val]++
      }
    }
  }

  if ($kind -eq "XML_WITH_ENTITIES") {
    try {
      $xml = [xml]$text
      $entities = $xml.SelectNodes("//Entity")
      $entityTotal += $entities.Count
      foreach ($e in $entities) {
        $vis = $e.GetAttribute("Visible")
        if ($vis -eq "False") { $visibleFalse++ }
        else { $visibleTrue++ }
        foreach ($child in $e.ChildNodes) {
          if ($child.NodeType -eq "Element" -and $child.Name -ne "TransformMatrix" -and $child.Name -ne "Color") {
            if (-not $primitiveCounts.ContainsKey($child.Name)) { $primitiveCounts[$child.Name] = 0 }
            $primitiveCounts[$child.Name]++
          }
        }
      }
    } catch {
      Write-Host ("XML parse error: {0} - {1}" -f $f.Name, $_)
    }
  }
}

$kindRows | Export-Csv $kindCsv -NoTypeInformation -Encoding UTF8
Write-Host ("Kind CSV: {0}" -f $kindCsv)
Write-Host ""

Write-Host "---- Kind distribution ----"
$kindCounts.GetEnumerator() | Sort-Object Value -Descending | ForEach-Object {
  Write-Host ("  {0,-30} {1}" -f $_.Key, $_.Value)
}
Write-Host ""

Write-Host "---- First line samples by kind ----"
foreach ($k in $firstLineSamples.Keys | Sort-Object) {
  Write-Host "  --- $k ---"
  foreach ($s in $firstLineSamples[$k]) {
    Write-Host ("    {0}" -f $s)
  }
}
Write-Host ""

if ($headerSamples.Count -gt 0) {
  Write-Host "---- TEXT_SECTION_KV_RECORD header distribution ----"
  $headerSamples.GetEnumerator() | Sort-Object Value -Descending | ForEach-Object {
    Write-Host ("  {0}: {1}" -f $_.Key, $_.Value)
  }
  Write-Host ""
}

if ($codeCounts.Count -gt 0) {
  Write-Host "---- CODE distribution ----"
  $codeCounts.GetEnumerator() | Sort-Object Value -Descending | ForEach-Object {
    Write-Host ("  CODE={0}: {1}" -f $_.Key, $_.Value)
  }
  Write-Host ""
}

Write-Host "---- Top 20 keys ----"
$keyCounts.GetEnumerator() | Sort-Object Value -Descending | Select-Object -First 20 | ForEach-Object {
  Write-Host ("  {0}: {1}" -f $_.Key, $_.Value)
}
Write-Host ""

if ($entityTotal -gt 0) {
  Write-Host "---- XML Entity stats ----"
  Write-Host ("  Entity total:  {0}" -f $entityTotal)
  Write-Host ("  Visible=True:  {0}" -f $visibleTrue)
  Write-Host ("  Visible=False: {0}" -f $visibleFalse)
  Write-Host ""
  Write-Host "---- Primitive distribution ----"
  $primitiveCounts.GetEnumerator() | Sort-Object Value -Descending | ForEach-Object {
    Write-Host ("  {0,-30} {1}" -f $_.Key, $_.Value)
  }
  Write-Host ""
}

# 关键判断
Write-Host "=== Verification ==="
$magic = (Get-ChildItem $SampleRoot -Directory | Where-Object { $_.Name -ieq "CBM" } | Measure-Object).Count
if ($magic -gt 0) {
  $type = "变电"
  $expectedKinds = @("XML_WITH_ENTITIES", "EMPTY_DEVICE_XML")
} else {
  $type = "线路"
  $expectedKinds = @("TEXT_SECTION_KV_RECORD", "TEXT_POINT_LINE", "TEXT_KEY_VALUE", "TEXT_HNUM_COMMA_RECORD")
}
Write-Host ("Sample type: {0}" -f $type)
Write-Host ("Expected kinds: {0}" -f ($expectedKinds -join ", "))

$actualKinds = $kindCounts.Keys
$newKinds = $actualKinds | Where-Object { $_ -notin $expectedKinds -and $_ -ne "EMPTY" }
if ($newKinds) {
  Write-Host ("WARN: unexpected kinds: {0}" -f ($newKinds -join ", "))
} else {
  Write-Host "PASS: kind set matches expected"
}

$sum = ($kindCounts.Values | Measure-Object -Sum).Sum
if ($sum -eq $total) {
  Write-Host ("PASS: kind count sum ({0}) matches total ({1})" -f $sum, $total)
} else {
  Write-Host ("FAIL: kind count sum ({0}) != total ({1})" -f $sum, $total)
}
