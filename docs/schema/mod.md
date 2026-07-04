# MOD 文件格式

## MOD 内部格式初步分型

### 线路工程

线路 MOD 共 1807 个。

按 `CODE / POINTNUM` 粗分：

| 类型                 | 数量 | 特征                               | 判断                |
| -------------------- | ---: | ---------------------------------- | ------------------- |
| CODE/POINTNUM 点线型 |  315 | 存在 `CODE`、`POINTNUM`、`LINENUM` | 点线几何 / 拓扑候选 |
| 未分类文本型         | 1492 | 未发现 `CODE`、`POINTNUM`          | 待进一步字段分析    |

CODE 分布：

| CODE | 数量 |
| ---- | ---: |
| 201  |  128 |
| 31   |   74 |
| 32   |   63 |
| 34   |   19 |
| 35   |   13 |
| 33   |   10 |
| 30   |    8 |

线路 MOD key Top 观察：

| key                                              |    数量 | 观察              |
| ------------------------------------------------ | ------: | ----------------- |
| `Bolt1` ~ `Bolt4`                                | 各 1300 | 螺栓 / 金具类参数 |
| `BoltNum`                                        |    1300 | 螺栓数量          |
| `CODE`                                           |     315 | 点线型 MOD 类型码 |
| `POINTNUM`                                       |     315 | 点数量            |
| `LINENUM`                                        |     315 | 线数量            |
| `POINT1..N`                                      |    多组 | 点坐标 / 点参数   |
| `LINE1..N`                                       |    多组 | 线段连接关系      |
| `OUTSIDEDIAMETER`、`SECTIONALAREA`、`WIREWEIGHT` |    各 9 | 疑似导线物理参数  |

当前判断：

- demo-line 的 MOD 不是统一 XML。
- 部分 MOD 是 key-value 点线描述。
- 大量 MOD 与 `Bolt*` 字段相关，可能描述线路金具 / 塔材局部构件。
- 暂不进入几何解析，只做字段分型与引用链分析。

### 变电工程

变电 MOD 共 4179 个。

当前未发现 `CODE / POINTNUM` 模式。

变电 MOD key Top 观察：

| key / 标签特征           |  数量 | 观察                              |
| ------------------------ | ----: | --------------------------------- |
| `<?xml version`          |  4179 | 所有变电 MOD 都疑似 XML-like 文本 |
| `<TransformMatrix Value` | 46250 | 大量变换矩阵                      |
| `<Entity ID`             | 46250 | 大量几何实体                      |
| `<Color R`               | 46250 | 实体颜色                          |
| `<Cylinder R`            | 20421 | 圆柱体图元                        |
| `<Cuboid L`              | 12401 | 长方体图元                        |
| `<StretchedBody Array`   | 10263 | 拉伸体图元                        |
| `<PorcelainBushing R`    |  1506 | 套管 / 绝缘类专用图元候选         |
| `<TruncatedCone TR`      |   730 | 截锥体                            |
| `<Ring DR`               |   235 | 环形图元                          |
| `<Sphere R`              |   141 | 球体                              |
| `<ChannelSteel Model`    |   129 | 槽钢图元候选                      |

当前判断：

- demo-substation 的 MOD 与线路 CODE/POINTNUM 型 MOD 不同。
- demo-substation 的 MOD 更接近 XML-like 基本图元组合。
- 变电 MOD 中确实存在基础图元、颜色、变换矩阵等几何表达。
- 但当前变电 3D 查看已有 IFC 主路径，MOD 暂不进入渲染或解析实现。

---

### 分析脚本

#### Step 1：运行 MOD 静态分型脚本

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

$modRoot = Get-GimDir $sampleRoot "Mod"

function Read-TextFileLoose($path) {
  $bytes = [System.IO.File]::ReadAllBytes((Resolve-Path $path))

  if ($bytes.Length -eq 0) {
    return ""
  }

  try {
    return [System.Text.Encoding]::UTF8.GetString($bytes)
  } catch {
    return [System.Text.Encoding]::Default.GetString($bytes)
  }
}

function Classify-ModText($text) {
  if ($null -eq $text -or $text.Trim().Length -eq 0) {
    return "EMPTY"
  }

  $trimmed = $text.TrimStart()

  if ($trimmed -match "^<\?xml" -or $trimmed -match "^<Device") {
    if ($trimmed -match "<Entities\s*/>") {
      return "XML_EMPTY_DEVICE"
    }

    if ($trimmed -match "<Entity") {
      return "XML_WITH_ENTITIES"
    }

    return "XML_OTHER"
  }

  if (
    $text -match "(?m)^CODE\s*=" -and
    $text -match "(?m)^POINTNUM\s*=" -and
    $text -match "(?m)^LINENUM\s*="
  ) {
    return "TEXT_POINT_LINE"
  }

  if ($text -match "(?m)^HNum\s*,") {
    return "TEXT_HNUM_COMMA_RECORD"
  }

  $lines = $text -split "`r?`n" |
    ForEach-Object { $_.Trim() } |
    Where-Object { $_ -ne "" }

  if ($lines.Count -eq 0) {
    return "EMPTY"
  }

  $firstLine = $lines[0]
  $kvLineCount = ($lines | Where-Object { $_ -match "^[A-Za-z0-9_.-]+\s*=" }).Count

  if ($firstLine -notmatch "=" -and $kvLineCount -gt 0) {
    return "TEXT_SECTION_KV_RECORD"
  }

  if ($kvLineCount -gt 0) {
    return "TEXT_KEY_VALUE"
  }

  if ($text -match "," -and $text -match "[0-9]") {
    return "TEXT_COMMA_NUMERIC"
  }

  return "TEXT_UNKNOWN"
}

$modProfileCsv = "$outDir\$sampleId-mod-static-profile.csv"

Get-ChildItem $modRoot -File -Filter *.mod |
  ForEach-Object {
    $file = $_
    $text = Read-TextFileLoose $file.FullName
    $kind = Classify-ModText $text

    $firstNonEmptyLine = (
      $text -split "`r?`n" |
      ForEach-Object { $_.Trim() } |
      Where-Object { $_ -ne "" } |
      Select-Object -First 1
    )

    [PSCustomObject]@{
      sample = $sampleId
      relativePath = $file.FullName.Replace((Resolve-Path $sampleRoot).Path + "\", "")
      fileName = $file.Name
      length = $file.Length
      kind = $kind
      firstLine = $firstNonEmptyLine
    }
  } |
  Export-Csv $modProfileCsv -NoTypeInformation -Encoding UTF8

$mods = Import-Csv $modProfileCsv

"=== MOD STATIC PROFILE ==="
$mods |
  Group-Object kind |
  Sort-Object Count -Descending |
  Select-Object Count, Name |
  Format-Table -AutoSize

"=== MOD SAMPLE BY KIND ==="
$mods |
  Group-Object kind |
  ForEach-Object {
    $_.Group |
      Select-Object -First 3 kind, relativePath, length, firstLine
  } |
  Format-Table -AutoSize
```

#### Step 2：TEXT_UNKNOWN样本分析

```powershell
$unknownMods = $mods | Where-Object { $_.kind -eq "TEXT_UNKNOWN" }

"=== UNKNOWN MOD COUNT ==="
$unknownMods.Count

$unknownMods |
  Select-Object -First 20 relativePath, length, firstLine |
  Format-Table -AutoSize

# 如果 TEXT_UNKNOWN > 0，再随机打开几个：
$unknownMods |
  Select-Object -First 5 |
  ForEach-Object {
    "===== $($_.relativePath) ====="
    Get-Content ".\demo\$sampleId\$($_.relativePath)" -Encoding UTF8 -TotalCount 40
  }
```

---

## 文件概述

MOD（Model/Module）文件是 GIM 工程中描述基础几何模型的数据文件，采用 XML 格式。MOD 文件定义了由基本几何图元（长方体、圆柱体、瓷套管、拉伸体）组成的模型，每个图元拥有独立的空间变换和颜色属性。MOD 是三维可视化层级中最底层的几何定义文件。

## 文件格式

- **编码**：UTF-8
- **格式**：XML
- **根元素**：`<Device>`
- **坐标单位**：毫米（mm）

## 字段说明

### XML 结构

| 元素         | 层级            | 说明             |
| ------------ | --------------- | ---------------- |
| `<Device>`   | 根元素          | 模型根节点       |
| `<Entities>` | Device 子元素   | 图元集合容器     |
| `<Entity>`   | Entities 子元素 | 单个几何图元定义 |

### Entity 属性

| 属性      | 类型             | 说明                      |
| --------- | ---------------- | ------------------------- |
| `ID`      | 整数             | 图元唯一标识              |
| `Type`    | 字符串           | 图元类型，目前为 `simple` |
| `Visible` | `True` / `False` | 是否可见                  |

### 几何图元类型

每个 `<Entity>` 内必须包含且仅包含以下一种几何图元：

| 图元   | 元素名               | 参数                                                                            | 说明                      |
| ------ | -------------------- | ------------------------------------------------------------------------------- | ------------------------- |
| 长方体 | `<Cuboid>`           | `L`（长）、`W`（宽）、`H`（高）                                                 | 标准长方体                |
| 圆柱体 | `<Cylinder>`         | `R`（半径）、`H`（高度）                                                        | 标准圆柱体                |
| 瓷套管 | `<PorcelainBushing>` | `R`（底部半径）、`R1`（中部半径）、`R2`（顶部半径）、`N`（伞裙数）、`H`（高度） | 绝缘子/瓷套管，带伞裙结构 |
| 拉伸体 | `<StretchedBody>`    | `Array`（截面顶点坐标，分号分隔）、`Normal`（拉伸法向量）、`L`（拉伸长度）      | 沿法向量拉伸截面形成的体  |

### Entity 子元素

| 元素                | 必需 | 说明                                                             |
| ------------------- | ---- | ---------------------------------------------------------------- |
| 几何图元（四选一）  | 是   | 定义图元形状                                                     |
| `<TransformMatrix>` | 是   | 空间变换矩阵，`Value` 属性为 16 个浮点数（逗号分隔，行优先）     |
| `<Color>`           | 是   | 颜色定义，`R`/`G`/`B` 范围 0-255，`A` 范围 0-100（透明度百分比） |

## 引用关系

```
PHM 文件
└── SOLIDMODEL → <uuid>.mod    → MOD 文件
    └── <Device>
        └── <Entities>
            ├── <Entity ID="0">
            │   ├── <Cuboid /> / <Cylinder /> / <PorcelainBushing /> / <StretchedBody />
            │   ├── <TransformMatrix />
            │   └── <Color />
            ├── <Entity ID="1">
            │   └── ...
            └── ...
```

## 示例

### 长方体模型

```xml
<?xml version="1.0" encoding="utf-8"?>
<Device>
  <Entities>
    <Entity ID="0" Type="simple" Visible="True">
      <Cuboid L="800" W="600" H="2000" />
      <TransformMatrix Value="1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1" />
      <Color R="128" G="128" B="128" A="100" />
    </Entity>
  </Entities>
</Device>
```

### 圆柱体模型

```xml
<?xml version="1.0" encoding="utf-8"?>
<Device>
  <Entities>
    <Entity ID="0" Type="simple" Visible="True">
      <Cylinder R="50" H="300" />
      <TransformMatrix Value="1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1" />
      <Color R="200" G="50" B="50" A="100" />
    </Entity>
  </Entities>
</Device>
```

### 瓷套管（绝缘子）模型

```xml
<?xml version="1.0" encoding="utf-8"?>
<Device>
  <Entities>
    <Entity ID="0" Type="simple" Visible="True">
      <PorcelainBushing R="30" R1="45" R2="25" N="8" H="500" />
      <TransformMatrix Value="1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1" />
      <Color R="180" G="180" B="220" A="100" />
    </Entity>
  </Entities>
</Device>
```

### 拉伸体模型

```xml
<?xml version="1.0" encoding="utf-8"?>
<Device>
  <Entities>
    <Entity ID="0" Type="simple" Visible="True">
      <StretchedBody Array="0,0;100,0;100,50;0,50" Normal="0,0,1" L="200" />
      <TransformMatrix Value="1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1" />
      <Color R="100" G="150" B="200" A="100" />
    </Entity>
  </Entities>
</Device>
```

### 多图元组合模型

```xml
<?xml version="1.0" encoding="utf-8"?>
<Device>
  <Entities>
    <Entity ID="0" Type="simple" Visible="True">
      <Cuboid L="800" W="600" H="50" />
      <TransformMatrix Value="1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1" />
      <Color R="128" G="128" B="128" A="100" />
    </Entity>
    <Entity ID="1" Type="simple" Visible="True">
      <Cylinder R="25" H="300" />
      <TransformMatrix Value="1,0,0,200,0,1,0,200,0,0,1,25,0,0,0,1" />
      <Color R="200" G="50" B="50" A="100" />
    </Entity>
    <Entity ID="2" Type="simple" Visible="False">
      <Cuboid L="100" W="100" H="100" />
      <TransformMatrix Value="1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1" />
      <Color R="0" G="0" B="0" A="0" />
    </Entity>
  </Entities>
</Device>
```
