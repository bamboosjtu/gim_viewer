# Round 6: Color 节点深度分析（R/G/B/A 4 个独立属性）
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File color-analysis.ps1 -SampleId "demo-substation" -SampleRoot "D:\path\to\demo-substation"
# 输出：文本报告 + {sampleId}-color-attrs.csv

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

$modDir = Get-GimDir $SampleRoot "MOD"
$modFiles = Get-ChildItem $modDir -File -Filter *.mod

Write-Host "=== Color Analysis: $SampleId ==="
Write-Host ("MOD files: {0}" -f $modFiles.Count)
Write-Host ""

$colorData = @()
$totalColorNodes = 0

foreach ($f in $modFiles) {
  $text = Read-TextFileLoose $f.FullName
  $trimmed = $text.TrimStart()
  if ($trimmed -notmatch "<Entity") { continue }

  try { $xml = [xml]$text } catch { continue }
  $colors = $xml.SelectNodes("//Color")
  foreach ($c in $colors) {
    $totalColorNodes++
    $r = 0; $g = 0; $b = 0; $a = 0
    [int]::TryParse($c.GetAttribute("R"), [ref]$r) | Out-Null
    [int]::TryParse($c.GetAttribute("G"), [ref]$g) | Out-Null
    [int]::TryParse($c.GetAttribute("B"), [ref]$b) | Out-Null
    [int]::TryParse($c.GetAttribute("A"), [ref]$a) | Out-Null

    $colorData += [PSCustomObject]@{
      modFile = $f.Name
      R = $r
      G = $g
      B = $b
      A = $a
      RGB = "$r,$g,$b,$a"
    }
  }
}

Write-Host ("Total Color nodes: {0}" -f $totalColorNodes)
Write-Host ""

if ($totalColorNodes -eq 0) {
  Write-Host "No Color nodes found. Sample may not be a substation project."
  exit 0
}

# 导出 CSV
$colorCsv = Join-Path $OutDir "$SampleId-color-attrs.csv"
$colorData | Export-Csv $colorCsv -NoTypeInformation -Encoding UTF8
Write-Host ("Color attrs CSV: {0}  ({1} rows)" -f $colorCsv, $colorData.Count)
Write-Host ""

Write-Host "---- R distribution ----"
$colorData | Group-Object R | Sort-Object Count -Descending | Select-Object Count, Name | Format-Table -AutoSize
Write-Host "---- G distribution ----"
$colorData | Group-Object G | Sort-Object Count -Descending | Select-Object Count, Name | Format-Table -AutoSize
Write-Host "---- B distribution ----"
$colorData | Group-Object B | Sort-Object Count -Descending | Select-Object Count, Name | Format-Table -AutoSize
Write-Host "---- A distribution ----"
$colorData | Group-Object A | Sort-Object Count -Descending | Select-Object Count, Name | Format-Table -AutoSize
Write-Host "---- Top 20 distinct RGB combinations ----"
$colorData | Group-Object RGB | Sort-Object Count -Descending | Select-Object -First 20 Count, Name | Format-Table -AutoSize

# 范围统计
Write-Host "---- Color range summary ----"
foreach ($field in @("R","G","B","A")) {
  $vals = $colorData | ForEach-Object { $_.$field }
  $min = ($vals | Measure-Object -Minimum).Minimum
  $max = ($vals | Measure-Object -Maximum).Maximum
  $mean = (($vals | Measure-Object -Average).Average).ToString("F2")
  $outOfRange = ($vals | Where-Object { $_ -lt 0 -or $_ -gt 255 }).Count
  Write-Host ("  {0}: min={1}, max={2}, mean={3}, out-of-range(0-255)={4}" -f $field, $min, $max, $mean, $outOfRange)
}
