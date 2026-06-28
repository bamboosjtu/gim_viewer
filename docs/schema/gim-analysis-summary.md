# GIM Analysis 总结

## 1. Round 1 定位

Round 1 的目标不是开发新功能，而是把当前两个 demo 的 GIM 文件结构从“代码经验”整理成“可复查、可复跑、可扩展验证”的 schema analysis 文档。

当前分析对象：

- `demo-line`
- `demo-substation`

当前分析范围：

```text
GIM 容器结构
文件清单与目录分布
文本 / 二进制粗判
CBM / FAM / DEV / PHM / MOD / STL / IFC 文件角色
MOD 静态分型
CBM -> DEV / FAM / CBM / IFC 引用链
DEV -> PHM / DEV 引用链
PHM -> MOD / STL 引用链
CBM / DEV / PHM 文件级引用完整性
```

当前不做：

```text
不改 src
不改 SQLite schema
不新增 UI
不实现 MOD 解析
不做 3D 线路
不做悬链线
不做 STL 解析
不递归展开完整设备树
不改变当前 MVP 行为
```

Round 1 的核心判断是：

```text
当前两个 demo 的文件级静态引用链已经可以闭合。
但这只是文件存在性和字段角色层面的闭合，不代表已经完成几何解析、构件语义解析或渲染实现。
```

---

## 2. Round 1 总体计划

Round 1 按以下阶段推进：

| 阶段      | 目标                                       | 产出                                                                                                        |
| --------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| Round 1.0 | 样本清单、文件清单、容器结构、文件角色初版 | `0-sample-corpus.md`、`1-gim-file-inventory.md`、`2-gim-container-analysis.md`、`3-gim-file-role-matrix.md` |
| Round 1.1 | MOD 静态分型                               | `3-gim-file-role-matrix.md` 中 MOD 分型结论                                                                 |
| Round 1.2 | PHM -> MOD/STL 引用链                      | `3-gim-file-role-matrix.md` 中 PHM 引用链                                                                   |
| Round 1.3 | DEV -> PHM / DEV / SUBDEVICE 引用链        | `3-gim-file-role-matrix.md` 中 DEV 引用链与全量统计                                                         |
| Round 1.4 | CBM 字段字典                               | `4-cbm-field-dictionary.md`                                                                                 |
| Round 1.5 | CBM 引用完整性校验                         | `5-gim-reference-integrity.md`                                                                              |
| Round 1.6 | DEV / PHM 引用完整性校验                   | `5-gim-reference-integrity.md`                                                                              |

当前已完成到 Round 1.6。

---

## 3. Round 1 分析思路

Round 1 采用“由外到内、先静态后语义、先字段后实现”的方式推进。

整体顺序是：

```text
.gim 容器
 -> 解压目录结构
 -> 文件类型分布
 -> 文本 / 二进制粗判
 -> 单类文件字段观察
 -> 文件角色矩阵
 -> 引用链观察
 -> 全量引用统计
 -> 文件级引用完整性校验
 -> 阶段结论收口
```

之所以采用这个顺序，是因为 GIM 包内存在多个层次：

```text
CBM
 ├─ OBJECTMODELPOINTER -> DEV
 │   ├─ SOLIDMODEL -> PHM
 │   │   └─ SOLIDMODEL -> MOD/STL
 │   └─ SOLIDMODEL/SUBDEVICE -> DEV
 ├─ BASEFAMILY -> FAM
 ├─ SUBDEVICE -> CBM
 └─ IFCFILE + IFCGUID -> IFC
```

如果直接解析 MOD、STL 或做 3D 渲染，会跳过上游引用关系，导致模型来源、对象层级、字段含义都不清晰。因此 Round 1 先确认：

1. 文件是否存在。
2. 文件是什么类型。
3. 文件之间如何互相引用。
4. 引用目标是否真实存在。
5. 哪些结论来自 demo 实证，哪些只是规范背景或候选推断。

---

## 4. Step 1：样本登记

### 4.1 目的

确认当前分析只基于两个 demo，不把样本事实扩大为 GIM 通用规范。

### 4.2 命令

```powershell
cd D:\vibe-coding\gim_viewer

Get-ChildItem .\demo -Force

Get-ChildItem .\demo -File -Filter *.gim |
  Select-Object Name, Length, LastWriteTime |
  Format-Table -AutoSize
```

### 4.3 当前结果

当前样本包括：

```text
demo-line.gim
demo-substation.gim
demo-line/
demo-substation/
```

目录结构：

```text
demo-line
 ├─ Cbm
 ├─ Dev
 ├─ Phm
 └─ Mod

demo-substation
 ├─ CBM
 ├─ DEV
 ├─ PHM
 └─ MOD
```

### 4.4 结果分析

线路样本使用 PascalCase 目录：

```text
Cbm / Dev / Phm / Mod
```

变电样本使用大写目录：

```text
CBM / DEV / PHM / MOD
```

因此后续所有路径处理都必须大小写不敏感，不能硬编码单一目录大小写。

---

## 5. Step 2：GIM 容器结构验证

### 5.1 目的

确认 `.gim` 文件不是直接标准压缩包，而是自定义头部 + 压缩数据。

### 5.2 Header 查看命令

```powershell
function Read-HeaderHex {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path,

    [int]$Length = 128
  )

  $bytes = [System.IO.File]::ReadAllBytes((Resolve-Path $Path))
  $take = [Math]::Min($Length, $bytes.Length)

  for ($i = 0; $i -lt $take; $i += 16) {
    $chunk = $bytes[$i..([Math]::Min($i + 15, $take - 1))]
    ($chunk | ForEach-Object { $_.ToString("X2") }) -join " "
  }
}

Read-HeaderHex ".\demo\demo-line.gim" 128
Read-HeaderHex ".\demo\demo-substation.gim" 128
```

### 5.3 压缩签名搜索命令

```powershell
function Find-SignatureOffset {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path
  )

  $resolved = Resolve-Path $Path
  $bytes = [System.IO.File]::ReadAllBytes($resolved)

  $sevenZip = [byte[]](0x37, 0x7A, 0xBC, 0xAF, 0x27, 0x1C)
  $zip = [byte[]](0x50, 0x4B, 0x03, 0x04)

  $limit = [Math]::Min($bytes.Length - 6, 1024 * 1024)

  for ($i = 0; $i -lt $limit; $i++) {
    $match7z = $true
    for ($j = 0; $j -lt $sevenZip.Length; $j++) {
      if ($bytes[$i + $j] -ne $sevenZip[$j]) {
        $match7z = $false
        break
      }
    }

    if ($match7z) {
      return [PSCustomObject]@{
        Path = $Path
        Format = "7z"
        Offset = $i
      }
    }

    $matchZip = $true
    for ($j = 0; $j -lt $zip.Length; $j++) {
      if ($bytes[$i + $j] -ne $zip[$j]) {
        $matchZip = $false
        break
      }
    }

    if ($matchZip) {
      return [PSCustomObject]@{
        Path = $Path
        Format = "zip"
        Offset = $i
      }
    }
  }

  return [PSCustomObject]@{
    Path = $Path
    Format = "unknown"
    Offset = $null
  }
}

Find-SignatureOffset ".\demo\demo-line.gim"
Find-SignatureOffset ".\demo\demo-substation.gim"
```

### 5.4 当前结果

```text
demo-line.gim:
GIMPKGT + 7z + offset 784

demo-substation.gim:
GIMPKGS + 7z + offset 784
```

### 5.5 结果分析

当前两个样本均为：

```text
GIMPKG* 自定义头部 + 7z 压缩数据
```

其中：

```text
GIMPKGT：线路工程候选标识
GIMPKGS：变电工程候选标识
```

但不能得出“所有 GIM 的压缩偏移都是 784”的结论。解析器继续采用“在头部 1MB 窗口内搜索 7z/ZIP 签名”的策略更稳健。

---

## 6. Step 3：文件清单统计

### 6.1 目的

统计两个 demo 解压后的文件类型、数量和目录分布，为后续字段分析提供范围。

### 6.2 导出文件清单命令

```powershell
function Export-FileInventory {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Root,

    [Parameter(Mandatory = $true)]
    [string]$Sample,

    [Parameter(Mandatory = $true)]
    [string]$Output
  )

  $base = (Resolve-Path $Root).Path

  Get-ChildItem $Root -Recurse -File |
    ForEach-Object {
      $relativePath = $_.FullName.Replace($base + "\", "")
      $parts = $relativePath -split "\\"

      [PSCustomObject]@{
        sample = $Sample
        relativePath = $relativePath
        topDir = $parts[0]
        name = $_.Name
        extension = $_.Extension.ToLower()
        length = $_.Length
      }
    } |
    Export-Csv $Output -NoTypeInformation -Encoding UTF8
}

New-Item -ItemType Directory -Force ".\docs\schema\_generated" | Out-Null

Export-FileInventory ".\demo\demo-line" "demo-line" ".\docs\schema\_generated\demo-line-file-inventory.csv"
Export-FileInventory ".\demo\demo-substation" "demo-substation" ".\docs\schema\_generated\demo-substation-file-inventory.csv"
```

### 6.3 扩展名统计命令

```powershell
Import-Csv ".\docs\schema\_generated\demo-line-file-inventory.csv" |
  Group-Object extension |
  Sort-Object Count -Descending |
  Select-Object Count, Name |
  Format-Table -AutoSize

Import-Csv ".\docs\schema\_generated\demo-substation-file-inventory.csv" |
  Group-Object extension |
  Sort-Object Count -Descending |
  Select-Object Count, Name |
  Format-Table -AutoSize
```

### 6.4 当前结果

demo-line：

```text
.cbm 27829
.fam 26485
.dev 4518
.phm 1836
.mod 1807
.stl 181
```

demo-substation：

```text
.fam 13056
.cbm 8701
.dev 4179
.mod 4179
.phm 4179
.stl 1803
.ifc 12
.std 1
.sch 1
.sld 1
```

### 6.5 结果分析

线路样本规模更偏向 CBM 层级树和线路对象：

```text
CBM 数量远高于 DEV / PHM / MOD
```

变电样本中：

```text
DEV / PHM / MOD 均为 4179
IFC 文件为 12
STL 文件为 1803
```

这说明变电样本中存在较稳定的 DEV-PHM-MOD 结构，同时还存在 IFC 结构。

---

## 7. Step 4：文本 / 二进制粗判

### 7.1 目的

判断各类文件是否可以按文本继续做字段扫描。

### 7.2 命令

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

    if ($text -match "<\?xml|<\w+|=|;") {
      return "text-like"
    }

    return "unknown-text"
  } catch {
    return "binary-like"
  }
}

function Export-TextBinarySurvey {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Root,

    [Parameter(Mandatory = $true)]
    [string]$Sample,

    [Parameter(Mandatory = $true)]
    [string]$Output
  )

  $base = (Resolve-Path $Root).Path

  Get-ChildItem $Root -Recurse -File |
    ForEach-Object {
      $relativePath = $_.FullName.Replace($base + "\", "")

      [PSCustomObject]@{
        sample = $Sample
        relativePath = $relativePath
        extension = $_.Extension.ToLower()
        kind = Test-TextLikeFile $_.FullName
      }
    } |
    Export-Csv $Output -NoTypeInformation -Encoding UTF8
}

Export-TextBinarySurvey ".\demo\demo-line" "demo-line" ".\docs\schema\_generated\demo-line-text-binary-survey.csv"
Export-TextBinarySurvey ".\demo\demo-substation" "demo-substation" ".\docs\schema\_generated\demo-substation-text-binary-survey.csv"

Import-Csv ".\docs\schema\_generated\demo-line-text-binary-survey.csv" |
  Group-Object extension, kind |
  Sort-Object Count -Descending |
  Select-Object Count, Name |
  Format-Table -AutoSize

Import-Csv ".\docs\schema\_generated\demo-substation-text-binary-survey.csv" |
  Group-Object extension, kind |
  Sort-Object Count -Descending |
  Select-Object Count, Name |
  Format-Table -AutoSize
```

### 7.3 当前结果分析

线路样本中：

```text
CBM / FAM / DEV / PHM 基本都是 text-like
MOD 大部分 text-like，少量 unknown-text
STL 是 binary-like
```

变电样本中：

```text
CBM / DEV / PHM / MOD / IFC / SCH / STD / SLD 均可按文本继续研究
STL 是 binary-like
部分 FAM 被判为 unknown-text，但不等于二进制
```

因此后续分析策略是：

```text
CBM / FAM / DEV / PHM / MOD / IFC：可以静态文本扫描
STL：只做文件存在性和资源角色确认，不解析几何
```

---

## 8. Step 5：MOD 静态分型

### 8.1 目的

确认 MOD 是否是统一格式，避免直接进入几何解析。

### 8.2 MOD key 分布命令

```powershell
function Export-KeySurvey {
  param(
    [string]$Root,
    [string]$Sample,
    [string]$Pattern,
    [string]$Output
  )

  $base = (Resolve-Path $Root).Path

  Get-ChildItem $Root -Recurse -File -Filter $Pattern |
    ForEach-Object {
      $file = $_
      $rel = $file.FullName.Replace($base + "\", "")

      try {
        Get-Content $file.FullName | ForEach-Object {
          $line = $_.Trim()
          if (-not $line) { return }

          if ($line -match "^([^=]+)=") {
            [PSCustomObject]@{
              sample = $Sample
              relativePath = $rel
              extension = $file.Extension.ToLower()
              key = $Matches[1].Trim()
              line = $line
            }
          } else {
            [PSCustomObject]@{
              sample = $Sample
              relativePath = $rel
              extension = $file.Extension.ToLower()
              key = "__CONTINUATION_OR_RAW__"
              line = $line
            }
          }
        }
      } catch {
      }
    } |
    Export-Csv $Output -NoTypeInformation -Encoding UTF8
}

Export-KeySurvey ".\demo\demo-line\Mod" "demo-line" "*.mod" ".\docs\schema\_generated\demo-line-mod-key-survey.csv"
Export-KeySurvey ".\demo\demo-substation\MOD" "demo-substation" "*.mod" ".\docs\schema\_generated\demo-substation-mod-key-survey.csv"

Import-Csv ".\docs\schema\_generated\demo-line-mod-key-survey.csv" |
  Group-Object key |
  Sort-Object Count -Descending |
  Select-Object -First 50 Count, Name |
  Format-Table -AutoSize

Import-Csv ".\docs\schema\_generated\demo-substation-mod-key-survey.csv" |
  Group-Object key |
  Sort-Object Count -Descending |
  Select-Object -First 50 Count, Name |
  Format-Table -AutoSize
```

### 8.3 MOD CODE 分布命令

```powershell
function Export-ModCodeSurvey {
  param(
    [string]$Root,
    [string]$Sample,
    [string]$Output
  )

  $base = (Resolve-Path $Root).Path

  Get-ChildItem $Root -Recurse -File -Filter *.mod |
    ForEach-Object {
      $file = $_
      $rel = $file.FullName.Replace($base + "\", "")
      $code = ""
      $hasPointNum = $false
      $hasLineNum = $false

      try {
        Get-Content -LiteralPath $file.FullName | ForEach-Object {
          $line = $_.Trim()

          if ($line -match "^CODE=(.*)$") {
            $code = $Matches[1].Trim()
          }

          if ($line -match "^POINTNUM=") {
            $hasPointNum = $true
          }

          if ($line -match "^LINENUM=") {
            $hasLineNum = $true
          }
        }
      } catch {
      }

      [PSCustomObject]@{
        sample = $Sample
        relativePath = $rel
        code = $code
        hasPointNum = $hasPointNum
        hasLineNum = $hasLineNum
      }
    } |
    Export-Csv $Output -NoTypeInformation -Encoding UTF8
}

Export-ModCodeSurvey ".\demo\demo-line\Mod" "demo-line" ".\docs\schema\_generated\demo-line-mod-code-survey.csv"
Export-ModCodeSurvey ".\demo\demo-substation\MOD" "demo-substation" ".\docs\schema\_generated\demo-substation-mod-code-survey.csv"

Import-Csv ".\docs\schema\_generated\demo-line-mod-code-survey.csv" |
  Group-Object code |
  Sort-Object Count -Descending |
  Select-Object Count, Name |
  Format-Table -AutoSize

Import-Csv ".\docs\schema\_generated\demo-substation-mod-code-survey.csv" |
  Group-Object code |
  Sort-Object Count -Descending |
  Select-Object Count, Name |
  Format-Table -AutoSize
```

### 8.4 当前结果

线路 MOD：

```text
1807 个 MOD
315 个有 CODE / POINTNUM
1492 个无 CODE / POINTNUM
```

有 CODE 的 315 个中：

```text
201: 128
31 : 74
32 : 63
34 : 19
35 : 13
33 : 10
30 : 8
```

变电 MOD：

```text
4179 个 MOD
全部无 CODE
全部无 POINTNUM
明显是 XML-like 图元结构
```

### 8.5 结果分析

MOD 不能统一定义为 XML，也不能统一定义为 CODE/POINTNUM 点线格式。

当前更准确的表述是：

```text
MOD 是底层几何 / 参数化模型候选文件。
其内部格式在变电和线路样本之间存在明显差异。
```

当前阶段只做 MOD 静态分型，不进入几何解析。

---

## 9. Step 6：PHM -> MOD/STL 引用链

### 9.1 目的

确认 PHM 是否承担组合模型 / 装配体角色，以及 PHM 是否引用 MOD/STL。

### 9.2 命令

```powershell
Export-KeySurvey ".\demo\demo-line\Phm" "demo-line" "*.phm" ".\docs\schema\_generated\demo-line-phm-key-survey.csv"
Export-KeySurvey ".\demo\demo-substation\PHM" "demo-substation" "*.phm" ".\docs\schema\_generated\demo-substation-phm-key-survey.csv"

Import-Csv ".\docs\schema\_generated\demo-line-phm-key-survey.csv" |
  Group-Object key |
  Sort-Object Count -Descending |
  Select-Object -First 50 Count, Name |
  Format-Table -AutoSize

Import-Csv ".\docs\schema\_generated\demo-substation-phm-key-survey.csv" |
  Group-Object key |
  Sort-Object Count -Descending |
  Select-Object -First 50 Count, Name |
  Format-Table -AutoSize

Select-String -Path ".\demo\demo-line\Phm\*.phm" -Pattern "MOD|STL|PHM|MODEL|POINTER|\.mod|\.stl|\.phm" -CaseSensitive:$false |
  Select-Object -First 80 Path, LineNumber, Line |
  Format-Table -AutoSize

Select-String -Path ".\demo\demo-substation\PHM\*.phm" -Pattern "MOD|STL|PHM|MODEL|POINTER|\.mod|\.stl|\.phm" -CaseSensitive:$false |
  Select-Object -First 80 Path, LineNumber, Line |
  Format-Table -AutoSize
```

### 9.3 当前结果分析

PHM 中稳定出现：

```text
SOLIDMODELS.NUM
SOLIDMODEL0
SOLIDMODEL1...
TRANSFORMMATRIX0
COLOR0
```

当前确认：

```text
PHM -> MOD
PHM -> STL
```

PHM 的角色可暂定为：

```text
组合模型 / 装配体层。
```

其中：

```text
SOLIDMODELn：引用底层 MOD/STL
TRANSFORMMATRIXn：描述对应实体的空间变换
COLORn：描述对应实体颜色
```

当前只确认字段角色和文件引用，不解析矩阵含义，不渲染几何。

---

## 10. Step 7：DEV -> PHM/DEV 引用链

### 10.1 目的

确认 DEV 如何引用 PHM 或其他 DEV。

### 10.2 样例搜索命令

```powershell
Select-String -Path ".\demo\demo-line\Dev\*.dev" -Pattern "PHM|MODEL|POINTER|\.phm|\.dev" -CaseSensitive:$false |
  Select-Object -First 80 Path, LineNumber, Line |
  Format-Table -AutoSize

Select-String -Path ".\demo\demo-substation\DEV\*.dev" -Pattern "PHM|MODEL|POINTER|\.phm|\.dev" -CaseSensitive:$false |
  Select-Object -First 80 Path, LineNumber, Line |
  Format-Table -AutoSize
```

### 10.3 全量统计命令

```powershell
function Export-DevRefSummary {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Root,

    [Parameter(Mandatory = $true)]
    [string]$Sample,

    [Parameter(Mandatory = $true)]
    [string]$Output
  )

  $base = (Resolve-Path $Root).Path

  Get-ChildItem $Root -File -Filter *.dev |
    ForEach-Object {
      $file = $_
      $relativePath = $file.FullName.Replace($base + "\", "")

      $solidModelsNum = ""
      $solidModelRefCount = 0
      $solidModelPhmCount = 0
      $solidModelDevCount = 0
      $solidModelOtherCount = 0
      $subDeviceCount = 0

      try {
        Get-Content -LiteralPath $file.FullName | ForEach-Object {
          $line = $_.Trim()

          if ($line -match "^SOLIDMODELS\.NUM=(\d+)") {
            $solidModelsNum = $Matches[1]
          }
          elseif ($line -match "^SOLIDMODEL\d+=(.+)$") {
            $target = $Matches[1].Trim()
            $solidModelRefCount++

            if ($target -match "\.phm$") {
              $solidModelPhmCount++
            }
            elseif ($target -match "\.dev$") {
              $solidModelDevCount++
            }
            else {
              $solidModelOtherCount++
            }
          }
          elseif ($line -match "^SUBDEVICE\d+=(.+\.dev)$") {
            $subDeviceCount++
          }
        }
      } catch {
      }

      [PSCustomObject]@{
        sample = $Sample
        relativePath = $relativePath
        solidModelsNum = $solidModelsNum
        solidModelRefCount = $solidModelRefCount
        solidModelPhmCount = $solidModelPhmCount
        solidModelDevCount = $solidModelDevCount
        solidModelOtherCount = $solidModelOtherCount
        subDeviceCount = $subDeviceCount
        hasPhm = ($solidModelPhmCount -gt 0)
        hasDevSolidModel = ($solidModelDevCount -gt 0)
        hasSubDevice = ($subDeviceCount -gt 0)
        hasPhmAndDevSolidModel = (($solidModelPhmCount -gt 0) -and ($solidModelDevCount -gt 0))
        hasPhmAndSubDevice = (($solidModelPhmCount -gt 0) -and ($subDeviceCount -gt 0))
      }
    } |
    Export-Csv $Output -NoTypeInformation -Encoding UTF8
}

Export-DevRefSummary ".\demo\demo-line\Dev" "demo-line" ".\docs\schema\_generated\demo-line-dev-ref-summary.csv"
Export-DevRefSummary ".\demo\demo-substation\DEV" "demo-substation" ".\docs\schema\_generated\demo-substation-dev-ref-summary.csv"
```

### 10.4 汇总命令

```powershell
function Show-DevRefStats {
  param(
    [Parameter(Mandatory = $true)]
    [string]$CsvPath
  )

  $rows = Import-Csv $CsvPath

  [PSCustomObject]@{
    file = $CsvPath
    totalDev = $rows.Count
    hasPhm = ($rows | Where-Object { [int]$_.solidModelPhmCount -gt 0 }).Count
    hasDevSolidModel = ($rows | Where-Object { [int]$_.solidModelDevCount -gt 0 }).Count
    hasSubDevice = ($rows | Where-Object { [int]$_.subDeviceCount -gt 0 }).Count
    hasPhmAndDevSolidModel = ($rows | Where-Object { $_.hasPhmAndDevSolidModel -eq "True" }).Count
    hasPhmAndSubDevice = ($rows | Where-Object { $_.hasPhmAndSubDevice -eq "True" }).Count
    solidModelOther = ($rows | Where-Object { [int]$_.solidModelOtherCount -gt 0 }).Count
  }
}

Show-DevRefStats ".\docs\schema\_generated\demo-line-dev-ref-summary.csv"
Show-DevRefStats ".\docs\schema\_generated\demo-substation-dev-ref-summary.csv"
```

### 10.5 当前结果

demo-line：

```text
totalDev = 4518
hasPhm = 1836
hasDevSolidModel = 2682
hasSubDevice = 0
```

demo-substation：

```text
totalDev = 4179
hasPhm = 4179
hasDevSolidModel = 0
hasSubDevice = 258
```

### 10.6 结果分析

线路 DEV 分成两类：

```text
DEV -> PHM
DEV -> DEV
```

变电 DEV 是：

```text
DEV -> PHM
DEV -> SUBDEVICE -> DEV
```

因此 DEV 层不能简单建模为单一路径：

```text
DEV -> PHM
```

更准确的表达是：

```text
DEV -> PHM -> MOD/STL
DEV -> DEV/SUBDEVICE -> ...
```

---

## 11. Step 8：CBM 字段字典

### 11.1 目的

确认 CBM 如何引用 DEV、FAM、CBM、IFC，以及线路和变电 CBM 的差异。

### 11.2 样例搜索命令

```powershell
Select-String -Path ".\demo\demo-line\Cbm\*.cbm" -Pattern "OBJECTMODELPOINTER|BASEFAMILY|SUBDEVICE|TOWER|WIRE|\.dev|\.phm|\.ifc|IFC" -CaseSensitive:$false |
  Select-Object -First 120 Path, LineNumber, Line |
  Format-Table -AutoSize

Select-String -Path ".\demo\demo-substation\CBM\*.cbm" -Pattern "OBJECTMODELPOINTER|BASEFAMILY|SUBDEVICE|TOWER|WIRE|\.dev|\.phm|\.ifc|IFC" -CaseSensitive:$false |
  Select-Object -First 120 Path, LineNumber, Line |
  Format-Table -AutoSize
```

### 11.3 全量统计命令

```powershell
function Export-CbmRefSummary {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Root,

    [Parameter(Mandatory = $true)]
    [string]$Sample,

    [Parameter(Mandatory = $true)]
    [string]$Output
  )

  $base = (Resolve-Path $Root).Path

  Get-ChildItem $Root -File -Filter *.cbm |
    ForEach-Object {
      $file = $_
      $relativePath = $file.FullName.Replace($base + "\", "")

      $entityName = ""
      $groupType = ""
      $wireType = ""
      $baseFamily = ""
      $objectModelPointer = ""
      $ifcFile = ""
      $ifcGuid = ""
      $subDevicesNum = ""
      $subDeviceCount = 0

      try {
        Get-Content -LiteralPath $file.FullName | ForEach-Object {
          $line = $_.Trim()

          if ($line -match "^ENTITYNAME=(.*)$") {
            $entityName = $Matches[1].Trim()
          }
          elseif ($line -match "^GROUPTYPE=(.*)$") {
            $groupType = $Matches[1].Trim()
          }
          elseif ($line -match "^WIRETYPE=(.*)$") {
            $wireType = $Matches[1].Trim()
          }
          elseif ($line -match "^BASEFAMILY=(.*)$") {
            $baseFamily = $Matches[1].Trim()
          }
          elseif ($line -match "^OBJECTMODELPOINTER=(.*)$") {
            $objectModelPointer = $Matches[1].Trim()
          }
          elseif ($line -match "^IFCFILE=(.*)$") {
            $ifcFile = $Matches[1].Trim()
          }
          elseif ($line -match "^IFCGUID=(.*)$") {
            $ifcGuid = $Matches[1].Trim()
          }
          elseif ($line -match "^SUBDEVICES\.NUM=(\d+)") {
            $subDevicesNum = $Matches[1]
          }
          elseif ($line -match "^SUBDEVICE\d+=(.+\.cbm)$") {
            $subDeviceCount++
          }
        }
      } catch {
      }

      [PSCustomObject]@{
        sample = $Sample
        relativePath = $relativePath
        entityName = $entityName
        groupType = $groupType
        wireType = $wireType
        baseFamily = $baseFamily
        objectModelPointer = $objectModelPointer
        ifcFile = $ifcFile
        ifcGuid = $ifcGuid
        subDevicesNum = $subDevicesNum
        subDeviceCount = $subDeviceCount

        hasBaseFamily = ($baseFamily -ne "")
        hasObjectModelPointer = ($objectModelPointer -ne "")
        objectModelIsDev = ($objectModelPointer -match "\.dev$")
        hasIfcFile = ($ifcFile -ne "")
        hasIfcGuid = ($ifcGuid -ne "")
        hasSubDevice = ($subDeviceCount -gt 0)
        hasEntityName = ($entityName -ne "")
        hasGroupType = ($groupType -ne "")
        hasWireType = ($wireType -ne "")
      }
    } |
    Export-Csv $Output -NoTypeInformation -Encoding UTF8
}

Export-CbmRefSummary ".\demo\demo-line\Cbm" "demo-line" ".\docs\schema\_generated\demo-line-cbm-ref-summary.csv"
Export-CbmRefSummary ".\demo\demo-substation\CBM" "demo-substation" ".\docs\schema\_generated\demo-substation-cbm-ref-summary.csv"
```

### 11.4 汇总命令

```powershell
function Show-CbmRefStats {
  param(
    [Parameter(Mandatory = $true)]
    [string]$CsvPath
  )

  $rows = Import-Csv $CsvPath

  [PSCustomObject]@{
    file = $CsvPath
    totalCbm = $rows.Count
    hasBaseFamily = ($rows | Where-Object { $_.hasBaseFamily -eq "True" }).Count
    hasObjectModelPointer = ($rows | Where-Object { $_.hasObjectModelPointer -eq "True" }).Count
    objectModelIsDev = ($rows | Where-Object { $_.objectModelIsDev -eq "True" }).Count
    hasIfcFile = ($rows | Where-Object { $_.hasIfcFile -eq "True" }).Count
    hasIfcGuid = ($rows | Where-Object { $_.hasIfcGuid -eq "True" }).Count
    hasSubDevice = ($rows | Where-Object { $_.hasSubDevice -eq "True" }).Count
    hasEntityName = ($rows | Where-Object { $_.hasEntityName -eq "True" }).Count
    hasGroupType = ($rows | Where-Object { $_.hasGroupType -eq "True" }).Count
    hasWireType = ($rows | Where-Object { $_.hasWireType -eq "True" }).Count
  }
}

Show-CbmRefStats ".\docs\schema\_generated\demo-line-cbm-ref-summary.csv"
Show-CbmRefStats ".\docs\schema\_generated\demo-substation-cbm-ref-summary.csv"
```

### 11.5 当前结果

demo-line：

```text
totalCbm = 27829
hasBaseFamily = 21967
hasObjectModelPointer = 21857
objectModelIsDev = 21857
hasIfcFile = 0
hasIfcGuid = 0
hasSubDevice = 5534
hasEntityName = 27828
hasGroupType = 5861
hasWireType = 5460
```

demo-substation：

```text
totalCbm = 8701
hasBaseFamily = 8554
hasObjectModelPointer = 4179
objectModelIsDev = 4179
hasIfcFile = 4360
hasIfcGuid = 4360
hasSubDevice = 258
hasEntityName = 8699
hasGroupType = 0
hasWireType = 0
```

### 11.6 结果分析

CBM 层当前确认三类下游引用：

```text
CBM -> DEV
CBM -> IFC
CBM -> CBM
```

并且还有属性关联：

```text
CBM -> FAM
```

字段对应关系：

```text
OBJECTMODELPOINTER -> DEV
BASEFAMILY -> FAM
SUBDEVICEn -> CBM
IFCFILE + IFCGUID -> IFC
```

线路 CBM 有 `GROUPTYPE` 和 `WIRETYPE`：

```text
GROUPTYPE:
WIRE  = 5460
TOWER = 327
CROSS = 74

WIRETYPE:
CONDUCTOR  = 3834
OPGW       = 860
GROUNDWIRE = 766
```

变电 CBM 没有 `GROUPTYPE` / `WIRETYPE`，但存在 `IFCFILE` / `IFCGUID`。

---

## 12. Step 9：CBM 引用完整性校验

### 12.1 目的

确认 CBM 指向的 DEV、FAM、CBM、IFC 文件是否真实存在。

### 12.2 命令

```powershell
function New-FileIndex {
  param(
    [Parameter(Mandatory = $true)]
    [string]$SampleRoot
  )

  $root = (Resolve-Path $SampleRoot).Path
  $index = @{}

  Get-ChildItem $SampleRoot -Recurse -File |
    ForEach-Object {
      $name = $_.Name.ToLower()
      $relativePath = $_.FullName.Replace($root + "\", "")

      if (-not $index.ContainsKey($name)) {
        $index[$name] = @()
      }

      $index[$name] += $relativePath
    }

  return $index
}

function Export-CbmReferenceIntegrity {
  param(
    [Parameter(Mandatory = $true)]
    [string]$SampleRoot,

    [Parameter(Mandatory = $true)]
    [string]$CbmRoot,

    [Parameter(Mandatory = $true)]
    [string]$Sample,

    [Parameter(Mandatory = $true)]
    [string]$Output
  )

  $sampleRootResolved = (Resolve-Path $SampleRoot).Path
  $fileIndex = New-FileIndex $SampleRoot

  $rows = New-Object System.Collections.Generic.List[object]

  Get-ChildItem $CbmRoot -File -Filter *.cbm |
    ForEach-Object {
      $file = $_
      $sourceRelativePath = $file.FullName.Replace($sampleRootResolved + "\", "")

      try {
        Get-Content -LiteralPath $file.FullName | ForEach-Object {
          $line = $_.Trim()
          if (-not $line) { return }

          $fieldName = $null
          $target = $null
          $targetKind = $null

          if ($line -match "^OBJECTMODELPOINTER=(.+\.dev)$") {
            $fieldName = "OBJECTMODELPOINTER"
            $target = $Matches[1].Trim()
            $targetKind = "DEV"
          }
          elseif ($line -match "^BASEFAMILY=(.+\.fam)$") {
            $fieldName = "BASEFAMILY"
            $target = $Matches[1].Trim()
            $targetKind = "FAM"
          }
          elseif ($line -match "^(SUBDEVICE\d+)=(.+\.cbm)$") {
            $fieldName = $Matches[1].Trim()
            $target = $Matches[2].Trim()
            $targetKind = "CBM"
          }
          elseif ($line -match "^IFCFILE=(.+\.ifc)$") {
            $fieldName = "IFCFILE"
            $target = $Matches[1].Trim()
            $targetKind = "IFC"
          }

          if ($null -ne $fieldName -and $null -ne $target -and $target -ne "") {
            $targetKey = $target.ToLower()
            $exists = $fileIndex.ContainsKey($targetKey)
            $matchedPaths = ""

            if ($exists) {
              $matchedPaths = ($fileIndex[$targetKey] -join ";")
            }

            $rows.Add([PSCustomObject]@{
              sample = $Sample
              sourceRelativePath = $sourceRelativePath
              fieldName = $fieldName
              targetKind = $targetKind
              target = $target
              exists = $exists
              matchedPaths = $matchedPaths
            })
          }
        }
      } catch {
      }
    }

  $rows |
    Export-Csv $Output -NoTypeInformation -Encoding UTF8
}

Export-CbmReferenceIntegrity `
  -SampleRoot ".\demo\demo-line" `
  -CbmRoot ".\demo\demo-line\Cbm" `
  -Sample "demo-line" `
  -Output ".\docs\schema\_generated\demo-line-cbm-integrity.csv"

Export-CbmReferenceIntegrity `
  -SampleRoot ".\demo\demo-substation" `
  -CbmRoot ".\demo\demo-substation\CBM" `
  -Sample "demo-substation" `
  -Output ".\docs\schema\_generated\demo-substation-cbm-integrity.csv"
```

### 12.3 汇总命令

```powershell
function Show-CbmIntegrityStats {
  param(
    [Parameter(Mandatory = $true)]
    [string]$CsvPath
  )

  $rows = Import-Csv $CsvPath

  [PSCustomObject]@{
    file = $CsvPath
    totalReferences = $rows.Count
    okReferences = ($rows | Where-Object { $_.exists -eq "True" }).Count
    missingReferences = ($rows | Where-Object { $_.exists -ne "True" }).Count
    devReferences = ($rows | Where-Object { $_.targetKind -eq "DEV" }).Count
    famReferences = ($rows | Where-Object { $_.targetKind -eq "FAM" }).Count
    cbmReferences = ($rows | Where-Object { $_.targetKind -eq "CBM" }).Count
    ifcReferences = ($rows | Where-Object { $_.targetKind -eq "IFC" }).Count
    missingDev = ($rows | Where-Object { $_.targetKind -eq "DEV" -and $_.exists -ne "True" }).Count
    missingFam = ($rows | Where-Object { $_.targetKind -eq "FAM" -and $_.exists -ne "True" }).Count
    missingCbm = ($rows | Where-Object { $_.targetKind -eq "CBM" -and $_.exists -ne "True" }).Count
    missingIfc = ($rows | Where-Object { $_.targetKind -eq "IFC" -and $_.exists -ne "True" }).Count
  }
}

Show-CbmIntegrityStats ".\docs\schema\_generated\demo-line-cbm-integrity.csv"
Show-CbmIntegrityStats ".\docs\schema\_generated\demo-substation-cbm-integrity.csv"
```

### 12.4 当前结果

demo-line：

```text
totalReferences = 61376
okReferences = 61376
missingReferences = 0
devReferences = 21857
famReferences = 21967
cbmReferences = 17552
ifcReferences = 0
```

demo-substation：

```text
totalReferences = 20987
okReferences = 20987
missingReferences = 0
devReferences = 4179
famReferences = 8554
cbmReferences = 3894
ifcReferences = 4360
```

### 12.5 结果分析

CBM 层引用完整性为 100%。

可以确认：

```text
CBM -> DEV：文件存在性通过
CBM -> FAM：文件存在性通过
CBM -> CBM：文件存在性通过
CBM -> IFC：文件存在性通过
```

但 `IFCGUID` 目前只确认字段存在，还没有校验 GUID 是否能在 IFC 文件内部命中。

---

## 13. Step 10：DEV / PHM 引用完整性校验

### 13.1 目的

确认 DEV 指向的 PHM/DEV、PHM 指向的 MOD/STL 是否真实存在。

### 13.2 命令

```powershell
function Export-DevPhmReferenceIntegrity {
  param(
    [Parameter(Mandatory = $true)]
    [string]$SampleRoot,

    [Parameter(Mandatory = $true)]
    [string]$DevRoot,

    [Parameter(Mandatory = $true)]
    [string]$PhmRoot,

    [Parameter(Mandatory = $true)]
    [string]$Sample,

    [Parameter(Mandatory = $true)]
    [string]$Output
  )

  $sampleRootResolved = (Resolve-Path $SampleRoot).Path
  $fileIndex = New-FileIndex $SampleRoot
  $rows = New-Object System.Collections.Generic.List[object]

  function Add-ReferenceRow {
    param(
      [string]$SourceKind,
      [string]$SourceRelativePath,
      [string]$FieldName,
      [string]$Target
    )

    $target = $Target.Trim()
    $targetKey = $target.ToLower()

    $targetKind = ""
    if ($targetKey -match "\.dev$") { $targetKind = "DEV" }
    elseif ($targetKey -match "\.phm$") { $targetKind = "PHM" }
    elseif ($targetKey -match "\.mod$") { $targetKind = "MOD" }
    elseif ($targetKey -match "\.stl$") { $targetKind = "STL" }
    else { $targetKind = "UNKNOWN" }

    $exists = $fileIndex.ContainsKey($targetKey)
    $matchedPaths = ""

    if ($exists) {
      $matchedPaths = ($fileIndex[$targetKey] -join ";")
    }

    $isExpected = $false

    if ($SourceKind -eq "DEV" -and $FieldName -match "^SOLIDMODEL" -and ($targetKind -eq "PHM" -or $targetKind -eq "DEV")) {
      $isExpected = $true
    }

    if ($SourceKind -eq "DEV" -and $FieldName -match "^SUBDEVICE" -and $targetKind -eq "DEV") {
      $isExpected = $true
    }

    if ($SourceKind -eq "PHM" -and $FieldName -match "^SOLIDMODEL" -and ($targetKind -eq "MOD" -or $targetKind -eq "STL")) {
      $isExpected = $true
    }

    $rows.Add([PSCustomObject]@{
      sample = $Sample
      sourceKind = $SourceKind
      sourceRelativePath = $SourceRelativePath
      fieldName = $FieldName
      targetKind = $targetKind
      target = $target
      exists = $exists
      isExpected = $isExpected
      matchedPaths = $matchedPaths
    })
  }

  Get-ChildItem $DevRoot -File -Filter *.dev |
    ForEach-Object {
      $file = $_
      $sourceRelativePath = $file.FullName.Replace($sampleRootResolved + "\", "")

      try {
        Get-Content -LiteralPath $file.FullName | ForEach-Object {
          $line = $_.Trim()
          if (-not $line) { return }

          if ($line -match "^(SOLIDMODEL\d+)=(.+\.(dev|phm|mod|stl))$") {
            Add-ReferenceRow "DEV" $sourceRelativePath $Matches[1].Trim() $Matches[2].Trim()
          }
          elseif ($line -match "^(SUBDEVICE\d+)=(.+\.dev)$") {
            Add-ReferenceRow "DEV" $sourceRelativePath $Matches[1].Trim() $Matches[2].Trim()
          }
        }
      } catch {
      }
    }

  Get-ChildItem $PhmRoot -File -Filter *.phm |
    ForEach-Object {
      $file = $_
      $sourceRelativePath = $file.FullName.Replace($sampleRootResolved + "\", "")

      try {
        Get-Content -LiteralPath $file.FullName | ForEach-Object {
          $line = $_.Trim()
          if (-not $line) { return }

          if ($line -match "^(SOLIDMODEL\d+)=(.+\.(dev|phm|mod|stl))$") {
            Add-ReferenceRow "PHM" $sourceRelativePath $Matches[1].Trim() $Matches[2].Trim()
          }
        }
      } catch {
      }
    }

  $rows |
    Export-Csv $Output -NoTypeInformation -Encoding UTF8
}

Export-DevPhmReferenceIntegrity `
  -SampleRoot ".\demo\demo-line" `
  -DevRoot ".\demo\demo-line\Dev" `
  -PhmRoot ".\demo\demo-line\Phm" `
  -Sample "demo-line" `
  -Output ".\docs\schema\_generated\demo-line-dev-phm-integrity.csv"

Export-DevPhmReferenceIntegrity `
  -SampleRoot ".\demo\demo-substation" `
  -DevRoot ".\demo\demo-substation\DEV" `
  -PhmRoot ".\demo\demo-substation\PHM" `
  -Sample "demo-substation" `
  -Output ".\docs\schema\_generated\demo-substation-dev-phm-integrity.csv"
```

### 13.3 汇总命令

```powershell
function Show-DevPhmIntegrityStats {
  param(
    [Parameter(Mandatory = $true)]
    [string]$CsvPath
  )

  $rows = Import-Csv $CsvPath

  [PSCustomObject]@{
    file = $CsvPath
    totalReferences = $rows.Count
    okReferences = ($rows | Where-Object { $_.exists -eq "True" }).Count
    missingReferences = ($rows | Where-Object { $_.exists -ne "True" }).Count

    devToPhm = ($rows | Where-Object { $_.sourceKind -eq "DEV" -and $_.targetKind -eq "PHM" }).Count
    devToDevSolidModel = ($rows | Where-Object { $_.sourceKind -eq "DEV" -and $_.fieldName -match "^SOLIDMODEL" -and $_.targetKind -eq "DEV" }).Count
    devSubDeviceToDev = ($rows | Where-Object { $_.sourceKind -eq "DEV" -and $_.fieldName -match "^SUBDEVICE" -and $_.targetKind -eq "DEV" }).Count

    phmToMod = ($rows | Where-Object { $_.sourceKind -eq "PHM" -and $_.targetKind -eq "MOD" }).Count
    phmToStl = ($rows | Where-Object { $_.sourceKind -eq "PHM" -and $_.targetKind -eq "STL" }).Count

    unexpectedReferences = ($rows | Where-Object { $_.isExpected -ne "True" }).Count

    missingDev = ($rows | Where-Object { $_.targetKind -eq "DEV" -and $_.exists -ne "True" }).Count
    missingPhm = ($rows | Where-Object { $_.targetKind -eq "PHM" -and $_.exists -ne "True" }).Count
    missingMod = ($rows | Where-Object { $_.targetKind -eq "MOD" -and $_.exists -ne "True" }).Count
    missingStl = ($rows | Where-Object { $_.targetKind -eq "STL" -and $_.exists -ne "True" }).Count
  }
}

Show-DevPhmIntegrityStats ".\docs\schema\_generated\demo-line-dev-phm-integrity.csv"
Show-DevPhmIntegrityStats ".\docs\schema\_generated\demo-substation-dev-phm-integrity.csv"
```

### 13.4 当前结果

demo-line：

```text
totalReferences = 143594
okReferences = 143594
missingReferences = 0
devToPhm = 1836
devToDevSolidModel = 138622
devSubDeviceToDev = 0
phmToMod = 2955
phmToStl = 181
unexpectedReferences = 0
```

demo-substation：

```text
totalReferences = 14011
okReferences = 14011
missingReferences = 0
devToPhm = 4179
devToDevSolidModel = 0
devSubDeviceToDev = 3894
phmToMod = 4135
phmToStl = 1803
unexpectedReferences = 0
```

### 13.5 结果分析

DEV / PHM 层引用完整性为 100%。

可以确认：

```text
DEV -> PHM：文件存在性通过
DEV -> DEV：文件存在性通过
PHM -> MOD：文件存在性通过
PHM -> STL：文件存在性通过
```

其中：

```text
demo-line 的 DEV -> DEV 来自 SOLIDMODEL=*.dev
demo-substation 的 DEV -> DEV 来自 SUBDEVICE=*.dev
```

当前未发现缺失引用，也未发现超出预期的引用类型。

---

## 14. Round 1 最终静态链路

综合当前分析，两个 demo 的文件级静态链路可以暂定为：

```text
CBM
 ├─ OBJECTMODELPOINTER -> DEV
 │   ├─ SOLIDMODEL -> PHM
 │   │   └─ SOLIDMODEL -> MOD/STL
 │   └─ SOLIDMODEL/SUBDEVICE -> DEV
 ├─ BASEFAMILY -> FAM
 ├─ SUBDEVICE -> CBM
 └─ IFCFILE + IFCGUID -> IFC
```

线路样本的主要路径是：

```text
CBM -> DEV -> PHM -> MOD/STL
CBM -> DEV -> DEV
CBM -> FAM
CBM -> CBM
```

变电样本的主要路径是：

```text
CBM -> DEV -> PHM -> MOD/STL
CBM -> DEV -> SUBDEVICE -> DEV
CBM -> IFCFILE + IFCGUID -> IFC
CBM -> FAM
CBM -> CBM
```

---

## 15. Round 1 已形成的关键结论

### 15.1 GIM 容器结论

当前两个 demo 都是：

```text
GIMPKG* header + 7z payload
```

但 offset 784 只能作为当前样本事实，不能作为通用规范。

### 15.2 目录大小写结论

线路：

```text
Cbm / Dev / Phm / Mod
```

变电：

```text
CBM / DEV / PHM / MOD
```

后续解析必须大小写不敏感。

### 15.3 IFC 结论

当前 demo-substation 中 `.ifc` 文件实际位于 `DEV` 目录。

但 CBM 中存在：

```text
IFCFILE=xxx.ifc
IFCGUID=xxx
```

说明 CBM 层可通过 `IFCFILE + IFCGUID` 关联 IFC 文件和 IFC 构件。

Round 1 只完成 IFC 文件存在性校验。Round 2-A 已进一步完成 IFCGUID 文本命中校验，并发现 IFCGUID 需要区分强关联、弱关联和硬未命中三类。

### 15.4 MOD 结论

MOD 不能统一定义为 XML，也不能统一定义为 CODE/POINTNUM 点线格式。

当前观察：

```text
线路 MOD：存在 CODE / POINTNUM / LINENUM 点线型样本，也存在大量未分类文本
变电 MOD：明显是 XML-like 图元结构
```

因此 MOD 只能暂定为底层几何 / 参数化模型候选文件，不进入 Round 1 解析。

### 15.5 PHM 结论

PHM 是组合模型 / 装配体层。

主要字段：

```text
SOLIDMODELS.NUM
SOLIDMODELn
TRANSFORMMATRIXn
COLORn
```

PHM 通过 `SOLIDMODELn` 引用 MOD/STL。

### 15.6 DEV 结论

DEV 是物理模型 / 设备组合层。

线路：

```text
DEV -> PHM
DEV -> DEV
```

变电：

```text
DEV -> PHM
DEV -> SUBDEVICE -> DEV
```

### 15.7 CBM 结论

CBM 是工程结构 / 层级骨架 / 上游索引层。

主要字段：

```text
OBJECTMODELPOINTER -> DEV
BASEFAMILY -> FAM
SUBDEVICEn -> CBM
IFCFILE + IFCGUID -> IFC
```

线路 CBM 特有字段：

```text
GROUPTYPE
WIRETYPE
```

变电 CBM 特有模式：

```text
IFCFILE + IFCGUID
```

---

## 16. Round 1 当前边界

当前已经完成：

```text
样本清单
文件清单
容器结构
文件角色矩阵
MOD 静态分型
PHM 引用链
DEV 引用链
CBM 字段字典
CBM 引用完整性
DEV / PHM 引用完整性
```

当前尚未完成：

```text
IFCGUID 语义级解释与 IFC 构件属性展开
FAM 与 CBM/DEV 的字段一致性分析
MOD/STL 几何解析
PHM TRANSFORMMATRIX 语义解析
完整设备树递归展开
多工程样本验证
```

---

## 17. Round 1 对后续开发的影响

### 17.1 可以作为稳定依据的内容

以下内容可以作为后续解析器设计依据：

```text
路径匹配需要大小写不敏感
CBM -> DEV 通过 OBJECTMODELPOINTER
CBM -> FAM 通过 BASEFAMILY
CBM -> CBM 通过 SUBDEVICE
CBM -> IFC 通过 IFCFILE + IFCGUID
DEV -> PHM / DEV 通过 SOLIDMODEL 或 SUBDEVICE
PHM -> MOD/STL 通过 SOLIDMODEL
```

### 17.2 不能直接进入实现的内容

以下内容不能直接进入 MVP 实现：

```text
MOD 几何解析
STL 几何解析
线路 3D 渲染
悬链线渲染
PHM 矩阵语义应用
IFCGUID 内部构件命中
完整设备树展开
```

### 17.3 推荐后续阶段

Round 2 可以考虑：

```text
1. IFCGUID 语义级解释与 IFC 构件属性展开
2. FAM 字段字典与 CBM/DEV 字段一致性分析
3. DEV/PHM 递归展开的只读树形审计
4. MOD 静态类型进一步分组
5. 多样本验证当前引用链是否稳定
```

但 Round 2 仍应保持 analysis 范围，不应直接进入几何渲染实现。

---

## 18. Round 1 结论

Round 1 已经完成当前两个 demo 的 GIM 静态结构画像。

核心结论：

```text
当前两个 demo 的 CBM、DEV、PHM 三层文件级引用链均可闭合。
线路和变电在目录大小写、CBM 字段、IFC 使用、DEV 组合方式、MOD 表层格式上存在明显差异。
当前最稳妥的工程策略是：继续把 GIM 解析拆成“文件层引用解析”和“几何层解析”两个阶段。
```

当前可接受的最终静态链路：

```text
CBM
 ├─ OBJECTMODELPOINTER -> DEV
 │   ├─ SOLIDMODEL -> PHM
 │   │   └─ SOLIDMODEL -> MOD/STL
 │   └─ SOLIDMODEL/SUBDEVICE -> DEV
 ├─ BASEFAMILY -> FAM
 ├─ SUBDEVICE -> CBM
 └─ IFCFILE + IFCGUID -> IFC
```

当前只确认文件级引用完整性，不代表已经完成几何解析、属性语义解析或渲染实现。

## 19. Round 2 定位

Round 2 的目标不是进入几何解析或功能开发，而是在 Round 1 文件级引用链闭合的基础上，继续验证两个关键问题：

```text
1. CBM 中的 IFCFILE + IFCGUID 是否真的能定位 IFC 文件内部构件。
2. CBM 中的 BASEFAMILY -> FAM 是否能解释节点属性、节点类型或异常引用。
```

当前仍保持 analysis 范围：

```text
不改 src
不改 SQLite schema
不新增 UI
不实现 IFC 构件高亮
不实现 MOD/STL 几何解析
不改变当前 MVP 行为
```

Round 2 当前分析对象仍然是：

```text
demo-line
demo-substation
```

Round 2 的核心判断是：

```text
IFCGUID 应视为可选定位能力，而不是 GIM 浏览器的强制加载前提。
FAM 应视为 CBM 节点关联的属性 sidecar，而不是先验定义为可复用族模板。
```

---

## 20. Round 2 总体计划

Round 2 按以下阶段推进：

| 阶段        | 目标                                                        | 产出                                                                    |
| ----------- | ----------------------------------------------------------- | ----------------------------------------------------------------------- |
| Round 2-A   | 校验 `IFCFILE + IFCGUID` 是否能在 IFC 文件文本中命中        | `5-gim-reference-integrity.md` 中 IFCGUID 文本命中与 hard missing 分型  |
| Round 2-A.1 | 解释 hard missing IFCGUID 的集中模式与浏览器容错策略        | `5-gim-reference-integrity.md` 中 hard missing 解释与浏览器实现影响     |
| Round 2-B1  | 校验 `CBM -> BASEFAMILY -> FAM` 引用完整性与覆盖关系        | `6-cbm-fam-consistency.md`                                              |
| Round 2-B2  | 分析不同 CBM 类型关联的 FAM 字段形态                        | `6-cbm-fam-consistency.md`                                              |
| Round 2-B3  | 验证 hard missing F4System 的 FAM 是否能解释 IFCGUID 未命中 | `5-gim-reference-integrity.md` 与 `6-cbm-fam-consistency.md` 的交叉结论 |

当前已完成到 Round 2-B3。

---

## 21. Round 2 分析思路

Round 2 采用“先定位能力、再属性 sidecar、最后解释异常”的方式推进。

整体顺序是：

```text
CBM 中的 IFCFILE + IFCGUID
  -> IFCFILE 文件存在性
  -> IFCGUID 在声明 IFC 文件中的文本命中
  -> IFCGUID 在任意 IFC 文件中的文本命中
  -> 精确命中 / 大小写不敏感命中 / hard missing 分型
  -> hard missing 的 CBM 上下文分析
  -> hard missing 的 FAM 对照分析
  -> 浏览器容错策略
```

并行检查：

```text
CBM 中的 BASEFAMILY
  -> FAM 文件存在性
  -> CBM 类型与 FAM 覆盖关系
  -> FAM 字段行解析
  -> 线路 / 变电 FAM schema 差异
  -> FAM 是否能解释 hard missing IFCGUID
```

之所以不直接把 IFCGUID 作为强约束，是因为：

```text
GIM 浏览器需要面向实际工程文件。
实际工程文件可能存在 IFC 缺失、IFCGUID 未命中、通用设备不落 IFC、族表达、占位节点或导出残留关联。
浏览器应尽量加载可用部分，并对不可定位部分发出诊断告警。
```

---

## 22. Step 1：IFCGUID -> IFC 文本命中校验

### 22.1 目的

验证 `demo-substation` 中 CBM 记录的 `IFCFILE + IFCGUID` 是否真的能在 IFC 文件内部命中。

本步骤只做文本级命中校验：

```text
不解析 IFC 语义
不展开 IFC 构件属性
不做 IFC 构件高亮
不判断 GIM 是否规范违规
```

### 22.2 命令

本步骤基于 `demo-substation` 的 CBM 与 IFC 文件生成诊断 CSV：

```powershell
cd D:\vibe-coding\gim_viewer

# 读取 CBM 中的 IFCFILE + IFCGUID
# 对声明 IFC 文件进行精确文本命中检查
# 对声明 IFC 文件进行大小写不敏感文本命中检查
# 对当前 demo-substation 中全部 IFC 文件进行任意文件命中检查
# 输出诊断结果
```

核心输出文件：

```text
docs/schema/_generated/demo-substation-ifc-guid-text-diagnosis.csv
```

后续统计基于该 CSV：

```powershell
Import-Csv ".\docs\schema\_generated\demo-substation-ifc-guid-text-diagnosis.csv" |
  Group-Object declaredIfcExists, exactInDeclaredIfc, caseInsensitiveInDeclaredIfc, exactInAnyIfc, caseInsensitiveInAnyIfc |
  Sort-Object Count -Descending |
  Select-Object Count, Name |
  Format-Table -AutoSize
```

### 22.3 当前结果

总体结果：

```text
IFC 引用总数：4360
IFCFILE 文件存在：4360
IFC 文件缺失：0

IFCGUID 精确命中声明 IFC 文件：3252
IFCGUID 精确未命中声明 IFC 文件：1108

IFCGUID 大小写不敏感命中声明 IFC 文件：3296
IFCGUID 大小写不敏感未命中声明 IFC 文件：1064

IFCGUID 精确命中任意 IFC 文件：3252
任意 IFC 文件均未精确命中：1108

IFCGUID 大小写不敏感命中任意 IFC 文件：3296
任意 IFC 文件均未大小写不敏感命中：1064
```

分型结果：

```text
3252 条：精确命中，可作为强 IFC 构件关联
44 条：精确未命中，但大小写不敏感命中，可作为弱 IFC 构件关联
1064 条：任意 IFC 文件均未命中，不应直接用于 IFC 构件定位
```

### 22.4 分析结论

当前 `IFCFILE + IFCGUID` 不能统一视为“可直接定位 IFC 构件”的强关联。

应按三类处理：

| 类型                  | 判断                                                |
| --------------------- | --------------------------------------------------- |
| 精确命中              | 可作为强 IFC 构件关联                               |
| 大小写不敏感命中      | 可作为弱 IFC 构件关联，后续实现中需要记录归一化警告 |
| 任意 IFC 文件均未命中 | 不应直接用于 IFC 构件定位                           |

当前只说明 IFCGUID 的定位能力存在差异，不说明 GIM 文件错误，也不说明规范不合规。

---

## 23. Step 2：hard missing IFCGUID 上下文分析

### 23.1 目的

解释 1064 条 hard missing IFCGUID 的上下文特征。

重点回答：

```text
这些 hard missing 是否是随机缺失？
是否集中在少数 IFC 文件？
是否集中在少数 IFCGUID？
是否与 CBM 字段缺失、FAM 缺失或 SYSCLASSIFYNAME 有关？
```

### 23.2 命令

统计 hard missing 的 CBM 上下文：

```powershell
cd D:\vibe-coding\gim_viewer

$diag = Import-Csv ".\docs\schema\_generated\demo-substation-ifc-guid-text-diagnosis.csv"

$diag |
  Where-Object { $_.caseInsensitiveInAnyIfc -eq "False" } |
  Group-Object ifcGuid |
  Sort-Object Count -Descending |
  Select-Object -First 30 Count, Name |
  Format-Table -AutoSize
```

比较命中组与未命中组的字段集合：

```powershell
$rows |
  Group-Object caseInsensitiveInAnyIfc, keySignature |
  Sort-Object Count -Descending |
  Select-Object Count, Name |
  Format-Table -AutoSize
```

比较命中组与未命中组的 GUID 复用情况：

```powershell
$guidReuse |
  Group-Object hit |
  ForEach-Object {
    $group = $_.Group

    [PSCustomObject]@{
      hit = $_.Name
      uniqueGuid = $group.Count
      maxReuse = ($group | Measure-Object count -Maximum).Maximum
      reuseGt10 = ($group | Where-Object { $_.count -gt 10 }).Count
      reuseGt100 = ($group | Where-Object { $_.count -gt 100 }).Count
    }
  } |
  Format-Table -AutoSize
```

### 23.3 当前结果

hard missing CBM 上下文：

```text
ENTITYNAME = F4System
OBJECTMODELPOINTER = 空
BASEFAMILY = 有值
SUBDEVICE = 无
SUBDEVICES.NUM = 0
```

hard missing 高度集中在两个 GUID：

```text
3Zu5Bv0LOHrPC10026FoUj：740 条
3Aw$FV5MbAufEo59pkoNlf：193 条
```

这两个 GUID 合计：

```text
933 / 1064 = 87.69%
```

两个高频 GUID 的分布：

```text
3Zu5Bv0LOHrPC10026FoUj：
- 740 个 CBM
- 740 个不同 BASEFAMILY
- 1 个 TRANSFORMMATRIX
- 分布在 2 个 IFCFILE

3Aw$FV5MbAufEo59pkoNlf：
- 193 个 CBM
- 193 个不同 BASEFAMILY
- 1 个 TRANSFORMMATRIX
- 分布在 1 个 IFCFILE
```

命中组与未命中组的字段集合一致：

```text
BASEFAMILY
ENTITYNAME
IFCFILE
IFCGUID
OBJECTMODELPOINTER
SUBDEVICES.NUM
SYSCLASSIFYNAME
TRANSFORMMATRIX
```

GUID 复用对照：

```text
命中组：
uniqueGuid = 2704
maxReuse = 4
reuseGt10 = 0
reuseGt100 = 0

未命中组：
uniqueGuid = 128
maxReuse = 740
reuseGt10 = 2
reuseGt100 = 2
```

### 23.4 分析结论

hard missing 的核心特征不是 FAM、不是 CBM 字段集合、也不是 SYSCLASSIFYNAME。

更准确的结论是：

```text
命中组表现为“构件级 GUID 分散引用”。
hard missing 组表现为“少数不存在于 IFC 文件中的 GUID 被大量 CBM 节点复用”。
```

因此，hard missing 更像：

```text
部分 F4System + IFC 节点记录了不可定位 IFCGUID。
这些 GUID 不能作为普通构件级 IFCGUID 处理。
```

但该现象不应直接解释为 GIM 文件错误或规范不合规。

从浏览器角度，应处理为：

```text
允许加载
保留 CBM 节点
不执行 IFC 构件定位
在诊断结果中提示 IFCGUID 无法定位
```

---

## 24. Step 3：CBM -> FAM 引用完整性与覆盖关系

### 24.1 目的

验证 CBM 中的 `BASEFAMILY` 是否能找到目标 FAM 文件，并观察 FAM 是否具有复用型族模板特征。

重点回答：

```text
CBM 写了 BASEFAMILY 时，FAM 文件是否存在？
一个 FAM 是否被多个 CBM 复用？
不同 modelKind 的 CBM 是否都有 FAM？
FAM 更像族模板，还是实例属性 sidecar？
```

### 24.2 命令

统计 CBM -> FAM 基础关系：

```powershell
cd D:\vibe-coding\gim_viewer

Show-CbmFamStats ".\docs\schema\_generated\demo-line-cbm-fam-context.csv"
Show-CbmFamStats ".\docs\schema\_generated\demo-substation-cbm-fam-context.csv"
```

按 modelKind 汇总：

```powershell
Show-CbmFamByModelKind ".\docs\schema\_generated\demo-line-cbm-fam-context.csv"
Show-CbmFamByModelKind ".\docs\schema\_generated\demo-substation-cbm-fam-context.csv"
```

按 entityName + modelKind 汇总：

```powershell
Show-CbmFamByEntityAndModel ".\docs\schema\_generated\demo-line-cbm-fam-context.csv"
Show-CbmFamByEntityAndModel ".\docs\schema\_generated\demo-substation-cbm-fam-context.csv"
```

核心输出文件：

```text
docs/schema/_generated/demo-line-cbm-fam-context.csv
docs/schema/_generated/demo-substation-cbm-fam-context.csv
```

### 24.3 当前结果

总体统计：

| 样本            | CBM 总数 | 有 BASEFAMILY | 无 BASEFAMILY | FAM 存在 | FAM 缺失 | 唯一 BASEFAMILY |
| --------------- | -------: | ------------: | ------------: | -------: | -------: | --------------: |
| demo-line       |    27829 |         21967 |          5862 |    21967 |        0 |           21967 |
| demo-substation |     8701 |          8554 |           147 |     8554 |        0 |            8554 |

demo-line 按 modelKind：

| modelKind        |  总数 | 有 BASEFAMILY | 无 BASEFAMILY | FAM 存在 | FAM 缺失 |  覆盖率 |
| ---------------- | ----: | ------------: | ------------: | -------: | -------: | ------: |
| DEV              | 21857 |         21857 |             0 |    21857 |        0 | 100.00% |
| CBM_GROUP        |  5534 |             0 |          5534 |        0 |        0 |   0.00% |
| NO_MODEL_POINTER |   438 |           110 |           328 |      110 |        0 |  25.11% |

demo-substation 按 modelKind：

| modelKind        | 总数 | 有 BASEFAMILY | 无 BASEFAMILY | FAM 存在 | FAM 缺失 |  覆盖率 |
| ---------------- | ---: | ------------: | ------------: | -------: | -------: | ------: |
| IFC              | 4360 |          4360 |             0 |     4360 |        0 | 100.00% |
| DEV              | 4179 |          4179 |             0 |     4179 |        0 | 100.00% |
| NO_MODEL_POINTER |  162 |            15 |           147 |       15 |        0 |   9.26% |

### 24.4 分析结论

当前两个 demo 中：

```text
凡是 CBM 写了 BASEFAMILY，目标 FAM 文件均存在。
CBM -> BASEFAMILY -> FAM 文件级引用完整性为 100%。
```

同时：

```text
demo-line:
hasBaseFamily = 21967
uniqueBaseFamily = 21967

demo-substation:
hasBaseFamily = 8554
uniqueBaseFamily = 8554
```

因此，当前两个 demo 中，`BASEFAMILY` 呈现一 CBM 对一 FAM 的实例级对应关系。

当前不宜把 FAM 先验定义为“可复用族模板”。更稳妥的表述是：

```text
FAM 是 CBM 节点关联的属性文件。
当前两个 demo 中，BASEFAMILY 呈现实例级属性 sidecar 特征。
```

---

## 25. Step 4：FAM 字段形态分析

### 25.1 目的

观察线路和变电 FAM 的字段形态，判断是否可以设计统一固定 DTO。

重点回答：

```text
FAM 字段是英文 key 还是中文 key？
线路和变电 FAM schema 是否相同？
是否可以提前固定 FAM DTO？
```

### 25.2 命令

统计 FAM 行类型：

```powershell
Import-Csv ".\docs\schema\_generated\demo-line-fam-field-rows.csv" |
  Group-Object rowKind |
  Sort-Object Count -Descending |
  Select-Object Count, Name |
  Format-Table -AutoSize

Import-Csv ".\docs\schema\_generated\demo-substation-fam-field-rows.csv" |
  Group-Object rowKind |
  Sort-Object Count -Descending |
  Select-Object Count, Name |
  Format-Table -AutoSize
```

统计 FAM key 分布：

```powershell
Import-Csv ".\docs\schema\_generated\demo-line-fam-field-rows.csv" |
  Where-Object { $_.key -ne "" } |
  Group-Object key |
  Sort-Object Count -Descending |
  Select-Object -First 80 Count, Name |
  Format-Table -AutoSize

Import-Csv ".\docs\schema\_generated\demo-substation-fam-field-rows.csv" |
  Where-Object { $_.key -ne "" } |
  Group-Object key |
  Sort-Object Count -Descending |
  Select-Object -First 80 Count, Name |
  Format-Table -AutoSize
```

核心输出文件：

```text
docs/schema/_generated/demo-line-fam-field-rows.csv
docs/schema/_generated/demo-substation-fam-field-rows.csv
```

### 25.3 当前结果

demo-line FAM 行类型：

| rowKind             |   数量 |
| ------------------- | -----: |
| CN_KEY_VALUE        | 179123 |
| KEY_VALUE           |   3063 |
| CONTINUATION_OR_RAW |   1330 |

demo-line 主要 key：

```text
MATERIALCODE
MANUFACTURER
BUNDLENUMBER
TYPE
SAFETYCOEFFICIENTMAXTENSION
EVERYDAYTENSION
MAXTENSION
PHASE
VOLTAGE
WIREPOINT
TOWERPOINT
INSULATORTYPE
TOWERNUMBER
LINEANGLE
RULINGSPAN
SPAN
```

demo-substation FAM 行类型：

| rowKind             |  数量 |
| ------------------- | ----: |
| CN_KEY_VALUE        | 40858 |
| CONTINUATION_OR_RAW |  6029 |
| KEY_VALUE           |     9 |

demo-substation 主要 key：

```text
额定电压
生产厂家
单位
电网工程标识系统编码
软件版本
装置名称
装置型号
装置编号
实物ID
工程中名称
附件名称
建设期次
三维设计模型编码
设备名称
电压等级
调度编码
```

### 25.4 分析结论

线路 FAM 以英文 KEY 为主，偏线路工程参数：

```text
导线属性
杆塔属性
绝缘子串属性
基础属性
张力 / 应力 / 相序 / 电压等级等工程参数
```

变电 FAM 以中文 KEY 为主，偏设备台账、工程管理和设备参数：

```text
额定电压
生产厂家
装置名称 / 型号 / 编号
电网工程标识系统编码
三维设计模型编码
实物ID
工程中名称
```

因此：

```text
线路与变电 FAM schema 差异显著。
后续解析应保持弱 schema / key-value 结构。
不宜过早固定 FAM DTO。
```

---

## 26. Step 5：hard missing F4System 的 FAM 对照分析

### 26.1 目的

验证 hard missing IFCGUID 是否可以通过 FAM 字段解释。

重点回答：

```text
hard missing F4System 是否有关联 FAM？
这些 FAM 是否存在？
这些 FAM 是否有有效字段？
命中组和 hard missing 组的 FAM 是否存在差异？
```

### 26.2 命令

检查 hard missing F4System 的 FAM 文件长度：

```powershell
$ctx = Import-Csv ".\docs\schema\_generated\demo-substation-ifc-guid-hard-missing-cbm-context.csv"

$rows = foreach ($row in $ctx) {
  $famName = $row.baseFamily.Trim()

  $file = Get-ChildItem ".\demo\demo-substation" -Recurse -File -Filter $famName |
    Select-Object -First 1

  [PSCustomObject]@{
    sourceRelativePath = $row.sourceRelativePath
    ifcFile = $row.ifcFile
    ifcGuid = $row.ifcGuid
    baseFamily = $famName
    famExists = ($file -ne $null)
    famLength = if ($file -ne $null) { $file.Length } else { $null }
  }
}

$rows |
  Group-Object famExists, famLength |
  Sort-Object Count -Descending |
  Select-Object Count, Name |
  Format-Table -AutoSize
```

对照命中组与未命中组的 FAM 是否为空：

```powershell
$rows |
  Where-Object { $_.entityName -eq "F4System" -and $_.modelKind -eq "IFC" } |
  Group-Object caseInsensitiveInAnyIfc, famIsBlank |
  Sort-Object Count -Descending |
  Select-Object Count, Name |
  Format-Table -AutoSize
```

### 26.3 当前结果

hard missing F4System 的 FAM 文件检查：

```text
1064 True, 2
```

汇总：

```text
total = 1064
famExists = 1064
famMissing = 0
zeroOrBlankFam = 1064
nonEmptyFam = 0
```

命中组与未命中组对照：

```text
3296 True, True
1064 False, True
```

含义：

```text
F4System + IFC 节点一共 4360 条。
其中 3296 条 IFCGUID 能在 IFC 中命中，FAM 也是空的。
其中 1064 条 IFCGUID 不能在 IFC 中命中，FAM 也是空的。
```

### 26.4 分析结论

FAM 不能解释 hard missing IFCGUID。

原因是：

```text
F4System + IFC 节点的 FAM 基本都是空 sidecar。
空 FAM 不是 hard missing 的专属特征。
命中组和未命中组的 FAM 都是空的。
```

因此，hard missing 的原因不在 FAM 字段，而应回到：

```text
IFCGUID 是否存在于 IFC 文件
GUID 复用模式
CBM 节点是否为可定位构件
浏览器是否应容错降级
```

---

## 27. Round 2 当前结论

Round 2 当前形成以下结论：

```text
1. IFCFILE 文件存在性可以通过，但 IFCGUID 不一定能在 IFC 内部命中。
2. IFCGUID 应分为强关联、弱关联、不可定位关联三类。
3. hard missing IFCGUID 不应直接判定为 GIM 文件错误或规范不合规。
4. hard missing 的核心特征是少数不存在于 IFC 文件中的 GUID 被大量 CBM 节点复用。
5. FAM 不能解释 hard missing IFCGUID，因为 F4System + IFC 节点的 FAM 基本都是空 sidecar。
6. CBM -> BASEFAMILY -> FAM 的文件级引用完整性为 100%。
7. 当前两个 demo 中，FAM 呈现一 CBM 对一 FAM 的实例属性 sidecar 特征。
8. 线路与变电 FAM schema 差异显著，后续解析应保持弱 schema / key-value 结构。
9. 浏览器实现应把 IFCGUID 视为可选定位能力，而不是强制加载前提。
```

浏览器侧建议策略：

| 场景                                    | 浏览器策略                                           |
| --------------------------------------- | ---------------------------------------------------- |
| IFCFILE 存在 + IFCGUID 精确命中         | 可作为强 IFC 构件关联                                |
| IFCFILE 存在 + IFCGUID 大小写不敏感命中 | 可作为弱 IFC 构件关联，并记录归一化警告              |
| IFCFILE 存在 + IFCGUID 未命中           | 不阻断加载，保留 CBM 节点，诊断提示 IFCGUID 无法定位 |
| IFCFILE 缺失                            | 不阻断加载，保留 CBM 节点，诊断提示 IFC 文件缺失     |
| FAM 为空                                | 不阻断加载，属性面板显示为空或提示无属性字段         |
| FAM schema 差异                         | 使用 key-value 弱 schema，不提前固定 DTO             |

---

## 28. Round 2 当前边界

当前已经完成：

```text
IFCGUID 文本命中校验
IFCGUID hard missing 分型
hard missing 高频 GUID 复用分析
hard missing F4System 的 FAM 对照分析
CBM -> FAM 引用完整性校验
CBM 类型与 FAM 覆盖关系分析
FAM 字段形态分析
浏览器容错策略收口
```

当前尚未完成：

```text
IFC 构件属性语义展开
IFC GUID 与 IFC 实体类型的映射分析
DEV / PHM / MOD / STL 递归树审计
PHM TRANSFORMMATRIX 语义解析
MOD/STL 几何解析
多工程样本验证
```

Round 2 当前仍只属于 schema analysis，不进入几何解析或产品功能实现。

## 29. Round 3 定位

Round 3 的目标不是实现几何解析或渲染，而是在 Round 1 / Round 2 已确认文件级引用链、IFC 命中分型、CBM -> FAM 基础关系后，继续验证：

```text id="clbb56"
CBM -> DEV -> PHM -> MOD/STL
```

这条链路在当前两个 demo 中是否能形成稳定的、可遍历的文件级几何目标引用链。

当前分析对象：

```text id="rlain0"
demo-line
demo-substation
```

当前分析范围：

```text id="grtwd9"
DEV 文件全集
DEV -> DEV / PHM 引用模式
DEV root / child 角色
CBM -> DEV 入口角色
DEV 图深度与环检测
PHM -> MOD/STL 引用模式
无几何 PHM
装配节点自身无几何但子设备有几何
orphan geometry 文件
CBM 几何目标可达性总分类
```

当前不做：

```text id="tl4dbv"
不改 src
不改 SQLite schema
不新增 UI
不实现 MOD 解析
不实现 STL 解析
不应用 TRANSFORMMATRIX
不做 3D 渲染
不做悬链线
不改变当前 MVP 行为
```

Round 3 的核心判断是：

```text id="tpfsnb"
当前两个 demo 中，DEV-linked CBM 均能沿 DEV / PHM 引用链到达至少一个 MOD 或 STL 几何目标。
但这只证明文件级几何目标可达，不代表 MOD/STL 已经完成语义解析或可渲染。
```

---

## 30. Round 3 总体计划

Round 3 按以下阶段推进：

| 阶段      | 目标                                       | 产出                              |
| --------- | ------------------------------------------ | --------------------------------- |
| Round 3.1 | 统计 DEV / PHM / MOD / STL 文件全集        | 文件数量基线                      |
| Round 3.2 | 分析 DEV 引用 PHM / DEV / SUBDEVICE 的模式 | DEV 引用模式                      |
| Round 3.3 | 判定 DEV 内部 root / child 角色            | root DEV 与 child DEV 对照        |
| Round 3.4 | 对齐 CBM -> DEV 入口与 DEV 内部角色        | CBM 入口角色分析                  |
| Round 3.5 | 检查 DEV 图深度与环                        | 最大深度、环检测                  |
| Round 3.6 | 分析 PHM -> MOD/STL 引用模式               | PHM 几何目标引用统计              |
| Round 3.7 | 分析无目标 PHM 与装配节点                  | assembly without own geometry     |
| Round 3.8 | 分析 orphan geometry 文件                  | unreferenced geometry 文件分类    |
| Round 3.9 | 汇总 CBM 几何可达性                        | DEV-linked CBM 的几何可达性总分类 |

当前已完成到 Round 3.9。

---

## 31. Round 3 分析思路

Round 3 采用“从文件全集到用户入口”的方式推进。

整体顺序是：

```text id="uzb7kk"
DEV / PHM / MOD / STL 文件全集
  -> DEV 引用模式
  -> DEV root / child 角色
  -> CBM -> DEV 入口角色
  -> DEV 图深度与环检测
  -> PHM -> MOD/STL 引用模式
  -> 无几何 PHM 解释
  -> orphan geometry 文件解释
  -> CBM 几何目标可达性总分类
```

之所以采用这个顺序，是因为浏览器最终面对的是 CBM 节点，但几何目标在下游：

```text id="mg17ce"
CBM
  -> OBJECTMODELPOINTER -> DEV
     -> SOLIDMODEL -> PHM
        -> SOLIDMODEL -> MOD/STL
```

或者：

```text id="g6z3i3"
CBM
  -> OBJECTMODELPOINTER -> DEV
     -> SOLIDMODEL / SUBDEVICE -> child DEV
        -> SOLIDMODEL -> PHM
           -> SOLIDMODEL -> MOD/STL
```

因此必须先确认 DEV 图是否可遍历，再判断 CBM 入口是否能到达几何目标。

---

## 32. Step 1：DEV / PHM / MOD / STL 文件全集

### 32.1 目的

确认 Round 3 的分析对象范围，建立 DEV / PHM / MOD / STL 文件数量基线。

### 32.2 命令

```powershell id="kv42xr"
cd D:\vibe-coding\gim_viewer

Get-ChildItem ".\demo\demo-line" -Recurse -File |
  Where-Object { $_.Extension -in ".dev", ".phm", ".mod", ".stl" } |
  Group-Object Extension |
  Sort-Object Name |
  Select-Object Name, Count |
  Format-Table -AutoSize

Get-ChildItem ".\demo\demo-substation" -Recurse -File |
  Where-Object { $_.Extension -in ".dev", ".phm", ".mod", ".stl" } |
  Group-Object Extension |
  Sort-Object Name |
  Select-Object Name, Count |
  Format-Table -AutoSize
```

### 32.3 当前结果

demo-line：

| 扩展名 | 数量 |
| ------ | ---: |
| `.dev` | 4518 |
| `.phm` | 1836 |
| `.mod` | 1807 |
| `.stl` |  181 |

demo-substation：

| 扩展名 | 数量 |
| ------ | ---: |
| `.dev` | 4179 |
| `.phm` | 4179 |
| `.mod` | 4179 |
| `.stl` | 1803 |

### 32.4 分析结论

demo-line 中 DEV 数量明显大于 PHM，说明线路样本中存在较多 DEV -> DEV 的组合 / 复用关系。

demo-substation 中 DEV / PHM / MOD 数量均为 4179，说明变电样本大概率存在较强的一对一链条：

```text id="e5dfms"
DEV -> PHM -> MOD
```

STL 是补充几何文件，不是每个 PHM 都有。

---

## 33. Step 2：DEV 引用模式

### 33.1 目的

确认 DEV 文件内部到底通过 `SOLIDMODEL` 指向 PHM，还是指向其他 DEV；同时确认是否存在 `SUBDEVICE` 引用。

### 33.2 命令

```powershell id="fuk2iu"
cd D:\vibe-coding\gim_viewer

Show-DevReferenceMode ".\demo\demo-line\Dev"
Show-DevReferenceMode ".\demo\demo-substation\DEV"
```

进一步统计引用数量：

```powershell id="t46gf5"
Show-DevReferenceCount ".\demo\demo-line\Dev"
Show-DevReferenceCount ".\demo\demo-substation\DEV"
```

### 33.3 当前结果

demo-line：

| 数量 | 引用模式  |
| ---: | --------- |
| 2682 | `.dev, 0` |
| 1836 | `.phm, 0` |

含义：

```text id="mri51f"
2682 个 DEV 的 SOLIDMODEL 指向 .dev
1836 个 DEV 的 SOLIDMODEL 指向 .phm
所有 DEV 都没有 SUBDEVICE
```

demo-line 按引用数量统计：

| 数量 | 引用模式       |
| ---: | -------------- |
| 1836 | `.phm, 1, 0`   |
|  408 | `.dev, 40, 0`  |
|  384 | `.dev, 109, 0` |
|  267 | `.dev, 5, 0`   |
|  244 | `.dev, 7, 0`   |
|  240 | `.dev, 107, 0` |
|  187 | `.dev, 9, 0`   |
|  123 | `.dev, 4, 0`   |
|  120 | `.dev, 75, 0`  |
|  116 | `.dev, 37, 0`  |
|  109 | `.dev, 13, 0`  |
|  107 | `.dev, 77, 0`  |
|   91 | `.dev, 71, 0`  |
|   74 | `.dev, 70, 0`  |
|   58 | `.dev, 42, 0`  |
|   26 | `.dev, 76, 0`  |
|   24 | `.dev, 143, 0` |
|   21 | `.dev, 104, 0` |
|   18 | `.dev, 87, 0`  |
|   16 | `.dev, 1, 0`   |
|   16 | `.dev, 8, 0`   |
|   12 | `.dev, 101, 0` |
|    7 | `.dev, 81, 0`  |
|    7 | `.dev, 83, 0`  |
|    3 | `.dev, 139, 0` |
|    3 | `.dev, 85, 0`  |
|    1 | `.dev, 189, 0` |

demo-substation：

| 数量 | 引用模式   |
| ---: | ---------- |
| 3921 | `.phm, 0`  |
|   54 | `.phm, 21` |
|   36 | `.phm, 1`  |
|   25 | `.phm, 12` |
|   18 | `.phm, 2`  |
|   16 | `.phm, 7`  |
|   15 | `.phm, 10` |
|   12 | `.phm, 9`  |
|    6 | `.phm, 75` |
|    6 | `.phm, 5`  |
|    6 | `.phm, 14` |
|    6 | `.phm, 8`  |

含义：

```text id="nxwggm"
demo-substation 全部 DEV 的 SOLIDMODEL 都指向 .phm。
其中 3921 个 DEV 没有 SUBDEVICE。
其余 258 个 DEV 有 SUBDEVICE。
SUBDEVICE -> DEV 引用总数为 3894。
```

### 33.4 分析结论

线路样本：

```text id="ykwrt8"
DEV 递归主链是 SOLIDMODEL -> DEV。
组合 DEV 的扇出较大，最大单个 DEV 引用 189 个 child DEV。
```

变电样本：

```text id="bihomn"
DEV 几何主链是 SOLIDMODEL -> PHM。
设备组合主链是 SUBDEVICE -> DEV。
最大单个 DEV 有 75 个 SUBDEVICE。
```

---

## 34. Step 3：DEV 内部 root / child 角色

### 34.1 目的

区分哪些 DEV 是被其他 DEV 引用的 child DEV，哪些 DEV 是 DEV 内部图中的 root candidate。

这里的 root candidate 只表示：

```text id="tpyeju"
没有被其他 DEV 通过 SOLIDMODEL 或 SUBDEVICE 引用的 DEV。
```

它还不是最终 GIM 对象根节点。最终对象入口还需要结合：

```text id="hxfq5r"
CBM -> OBJECTMODELPOINTER -> DEV
```

### 34.2 命令

```powershell id="oubj78"
cd D:\vibe-coding\gim_viewer

Show-DevRootChildStats ".\demo\demo-line\Dev"
Show-DevRootChildStats ".\demo\demo-substation\DEV"
```

### 34.3 当前结果

demo-line：

```text id="fvkt5c"
totalDev                 : 4518
internalDevEdges         : 138622
missingDevEdges          : 0
childDevCount            : 173
rootDevCandidateCount    : 4345
maxParentsOrRefsPerChild : 26034
reusedChildDevCount      : 172
```

Top reused child DEV：

| 引用次数 | DEV                                        |
| -------: | ------------------------------------------ |
|    26034 | `70a17d5e-83ff-41ea-a931-be7146599692.dev` |
|    20800 | `3abcf9b3-0b5b-484d-9a5c-4d5b94864ebc.dev` |
|    14058 | `37e337cf-3b45-43db-a742-bdc20a76a0c0.dev` |
|     9792 | `8225a4b3-afb0-4ad3-b270-8463be184bcd.dev` |
|     8715 | `9e67c7f3-b43c-4cb9-afd0-71518db7fc5a.dev` |

demo-substation：

```text id="mah8yk"
totalDev                 : 4179
internalDevEdges         : 3894
missingDevEdges          : 0
childDevCount            : 3894
rootDevCandidateCount    : 285
maxParentsOrRefsPerChild : 1
reusedChildDevCount      : 0
```

### 34.4 分析结论

demo-line：

```text id="issk1g"
少量 child DEV 被大量复用。
这更像“组件库 / 参数化构件 / 同质化部件复用”模式。
```

demo-substation：

```text id="skxirf"
每个 child DEV 只被引用 1 次。
这更像“设备树 / 装配树 / 实例级层级”模式。
```

当前两个 demo 的结果与领域经验一致：

```text id="pkupri"
线路工程构件同质化程度较高，适合族 / 模板 / 参数化复用。
变电工程设备异质性更强，更接近实例级设备树。
```

但该解释只作为领域经验辅助理解，不能直接扩大为 GIM 通用规范结论。

---

## 35. Step 4：CBM -> DEV 入口与 DEV 内部角色对齐

### 35.1 目的

验证 CBM 指向的 DEV 是 DEV 内部 root candidate，还是 child DEV。

重点回答：

```text id="nqdpbo"
CBM 引用了多少个 DEV？
CBM 引用的 DEV 是否存在？
CBM 是直接引用 root DEV，还是也会直接引用 child DEV？
线路中高复用 child DEV 是否被 CBM 直接引用？
变电中 F4System / PARTINDEX 分别对应什么 DEV 角色？
```

### 35.2 命令

```powershell id="jjk7yo"
cd D:\vibe-coding\gim_viewer

Show-CbmDevEntryVsInternalRole ".\demo\demo-line" "Cbm" "Dev"
Show-CbmDevEntryVsInternalRole ".\demo\demo-substation" "CBM" "DEV"
```

### 35.3 当前结果

demo-line：

```text id="pjb5xq"
cbmDevEntries         : 21857
uniqueEntryDev        : 4345
missingEntryDev       : 0
entryRootDevCandidate : 21857
entryChildDev         : 0
```

按 entityName + internal role：

|  数量 | 类型                               |
| ----: | ---------------------------------- |
| 11773 | `Wire_Device, ROOT_DEV_CANDIDATE`  |
|  5460 | `WIRE, ROOT_DEV_CANDIDATE`         |
|  4309 | `Tower_Device, ROOT_DEV_CANDIDATE` |
|   315 | `CROSS, ROOT_DEV_CANDIDATE`        |

demo-substation：

```text id="igxrs6"
cbmDevEntries         : 4179
uniqueEntryDev        : 4179
missingEntryDev       : 0
entryRootDevCandidate : 285
entryChildDev         : 3894
```

按 entityName + internal role：

| 数量 | 类型                           |
| ---: | ------------------------------ |
| 3894 | `PARTINDEX, CHILD_DEV`         |
|  285 | `F4System, ROOT_DEV_CANDIDATE` |

### 35.4 分析结论

demo-line：

```text id="qfqlki"
CBM 只引用顶层 DEV。
DEV 内部再通过 SOLIDMODEL -> DEV 引用少量高复用 child DEV。
```

线路组织方式可以表示为：

```text id="ws2bbz"
CBM 实例
  -> root DEV
     -> reusable child DEV
        -> PHM
           -> MOD/STL
```

demo-substation：

```text id="xy9zpc"
CBM 同时记录设备级 F4System 和部件级 PARTINDEX。
F4System DEV 通过 SUBDEVICE 引用 PARTINDEX DEV。
但 PARTINDEX DEV 本身也被 CBM 直接引用。
```

变电组织方式可以表示为：

```text id="gi2j3y"
CBM F4System
  -> root DEV
     -> child DEV

CBM PARTINDEX
  -> same child DEV
```

---

## 36. Step 5：DEV 图深度与环检测

### 36.1 目的

验证 DEV 内部图是否存在更深层递归或引用环。

重点回答：

```text id="vhj5mb"
是否存在 DEV -> DEV -> DEV 更深层级？
是否存在 DEV 引用环？
当前两个 demo 的 DEV 图最大深度是多少？
```

### 36.2 命令

```powershell id="u7xdki"
cd D:\vibe-coding\gim_viewer

Show-DevGraphDepth ".\demo\demo-line\Dev"
Show-DevGraphDepth ".\demo\demo-substation\DEV"
```

### 36.3 当前结果

demo-line：

```text id="u18jfg"
totalDev              : 4518
rootDevCandidateCount : 4345
maxDevToDevDepth      : 1
cycleCount            : 0
leafPathCount         : 140285
```

Depth distribution：

| 路径数 | depth |
| -----: | ----: |
|   1663 |     0 |
| 138622 |     1 |

demo-substation：

```text id="uriyvj"
totalDev              : 4179
rootDevCandidateCount : 285
maxDevToDevDepth      : 1
cycleCount            : 0
leafPathCount         : 3921
```

Depth distribution：

| 路径数 | depth |
| -----: | ----: |
|     27 |     0 |
|   3894 |     1 |

### 36.4 分析结论

当前两个 demo 的 DEV 内部引用图都是浅层图：

```text id="j4u70a"
最大 DEV-to-DEV 深度 = 1
没有发现 DEV 引用环
没有发现 DEV-to-DEV 缺失引用
```

demo-line：

```text id="i2heuf"
1663 个 root DEV 直接作为叶子 DEV，自身指向 PHM。
2682 个 root DEV 通过 SOLIDMODEL 引用 child DEV，child DEV 再指向 PHM。
```

demo-substation：

```text id="ci635u"
27 个 root DEV 没有 SUBDEVICE，自身指向 PHM。
258 个 root DEV 通过 SUBDEVICE 引用 child DEV。
3894 个 child DEV 被 root DEV 引用，同时也被 CBM PARTINDEX 直接引用。
```

实现影响：

```text id="mjmcwv"
MVP 阶段不需要先假设复杂无限递归。
但解析器仍应按递归写法实现，并加 visited 防环。
```

---

## 37. Step 6：PHM -> MOD/STL 引用模式

### 37.1 目的

确认 DEV 叶子最终是否都能落到 PHM，再由 PHM 指向 MOD/STL 几何目标。

### 37.2 命令

```powershell id="xsk0eo"
cd D:\vibe-coding\gim_viewer

Show-PhmReferenceMode ".\demo\demo-line" "Phm" "Mod"
Show-PhmReferenceMode ".\demo\demo-substation" "PHM" "MOD"
```

### 37.3 当前结果

demo-line：

```text id="d5ttns"
totalPhm            : 1836
totalTargets        : 3136
totalMissingTargets : 0
```

按 targetExts + targetCount + missingTargetCount：

| 数量 | 模式         |
| ---: | ------------ |
| 1300 | `.mod, 2, 0` |
|  355 | `.mod, 1, 0` |
|  181 | `.stl, 1, 0` |

demo-substation：

```text id="bawtha"
totalPhm            : 4179
totalTargets        : 5938
totalMissingTargets : 0
```

按 targetExts + targetCount + missingTargetCount：

| 数量 | 模式              |
| ---: | ----------------- |
| 4049 | `.mod, 1, 0`      |
|   30 | `.stl, 1, 0`      |
|   16 | `.mod,.stl, 2, 0` |
|   14 | `, 0, 0`          |

其余少量 PHM 同时引用多个 MOD/STL。

### 37.4 分析结论

demo-line：

```text id="hy3lhc"
PHM 引用目标全部存在。
PHM 最终落到 MOD 或 STL。
没有发现 PHM -> MOD/STL 缺失引用。
```

demo-substation：

```text id="vh5em0"
PHM 引用目标全部存在。
但存在 14 个 PHM 没有 SOLIDMODEL 目标。
另有少量 PHM 引用大量 MOD/STL，可能对应复杂组合几何。
```

当前可以区分两种情况：

```text id="l6446u"
PHM -> MOD/STL 缺失：
目标写了，但文件找不到。

无几何 PHM：
目标根本没写。
```

demo-substation 的 14 个 PHM 属于后者，不应直接作为 missing reference 处理。

---

## 38. Step 7：无目标 PHM 与装配节点分析

### 38.1 目的

解释 demo-substation 中 14 个没有 MOD/STL 目标的 PHM。

重点回答：

```text id="x84z4j"
这些 PHM 是否孤立？
是否被 DEV 引用？
引用这些 PHM 的 DEV 是否被 CBM 引用？
这些 DEV 是否有 SUBDEVICE？
子 DEV 是否能到达几何？
```

### 38.2 命令

检查无目标 PHM：

```powershell id="fplhb2"
cd D:\vibe-coding\gim_viewer

Show-PhmNoTargetFiles ".\demo\demo-substation\PHM"
```

反查无目标 PHM 的 DEV / CBM 使用情况：

```powershell id="um2u5j"
Show-NoTargetPhmUsage ".\demo\demo-substation" "PHM" "DEV" "CBM"
```

验证无几何 root DEV 的子设备几何是否完整：

```powershell id="uamfqg"
Show-NoGeometryRootDevChildren ".\demo\demo-substation"
```

### 38.3 当前结果

14 个无目标 PHM：

| PHM                                        | length | SOLIDMODEL 行数 |
| ------------------------------------------ | -----: | --------------: |
| `1925865d-5ac8-40bd-8c9f-abf8c35b667e.phm` |     21 |               0 |
| `310d95fe-cb39-4d07-b4a6-c8deb9425573.phm` |     21 |               0 |
| `37e853ae-64e5-499c-bd96-7d700ffd751d.phm` |     21 |               0 |
| `5d5812dd-1427-4cb4-83f7-9e0126035e2a.phm` |     21 |               0 |
| `63d540cf-058e-4f09-bbb1-cb1b0917d790.phm` |     21 |               0 |
| `6f4be64b-92b3-4955-b5f1-d7a5cbf5f3f7.phm` |     21 |               0 |
| `7bffd7a0-bc87-4f52-a5e9-f50d1596e9f9.phm` |     21 |               0 |
| `7ef16b9b-fe8c-4d86-8c29-cbaf1fcefe37.phm` |     21 |               0 |
| `81d86027-46c6-491d-9e09-edddefed9db3.phm` |     21 |               0 |
| `908854e7-a16c-47ef-92ef-b3ee12a920ee.phm` |     21 |               0 |
| `b1b1f864-a3e5-4ae5-b8a8-ed57b3c28805.phm` |     21 |               0 |
| `c04f4489-9df9-4db1-8c57-aa047a57ee60.phm` |     21 |               0 |
| `c8de9c5a-1517-477f-a08f-d7357f4dc441.phm` |     21 |               0 |
| `e54ba79d-0b56-428b-8e7a-7a1024a1f052.phm` |     21 |               0 |

这些 PHM 的使用情况：

```text id="hi3jeg"
14 个 PHM 都被 DEV 引用。
对应 DEV 全部被 1 个 CBM 引用。
CBM ENTITYNAME 全部是 F4System。
这些 DEV 都有 SUBDEVICE。
SUBDEVICE 数量为 7 或 9。
```

进一步检查子设备：

```text id="v83ge2"
missingChildDev = 0
childWithoutPhm = 0
childWithoutGeometry = 0
childMissingGeometryTarget = 0
```

### 38.4 分析结论

这 14 个无目标 PHM 不应归类为错误引用。

更准确的分类是：

```text id="p95yyp"
ASSEMBLY_NODE_WITHOUT_OWN_GEOMETRY
```

含义：

```text id="lyshv1"
F4System 根设备 / 装配节点自身没有几何；
几何存在于它的 SUBDEVICE 子 DEV 上。
```

浏览器策略：

```text id="dsapgo"
不报错
不尝试渲染该节点自身几何
保留其层级节点
递归渲染其子设备几何
在诊断中标记：装配节点自身无几何
```

---

## 39. Step 8：PHM 与几何文件 orphan / 复用分析

### 39.1 目的

检查是否存在：

```text id="k2kngs"
没有被 DEV 引用的 PHM
PHM 引用但不存在的 MOD/STL
存在于包内但没有被 PHM 引用的 MOD/STL
MOD/STL 被多个 PHM 复用
```

### 39.2 命令

```powershell id="j005uw"
cd D:\vibe-coding\gim_viewer

Show-PhmAndGeometryUsage ".\demo\demo-line" "Dev" "Phm" "Mod"
Show-PhmAndGeometryUsage ".\demo\demo-substation" "DEV" "PHM" "MOD"
```

检查 demo-substation orphan geometry 文件：

```powershell id="vvg508"
$phmRoot = ".\demo\demo-substation\PHM"
$modRoot = ".\demo\demo-substation\MOD"

# 统计未被任何 PHM.SOLIDMODEL 指向的 .mod / .stl 文件
```

检查 orphan MOD 内容与 hash：

```powershell id="usn6av"
$orphans |
  Get-FileHash -Algorithm SHA256 |
  Group-Object Hash |
  Sort-Object Count -Descending |
  Select-Object Count, Name |
  Format-Table -AutoSize

$orphans |
  Sort-Object Name |
  Select-Object -First 5 |
  ForEach-Object {
    "---- $($_.Name) ----"
    Get-Content -LiteralPath $_.FullName -Raw
  }
```

检查空 MOD 是否被引用：

```powershell id="r00fkx"
$rows |
  Where-Object { $_.isEmptyDeviceXml -eq $true } |
  Group-Object isReferenced |
  Sort-Object Name |
  Select-Object Count, Name |
  Format-Table -AutoSize
```

### 39.3 当前结果

demo-line：

```text id="jvrc2o"
totalPhm                  : 1836
phmReferenceCount         : 1836
uniqueReferencedPhm       : 1836
missingPhmReferences      : 0
orphanPhm                 : 0

totalGeometryFiles        : 1988
geometryReferenceCount    : 3136
uniqueReferencedGeometry  : 1988
missingGeometryReferences : 0
orphanGeometryFiles       : 0

maxGeometryReuse          : 70
reusedGeometryFiles       : 127
```

demo-line 几何引用扩展名：

| 数量 | 扩展名 |
| ---: | ------ |
| 2955 | `.mod` |
|  181 | `.stl` |

demo-substation：

```text id="xdbcyw"
totalPhm                  : 4179
phmReferenceCount         : 4179
uniqueReferencedPhm       : 4179
missingPhmReferences      : 0
orphanPhm                 : 0

totalGeometryFiles        : 5982
geometryReferenceCount    : 5938
uniqueReferencedGeometry  : 5938
missingGeometryReferences : 0
orphanGeometryFiles       : 44

maxGeometryReuse          : 1
reusedGeometryFiles       : 0
```

demo-substation 几何引用扩展名：

| 数量 | 扩展名 |
| ---: | ------ |
| 4135 | `.mod` |
| 1803 | `.stl` |

demo-substation orphan geometry：

```text id="va3vop"
数量：44
类型：全部 .mod
长度：全部 78 bytes
SHA256：全部一致
是否被 PHM 引用：全部未引用
```

orphan MOD 内容：

```xml id="jd9x62"
<?xml version="1.0" encoding="utf-8"?>
<Device>
  <Entities />
</Device>
```

空 MOD 引用状态：

| 数量 | isReferenced |
| ---: | ------------ |
|   44 | False        |

### 39.4 分析结论

demo-line：

```text id="z9opnq"
PHM 全部被 DEV 引用。
MOD/STL 全部被 PHM 引用。
无 orphan PHM。
无 orphan MOD/STL。
无 missing PHM。
无 missing MOD/STL。
但 MOD 存在复用，最大复用 70 次，127 个几何文件被复用。
```

demo-substation：

```text id="x1w5ej"
PHM 全部被 DEV 引用。
PHM 引用的 MOD/STL 全部存在。
无 orphan PHM。
无 missing PHM。
无 missing MOD/STL。
几何文件没有复用，maxGeometryReuse = 1。
但存在 44 个 orphan empty MOD。
```

44 个 orphan empty MOD 的分类：

```text id="go9k2d"
UNREFERENCED_EMPTY_MOD
```

浏览器策略：

```text id="l6yrsr"
不参与主链解析
不参与渲染
不作为 missing reference
仅进入诊断报告
```

---

## 40. Step 9：CBM 几何可达性总分类

### 40.1 目的

从用户视角验证：

```text id="gdz7dk"
CBM 通过 OBJECTMODELPOINTER 指向 DEV 后，最终是否能到达 MOD/STL 几何目标。
```

本步骤只覆盖 DEV-linked CBM，不覆盖 IFC-only CBM 或 no model pointer 节点。

### 40.2 命令

```powershell id="dx5wxl"
cd D:\vibe-coding\gim_viewer

Show-CbmGeometryReachability ".\demo\demo-line" "Cbm" "Dev" "Phm" "Mod"
Show-CbmGeometryReachability ".\demo\demo-substation" "CBM" "DEV" "PHM" "MOD"
```

### 40.3 当前结果

demo-line：

By status：

|  数量 | status              |
| ----: | ------------------- |
| 19175 | OWN_GEOMETRY        |
|  2682 | CHILD_GEOMETRY_ONLY |

By entityName + status：

|  数量 | 类型                                |
| ----: | ----------------------------------- |
| 11773 | `Wire_Device, OWN_GEOMETRY`         |
|  5460 | `WIRE, OWN_GEOMETRY`                |
|  2682 | `Tower_Device, CHILD_GEOMETRY_ONLY` |
|  1627 | `Tower_Device, OWN_GEOMETRY`        |
|   315 | `CROSS, OWN_GEOMETRY`               |

demo-substation：

By status：

| 数量 | status                 |
| ---: | ---------------------- |
| 3921 | OWN_GEOMETRY           |
|  244 | OWN_AND_CHILD_GEOMETRY |
|   14 | CHILD_GEOMETRY_ONLY    |

By entityName + status：

| 数量 | 类型                               |
| ---: | ---------------------------------- |
| 3894 | `PARTINDEX, OWN_GEOMETRY`          |
|  244 | `F4System, OWN_AND_CHILD_GEOMETRY` |
|   27 | `F4System, OWN_GEOMETRY`           |
|   14 | `F4System, CHILD_GEOMETRY_ONLY`    |

### 40.4 分析结论

demo-line：

```text id="yr6bvn"
CBM -> DEV 入口总数：21857
OWN_GEOMETRY：19175
CHILD_GEOMETRY_ONLY：2682
MISSING / NO_GEOMETRY / CYCLE：0
```

线路样本中，所有 DEV-linked CBM 最终都能到达几何。

其中 Tower_Device 有两种表达：

```text id="ywqwzf"
1. DEV 自身直接指向 PHM 几何。
2. DEV 自身不直接有 PHM，而是通过 child DEV 到达几何。
```

demo-substation：

```text id="zxuy02"
CBM -> DEV 入口总数：4179
OWN_GEOMETRY：3921
OWN_AND_CHILD_GEOMETRY：244
CHILD_GEOMETRY_ONLY：14
MISSING / NO_GEOMETRY / CYCLE：0
```

变电样本中，所有 DEV-linked CBM 最终也都能到达几何。

其中：

```text id="vydpse"
PARTINDEX 是部件级实例，全部有自身几何。

F4System 是设备 / 装配级节点，可能：
1. 自身有几何；
2. 自身和子设备都有几何；
3. 自身无几何，但子设备有几何。
```

---

## 41. Round 3 当前结论

当前两个 demo 的 DEV-linked CBM 几何可达性为 100%。

也就是说：

```text id="kl7r14"
CBM 只要通过 OBJECTMODELPOINTER 指向 DEV，
最终都能沿 DEV / PHM 引用链到达至少一个 MOD 或 STL 几何目标。
```

但边界必须明确：

```text id="w70qd2"
这只覆盖 DEV-linked CBM。
不覆盖 IFC-only CBM。
不覆盖 no model pointer 的分组节点。
不代表 MOD/STL 已经可解析。
不代表 MOD/STL 已经可渲染。
只代表文件级几何目标可达。
```

当前形成以下结论：

```text id="d4nfik"
1. demo-line 中，DEV 图通过 SOLIDMODEL -> DEV 形成一层浅递归。
2. demo-substation 中，DEV 图通过 SUBDEVICE -> DEV 形成一层浅递归。
3. 两个 demo 的最大 DEV-to-DEV 深度都是 1。
4. 两个 demo 均未发现 DEV 引用环。
5. 两个 demo 均未发现 DEV -> DEV 缺失引用。
6. 两个 demo 均未发现 DEV -> PHM 缺失引用。
7. 两个 demo 均未发现 PHM -> MOD/STL 缺失引用。
8. demo-line 无 orphan PHM，且无 orphan geometry。
9. demo-substation 无 orphan PHM，但存在 44 个 orphan empty MOD。
10. demo-substation 存在 14 个装配节点自身无几何，但子设备几何完整。
11. DEV-linked CBM 均能到达至少一个 MOD/STL 几何目标。
```

---

## 42. Round 3 对浏览器实现的影响

### 42.1 DEV-linked CBM 可以递归追踪几何目标

当前两个 demo 说明：

```text id="rwjqf7"
OBJECTMODELPOINTER -> DEV
```

之后，浏览器可以通过 DEV / PHM 引用链找到 MOD/STL 文件级几何目标。

### 42.2 递归仍需 visited 防环

虽然当前两个 demo 中：

```text id="n4u3tr"
maxDevToDevDepth = 1
cycleCount = 0
```

但实现不能假设全部 GIM 都只有一层 DEV-to-DEV。解析器仍应使用递归遍历，并加入 visited 集合防止环。

### 42.3 装配节点自身无几何时不应报错

demo-substation 中存在 14 个：

```text id="unf5e9"
ASSEMBLY_NODE_WITHOUT_OWN_GEOMETRY
```

处理策略：

```text id="rg7mhb"
保留节点
不渲染自身几何
继续递归子 DEV
渲染子设备几何
诊断中提示“装配节点自身无几何”
```

### 42.4 orphan empty MOD 不参与主链渲染

demo-substation 中存在 44 个：

```text id="g6sz76"
UNREFERENCED_EMPTY_MOD
```

处理策略：

```text id="oudvz0"
不参与主链解析
不参与渲染
不作为 missing reference
进入诊断报告
```

### 42.5 线路与变电的建模差异应进入解析设计

demo-line 更偏向：

```text id="b96vxq"
高复用 child DEV
组件库 / 参数化构件 / 同质化部件复用
```

demo-substation 更偏向：

```text id="z2pzh1"
实例化 DEV / PHM / MOD
设备树 / 装配树 / PARTINDEX 明细节点
```

浏览器实现中不宜只按一种模型组织方式写死逻辑。

### 42.6 当前仍不能进入的结论

当前不能得出：

```text id="w9tv91"
MOD 已经可解析
STL 已经可解析
PHM TRANSFORMMATRIX 已经可应用
DEV 图在所有 GIM 中都只有一层
所有工程都没有 DEV 环
所有 orphan MOD 都是空 XML
线路和变电的组织方式可推广为规范规则
```

当前只能确认：

```text id="vpynzy"
在当前两个 demo 中，
DEV-linked CBM 的文件级几何目标引用链可以闭合。
```

---

## 43. Round 3 后续建议

后续可以继续做：

```text id="pwrjvg"
1. PHM TRANSFORMMATRIX 字段形态分析。
2. MOD 静态类型进一步分组。
3. STL 文件大小与引用类型分析。
4. IFC-only CBM 与 DEV-linked CBM 的并行渲染策略设计。
5. 多工程样本验证 DEV 图深度、环、orphan geometry 是否稳定。
```

但这些仍应保持 schema analysis 范围，不应直接进入几何渲染实现。
