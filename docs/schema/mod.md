# MOD 文件格式

## 文件概述

MOD（Model/Module）文件是 GIM 工程中描述基础几何模型的数据文件，位于 GIM 解压后的 `MOD/` 目录中，文件名采用 UUID 格式。MOD 文件被 PHM 文件的 `SOLIDMODELn` 字段引用，是三维可视化层级中最底层的几何定义文件。

MOD 不是单一格式，而是按工程类型分为两大格式族：

```text
变电工程：XML 格式族（Device / Entities / Entity / primitive）
线路工程：文本格式族（4 类，详见 08-mod-static-survey.md）
```

### 变电工程与线路工程的差异

| 维度       | 变电工程                                       | 线路工程                                          |
| ---------- | ---------------------------------------------- | ------------------------------------------------- |
| 格式族     | XML（`<Device><Entities><Entity>...`）        | 4 类文本格式族                                    |
| 文件数     | 4179（demo-substation）                        | 1807（demo-line）/ 508（demo-line1）              |
| 几何表达   | Entity + primitive（Cylinder/Cuboid/...）     | 点线记录 / 螺栓参数 / 杆塔分段 / 导线参数          |
| 几何字段   | `<TransformMatrix Value>` + `<Color>` + 图元  | `CODE`/`POINTn`/`LINEn`、`HNum`/`P`/`R`/`G` 等     |
| 上游 entityName | F4System / PARTINDEX                     | Tower_Device / CROSS / WIRE                       |
| 孤儿文件   | 44 个 EMPTY_DEVICE_XML（未被 PHM 引用）        | demo-line1 有 148 个 CBM 链不可达的 TEXT_POINT_LINE |
| 3D 渲染路径 | 当前已有 IFC 主路径，MOD 暂不进入渲染          | 暂不进入几何解析，先按文本格式族分支处理            |

## 文件格式

- **编码**：UTF-8
- **格式**：变电为 XML；线路为多种文本格式（key-value / section / 逗号记录）
- **坐标单位**：毫米（mm，仅变电 XML 已确认；线路文本格式未确认）

## 字段说明

### 变电工程 XML 格式

#### XML 结构

| 元素         | 层级            | 说明             |
| ------------ | --------------- | ---------------- |
| `<Device>`   | 根元素          | 模型根节点       |
| `<Entities>` | Device 子元素   | 图元集合容器     |
| `<Entity>`   | Entities 子元素 | 单个几何图元定义 |

#### Entity 属性

| 属性      | 类型             | 说明                      |
| --------- | ---------------- | ------------------------- |
| `ID`      | 整数             | 图元唯一标识              |
| `Type`    | 字符串           | 图元类型，目前为 `simple` |
| `Visible` | `True` / `False` | 是否可见                  |

#### 几何图元类型

每个 `<Entity>` 内必须包含且仅包含以下一种几何图元：

| 图元   | 元素名               | 参数                                                                            | 说明                      |
| ------ | -------------------- | ------------------------------------------------------------------------------- | ------------------------- |
| 长方体 | `<Cuboid>`           | `L`（长）、`W`（宽）、`H`（高）                                                 | 标准长方体                |
| 圆柱体 | `<Cylinder>`         | `R`（半径）、`H`（高度）                                                        | 标准圆柱体                |
| 瓷套管 | `<PorcelainBushing>` | `R`（底部半径）、`R1`（中部半径）、`R2`（顶部半径）、`N`（伞裙数）、`H`（高度） | 绝缘子/瓷套管，带伞裙结构 |
| 拉伸体 | `<StretchedBody>`    | `Array`（截面顶点坐标，分号分隔）、`Normal`（拉伸法向量）、`L`（拉伸长度）      | 沿法向量拉伸截面形成的体  |

> 实际样本中还观察到 Ring / Sphere / ChannelSteel / Table / CircularGasket / RectangularFixedPlate / OffsetRectangularTable / RectangularRing / TruncatedCone / TerminalBlock 等 primitive，共 14 类。

#### Entity 子元素

| 元素                | 必需 | 说明                                                             |
| ------------------- | ---- | ---------------------------------------------------------------- |
| 几何图元（多选一）  | 是   | 定义图元形状                                                     |
| `<TransformMatrix>` | 是   | 空间变换矩阵，`Value` 属性为 16 个浮点数（逗号分隔，行优先）     |
| `<Color>`           | 是   | 颜色定义，`R`/`G`/`B` 范围 0-255，`A` 范围 0-100（透明度百分比） |

### 线路工程文本格式族

线路 MOD 共 4 类文本格式族，全部不是 XML：

| MOD kind               | 特征                                                            | 典型字段                            | 业务映射             |
| ---------------------- | --------------------------------------------------------------- | ------------------------------------ | -------------------- |
| `TEXT_SECTION_KV_RECORD` | 第一行为 section header，后续为 key=value 记录                  | `Bolt` / `BoltNum` / `Bolt1..N`      | Tower_Device 螺栓参数 |
| `TEXT_POINT_LINE`      | 含 `CODE` / `POINTNUM` / `LINENUM` / `POINTn` / `LINEn` 字段    | 点线几何记录                         | CROSS                |
| `TEXT_KEY_VALUE`       | 主要由 key=value 行构成，无独立 section header                  | `type`/`d`/`e1`/`e2`/`H1-H4` 或导线参数 | Tower_Device / WIRE  |
| `TEXT_HNUM_COMMA_RECORD` | 第一行 `HNum,n`，后续为逗号分隔记录（`H`/`Body`/`P`/`R`/`G` 等） | 杆塔主体 / 分段构件文本记录          | Tower_Device         |

> 线路 MOD 的详细分型、字段统计、CODE 分布、HNum 分布、token 分布及上游 CBM→MOD 映射详见 [08-mod-static-survey.md](08-mod-static-survey.md)。

## 引用关系

```
PHM 文件
└── SOLIDMODEL → <uuid>.mod    → MOD 文件
    ├── 变电： <Device><Entities><Entity>...</Entity></Entities></Device>
    └── 线路： 4 类文本格式族之一
```

### 变电工程 XML MOD 引用链

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

### 变电工程：长方体模型

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

### 变电工程：圆柱体模型

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

### 变电工程：瓷套管（绝缘子）模型

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

### 变电工程：拉伸体模型

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

### 变电工程：多图元组合模型

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

### 线路工程：TEXT_SECTION_KV_RECORD 示例

```text
Bolt
BoltNum=4
Bolt1=...
Bolt2=...
Bolt3=...
Bolt4=...
```

### 线路工程：TEXT_POINT_LINE 示例

```text
CODE=201
POINTNUM=4
LINENUM=4
POINT1=...
POINT2=...
POINT3=...
POINT4=...
LINE1=...
LINE2=...
LINE3=...
LINE4=...
```

### 线路工程：TEXT_KEY_VALUE 示例（杆塔参数型）

```text
type=...
d=...
e1=...
e2=...
H1=...
H2=...
H3=...
H4=...
```

### 线路工程：TEXT_KEY_VALUE 示例（导线参数型）

```text
COEFFICIENTOFELASTICITY=...
EXPANSIONCOEFFICIENTOFWIRE=...
RATEDSTRENGTH=...
SECTIONALAREA=...
OUTSIDEDIAMETER=...
WIREWEIGHT=...
```

### 线路工程：TEXT_HNUM_COMMA_RECORD 示例

```text
HNum,10
H,27000,Body1,Leg1
H,30000,Body1,Leg2
H,33000,Body1,Leg3
Body1
HBody1,26720.401
P,1,7519.597693,-953.003542,56293.389910
P,2,13970.086400,-649.820596,54093.616930
R,...
G,...
```

## 统计数据

### 数量统计

| 指标                  | demo-line（线路） | demo-line1（线路） | demo-substation（变电） |
| --------------------- | ----------------: | ------------------: | ----------------------: |
| MOD 文件总数          |              1807 |                 508 |                    4179 |
| XML_WITH_ENTITIES     |                 0 |                   0 |                    4135 |
| EMPTY_DEVICE_XML      |                 0 |                   0 |                      44 |
| TEXT_SECTION_KV_RECORD|              1300 |                 156 |                       0 |
| TEXT_POINT_LINE       |               315 |                 300 |                       0 |
| TEXT_KEY_VALUE        |               161 |                  34 |                       0 |
| TEXT_HNUM_COMMA_RECORD|                31 |                  18 |                       0 |
| 全部被 PHM 引用       |              true |                true |                   false |
| CBM 链全部可达        |              true |               false |                   false |
| 孤儿 / 未引用 MOD     |                 0 |                 148 |                      44 |

### XML Entity 与 primitive 统计（仅变电）

| 指标                | demo-substation |
| ------------------- | --------------: |
| Entity 总数          |           46250 |
| Visible=True        |           45558 |
| Visible=False       |             692 |
| 每个 Entity primitive 数 |              1 |
| TransformMatrix.Value 元素数 |           16 |
| 含 Color A/R/G/B    |          46250 |

primitive 分布（demo-substation）：

| primitive              |    数量 |
| ---------------------- | ------: |
| Cylinder               |   20421 |
| Cuboid                 |   12401 |
| StretchedBody          |   10263 |
| PorcelainBushing       |    1506 |
| TruncatedCone          |     730 |
| Ring                   |     235 |
| TerminalBlock          |     201 |
| Sphere                 |     141 |
| ChannelSteel           |     129 |
| Table                  |     109 |
| CircularGasket         |      80 |
| RectangularFixedPlate  |      18 |
| OffsetRectangularTable |      15 |
| RectangularRing        |       1 |

### 上游 CBM → MOD 映射对比

| 样本            | entityName → MOD kind                          | 唯一 MOD 数 |
| --------------- | ---------------------------------------------- | ----------: |
| demo-line       | Tower_Device → TEXT_SECTION_KV_RECORD          |        1300 |
| demo-line       | CROSS → TEXT_POINT_LINE                        |         315 |
| demo-line       | Tower_Device → TEXT_KEY_VALUE                  |         152 |
| demo-line       | Tower_Device → TEXT_HNUM_COMMA_RECORD          |          31 |
| demo-line       | WIRE → TEXT_KEY_VALUE                          |           9 |
| demo-line1      | Tower_Device → TEXT_SECTION_KV_RECORD          |         156 |
| demo-line1      | CROSS → TEXT_POINT_LINE                        |         152 |
| demo-line1      | Tower_Device → TEXT_KEY_VALUE                  |          28 |
| demo-line1      | Tower_Device → TEXT_HNUM_COMMA_RECORD          |          18 |
| demo-line1      | WIRE → TEXT_KEY_VALUE                          |           6 |
| demo-line1      | Wire_Device → 无几何链                          |           0 |
| demo-substation | F4System → XML_WITH_ENTITIES                   |        4135 |
| demo-substation | PARTINDEX → XML_WITH_ENTITIES                 |        3894 |

> demo-line1 中 Wire_Device entityName 在 CBM 中出现 1953 次但不到达任何 MOD（无几何链）；148 个 TEXT_POINT_LINE 孤儿 MOD 被 PHM 引用但 CBM 链不可达。

## 分析脚本

MOD 静态分型、各 kind 详细统计、上游 CBM→MOD 映射与孤儿诊断的脚本入口与说明见 [08-mod-static-survey.md](08-mod-static-survey.md) 附录 A。

主要脚本：

| 脚本                                       | 用途                                          |
| ------------------------------------------ | --------------------------------------------- |
| `_generated/mod-static-profile-v2.ps1`     | MOD 静态分型（kind / key / CODE / primitive） |
| `_generated/mod-per-kind-stats.ps1`        | 各 kind 详细字段统计                          |
| `_generated/mod-upstream-mapping-v2.ps1`   | 上游 CBM → DEV → PHM → MOD 映射               |
| `_generated/mod-upstream-diagnostic.ps1`   | 孤儿 MOD 诊断（CBM 链可达性）                  |
