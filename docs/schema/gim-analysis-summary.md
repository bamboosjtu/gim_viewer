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

## 19. Round 2-A：IFCGUID -> IFC 内部命中校验

Round 2-A 对 `demo-substation` 中 4360 条 `IFCFILE + IFCGUID` 记录进行了 IFC 文本命中校验。

当前结果：

```text
IFCFILE 文件存在：4360 / 4360
IFCGUID 精确命中声明 IFC 文件：3252 / 4360
IFCGUID 大小写不敏感命中声明 IFC 文件：3296 / 4360
任意 IFC 文件均未命中：1064 / 4360
```

当前判断：

IFCFILE 文件存在性 100% 通过。
IFCGUID 不是全部都能在 IFC 文件中命中。
精确命中的 IFCGUID 可作为强 IFC 构件关联。
大小写不敏感命中的 IFCGUID 可作为弱关联。
硬未命中的 IFCGUID 当前不应作为 IFC 构件定位依据。

硬未命中项全部具有以下 CBM 特征：

```text
ENTITYNAME = F4System
OBJECTMODELPOINTER = 空
BASEFAMILY = 有值
SUBDEVICE = 无
```

## 20. Round 2-B：CBM -> FAM 基础分析

Round 2-B1 / B2 已形成独立文档：

```text
docs/schema/6-cbm-fam-consistency.md
```

当前分析结论：

1. 当前两个 demo 中，CBM -> BASEFAMILY -> FAM 的文件级引用完整性为 100%。
2. 凡是 CBM 写了 BASEFAMILY，目标 FAM 文件均存在。
3. 当前两个 demo 中，BASEFAMILY 基本呈现一 CBM 对一 FAM 的实例级对应关系，暂未观察到多 CBM 复用同一个 FAM。
4. FAM 更适合作为 CBM 节点的属性 sidecar，而不是先验定义为可复用族模板。
5. 线路样本中，DEV 型业务对象节点全部有 FAM；F4System 分组节点通常没有 FAM。
6. 变电样本中，IFC 型和 DEV 型 CBM 全部有 FAM；F4System 既可能是 IFC 关联节点，也可能是 DEV 关联节点。
7. 不能仅凭 ENTITYNAME=F4System 判断节点是否为分组节点，必须结合 modelKind、IFCFILE、OBJECTMODELPOINTER、BASEFAMILY、SUBDEVICE 等字段。
8. 线路与变电 FAM 字段 schema 差异显著，后续解析应保持弱 schema / key-value 结构，不宜过早固定 DTO。

当前仍不能下的结论：

- FAM 是标准族模板
- FAM 可跨 CBM 复用
- FAM 字段可以统一映射成固定 DTO
- F4System 一定是分组节点
- F4System 一定是具体构件节点
- CBM 与 FAM 有同名字段必须一致
