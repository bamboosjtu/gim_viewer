# GIM 文件清单统计

## 1. demo-line 扩展名统计

| 扩展名 |  数量 |
| ------ | ----: |
| .cbm   | 27829 |
| .fam   | 26485 |
| .dev   |  4518 |
| .phm   |  1836 |
| .mod   |  1807 |
| .stl   |   181 |

## 2. demo-line 目录分布

| 目录 | 扩展名 |  数量 |
| ---- | ------ | ----: |
| Cbm  | .cbm   | 27829 |
| Cbm  | .fam   | 21967 |
| Dev  | .fam   |  4518 |
| Dev  | .dev   |  4518 |
| Phm  | .phm   |  1836 |
| Mod  | .mod   |  1807 |
| Mod  | .stl   |   181 |

## 3. demo-substation 扩展名统计

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

## 4. demo-substation 目录分布

| 目录 | 扩展名 | 数量 |
| ---- | ------ | ---: |
| CBM  | .fam   | 8877 |
| CBM  | .cbm   | 8701 |
| DEV  | .dev   | 4179 |
| MOD  | .mod   | 4179 |
| PHM  | .phm   | 4179 |
| DEV  | .fam   | 4179 |
| MOD  | .stl   | 1803 |
| DEV  | .ifc   |   12 |
| CBM  | .sch   |    1 |
| CBM  | .sld   |    1 |
| CBM  | .std   |    1 |

## 5. 文本 / 二进制粗判

### 5.1 demo-line

| 扩展名 | 判定         |  数量 |
| ------ | ------------ | ----: |
| .cbm   | text-like    | 27829 |
| .fam   | text-like    | 26485 |
| .dev   | text-like    |  4518 |
| .phm   | text-like    |  1836 |
| .mod   | text-like    |  1776 |
| .mod   | unknown-text |    31 |
| .stl   | binary-like  |   181 |

### 5.2 demo-substation

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

### 5.3 判定说明

- `text-like` 表示文件前部样本可按 UTF-8 文本读取，并命中 key-value、XML 或类文本特征。
- `unknown-text` 不等于二进制。当前抽样显示，部分 `unknown-text` 文件仍然是 plain text，只是没有命中粗判脚本中的 `<xml`、`<tag`、`=`、`;` 等启发式规则。
- `binary-like` 当前主要出现在 `.stl`，可暂按三角网格二进制资源处理。
- 线路与变电的 `.mod` 均不应直接视为黑盒二进制文件；当前阶段可进入静态文本分析，但不进入几何解析。

## 脚本

### 1. 生成文件清单

```powershell
cd D:\vibe-coding\gim_viewer

$demoRoot = ".\demo"
$outDir = ".\docs\schema\_generated"
New-Item -ItemType Directory -Force $outDir | Out-Null

Get-ChildItem "$demoRoot\demo-line" -Recurse -File |
  Select-Object `
    @{Name="sample";Expression={"demo-line"}},
    FullName,
    @{Name="relativePath";Expression={$_.FullName.Replace((Resolve-Path "$demoRoot\demo-line").Path + "\", "")}},
    Extension,
    Length,
    LastWriteTime |
  Export-Csv "$outDir\demo-line-file-inventory.csv" -NoTypeInformation -Encoding UTF8

Get-ChildItem "$demoRoot\demo-substation" -Recurse -File |
  Select-Object `
    @{Name="sample";Expression={"demo-substation"}},
    FullName,
    @{Name="relativePath";Expression={$_.FullName.Replace((Resolve-Path "$demoRoot\demo-substation").Path + "\", "")}},
    Extension,
    Length,
    LastWriteTime |
  Export-Csv "$outDir\demo-substation-file-inventory.csv" -NoTypeInformation -Encoding UTF8
```

### 2. 生成扩展名统计

```powershell
Import-Csv ".\docs\schema\_generated\demo-line-file-inventory.csv" |
  Group-Object Extension |
  Sort-Object Count -Descending |
  Select-Object Name, Count |
  Format-Table -AutoSize

Import-Csv ".\docs\schema\_generated\demo-substation-file-inventory.csv" |
  Group-Object Extension |
  Sort-Object Count -Descending |
  Select-Object Name, Count |
  Format-Table -AutoSize
```

### 3. 生成目录层级统计

```powershell
cd D:\vibe-coding\gim_viewer

function Get-TopDirStats($samplePath, $sampleName) {
  Get-ChildItem $samplePath -Recurse -File |
    ForEach-Object {
      $rel = $_.FullName.Replace((Resolve-Path $samplePath).Path + "\", "")
      $top = $rel.Split("\")[0]
      [PSCustomObject]@{
        sample = $sampleName
        topDir = $top
        extension = $_.Extension.ToLower()
        length = $_.Length
      }
    } |
    Group-Object topDir, extension |
    Sort-Object Count -Descending |
    Select-Object Count, Name
}

Get-TopDirStats ".\demo\demo-line" "demo-line" | Format-Table -AutoSize
Get-TopDirStats ".\demo\demo-substation" "demo-substation" | Format-Table -AutoSize
```
