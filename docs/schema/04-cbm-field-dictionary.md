# CBM 工程语义骨架

目标：确认变电/线路工程的结构。

## 1. 当前范围

本文基于当前3个 demo：

- `demo-line`、`demo-line1`
- `demo-substation`

目标是记录 CBM 文件中的字段角色、引用关系和线路 / 变电差异。

---

## 2. CBM 引用链总览

当前已观察到四类 CBM 下游引用：

```text
CBM -> DEV
CBM -> IFC
CBM -> FAM
CBM -> CBM
```

字段对应关系：

| 字段                                       | 目标          | 说明                                                                       |
| ------------------------------------------ | ------------- | -------------------------------------------------------------------------- |
| `OBJECTMODELPOINTER`                       | `.dev`        | 指向 DEV 物理模型（设备级 CBM 的主入口）                                   |
| `IFCFILE`                                  | `.ifc`        | 单值字段，指向 IFC 文件（仅变电 F4System 出现）                            |
| `IFCGUID`                                  | IFC 构件 GUID | 与 `IFCFILE` 配对，指向 IFC 文件中的具体构件                               |
| `IFC.NUM` + `IFC0..N`                      | `.ifc`        | 列表字段，指向多个 IFC 文件（仅变电 F1System 出现，工程级 IFC 索引）       |
| `SUBSYSTEMS.NUM` + `SUBSYSTEM0..N`         | `.cbm`        | 变电层级递归字段（F1→F2→F3 均使用）                                        |
| `SECTIONS.NUM` + `SECTION0..N`             | `.cbm`        | 线路 F1System 层级字段                                                     |
| `STRAINSECTIONS.NUM` + `STRAINSECTION0..N` | `.cbm`        | 线路 F2System 耐张段层级字段                                               |
| `GROUPS.NUM` + `GROUP0..N`                 | `.cbm`        | 线路 F3System 分组层级字段                                                 |
| `TOWERS.NUM` + `TOWER0..N`                 | `.cbm`        | 线路 F4System (GROUPTYPE=TOWER) 杆塔引用字段                               |
| `BASES.NUM` + `BASE0..N`                   | `.cbm`        | 线路 F4System (GROUPTYPE=TOWER) 基础引用字段                               |
| `STRINGS.NUM` + `STRINGn.STRING`           | `.cbm`        | 线路 F4System (GROUPTYPE=TOWER) 导线/地线串引用字段（含 `STRINGn.GPOINT`） |
| `BACKSTRING` / `FRONTSTRING`               | `.cbm`        | 线路 F4System (GROUPTYPE=WIRE) 前后耐张串引用字段                          |
| `SUBDEVICES.NUM` + `SUBDEVICE0..N`         | `.cbm`        | 子设备分组字段（变电 F4System 与线路 F4System 均使用，**不是主层级字段**） |
| `BASEFAMILY`                               | `.fam`        | 单值属性文件引用（所有工程通用）                                           |
| `BASEFAMILY1` ~ `BASEFAMILYN`              | `.fam`        | 多值属性文件引用（仅变电 F3System/F4System 抽样出现）                      |

> 关键修正：早期版本将 `SUBDEVICEn` 描述为“CBM 层级递归字段”不准确。`SUBDEVICE` 仅用于在 F4System 内部对子设备/子构件分组，不承担 F1→F4 主层级职责。主层级字段在变电中是 `SUBSYSTEMS`，在线路中是 `SECTIONS`/`STRAINSECTIONS`/`GROUPS`。

当前完整引用链候选为：

```text
CBM -> OBJECTMODELPOINTER -> DEV -> PHM -> MOD/STL
CBM -> SUBSYSTEMS / SECTIONS / STRAINSECTIONS / GROUPS -> CBM -> ...
CBM -> IFC.NUM + IFC0..N          (变电 F1System 工程级 IFC 索引)
CBM -> IFCFILE + IFCGUID          (变电 F4System 设备构件)
CBM -> SUBDEVICES -> CBM          (F4System 内部子设备分组)
CBM -> TOWERS / BASES / STRINGS   (线路 F4System GROUPTYPE=TOWER)
CBM -> BACKSTRING / FRONTSTRING   (线路 F4System GROUPTYPE=WIRE)
```

---

## 3. CBM 层级字段模式

CBM 层级结构由 `ENTITYNAME` 与层级字段共同决定。线路工程与变电工程使用不同的层级字段名集合。

### 3.1 变电工程层级字段

| ENTITYNAME  | 主层级字段                         | 子节点 ENTITYNAME | 备注                               |
| ----------- | ---------------------------------- | ----------------- | ---------------------------------- |
| `F1System`  | `SUBSYSTEMS.NUM` + `SUBSYSTEM0..N` | `F2System`        | project.cbm 入口下的一级子系统     |
| `F2System`  | `SUBSYSTEMS.NUM` + `SUBSYSTEM0..N` | `F3System`        | 二级子系统                         |
| `F3System`  | `SUBSYSTEMS.NUM` + `SUBSYSTEM0..N` | `F4System`        | 三级子系统                         |
| `F4System`  | `SUBDEVICES.NUM` + `SUBDEVICE0..N` | `PARTINDEX`       | 设备级 CBM，子节点为 PARTINDEX     |
| `PARTINDEX` | （叶子节点）                       | -                 | 通过 `OBJECTMODELPOINTER` 指向 DEV |

变电工程示例（取自 `0b0ccf10-9d4e-4c0f-93b2-ba13cb4b492e.cbm`）：

```text
ENTITYNAME=F3System
SYSCLASSIFYNAME=0AFD*002
SYSTEMNAME1=交流电气系统
SYSTEMNAME2=110kV系统
SYSTEMNAME3=#2主变 110kV进线间隔
BASEFAMILY1=e941d639-3ba0-4348-933f-09cd8da077eb.fam
BASEFAMILY2=59fd06e0-7d14-486e-a499-9c3e5aaa2669.fam
BASEFAMILY3=cb4b66cb-c8b0-4845-9242-ae1d2ea9d67d.fam
BASEFAMILY4=1e65e90f-903e-4f51-abf5-ebe29b713305.fam
SUBSYSTEMS.NUM=1
SUBSYSTEM0=2002dd4c-2820-4b42-8ceb-df30a58bd284.cbm
IFC.NUM=0
MATERIALSHEET=
```

### 3.2 线路工程层级字段

| ENTITYNAME | 主层级字段                                 | 子节点 ENTITYNAME                                 | 备注                               |
| ---------- | ------------------------------------------ | ------------------------------------------------- | ---------------------------------- |
| `F1System` | `SECTIONS.NUM` + `SECTION0..N`             | `F2System`                                        | project.cbm 入口下的一级标段       |
| `F2System` | `STRAINSECTIONS.NUM` + `STRAINSECTION0..N` | `F3System`                                        | 耐张段层级                         |
| `F3System` | `GROUPS.NUM` + `GROUP0..N`                 | `F4System`                                        | 分组层级                           |
| `F4System` | 见 3.3 节（按 GROUPTYPE 分支）             | `Tower_Device` / `Wire_Device` / `WIRE` / `CROSS` | 杆塔/导线/地线/跨越分组节点        |
| 叶子节点   | （无）                                     | -                                                 | 通过 `OBJECTMODELPOINTER` 指向 DEV |

线路工程示例（取自 `001f89fb-a2f1-439e-b690-032304505194.cbm`）：

```text
ENTITYNAME=F3System
BASEFAMILY=001f89fb-a2f1-439e-b690-032304505194.fam
GROUPS.NUM=88
GROUP0=e88204e1-785f-4db0-adfe-05417e0eb398.cbm
...
MATERIALSHEET=
```

### 3.3 线路 F4System 按 GROUPTYPE 分支

线路 F4System 通过 `GROUPTYPE` 字段区分三种业务分组，每种分组使用不同的引用字段：

| GROUPTYPE | 数量(line/line1) | 引用字段                                                                                      | 子节点 ENTITYNAME      | 备注                                |
| --------- | ---------------- | --------------------------------------------------------------------------------------------- | ---------------------- | ----------------------------------- |
| `TOWER`   | 327 / 40         | `TOWERS.NUM` + `TOWER0..N`、`STRINGS.NUM` + `STRINGn.STRING/GPOINT`、`BASES.NUM` + `BASE0..N` | `Tower_Device`         | 杆塔分组，含塔位/导线串/基础        |
| `WIRE`    | 5460 / 1013      | `BACKSTRING` + `FRONTSTRING` + `SUBDEVICES.NUM` + `SUBDEVICE0..N`                             | `Wire_Device` / `WIRE` | 导线/地线分组，含前后耐张串与子导线 |
| `CROSS`   | 74 / 19          | `SUBDEVICES.NUM` + `SUBDEVICE0..N`                                                            | `CROSS`                | 跨越分组                            |

线路 F4System 还可携带 `WIRETYPE`（CONDUCTOR/OPGW/GROUNDWIRE）与 `ISJUMPER`（0/1）等业务字段。

---

## 4. 线路工程 CBM 全量统计

| 指标                    |  line | line1 |
| ----------------------- | ----: | ----: |
| CBM 总数                | 27829 |  4998 |
| 有 `BASEFAMILY`         | 21967 |  3925 |
| 有 `BASEFAMILY1..N`     |     0 |     0 |
| 有 `OBJECTMODELPOINTER` | 21857 |  3900 |
| 有 `IFCFILE`            |     0 |     0 |
| 有 `IFCGUID`            |     0 |     0 |
| 有 `IFC.NUM`            |     0 |     0 |
| 有 `SUBDEVICE`          |  5534 |  1032 |
| 有 `SUBSYSTEM`          |     0 |     0 |
| 有 `SECTIONS`           |     1 |     1 |
| 有 `STRAINSECTIONS`     |     1 |     2 |
| 有 `GROUPS`             |   108 |    22 |
| 有 `TOWERS`             |   327 |    40 |
| 有 `BASES`              |   327 |    40 |
| 有 `STRINGS`            |   327 |    40 |
| 有 `ENTITYNAME`         | 27828 |  4997 |
| 有 `GROUPTYPE`          |  5861 |  1072 |
| 有 `WIRETYPE`           |  5460 |  1013 |
| 有 `SYSCLASSIFYNAME`    |     0 |     0 |

> 注：「有 SUBDEVICE」按文件计：CBM 文件中存在至少一个 `SUBDEVICEn` 引用键即计为 1，不是引用条目数。`05-gim-reference-integrity.md` 中的 `SUBDEVICEN` 是引用条目数（demo-line1 = 3127 条引用），与文件数（demo-line1 = 1032 个文件）不同。

当前判断：

- 线路 CBM 不使用 IFC 关联字段。
- 线路 CBM 通过 `OBJECTMODELPOINTER=*.dev` 指向 DEV。
- 线路 CBM 主层级通过 `SECTIONS` → `STRAINSECTIONS` → `GROUPS` 三级递归，**不使用 `SUBSYSTEM`**。
- 线路 F4System 通过 `GROUPTYPE` 区分 TOWER/WIRE/CROSS 三种业务分组，分别使用不同引用字段。
- `GROUPTYPE`、`WIRETYPE`、`ISJUMPER`、`BACKSTRING`、`FRONTSTRING`、`KVALUE`、`POINTn.BLHA`、`POINTn.MATRIX0`、`MODLEG` 是线路特有字段。

### ENTITYNAME 分布

| ENTITYNAME     | 判断               |  line | line1 |
| -------------- | ------------------ | ----: | ----: |
| `F1System`     | F1 层级节点        |     1 |     1 |
| `F2System`     | F2 层级节点        |     1 |     2 |
| `F3System`     | F3 层级节点        |   108 |    22 |
| `F4System`     | F4 层级 / 分组节点 |  5861 |  1072 |
| `Tower_Device` | 杆塔设备节点       |  4309 |   782 |
| `WIRE`         | 导线实体节点       |  5460 |  1013 |
| `Wire_Device`  | 导线设备节点       | 11773 |  1953 |
| `CROSS`        | 跨越实体节点       |   315 |   152 |
| 空             | 待抽样确认         |     1 |     1 |

### GROUPTYPE 分布

| GROUPTYPE | 判断       |  line | line1 |
| --------- | ---------- | ----: | ----: |
| `TOWER`   | 杆塔分组   |   327 |    40 |
| `WIRE`    | 导线分组   |  5460 |  1013 |
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

## 5. 变电工程 CBM 全量统计

变电 CBM 共 8701 个。

| 指标                                    | 数量 |
| --------------------------------------- | ---: |
| CBM 总数                                | 8701 |
| 有 `BASEFAMILY`（单值）                 | 8554 |
| 有 `BASEFAMILY1..N`（多值）             |  145 |
| 有 `OBJECTMODELPOINTER`                 | 4179 |
| 有 `IFCFILE`（非空）                    | 4360 |
| 有 `IFCGUID`（非空）                    | 4360 |
| 有 `IFC.NUM`                            |    1 |
| 有 `SUBDEVICE`                          |  258 |
| 有 `SUBSYSTEM`                          | 4805 |
| 有 `SECTIONS`/`STRAINSECTIONS`/`GROUPS` |    0 |
| 有 `ENTITYNAME`                         | 8699 |
| 有 `GROUPTYPE`                          |    0 |
| 有 `WIRETYPE`                           |    0 |
| 有 `SYSCLASSIFYNAME`                    | 4805 |

当前判断：

- 变电 CBM 同时存在 DEV 模型入口和 IFC 构件入口。
- `OBJECTMODELPOINTER=*.dev` 对应电气设备 / 物理模型入口（主要在 F4System 和 PARTINDEX）。
- `IFCFILE + IFCGUID` 对应 IFC 模型中的构件关联（主要在 F4System）。
- `IFC.NUM + IFC0..N` 仅出现在 F1System 工程入口，作为工程级 IFC 文件清单。
- 变电 CBM 主层级通过 `SUBSYSTEMS` 递归（F1→F2→F3），**不使用线路的 `SECTIONS`/`STRAINSECTIONS`/`GROUPS`**。
- 变电 CBM 不使用线路中的 `GROUPTYPE` / `WIRETYPE` / `BACKSTRING` / `FRONTSTRING` / `KVALUE` / `POINTn.*`。
- `SYSCLASSIFYNAME`、`SYSTEMNAME1..4`、`BASEFAMILY1..N` 是变电特有字段（前者用于设备分类，后两者用于多 FAM 引用）。

### ENTITYNAME 分布

| ENTITYNAME  | 数量 | 判断                        |
| ----------- | ---: | --------------------------- |
| `F1System`  |    1 | F1 层级节点                 |
| `F2System`  |   14 | F2 层级节点                 |
| `F3System`  |  145 | F3 层级节点                 |
| `F4System`  | 4645 | F4 层级 / 设备或构件节点    |
| `PARTINDEX` | 3894 | 部件索引 / 构件索引节点候选 |
| 空          |    2 | 待抽样确认                  |

### 变电 F4System 角色

通过对 `OBJECTMODELPOINTER`、`IFCFILE`、`SUBDEVICES.NUM` 三组字段的非空统计，F4System 进一步分为三种角色：

| F4System 角色                    | 数量 | `OBJECTMODELPOINTER` | `IFCFILE` | `SUBDEVICES.NUM` |
| -------------------------------- | ---: | -------------------- | --------- | ---------------- |
| 设备入口（含子设备）             |  285 | 非空                 | 空        | >0               |
| IFC 构件入口                     | 4360 | 空                   | 非空      | 通常为 0         |
| 仅容器（无 OBJECT 也无 IFCFILE） |    0 | 空                   | 空        | 通常为 0         |

PARTINDEX（3894 个）100% 携带 `OBJECTMODELPOINTER`，无 `IFCFILE`，作为设备级叶子节点。

---

## 6. 线路与变电 CBM 差异

### 6.1 引用字段差异

| 维度       | demo-line                                                                                   | demo-substation                                  |
| ---------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| DEV 引用   | `OBJECTMODELPOINTER=*.dev`                                                                  | `OBJECTMODELPOINTER=*.dev`                       |
| IFC 引用   | 无                                                                                          | F1: `IFC.NUM + IFC0..N`；F4: `IFCFILE + IFCGUID` |
| 主层级字段 | `SECTIONS` → `STRAINSECTIONS` → `GROUPS`                                                    | `SUBSYSTEMS`（F1/F2/F3 共用）                    |
| F4 子节点  | `TOWERS`/`BASES`/`STRINGS` (TOWER)、`BACKSTRING`/`FRONTSTRING` (WIRE)、`SUBDEVICES` (CROSS) | `SUBDEVICES`                                     |
| FAM 引用   | `BASEFAMILY`（单值）                                                                        | `BASEFAMILY` 或 `BASEFAMILY1..N`                 |
| 线路分组   | `GROUPTYPE`/`WIRETYPE`/`ISJUMPER`                                                           | 无                                               |
| 设备分类   | 无                                                                                          | `SYSCLASSIFYNAME`/`SYSTEMNAME1..4`               |
| 主要实体   | `Wire_Device` / `WIRE` / `Tower_Device` / `CROSS`                                           | `F4System` / `PARTINDEX`                         |

### 6.2 层级路径差异

| 维度      | demo-line                                                                             | demo-substation                               |
| --------- | ------------------------------------------------------------------------------------- | --------------------------------------------- |
| F1 → F2   | `SECTIONS.NUM` + `SECTIONn`                                                           | `SUBSYSTEMS.NUM` + `SUBSYSTEMn`               |
| F2 → F3   | `STRAINSECTIONS.NUM` + `STRAINSECTIONn`                                               | `SUBSYSTEMS.NUM` + `SUBSYSTEMn`               |
| F3 → F4   | `GROUPS.NUM` + `GROUPn`                                                               | `SUBSYSTEMS.NUM` + `SUBSYSTEMn`               |
| F4 → 叶子 | `TOWERS`/`STRINGS`/`BASES` (TOWER)、`BACK`/`FRONTSTRING` (WIRE)、`SUBDEVICES` (CROSS) | `SUBDEVICES.NUM` + `SUBDEVICEn` → `PARTINDEX` |
| 叶子节点  | `Tower_Device`/`Wire_Device`/`WIRE`/`CROSS`                                           | `PARTINDEX`                                   |

---

## 7. 当前结论

当前可以确认完整的 GIM 引用链为：

```text
CBM
 ├─ OBJECTMODELPOINTER -> DEV -> PHM -> MOD/STL
 ├─ IFCFILE + IFCGUID            (变电 F4System 设备构件)
 ├─ IFC.NUM + IFC0..N            (变电 F1System 工程级 IFC 索引)
 ├─ SUBSYSTEMS / SECTIONS / STRAINSECTIONS / GROUPS -> CBM -> ...
 ├─ SUBDEVICES -> CBM            (F4System 内部子设备分组)
 ├─ TOWERS / BASES / STRINGS     (线路 F4System GROUPTYPE=TOWER)
 ├─ BACKSTRING / FRONTSTRING     (线路 F4System GROUPTYPE=WIRE)
 └─ BASEFAMILY / BASEFAMILYN -> FAM
```

其中：

- `OBJECTMODELPOINTER` 是 CBM 指向 DEV 的主字段（叶子节点必备）。
- `BASEFAMILY` 是 CBM 指向 FAM 属性文件的主字段；`BASEFAMILY1..N` 仅在变电中出现。
- `SUBSYSTEMS` 是变电主层级递归字段（F1/F2/F3 共用）。
- `SECTIONS` / `STRAINSECTIONS` / `GROUPS` 是线路主层级递归字段（按 F1/F2/F3 分别使用）。
- `SUBDEVICES` 是 F4System 内部子设备分组字段，**不承担 F1→F4 主层级职责**。
- `IFCFILE` / `IFCGUID` 是变电 F4System 关联 IFC 构件的字段；`IFC.NUM` / `IFC0..N` 是变电 F1System 的工程级 IFC 清单。
- `GROUPTYPE` / `WIRETYPE` / `ISJUMPER` / `BACKSTRING` / `FRONTSTRING` / `KVALUE` / `POINTn.*` 是线路 CBM 的业务字段。
- `SYSCLASSIFYNAME` / `SYSTEMNAME1..4` 是变电 CBM 的分类字段。

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
        $key -match "^SUBSYSTEM\d+$" -or
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
