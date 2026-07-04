# Round 6: 变电 XML primitive 字段值范围分析
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File xml-primitive-survey.ps1 -SampleId "demo-substation" -SampleRoot "D:\path\to\demo-substation"
# 输出 CSV：{sampleId}-primitive-attrs.csv / {sampleId}-primitive-summary.csv

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

Write-Host "=== XML Primitive Survey: $SampleId ==="
Write-Host ("MOD files: {0}" -f $modFiles.Count)
Write-Host ""

# 收集所有 primitive 实例
$primitiveRows = @()
$entityTotal = 0

foreach ($f in $modFiles) {
  $text = Read-TextFileLoose $f.FullName
  $trimmed = $text.TrimStart()
  if ($trimmed -notmatch "<Entity") { continue }

  try { $xml = [xml]$text } catch { continue }
  $entities = $xml.SelectNodes("//Entity")
  foreach ($e in $entities) {
    $entityTotal++
    $entityId = $e.GetAttribute("ID")
    $entityVisible = $e.GetAttribute("Visible")
    if (-not $entityVisible) { $entityVisible = "True" }

    foreach ($child in $e.ChildNodes) {
      if ($child.NodeType -ne "Element") { continue }
      $name = $child.Name
      if ($name -eq "TransformMatrix" -or $name -eq "Color") { continue }

      # 收集所有属性
      $attrs = @{}
      foreach ($attr in $child.Attributes) {
        $attrs[$attr.Name] = $attr.Value
      }
      # 也收集子元素作为字段（如 Array 子节点）
      foreach ($sub in $child.ChildNodes) {
        if ($sub.NodeType -eq "Element") {
          $attrs[$sub.Name] = $sub.InnerText.Trim()
        }
      }

      $row = [PSCustomObject]@{
        sample = $SampleId
        modFile = $f.Name
        entityId = $entityId
        entityVisible = $entityVisible
        primitiveName = $name
        attrsJson = ($attrs | ConvertTo-Json -Compress -Depth 3)
      }
      # 把每个属性也单独作为列输出
      foreach ($k in $attrs.Keys) {
        $row | Add-Member -MemberType NoteProperty -Name "attr_$k" -Value $attrs[$k] -Force
      }
      $primitiveRows += $row
    }
  }
}

$attrsCsv = Join-Path $OutDir "$SampleId-primitive-attrs.csv"
$primitiveRows | Export-Csv $attrsCsv -NoTypeInformation -Encoding UTF8
Write-Host ("Primitive attrs CSV: {0}  ({1} rows)" -f $attrsCsv, $primitiveRows.Count)
Write-Host ("Entity total: {0}" -f $entityTotal)
Write-Host ""

# 按 primitive 类型分组统计
Write-Host "---- Primitive type distribution ----"
$primitiveRows | Group-Object primitiveName |
  Sort-Object Count -Descending |
  Select-Object Count, Name |
  Format-Table -AutoSize

# 收集每个 primitive 的所有字段名
$primitiveFields = @{}
foreach ($r in $primitiveRows) {
  if (-not $primitiveFields.ContainsKey($r.primitiveName)) {
    $primitiveFields[$r.primitiveName] = @{}
  }
  $rowPs = $r.PSObject.Properties | Where-Object { $_.Name -like "attr_*" }
  foreach ($p in $rowPs) {
    $fieldName = $p.Name.Substring(5)
    if (-not $primitiveFields[$r.primitiveName].ContainsKey($fieldName)) {
      $primitiveFields[$r.primitiveName][$fieldName] = 0
    }
    $primitiveFields[$r.primitiveName][$fieldName]++
  }
}

Write-Host ""
Write-Host "---- Per-primitive field distribution ----"
foreach ($pname in ($primitiveFields.Keys | Sort-Object)) {
  $instances = ($primitiveRows | Where-Object { $_.primitiveName -eq $pname }).Count
  Write-Host ("=== {0}  ({1} instances) ===" -f $pname, $instances)
  $primitiveFields[$pname].GetEnumerator() | Sort-Object Value -Descending | ForEach-Object {
    $coverage = if ($instances -gt 0) { ($_.Value / $instances * 100).ToString("F2") } else { "0" }
    Write-Host ("  {0,-30} {1,8}  ({2}%)" -f $_.Key, $_.Value, $coverage)
  }
  Write-Host ""
}

# 对数值字段做范围统计
Write-Host "---- Numeric field ranges (min/max/mean) ----"
$numericSummary = @()
foreach ($pname in ($primitiveFields.Keys | Sort-Object)) {
  $rows = $primitiveRows | Where-Object { $_.primitiveName -eq $pname }
  foreach ($fieldName in ($primitiveFields[$pname].Keys | Sort-Object)) {
    $values = @()
    foreach ($r in $rows) {
      $val = $r.("attr_$fieldName")
      if ($null -ne $val) {
        $v = 0.0
        if ([double]::TryParse($val, [ref]$v)) { $values += $v }
      }
    }
    if ($values.Count -gt 0) {
      $min = ($values | Measure-Object -Minimum).Minimum
      $max = ($values | Measure-Object -Maximum).Maximum
      $mean = (($values | Measure-Object -Average).Average).ToString("F4")
      $negCount = ($values | Where-Object { $_ -lt 0 }).Count
      $zeroCount = ($values | Where-Object { $_ -eq 0 }).Count

      $numericSummary += [PSCustomObject]@{
        primitive = $pname
        field = $fieldName
        count = $values.Count
        min = $min
        max = $max
        mean = $mean
        negatives = $negCount
        zeros = $zeroCount
      }
    }
  }
}

if ($numericSummary.Count -gt 0) {
  $summaryCsv = Join-Path $OutDir "$SampleId-primitive-summary.csv"
  $numericSummary | Export-Csv $summaryCsv -NoTypeInformation -Encoding UTF8
  Write-Host ("Summary CSV: {0}" -f $summaryCsv)
  Write-Host ""
  $numericSummary | Format-Table -AutoSize
}

# 抽样：每个 primitive 类型第一个实例的完整属性
Write-Host ""
Write-Host "---- Sample instance per primitive type ----"
foreach ($pname in ($primitiveFields.Keys | Sort-Object)) {
  $sample = $primitiveRows | Where-Object { $_.primitiveName -eq $pname } | Select-Object -First 1
  if ($sample) {
    Write-Host ("=== {0} (from {1}) ===" -f $pname, $sample.modFile)
    $samplePs = $sample.PSObject.Properties | Where-Object { $_.Name -like "attr_*" }
    foreach ($p in $samplePs) {
      Write-Host ("  {0,-30} = {1}" -f $p.Name.Substring(5), $p.Value)
    }
    Write-Host ""
  }
}

# Color 字段分析（Color 节点使用 R/G/B/A 4 个独立属性，不使用 Value）
# 完整的 Color 分析请运行 color-analysis.ps1（专门处理 R/G/B/A 分布）
Write-Host "---- Color field analysis ----"
Write-Host "Note: Color nodes use R/G/B/A 4 separate attributes (not Value)."
Write-Host "Note: Run color-analysis.ps1 for full R/G/B/A distribution."

$colorCount = 0
foreach ($f in $modFiles) {
  $text = Read-TextFileLoose $f.FullName
  $trimmed = $text.TrimStart()
  if ($trimmed -notmatch "<Entity") { continue }
  try { $xml = [xml]$text } catch { continue }
  $colorNodes = $xml.SelectNodes("//Color")
  $colorCount += $colorNodes.Count
}
Write-Host ("Total Color nodes: {0}" -f $colorCount)
