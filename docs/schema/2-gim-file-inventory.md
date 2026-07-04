# GIM 文件目录与粗分型

目标：确认解压后有哪些文件族。

## 1. 线路工程

### 扩展名统计

| 扩展名 |  line | line1 |
| ------ | ----: | ----: |
| .cbm   | 27829 |  4998 |
| .fam   | 26485 |  5073 |
| .dev   |  4518 |  1148 |
| .phm   |  1836 |   563 |
| .mod   |  1807 |   508 |
| .stl   |   181 |    82 |

### 目录分布

| 目录 | 扩展名 |  line | line1 |
| ---- | ------ | ----: | ----: |
| Cbm  | .cbm   | 27829 |  4998 |
| Cbm  | .fam   | 21967 |  3925 |
| Dev  | .dev   |  4518 |  1148 |
| Dev  | .fam   |  4518 |  1148 |
| Phm  | .phm   |  1836 |   563 |
| Mod  | .mod   |  1807 |   508 |
| Mod  | .stl   |   181 |    82 |

## 2. 变电工程

### 扩展名统计

| 扩展名 |  数量 |
| ------ | ----: |
| .fam   | 13056 |
| .cbm   |  8701 |
| .dev   |  4179 |
| .mod   |  4179 |
| .phm   |  4179 |
| .stl   |  1803 |
| .ifc   |    12 |
| .std   |     1 |
| .sch   |     1 |
| .sld   |     1 |

### 目录分布

| 目录 | 扩展名 | 数量 |
| ---- | ------ | ---: |
| CBM  | .cbm   | 8701 |
| CBM  | .fam   | 8877 |
| CBM  | .sch   |    1 |
| CBM  | .sld   |    1 |
| CBM  | .std   |    1 |
| DEV  | .dev   | 4179 |
| DEV  | .fam   | 4179 |
| DEV  | .ifc   |   12 |
| PHM  | .phm   | 4179 |
| MOD  | .mod   | 4179 |
| MOD  | .stl   | 1803 |

## 3. 文本 / 二进制粗判

### 3.1 线路工程

| 扩展名 | 判定         |  line | line1 |
| ------ | ------------ | ----: | ----: |
| .cbm   | text-like    | 27829 |  4998 |
| .fam   | text-like    | 26485 |  5073 |
| .dev   | text-like    |  4518 |  1148 |
| .phm   | text-like    |  1836 |   563 |
| .mod   | text-like    |  1776 |   508 |
| .mod   | unknown-text |    31 |     0 |
| .stl   | binary-like  |   181 |    82 |

### 3.2 变电工程

| 扩展名 | 判定         | 数量 |
| ------ | ------------ | ---: |
| .sch   | text-like    |    1 |
| .sld   | text-like    |    1 |
| .std   | text-like    |    1 |
| .ifc   | text-like    |   12 |
| .stl   | binary-like  | 1803 |
| .dev   | text-like    | 4179 |
| .mod   | text-like    | 4179 |
| .phm   | text-like    | 4179 |
| .fam   | text-like    | 4302 |
| .fam   | unknown-text | 8754 |
| .cbm   | text-like    | 8701 |

### 3.3 判定说明

- `text-like` 表示文件前部样本可按 UTF-8 文本读取，并命中 key-value、XML 或类文本特征。
- `unknown-text` 不等于二进制。当前抽样显示，部分 `unknown-text` 文件仍然是 plain text，只是没有命中粗判脚本中的 `<xml`、`<tag`、`=`、`;` 等启发式规，后续实证大部分为键值对。
- `binary-like` 当前主要出现在 `.stl`，可暂按三角网格二进制资源处理。
- 线路与变电的 `.mod` 均不应直接视为黑盒二进制文件；当前阶段可进入静态文本分析，但不进入几何解析。

## 脚本

### 1. 生成文件清单与目录分布

```powershell
$inventoryCsv = "$outDir\$sampleId-file-inventory.csv"

Get-ChildItem $sampleRoot -Recurse -File |
  ForEach-Object {
    $base = (Resolve-Path $sampleRoot).Path
    $relativePath = $_.FullName.Replace($base + "\", "")
    $parts = $relativePath -split "\\"

    [PSCustomObject]@{
      sample = $sampleId
      relativePath = $relativePath
      topDir = $parts[0]
      name = $_.Name
      extension = $_.Extension.ToLower()
      length = $_.Length
      lastWriteTime = $_.LastWriteTime
    }
  } |
  Export-Csv $inventoryCsv -NoTypeInformation -Encoding UTF8

"=== EXTENSION STATS ==="
Import-Csv $inventoryCsv |
  Group-Object extension |
  Sort-Object Count -Descending |
  Select-Object Count, Name |
  Format-Table -AutoSize

"=== TOP DIR + EXTENSION STATS ==="
Import-Csv $inventoryCsv |
  Group-Object topDir, extension |
  Sort-Object Count -Descending |
  Select-Object Count, Name |
  Format-Table -AutoSize
```

### 2. 文本/二进制粗判

```powershell
function Test-TextLikeFile {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path
  )

  $bytes = [System.IO.File]::ReadAllBytes((Resolve-Path $Path))

  if ($bytes.Length -eq 0) {
    return "empty"
  }

  $take = [Math]::Min(4096, $bytes.Length)
  $sample = $bytes[0..($take - 1)]

  $zeroCount = ($sample | Where-Object { $_ -eq 0 }).Count
  if ($zeroCount -gt 0) {
    return "binary-like"
  }

  try {
    $text = [System.Text.Encoding]::UTF8.GetString($sample)

    if ($text -match "<\?xml|<\w+|=|;|,") {
      return "text-like"
    }

    return "unknown-text"
  } catch {
    return "binary-like"
  }
}

$textBinaryCsv = "$outDir\$sampleId-text-binary-survey.csv"

Get-ChildItem $sampleRoot -Recurse -File |
  ForEach-Object {
    $base = (Resolve-Path $sampleRoot).Path
    [PSCustomObject]@{
      sample = $sampleId
      relativePath = $_.FullName.Replace($base + "\", "")
      extension = $_.Extension.ToLower()
      length = $_.Length
      kind = Test-TextLikeFile $_.FullName
    }
  } |
  Export-Csv $textBinaryCsv -NoTypeInformation -Encoding UTF8

Import-Csv $textBinaryCsv |
  Group-Object extension, kind |
  Sort-Object Count -Descending |
  Select-Object Count, Name |
  Format-Table -AutoSize
```
