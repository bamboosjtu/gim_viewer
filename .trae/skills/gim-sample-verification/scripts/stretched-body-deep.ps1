# Round 6: StretchedBody 字段深度分析（Array 点序列 + Normal 向量）
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File stretched-body-deep.ps1 -SampleId "demo-substation" -SampleRoot "D:\path\to\demo-substation"
# 输出：文本报告 + {sampleId}-stretched-body-summary.csv

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

Write-Host "=== StretchedBody Deep Analysis: $SampleId ==="
Write-Host ("MOD files: {0}" -f $modFiles.Count)
Write-Host ""

$arrayStats = @()
$normalStats = @()
$normalLengthDist = @{}
$arrayPointCountDist = @{}

$totalStretchedBody = 0
$arrayParseFail = 0
$normalParseFail = 0

foreach ($f in $modFiles) {
  $text = Read-TextFileLoose $f.FullName
  $trimmed = $text.TrimStart()
  if ($trimmed -notmatch "<Entity") { continue }

  try { $xml = [xml]$text } catch { continue }
  $sbs = $xml.SelectNodes("//StretchedBody")
  foreach ($sb in $sbs) {
    $totalStretchedBody++

    # Array 是分号分隔的 "x,y,z" 点列表
    $arrayStr = $sb.GetAttribute("Array")
    if ($arrayStr) {
      $points = $arrayStr -split ";" | Where-Object { $_ -ne "" }
      if (-not $arrayPointCountDist.ContainsKey($points.Count)) {
        $arrayPointCountDist[$points.Count] = 0
      }
      $arrayPointCountDist[$points.Count]++

      # 尝试解析每个点的 x,y,z
      $validPoints = 0
      $xVals = @(); $yVals = @(); $zVals = @()
      foreach ($p in $points) {
        $coords = $p -split "," | Where-Object { $_ -ne "" }
        if ($coords.Count -eq 3) {
          $x = 0.0; $y = 0.0; $z = 0.0
          if ([double]::TryParse($coords[0].Trim(), [ref]$x) -and
              [double]::TryParse($coords[1].Trim(), [ref]$y) -and
              [double]::TryParse($coords[2].Trim(), [ref]$z)) {
            $validPoints++
            $xVals += $x; $yVals += $y; $zVals += $z
          }
        }
      }

      if ($validPoints -gt 0) {
        $arrayStats += [PSCustomObject]@{
          file = $f.Name
          pointCount = $validPoints
          xMin = ($xVals | Measure-Object -Minimum).Minimum
          xMax = ($xVals | Measure-Object -Maximum).Maximum
          yMin = ($yVals | Measure-Object -Minimum).Minimum
          yMax = ($yVals | Measure-Object -Maximum).Maximum
          zMin = ($zVals | Measure-Object -Minimum).Minimum
          zMax = ($zVals | Measure-Object -Maximum).Maximum
        }
      } else {
        $arrayParseFail++
      }
    }

    # Normal 是 "x,y,z" 3 个浮点数
    $normalStr = $sb.GetAttribute("Normal")
    if ($normalStr) {
      $coords = $normalStr -split "," | Where-Object { $_ -ne "" }
      if ($coords.Count -eq 3) {
        $x = 0.0; $y = 0.0; $z = 0.0
        if ([double]::TryParse($coords[0].Trim(), [ref]$x) -and
            [double]::TryParse($coords[1].Trim(), [ref]$y) -and
            [double]::TryParse($coords[2].Trim(), [ref]$z)) {
          $length = [Math]::Sqrt($x*$x + $y*$y + $z*$z)
          $roundedLen = [Math]::Round($length, 1)
          if (-not $normalLengthDist.ContainsKey($roundedLen)) {
            $normalLengthDist[$roundedLen] = 0
          }
          $normalLengthDist[$roundedLen]++
          $normalStats += [PSCustomObject]@{
            file = $f.Name
            x = $x; y = $y; z = $z
            length = $length
          }
        } else {
          $normalParseFail++
        }
      } else {
        $normalParseFail++
      }
    }
  }
}

Write-Host ("Total StretchedBody: {0}" -f $totalStretchedBody)
Write-Host ""

if ($totalStretchedBody -eq 0) {
  Write-Host "No StretchedBody nodes found. Sample may not be a substation project."
  exit 0
}

# 导出汇总 CSV
$summaryCsv = Join-Path $OutDir "$SampleId-stretched-body-summary.csv"
$arrayStats | Export-Csv $summaryCsv -NoTypeInformation -Encoding UTF8
Write-Host ("StretchedBody Array summary CSV: {0}  ({1} rows)" -f $summaryCsv, $arrayStats.Count)
Write-Host ""

Write-Host "---- Array point count distribution ----"
$arrayPointCountDist.GetEnumerator() | Sort-Object Name | ForEach-Object {
  Write-Host ("  {0,5} points: {1} instances" -f $_.Key, $_.Value)
}
Write-Host ""

Write-Host "---- Array range stats (first 20 samples) ----"
$arrayStats | Select-Object -First 20 | Format-Table -AutoSize
Write-Host ""

Write-Host "---- Array global X/Y/Z range ----"
if ($arrayStats.Count -gt 0) {
  $allX = $arrayStats | ForEach-Object { $_.xMin; $_.xMax }
  $allY = $arrayStats | ForEach-Object { $_.yMin; $_.yMax }
  $allZ = $arrayStats | ForEach-Object { $_.zMin; $_.zMax }
  Write-Host ("X range: {0:F2} ~ {1:F2}" -f ($allX | Measure-Object -Minimum).Minimum, ($allX | Measure-Object -Maximum).Maximum)
  Write-Host ("Y range: {0:F2} ~ {1:F2}" -f ($allY | Measure-Object -Minimum).Minimum, ($allY | Measure-Object -Maximum).Maximum)
  Write-Host ("Z range: {0:F2} ~ {1:F2}" -f ($allZ | Measure-Object -Minimum).Minimum, ($allZ | Measure-Object -Maximum).Maximum)
}
Write-Host ""

Write-Host "---- Normal length distribution (rounded to 0.1) ----"
$normalLengthDist.GetEnumerator() | Sort-Object Name | ForEach-Object {
  Write-Host ("  length={0}: {1} instances" -f $_.Key, $_.Value)
}
Write-Host ""

Write-Host "---- Normal range stats ----"
if ($normalStats.Count -gt 0) {
  $xVals = $normalStats | ForEach-Object { $_.x }
  $yVals = $normalStats | ForEach-Object { $_.y }
  $zVals = $normalStats | ForEach-Object { $_.z }
  Write-Host ("X range: {0} ~ {1}" -f ($xVals | Measure-Object -Minimum).Minimum, ($xVals | Measure-Object -Maximum).Maximum)
  Write-Host ("Y range: {0} ~ {1}" -f ($yVals | Measure-Object -Minimum).Minimum, ($yVals | Measure-Object -Maximum).Maximum)
  Write-Host ("Z range: {0} ~ {1}" -f ($zVals | Measure-Object -Minimum).Minimum, ($zVals | Measure-Object -Maximum).Maximum)
}
Write-Host ""

Write-Host "---- Normal X / Y / Z distribution top 10 ----"
Write-Host "X:"
$normalStats | Group-Object { [Math]::Round($_.x, 1) } | Sort-Object Count -Descending | Select-Object -First 10 Count, Name | Format-Table -AutoSize
Write-Host "Y:"
$normalStats | Group-Object { [Math]::Round($_.y, 1) } | Sort-Object Count -Descending | Select-Object -First 10 Count, Name | Format-Table -AutoSize
Write-Host "Z:"
$normalStats | Group-Object { [Math]::Round($_.z, 1) } | Sort-Object Count -Descending | Select-Object -First 10 Count, Name | Format-Table -AutoSize
Write-Host ""

Write-Host ("Array parse failures: {0}" -f $arrayParseFail)
Write-Host ("Normal parse failures: {0}" -f $normalParseFail)
