# DEV 文件格式

## 文件概述

DEV（Device）文件是 GIM 工程中描述物理设备的文件，采用键值对文本格式。DEV 文件定义了设备的基本信息、符号类型、关联的属性文件（FAM）以及三维几何模型引用。一个 DEV 文件可通过 `SOLIDMODELn` 引用多个 PHM 模型或子 DEV 文件，每个引用都附带 4×4 变换矩阵定义其在空间中的位置、旋转和缩放。

DEV 文件位于 GIM 解压后的 `DEV/` 目录中，文件名采用 UUID 格式（如 `00230f03-7de3-4df9-bf4d-c7e303b0970c.dev`）。DEV 文件被 CBM 层的 `OBJECTMODELPOINTER` 字段引用，作为 CBM 节点到物理设备的桥梁。

### 变电工程与线路工程的差异

DEV 文件在两类工程中存在显著差异：

| 维度       | 变电工程                         | 线路工程                                    |
| ---------- | -------------------------------- | ------------------------------------------- |
| 类型字段   | `TYPE`（设备分类，如 OTHERS）    | `DEVICETYPE`（设备类型，如 STRING/BASE）    |
| 子设备组合 | `SUBDEVICEn=*.dev` + 独立变换矩阵 | `SOLIDMODELn=*.dev` + 共用变换矩阵索引      |
| 模型引用   | `SOLIDMODELn` 仅指向 `.phm`     | `SOLIDMODELn` 可指向 `.phm` 或 `.dev`       |
| 符号名称   | `SYMBOLNAME` 为中文（如 `柜体`） | `SYMBOLNAME` 为英文（如 `INSULATOR`）       |

## 文件格式

- **编码**：UTF-8
- **行分隔符**：换行符
- **键值分隔符**：`=`
- **列表索引**：从 0 开始（如 `SOLIDMODEL0`、`SUBDEVICE0`）
- **字段顺序**：通常为 `BASEFAMILY` → 类型字段 → `SOLIDMODELS` / `SUBDEVICES` 块

## 字段说明

### 通用字段

以下字段在变电工程与线路工程中均出现：

| 字段                  | 格式                      | 说明                                              |
| --------------------- | ------------------------- | ------------------------------------------------- |
| `BASEFAMILY`          | `<uuid>.fam`              | 引用同名目录下的 FAM 属性文件                     |
| `SYMBOLNAME`          | `<名称>`                  | 设备符号名称。变电为中文（`柜体`/`空开`），线路为英文（`INSULATOR`/`BASE`） |
| `SOLIDMODELS.NUM`     | `<N>`                     | 组合模型引用数量                                  |
| `SOLIDMODEL0`~`SOLIDMODELN` | `<uuid>.phm` 或 `<uuid>.dev` | 引用 PHM 模型或子 DEV 文件                       |
| `TRANSFORMMATRIX0`~`TRANSFORMMATRIXN` | `<16个浮点数>`      | 对应 `SOLIDMODELn` 的 4×4 变换矩阵                |

> **TRANSFORMMATRIX 索引独立**：`TRANSFORMMATRIXn` 与 `SOLIDMODELn` 通过索引 `n` 一一对应。当 DEV 文件同时包含 `SUBDEVICES` 块和 `SOLIDMODELS` 块时，两个块各自独立使用从 0 开始的 TRANSFORMMATRIX 索引（见变电工程示例）。

### 线路工程专用字段

| 字段          | 格式       | 说明                                                          |
| ------------- | ---------- | ------------------------------------------------------------- |
| `DEVICETYPE`  | `<枚举值>` | 设备类型分类，决定该设备在杆塔上的角色                        |

`DEVICETYPE` 取值分布（基于 demo-line 4518 个 DEV 文件）：

| DEVICETYPE   | 数量  | 含义                                   |
| ------------ | ----: | -------------------------------------- |
| `TOWER`       |   31 | 杆塔                                   |
| `BASE`        | 1300 | 基础构件（杆塔基础）                    |
| `STRING`      | 2682 | 绝缘子串（杆塔上的绝缘组合）           |
| `INSULATOR`   |   14 | 绝缘子（独立绝缘子，区别于 STRING）    |
| `CONDUCTOR`   |    3 | 导线                                   |
| `GROUNDWIRE`  |    3 | 地线                                   |
| `OPGW`        |    3 | 光纤复合架空地线                       |
| `CROSS`       |  315 | 横担                                   |
| `FITTINGS`    |  159 | 金具                                   |
| `DAMPER`      |    5 | 防震锤                                 |
| `SPACER`      |    3 | 间隔棒                                 |

线路工程的 DEV 通过 `SOLIDMODELn=*.dev` 引用子 DEV 来表达组合关系（如绝缘子串由多个绝缘子片组成），**不使用** `SUBDEVICES` 字段。

### 变电工程专用字段

| 字段              | 格式               | 说明                                                |
| ----------------- | ------------------ | --------------------------------------------------- |
| `TYPE`            | `<枚举值>`         | 设备分类，用于变电工程设备类型识别                  |
| `SUBDEVICES.NUM`  | `<N>`              | 子设备数量                                          |
| `SUBDEVICE0`~`SUBDEVICEN` | `<uuid>.dev` | 引用子设备 DEV 文件                                 |
| `TRANSFORMMATRIX0`~`TRANSFORMMATRIXN`（SUBDEVICES 块） | `<16个浮点数>` | 对应 `SUBDEVICEn` 的 4×4 变换矩阵 |

`TYPE` 取值分布（基于 demo-substation 4179 个 DEV 文件）：

| TYPE                                            | 数量  | 含义                   |
| ----------------------------------------------- | ----: | ---------------------- |
| `OilImmersedTransformer`                         |    3 | 油浸变压器             |
| `OpenGroundingEquipment/NeutralPointEquipment`   |    6 | 接地设备/中性点设备    |
| `HGIS`                                           |   32 | 复合组合电器           |
| `GIS`                                            |    5 | 组合电器               |
| `HVSwitchCabinet`                                |   81 | 高压开关柜             |
| `ACIsolatingSwitch`                              |    6 | 交流隔离开关           |
| `GroundTransformer/ArcExtinguishingCoil`          |    4 | 接地变/消弧线圈        |
| `LightningArrester`                              |   24 | 避雷器                 |
| `FrameCapacitor`                                 |   36 | 框架式电容器           |
| `DryTypeReactor`                                 |    6 | 干式电抗器             |
| `SecondaryCabinet`                               |  106 | 二次柜                 |
| `OTHERS`                                         | 3870 | 其他（通用设备）       |

变电工程中，258 个 DEV 文件包含非零 `SUBDEVICES`（其余 3921 个 `SUBDEVICES.NUM=0`）。`SUBDEVICES` 块和 `SOLIDMODELS` 块各自独立使用从 0 开始的 TRANSFORMMATRIX 索引。

## 变换矩阵格式

4×4 变换矩阵按**列主序**展开为 16 个浮点数（与 Three.js / OpenGL `Matrix4.elements` 布局一致），以英文逗号分隔：

```
M00,M10,M20,M30,M01,M11,M21,M31,M02,M12,M22,M32,M03,M13,M23,M33
```

对应矩阵（列主序：先填列 0，再填列 1…）：

```
| M00  M01  M02  M03 |
| M10  M11  M12  M13 |
| M20  M21  M22  M23 |
| M30  M31  M32  M33 |
```

其中：
- 左上角 3×3 子矩阵（M00~M22）控制旋转和缩放
- **平移分量在 m[12]、m[13]、m[14]**（数组下标 12/13/14，即矩阵最后一列 M03/M13/M23），控制 X/Y/Z 方向平移
- 最后一行固定为 `0,0,0,1`

> **存储约定**（详见 [09-transform-chain-analysis.md](09-transform-chain-analysis.md) §8）：GIM 16 浮点数采用列主序存储，平移在 m[12..14]，与 Three.js `Matrix4.elements` 布局一致，可直接 `Matrix4.fromArray(values)` 使用。早期版本曾误记为"行优先、平移在最后一列 m[3]/m[7]/m[11]"，已修正。

**单位矩阵**：`1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1`

数值精度因工程而异：
- 变电工程常见整数形式：`1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1`
- 线路工程常见浮点形式：`1.000000,0.000000,0.000000,0.000000,...`

## 引用关系

### 线路工程

```text
DEV 文件
├── BASEFAMILY → <uuid>.fam        → 属性文件
├── DEVICETYPE                      → 设备类型（STRING/BASE/...）
└── SOLIDMODELS
    ├── SOLIDMODEL0 → <uuid>.phm   → PHM 几何模型（叶子节点）
    │   └── TRANSFORMMATRIX0
    └── SOLIDMODEL0 → <uuid>.dev   → 子 DEV（递归组合，如绝缘子串）
        └── TRANSFORMMATRIX0
```

线路 DEV 的 `SOLIDMODELn` 既可指向 `.phm`（叶子几何）也可指向 `.dev`（子设备组合），二者不混合出现于同一个 DEV 文件内。

### 变电工程

```text
DEV 文件
├── BASEFAMILY → <uuid>.fam        → 属性文件
├── TYPE                            → 设备分类（OTHERS/HVSwitchCabinet/...）
├── SUBDEVICES（可选）
│   ├── SUBDEVICE0 → <uuid>.dev    → 子设备 DEV（递归）
│   │   └── TRANSFORMMATRIX0
│   └── SUBDEVICEN → <uuid>.dev
│       └── TRANSFORMMATRIXN
└── SOLIDMODELS
    └── SOLIDMODEL0 → <uuid>.phm   → PHM 几何模型
        └── TRANSFORMMATRIX0
```

变电 DEV 的 `SOLIDMODELn` 仅指向 `.phm`；子设备组合通过独立的 `SUBDEVICES` 块表达。`SUBDEVICES` 块的 `TRANSFORMMATRIX` 索引与 `SOLIDMODELS` 块的 `TRANSFORMMATRIX` 索引各自从 0 开始独立编号。

## 示例

### 线路工程：BASE 类型（叶子设备）

```text
DEVICETYPE=BASE
SYMBOLNAME=BASE
BASEFAMILY=00230f03-7de3-4df9-bf4d-c7e303b0970c.fam
SOLIDMODELS.NUM=1
SOLIDMODEL0=c66d61fe-a264-41ea-aa69-844dec863b0b.phm
TRANSFORMMATRIX0=1.000000000,0.000000000,0.000000000,0.000000000,0.000000000,1.000000000,0.000000000,0.000000000,0.000000000,0.000000000,1.000000000,0.000000000,0.000000000,0.000000000,0.000000000,1.000000000
```

### 线路工程：STRING 类型（多子设备组合）

```text
DEVICETYPE=STRING
SYMBOLNAME=INSULATOR
BASEFAMILY=006bb90c-7d49-4f08-92f8-b43f2f18c4db.fam
SOLIDMODELS.NUM=4
SOLIDMODEL0=9e67c7f3-b43c-4cb9-afd0-71518db7fc5a.dev
TRANSFORMMATRIX0=-0.000000,-1.000000,0.000000,0.000000,-1.000000,0.000000,0.000000,0.000000,-0.000000,0.000000,-1.000000,0.000000,0.000000,0.000000,-0.100000,1.000000
SOLIDMODEL1=4357eeab-750f-4af6-a356-0dad58d2fa98.dev
TRANSFORMMATRIX1=1.000000,0.000000,0.000000,0.000000,0.000000,1.000000,0.000000,0.000000,0.000000,0.000000,1.000000,0.000000,-0.000000,0.000000,-0.100000,1.000000
SOLIDMODEL2=4f162b79-db69-4aea-b17f-bb70fb72ce22.dev
TRANSFORMMATRIX2=0.000000,1.000000,0.000000,0.000000,-1.000000,0.000000,0.000000,0.000000,0.000000,0.000000,1.000000,0.000000,-0.000000,0.000000,-0.195000,1.000000
SOLIDMODEL3=e9bc64b3-401d-49b1-b3cd-13dea6440516.dev
TRANSFORMMATRIX3=0.000000,-1.000000,0.000000,0.000000,1.000000,0.000000,0.000000,0.000000,0.000000,0.000000,1.000000,0.000000,-0.000000,0.000000,-0.315000,1.000000
```

大型绝缘子串 DEV 可引用多达 42 个子 DEV（`SOLIDMODELS.NUM=42`）。

### 变电工程：简单设备（无子设备）

```text
BASEFAMILY=4058963c-f997-4209-a3d5-beda62a70479.fam
SYMBOLNAME=柜体
TYPE=OTHERS
SUBDEVICES.NUM=0
SOLIDMODELS.NUM=1
SOLIDMODEL0=9aaf75bf-db95-4f71-a556-31fae57d58b3.phm
TRANSFORMMATRIX0=1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1
```

### 变电工程：含子设备的设备

```text
BASEFAMILY=77791a2a-6f55-4c6c-8d7a-c48e0cb0fc4d.fam
SYMBOLNAME=框架式电容器（典设A2-6）
TYPE=FrameCapacitor
SUBDEVICES.NUM=9
SUBDEVICE0=1caef33c-0f6e-4c60-bc2f-b0bdb3aa24c3.dev
TRANSFORMMATRIX0=1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1
SUBDEVICE1=da2d14df-d86b-42de-b7d6-de7815d57a05.dev
TRANSFORMMATRIX1=1,0,0,0,0,1,0,0,0,0,1,0,1.08286712929839E-12,0,-1.40772726808791E-11,1
...
SUBDEVICE8=2bb88510-6ac5-41e2-95d0-2b886fdad9bd.dev
TRANSFORMMATRIX8=1,0,0,0,0,1,0,0,0,0,1,0,1.46728496019932E-10,0,-1.3651351653956E-11,1
SOLIDMODELS.NUM=1
SOLIDMODEL0=b1b1f864-a3e5-4ae5-b8a8-ed57b3c28805.phm
TRANSFORMMATRIX0=1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1
```

注意 `SUBDEVICE` 块使用 `TRANSFORMMATRIX0`~`TRANSFORMMATRIX8`，`SOLIDMODELS` 块重新从 `TRANSFORMMATRIX0` 开始编号。

## 统计数据

### 数量统计

| 指标                            | demo-line（线路） | demo-substation（变电） |
| ------------------------------- | ----------------: | ----------------------: |
| DEV 文件总数                    |              4518 |                    4179 |
| 含 `SOLIDMODELS` 字段的文件数   |              4518 |                    4179 |
| 含非零 `SUBDEVICES` 的文件数    |                 0 |                     258 |
| `SUBDEVICES.NUM=0` 的文件数     |              4518 |                    3921 |
| 含 `TRANSFORMMATRIX0` 的文件数  |              4518 |                    4179 |

### 引用统计

| 引用类型               | demo-line（线路） | demo-substation（变电） |
| ---------------------- | ----------------: | ----------------------: |
| `SOLIDMODEL` → `.phm`  |              1836 |                    4179 |
| `SOLIDMODEL` → `.dev`  |            138622 |                       0 |
| `SUBDEVICE` → `.dev`   |                 0 |                    258（文件数） |

> demo-line 的 138622 条 `SOLIDMODEL → .dev` 引用集中在 2682 个 STRING 类型 DEV 文件中，平均每个文件约 52 条子 DEV 引用。

### 类型字段分布对比

| 维度       | 线路工程（`DEVICETYPE`）     | 变电工程（`TYPE`）                |
| ---------- | ---------------------------- | --------------------------------- |
| 字段名     | `DEVICETYPE`                 | `TYPE`                            |
| 取值风格   | 英文枚举（设备物理角色）    | 英文枚举（电气设备分类）          |
| 主导值     | STRING（59%）、BASE（29%）   | OTHERS（93%）                     |
| 与 CBM 关系 | 与 CBM 层级结构对应（杆塔组件） | 独立于 CBM 层级（电气设备分类） |

## 同名不同语义说明

`SUBDEVICEn` 字段在 CBM 和 DEV 两层都出现，但语义独立：

| 出现位置 | 引用目标    | 语义                                       |
| -------- | ----------- | ------------------------------------------ |
| CBM 文件 | `<uuid>.cbm` | F4System 内部子设备分组（不是主层级字段） |
| DEV 文件 | `<uuid>.dev` | DEV 层子设备组合（仅变电工程使用）         |

解析时需按所在文件类型区分 `SUBDEVICEn` 的语义。
