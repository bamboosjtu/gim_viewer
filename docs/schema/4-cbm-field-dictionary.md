# CBM 字段字典

## 1. 当前范围

本文基于当前3个 demo：

- `demo-line`、`demo-line1`
- `demo-substation`

目标是记录 CBM 文件中的字段角色、引用关系和线路 / 变电差异。

---

## 2. CBM 引用链总览

当前已观察到三类 CBM 下游引用：

```text
CBM -> DEV
CBM -> IFC
CBM -> CBM
```

字段对应关系：

| 字段                 | 目标          | 说明                      |
| -------------------- | ------------- | ------------------------- |
| `OBJECTMODELPOINTER` | `.dev`        | 指向 DEV 物理模型         |
| `IFCFILE`            | `.ifc`        | 指向 IFC 文件             |
| `IFCGUID`            | IFC 构件 GUID | 指向 IFC 文件中的具体构件 |
| `SUBDEVICEn`         | `.cbm`        | 指向子 CBM 节点           |
| `BASEFAMILY`         | `.fam`        | 指向 CBM 属性文件         |

当前完整引用链候选为：

```text
CBM -> DEV -> PHM -> MOD/STL
CBM -> IFCFILE + IFCGUID
CBM -> SUBDEVICE -> CBM -> ...
```

---

## 3. 线路工程 CBM 全量统计

| 指标                    |  line | line1 |
| ----------------------- | ----: | ----: |
| CBM 总数                | 27829 |  4998 |
| 有 `BASEFAMILY`         | 21967 |  3925 |
| 有 `OBJECTMODELPOINTER` | 21857 |  3900 |
| 有 `IFCFILE`            |     0 |     0 |
| 有 `IFCGUID`            |     0 |     0 |
| 有 `SUBDEVICE`          |  5534 |       |
| 有 `ENTITYNAME`         | 27828 |       |
| 有 `GROUPTYPE`          |  5861 |       |
| 有 `WIRETYPE`           |  5460 |       |

当前判断：

- 线路 CBM 不使用 IFC 关联字段。
- 线路 CBM 通过 `OBJECTMODELPOINTER=*.dev` 指向 DEV。
- 线路 CBM 通过 `SUBDEVICEn=*.cbm` 建立 CBM 层级。
- `GROUPTYPE` 和 `WIRETYPE` 是线路特有的业务分组字段。

### ENTITYNAME 分布

| ENTITYNAME     | 判断               |  line | line1 |
| -------------- | ------------------ | ----: | ----: |
| `Wire_Device`  | 导线设备节点       | 11773 |  1953 |
| `WIRE`         | 导线实体节点       |  5460 |  1013 |
| `Tower_Device` | 杆塔设备节点       |  4309 |   782 |
| `CROSS`        | 跨越实体节点       |   315 |   152 |
| `F4System`     | F4 层级 / 分组节点 |  5861 |  1072 |
| `F3System`     | F3 层级节点        |   108 |    22 |
| `F2System`     | F2 层级节点        |     1 |     2 |
| `F1System`     | F1 层级节点        |     1 |     1 |
| 空             | 待抽样确认         |     1 |     1 |

### GROUPTYPE 分布

| GROUPTYPE | 判断       |  line | line1 |
| --------- | ---------- | ----: | ----: |
| `WIRE`    | 导线分组   |  5460 |  1013 |
| `TOWER`   | 杆塔分组   |   327 |    40 |
| `CROSS`   | 跨越分组   |    74 |    19 |
| 空        | 非分组节点 | 21968 |  3926 |

### WIRETYPE 分布

| WIRETYPE     | 判断         |  line | line1 |
| ------------ | ------------ | ----: | ----: |
| `CONDUCTOR`  | 导线         |  3834 |   834 |
| `OPGW`       | OPGW 光缆    |   860 |   174 |
| `GROUNDWIRE` | 地线         |   766 |     5 |
| 空           | 非 WIRE 节点 | 22369 |  3985 |

---

## 4. 变电工程 CBM 全量统计

变电 CBM 共 8701 个。

| 指标                             | 数量 |
| -------------------------------- | ---: |
| CBM 总数                         | 8701 |
| 有 `BASEFAMILY`                  | 8554 |
| 有 `OBJECTMODELPOINTER`          | 4179 |
| 有 `IFCFILE`                     | 4360 |
| 有 `IFCGUID`                     | 4360 |
| 有 `SUBDEVICE`                   |  258 |
| 有 `ENTITYNAME`                  | 8699 |
| 有 `GROUPTYPE`                   |    0 |
| 有 `WIRETYPE`                    |    0 |

当前判断：

- 变电 CBM 同时存在 DEV 模型入口和 IFC 构件入口。
- `OBJECTMODELPOINTER=*.dev` 对应电气设备 / 物理模型入口。
- `IFCFILE + IFCGUID` 对应 IFC 模型中的构件关联。
- 变电 CBM 不使用线路中的 `GROUPTYPE` / `WIRETYPE`。
- 变电 CBM 也通过 `SUBDEVICEn=*.cbm` 建立 CBM 层级。

### ENTITYNAME 分布

| ENTITYNAME  | 数量 | 判断                        |
| ----------- | ---: | --------------------------- |
| `F4System`  | 4645 | F4 层级 / 设备或构件节点    |
| `PARTINDEX` | 3894 | 部件索引 / 构件索引节点候选 |
| `F3System`  |  145 | F3 层级节点                 |
| `F2System`  |   14 | F2 层级节点                 |
| `F1System`  |    1 | F1 层级节点                 |
| 空          |    2 | 待抽样确认                  |

---

## 5. 线路与变电 CBM 差异

| 维度        | demo-line                                         | demo-substation            |
| ----------- | ------------------------------------------------- | -------------------------- |
| DEV 引用    | `OBJECTMODELPOINTER=*.dev`                        | `OBJECTMODELPOINTER=*.dev` |
| IFC 引用    | 无                                                | `IFCFILE + IFCGUID`        |
| 子 CBM 引用 | `SUBDEVICEn=*.cbm`                                | `SUBDEVICEn=*.cbm`         |
| FAM 引用    | `BASEFAMILY=*.fam`                                | `BASEFAMILY=*.fam`         |
| 线路分组    | `GROUPTYPE`                                       | 无                         |
| 导线类型    | `WIRETYPE`                                        | 无                         |
| 主要实体    | `Wire_Device` / `WIRE` / `Tower_Device` / `CROSS` | `F4System` / `PARTINDEX`   |

---

## 6. 当前结论

当前可以确认完整的 GIM 引用链为：

```text
CBM
 ├─ OBJECTMODELPOINTER -> DEV -> PHM -> MOD/STL
 ├─ IFCFILE + IFCGUID -> IFC
 └─ SUBDEVICE -> CBM -> ...
```

其中：

- `OBJECTMODELPOINTER` 是 CBM 指向 DEV 的主字段。
- `BASEFAMILY` 是 CBM 指向 FAM 属性文件的主字段。
- `SUBDEVICE` 是 CBM 内部层级递归字段。
- `IFCFILE / IFCGUID` 是变电 CBM 关联 IFC 的字段。
- `GROUPTYPE / WIRETYPE` 是线路 CBM 的业务分组字段。


## 脚本

### 线路工程

#### Step 1：准备变量

```powershell
cd D:\vibe-coding\gim_viewer

$sampleId = "demo-line1"
$sampleRoot = ".\demo\$sampleId"
$outDir = ".\docs\schema\_generated\$sampleId"

New-Item -ItemType Directory -Force $outDir | Out-Null

function Get-GimDir($root, $name) {
  $dir = Get-ChildItem $root -Directory |
    Where-Object { $_.Name -ieq $name } |
    Select-Object -First 1

  if (-not $dir) {
    throw "Cannot find directory: $name under $root"
  }

  return $dir.FullName
}

$cbmRoot = Get-GimDir $sampleRoot "Cbm"
$devRoot = Get-GimDir $sampleRoot "Dev"
$phmRoot = Get-GimDir $sampleRoot "Phm"
$modRoot = Get-GimDir $sampleRoot "Mod"
```

#### Step 2：生成 CBM 字段摘要

```powershell
function Read-KvFile($path) {
  $kv = @{}

  Get-Content -LiteralPath $path -Encoding UTF8 | ForEach-Object {
    $line = $_.Trim()
    if (-not $line) { return }

    $idx = $line.IndexOf("=")
    if ($idx -gt 0) {
      $key = $line.Substring(0, $idx).Trim()
      $value = $line.Substring($idx + 1).Trim()
      $kv[$key] = $value
    }
  }

  return $kv
}

$cbmSummaryCsv = "$outDir\$sampleId-cbm-ref-summary.csv"

Get-ChildItem $cbmRoot -File -Filter *.cbm |
  ForEach-Object {
    $file = $_
    $kv = Read-KvFile $file.FullName

    $subDeviceCount = 0
    foreach ($key in $kv.Keys) {
      if ($key -match "^SUBDEVICE\d+$") {
        $subDeviceCount++
      }
    }

    $recursiveCbmRefCount = 0
    foreach ($key in $kv.Keys) {
      if (
        $key -match "^SUBDEVICE\d+$" -or
        $key -match "^SECTION\d+$" -or
        $key -match "^STRAINSECTION\d+$" -or
        $key -match "^GROUP\d+$" -or
        $key -match "^TOWER\d+$" -or
        $key -match "^BASE\d+$" -or
        $key -match "^STRING\d+\.STRING$"
      ) {
        if ($kv[$key] -match "\.cbm$") {
          $recursiveCbmRefCount++
        }
      }
    }

    $objectModelPointer = if ($kv.ContainsKey("OBJECTMODELPOINTER")) { $kv["OBJECTMODELPOINTER"] } else { "" }
    $baseFamily = if ($kv.ContainsKey("BASEFAMILY")) { $kv["BASEFAMILY"] } else { "" }

    $modelKind = "NO_MODEL_POINTER"
    if ($objectModelPointer -match "\.dev$") {
      $modelKind = "DEV"
    } elseif ($recursiveCbmRefCount -gt 0) {
      $modelKind = "CBM_GROUP"
    } elseif ($baseFamily -ne "") {
      $modelKind = "ATTR_ONLY"
    }

    [PSCustomObject]@{
      sample = $sampleId
      relativePath = $file.FullName.Replace((Resolve-Path $sampleRoot).Path + "\", "")
      entityName = if ($kv.ContainsKey("ENTITYNAME")) { $kv["ENTITYNAME"] } else { "" }
      sysClassifyName = if ($kv.ContainsKey("SYSCLASSIFYNAME")) { $kv["SYSCLASSIFYNAME"] } else { "" }
      groupType = if ($kv.ContainsKey("GROUPTYPE")) { $kv["GROUPTYPE"] } else { "" }
      wireType = if ($kv.ContainsKey("WIRETYPE")) { $kv["WIRETYPE"] } else { "" }
      baseFamily = $baseFamily
      objectModelPointer = $objectModelPointer
      subDeviceCount = $subDeviceCount
      recursiveCbmRefCount = $recursiveCbmRefCount
      hasBaseFamily = ($baseFamily -ne "")
      hasObjectModelPointer = ($objectModelPointer -ne "")
      objectModelIsDev = ($objectModelPointer -match "\.dev$")
      modelKind = $modelKind
    }
  } |
  Export-Csv $cbmSummaryCsv -NoTypeInformation -Encoding UTF8

$rows = Import-Csv $cbmSummaryCsv

"=== CBM TOTAL ==="
$rows.Count

"=== ENTITYNAME ==="
$rows |
  Group-Object entityName |
  Sort-Object Count -Descending |
  Select-Object Count, Name |
  Format-Table -AutoSize

"=== MODELKIND ==="
$rows |
  Group-Object modelKind |
  Sort-Object Count -Descending |
  Select-Object Count, Name |
  Format-Table -AutoSize

"=== GROUPTYPE ==="
$rows |
  Group-Object groupType |
  Sort-Object Count -Descending |
  Select-Object Count, Name |
  Format-Table -AutoSize

"=== WIRETYPE ==="
$rows |
  Group-Object wireType |
  Sort-Object Count -Descending |
  Select-Object Count, Name |
  Format-Table -AutoSize

"=== BASEFAMILY / OBJECTMODELPOINTER ==="
[PSCustomObject]@{
  totalCbm = $rows.Count
  hasBaseFamily = ($rows | Where-Object { $_.hasBaseFamily -eq "True" }).Count
  hasObjectModelPointer = ($rows | Where-Object { $_.hasObjectModelPointer -eq "True" }).Count
  objectModelIsDev = ($rows | Where-Object { $_.objectModelIsDev -eq "True" }).Count
}
```

#### Step 3：校验 CBM 引用完整性

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

$fileIndex = New-FileIndex $sampleRoot
$cbmIntegrityCsv = "$outDir\$sampleId-cbm-integrity.csv"

$refRows = New-Object System.Collections.Generic.List[object]

Get-ChildItem $cbmRoot -File -Filter *.cbm |
  ForEach-Object {
    $file = $_
    $sourceRelativePath = $file.FullName.Replace((Resolve-Path $sampleRoot).Path + "\", "")
    $kv = Read-KvFile $file.FullName

    foreach ($key in $kv.Keys) {
      $value = $kv[$key].Trim()
      if (-not $value) { continue }

      $targetKind = $null

      if ($value -match "\.dev$") {
        $targetKind = "DEV"
      } elseif ($value -match "\.fam$") {
        $targetKind = "FAM"
      } elseif ($value -match "\.cbm$") {
        $targetKind = "CBM"
      } elseif ($value -match "\.ifc$") {
        $targetKind = "IFC"
      }

      if ($null -eq $targetKind) { continue }

      $targetName = ($value -split "[/\\]")[-1]
      $targetKey = $targetName.ToLower()
      $exists = $fileIndex.ContainsKey($targetKey)

      $refRows.Add([PSCustomObject]@{
        sample = $sampleId
        sourceRelativePath = $sourceRelativePath
        fieldName = $key
        targetKind = $targetKind
        target = $targetName
        exists = $exists
        matchedPaths = if ($exists) { $fileIndex[$targetKey] -join ";" } else { "" }
      })
    }
  }

$refRows |
  Export-Csv $cbmIntegrityCsv -NoTypeInformation -Encoding UTF8

$refs = Import-Csv $cbmIntegrityCsv

"=== CBM REFERENCE INTEGRITY SUMMARY ==="
[PSCustomObject]@{
  totalReferences = $refs.Count
  okReferences = ($refs | Where-Object { $_.exists -eq "True" }).Count
  missingReferences = ($refs | Where-Object { $_.exists -ne "True" }).Count
  devReferences = ($refs | Where-Object { $_.targetKind -eq "DEV" }).Count
  famReferences = ($refs | Where-Object { $_.targetKind -eq "FAM" }).Count
  cbmReferences = ($refs | Where-Object { $_.targetKind -eq "CBM" }).Count
  ifcReferences = ($refs | Where-Object { $_.targetKind -eq "IFC" }).Count
}

"=== MISSING BY KIND ==="
$refs |
  Where-Object { $_.exists -ne "True" } |
  Group-Object targetKind |
  Sort-Object Count -Descending |
  Select-Object Count, Name |
  Format-Table -AutoSize

"=== TOP CBM REF FIELDS ==="
$refs |
  Group-Object fieldName, targetKind |
  Sort-Object Count -Descending |
  Select-Object -First 40 Count, Name |
  Format-Table -AutoSize
```
