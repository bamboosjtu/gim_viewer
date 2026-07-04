# Round 1.2 + 1.3: 文件清单 + 文本/二进制粗判
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File file-inventory-text-binary.ps1 -SampleId "demo-line" -SampleRoot "D:\path\to\demo-line"
# 输出 CSV：{sampleId}-file-inventory.csv / {sampleId}-text-binary-survey.csv

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

$base = (Resolve-Path $SampleRoot).Path

# ---- 文件清单 ----
$inventoryCsv = Join-Path $OutDir "$SampleId-file-inventory.csv"

Write-Host "=== File Inventory: $SampleId ==="

Get-ChildItem $SampleRoot -Recurse -File |
  ForEach-Object {
    $relativePath = $_.FullName.Replace($base + "\", "")
    $parts = $relativePath -split "\\"
    [PSCustomObject]@{
      sample = $SampleId
      relativePath = $relativePath
      topDir = $parts[0]
      name = $_.Name
      extension = $_.Extension.ToLower()
      length = $_.Length
      lastWriteTime = $_.LastWriteTime
    }
  } |
  Export-Csv $inventoryCsv -NoTypeInformation -Encoding UTF8

Write-Host ("Inventory CSV: {0}" -f $inventoryCsv)
Write-Host ""

Write-Host "---- Extension stats ----"
Import-Csv $inventoryCsv |
  Group-Object extension |
  Sort-Object Count -Descending |
  Select-Object Count, Name |
  Format-Table -AutoSize

Write-Host "---- Top dir + Extension stats ----"
Import-Csv $inventoryCsv |
  Group-Object topDir, extension |
  Sort-Object Count -Descending |
  Select-Object Count, Name |
  Format-Table -AutoSize

# ---- 文本/二进制粗判 ----
function Test-TextLikeFile {
  param([string]$Path)
  $bytes = [System.IO.File]::ReadAllBytes((Resolve-Path $Path))
  if ($bytes.Length -eq 0) { return "empty" }
  $take = [Math]::Min(4096, $bytes.Length)
  $sample = $bytes[0..($take - 1)]
  $zeroCount = ($sample | Where-Object { $_ -eq 0 }).Count
  if ($zeroCount -gt 0) { return "binary-like" }
  try {
    $text = [System.Text.Encoding]::UTF8.GetString($sample)
    if ($text -match "<\?xml|<\w+|=|;|,") { return "text-like" }
    return "unknown-text"
  } catch {
    return "binary-like"
  }
}

$textBinaryCsv = Join-Path $OutDir "$SampleId-text-binary-survey.csv"

Write-Host "=== Text/Binary Survey: $SampleId ==="

Get-ChildItem $SampleRoot -Recurse -File |
  ForEach-Object {
    $relativePath = $_.FullName.Replace($base + "\", "")
    [PSCustomObject]@{
      sample = $SampleId
      relativePath = $relativePath
      extension = $_.Extension.ToLower()
      length = $_.Length
      kind = Test-TextLikeFile $_.FullName
    }
  } |
  Export-Csv $textBinaryCsv -NoTypeInformation -Encoding UTF8

Write-Host ("Text/Binary CSV: {0}" -f $textBinaryCsv)
Write-Host ""

Write-Host "---- Extension × kind ----"
Import-Csv $textBinaryCsv |
  Group-Object extension, kind |
  Sort-Object Count -Descending |
  Select-Object Count, Name |
  Format-Table -AutoSize

# ---- 关键判断 ----
Write-Host "=== Verification ==="
$inv = Import-Csv $inventoryCsv
$tb = Import-Csv $textBinaryCsv

$exts = $inv | Group-Object extension | Select-Object Name, Count
$topDirs = $inv | Group-Object topDir | Select-Object Name, Count

$expectedDirs = @("CBM", "DEV", "PHM", "MOD")
foreach ($d in $expectedDirs) {
  $match = $topDirs | Where-Object { $_.Name -ieq $d }
  if (-not $match) {
    Write-Host ("FAIL: expected top directory {0} not found" -f $d)
  } else {
    Write-Host ("PASS: {0} ({1} files)" -f $d, $match.Count)
  }
}

# 检查 STL 是否全为 binary-like
$stl = $tb | Where-Object { $_.extension -eq ".stl" }
if ($stl) {
  $stlBin = ($stl | Where-Object { $_.kind -eq "binary-like" }).Count
  if ($stlBin -eq $stl.Count) {
    Write-Host ("PASS: all .stl files are binary-like ({0})" -f $stlBin)
  } else {
    Write-Host ("WARN: {0} / {1} .stl files are not binary-like" -f ($stl.Count - $stlBin), $stl.Count)
  }
}

# 检查 CBM/FAM/DEV/PHM 是否全部 text-like
foreach ($ext in @(".cbm", ".fam", ".dev", ".phm")) {
  $files = $tb | Where-Object { $_.extension -eq $ext }
  if (-not $files) { continue }
  $textLike = ($files | Where-Object { $_.kind -eq "text-like" }).Count
  $unknownText = ($files | Where-Object { $_.kind -eq "unknown-text" }).Count
  if ($textLike -eq $files.Count) {
    Write-Host ("PASS: all {0} files are text-like ({1})" -f $ext, $textLike)
  } elseif ($textLike + $unknownText -eq $files.Count) {
    Write-Host ("PASS: {0} files text-like + unknown-text (no binary) ({1} + {2})" -f $ext, $textLike, $unknownText)
  } else {
    Write-Host ("FAIL: some {0} files are binary-like" -f $ext)
  }
}
