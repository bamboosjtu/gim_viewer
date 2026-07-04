# GIM 引用完整性校验

目标：确认 CBM / DEV / PHM 层引用是否闭合。

## 1. 范围与方法

### 校验范围

当前覆盖 3 个 demo 的 GIM 文件：

- `demo-line`、`demo-line1`（线路工程）
- `demo-substation`（变电工程）

校验层次为 CBM、DEV、PHM 三层的文件级引用目标是否存在。不递归展开完整模型树，不解析 PHM / MOD / STL 几何。

### 校验方法

1. 扫描样本目录下所有文件，建立文件名索引。
2. 扫描所有 `.cbm` / `.dev` / `.phm` 文件。
3. 提取所有形如 `KEY=VALUE` 的引用字段（`VALUE` 含扩展名 `.cbm` / `.dev` / `.phm` / `.fam` / `.ifc` / `.mod` / `.stl`）。
4. 使用大小写不敏感的文件名匹配，判断引用目标是否存在。
5. 输出引用明细 CSV 和汇总统计。

> **关键修正**：早期版本只把 `SUBDEVICEn` / `OBJECTMODELPOINTER` / `IFCFILE` / `BASEFAMILY` 视为引用字段，遗漏了线路工程的 `SUBSYSTEMn` / `SECTIONn` / `STRAINSECTIONn` / `GROUPn` / `TOWERn` / `BASEn` / `STRINGn.STRING` / `BACKSTRING` / `FRONTSTRING` 等层级字段，以及变电工程 `FileDevRelation.cbm` 中的 `FILE.N.DEVn` 字段。本次复核改为按「`VALUE` 是否带文件扩展名」做全量统计，避免遗漏。

### 引用字段分类

#### CBM 层引用字段

| 字段模式                     | 引用目标 | 适用工程 | 说明                                       |
| ---------------------------- | -------- | -------- | ------------------------------------------ |
| `SUBSYSTEMn`                 | `.cbm`   | 变电     | F1→F2→F3 层级递归字段                      |
| `SECTIONn`                   | `.cbm`   | 线路     | F1System → F2System 层级字段               |
| `STRAINSECTIONn`             | `.cbm`   | 线路     | F2System → F3System 耐张段层级字段         |
| `GROUPn`                     | `.cbm`   | 线路     | F3System → F4System 分组层级字段           |
| `SUBDEVICEn`                 | `.cbm`   | 通用     | F4System 内部子设备分组（**不是主层级**）  |
| `TOWERn`                     | `.cbm`   | 线路     | F4System TOWER → Tower_Device 引用         |
| `BASEn`                      | `.cbm`   | 线路     | F4System TOWER → 基础构件引用              |
| `STRINGn.STRING`             | `.cbm`   | 线路     | F4System TOWER → 串引用                    |
| `BACKSTRING` / `FRONTSTRING` | `.cbm`   | 线路     | WIRE → 耐张段塔位引用                      |
| `FILE.N.DEVn`                | `.cbm`   | 变电     | FileDevRelation.cbm 文件设备映射表专用字段 |
| `OBJECTMODELPOINTER`         | `.dev`   | 通用     | CBM 指向 DEV 物理模型                      |
| `IFCFILE`                    | `.ifc`   | 通用     | CBM 指向 IFC 文件                          |
| `IFC.NUM` + `IFC0..N`        | `.ifc`   | 变电     | F1System 工程级 IFC 引用列表               |
| `BASEFAMILY`                 | `.fam`   | 通用     | CBM 指向 FAM 单属性文件                    |
| `BASEFAMILY1..N`             | `.fam`   | 变电     | CBM 指向多 FAM 属性文件（仅变电 F3System） |

#### DEV 层引用字段

| 字段模式      | 引用目标        | 说明                                                      |
| ------------- | --------------- | --------------------------------------------------------- |
| `SOLIDMODELn` | `.phm` / `.dev` | 实体模型引用，目标可为 PHM 或子 DEV                       |
| `SUBDEVICEn`  | `.dev`          | 子设备引用（变电专用，与 CBM 的 SUBDEVICEn 同名不同语义） |

#### PHM 层引用字段

| 字段模式           | 引用目标        | 说明                         |
| ------------------ | --------------- | ---------------------------- |
| `SOLIDMODELn`      | `.mod` / `.stl` | 实体模型引用，目标为几何图元 |
| `TRANSFORMMATRIXn` | (无)            | 空间变换矩阵，非文件引用     |
| `COLORn`           | (无)            | 颜色字段，非文件引用         |

当前生成文件：

```text
docs/schema/_generated/demo-line-cbm-integrity.csv
docs/schema/_generated/demo-substation-cbm-integrity.csv
```

`_generated` 目录为临时分析输出，不进入版本管理。

---

## 2. CBM 层

### 2.1 引用字段分布（按扩展名汇总）

| 样本            | CBM 总数 | CBM 引用 | DEV 引用 | FAM 引用 | IFC 引用 | 缺失 |
| --------------- | -------: | -------: | -------: | -------: | -------: | ---: |
| demo-line       |    27829 |    38859 |    21857 |    21967 |        0 |    0 |
| demo-line1      |     4998 |     7052 |     3900 |     3925 |        0 |    0 |
| demo-substation |     8701 |    13344 |     4179 |     9134 |     4384 |    0 |

> **修正说明**：原版本「CBM 引用」只统计 `SUBDEVICEn`，demo-line 仅 17552、demo-substation 仅 3894。本次复核按扩展名全量统计后，新增了线路的 `FRONTSTRING` / `BACKSTRING` / `STRINGn.STRING` / `GROUPn` / `BASEn` / `TOWERn` / `STRAINSECTIONn` / `SECTIONn`，以及变电 `FileDevRelation.cbm` 的 `FILE.N.DEVn` 字段。

#### 线路工程 CBM 引用按字段分组

| 字段（数字归一为 N） |  line | line1 | 说明                         |
| -------------------- | ----: | ----: | ---------------------------- |
| `SUBSYSTEM`          |     1 |     1 | 工程入口 SUBSYSTEM 字段      |
| `SECTIONN`           |     1 |     2 | F1 → F2 标段层级             |
| `STRAINSECTIONN`     |   108 |    22 | F2 → F3 耐张段层级           |
| `GROUPN`             |  1092 |  1092 | F3System → F4System 分组层级 |
| `SUBDEVICEN`         | 17552 |  3127 | F4System 子设备分组          |
| `TOWERN`             |   327 |    40 | TOWER 关联塔引用             |
| `BASEN`              |  1300 |   157 | TOWER 基础引用               |
| `STRINGN.STRING`     |  2682 |   585 | TOWER 串引用                 |
| `FRONTSTRING`        |  5460 |  1013 | WIRE 前侧耐张段塔位          |
| `BACKSTRING`         |  5460 |  1013 | WIRE 后侧耐张段塔位          |
| **合计**             | 38859 |  7052 |                              |

#### 变电工程 CBM 引用按字段分组

| 字段（数字归一为 N） | 引用数 | 说明                                       |
| -------------------- | -----: | ------------------------------------------ |
| `SUBSYSTEM`          |      1 | 工程入口 SUBSYSTEM 字段                    |
| `SUBSYSTEMN`         |   4804 | F1→F2→F3 层级递归                          |
| `SUBDEVICEN`         |   3894 | F4System 子设备分组                        |
| `FILE0.DEVN`         |    112 | FileDevRelation.cbm 设备映射               |
| `FILE2.DEVN`         |     48 | FileDevRelation.cbm 设备映射               |
| `FILE4.DEVN`         |   1332 | FileDevRelation.cbm 设备映射（对应 1.ifc） |
| `FILE6.DEVN`         |     95 | FileDevRelation.cbm 设备映射               |
| `FILE8.DEVN`         |    960 | FileDevRelation.cbm 设备映射               |
| `FILE10.DEVN`        |     57 | FileDevRelation.cbm 设备映射               |
| `FILE12.DEVN`        |    260 | FileDevRelation.cbm 设备映射               |
| `FILE14.DEVN`        |     74 | FileDevRelation.cbm 设备映射               |
| `FILE16.DEVN`        |     58 | FileDevRelation.cbm 设备映射               |
| `FILE18.DEVN`        |    353 | FileDevRelation.cbm 设备映射               |
| `FILE20.DEVN`        |   1151 | FileDevRelation.cbm 设备映射               |
| `FILE22.DEVN`        |    145 | FileDevRelation.cbm 设备映射               |
| **合计**             |  13344 |                                            |

> `FILE.N.DEVn` 字段集中在 `FileDevRelation.cbm` 一个文件中，每个 `FILE.N` 对应一个 IFC 文件，`DEVn` 列出该 IFC 关联的所有设备 CBM。这是变电工程专用的「IFC ↔ 设备」反向索引表。

### 2.2 引用完整性结论

| 样本            | CBM 引用 | 缺失 | DEV 引用 | 缺失 | FAM 引用 | 缺失 | IFC 引用 | 缺失 |
| --------------- | -------: | ---: | -------: | ---: | -------: | ---: | -------: | ---: |
| demo-line       |    38859 |    0 |    21857 |    0 |    21967 |    0 |        0 |    0 |
| demo-line1      |     7052 |    0 |     3900 |    0 |     3925 |    0 |        0 |    0 |
| demo-substation |    13344 |    0 |     4179 |    0 |     9134 |    0 |     4384 |    0 |

三个样本的 CBM 层文件级引用完整性均为 100%，所有引用目标均存在。

> **FAM 引用差异说明**：demo-substation 的 FAM 引用 9134 条中，单 `BASEFAMILY` 8554 条 + 多 `BASEFAMILY1..N` 580 条；线路样本均只有单 `BASEFAMILY`。详见 `06-cbm-fam-consistency.md`。

### 2.3 IFCGUID → IFC 内部命中校验

CBM 通过 `IFCFILE + IFCGUID` 指向 IFC 内部构件。本节校验这些 GUID 是否能在对应 IFC 文件文本中命中（仅文本级匹配，不解析 IFC 语义）。**仅 demo-substation 存在此引用类型**，线路样本的 `IFCFILE` / `IFCGUID` 字段均为空。

校验对象：

| 字段          | 说明                                       |
| ------------- | ------------------------------------------ |
| `IFCFILE`     | CBM 指向的 IFC 文件名                      |
| `IFCGUID`     | CBM 中记录的 IFC GUID                      |
| 声明 IFC 文件 | `IFCFILE` 指向的 IFC 文件                  |
| 任意 IFC 文件 | 当前 demo-substation 中全部 12 个 IFC 文件 |

#### 总体统计

| 指标                              | 数量 |
| --------------------------------- | ---: |
| IFC 引用总数                      | 4360 |
| 有 IFCFILE                        | 4360 |
| 有 IFCGUID                        | 4360 |
| IFC 文件存在                      | 4360 |
| IFC 文件缺失                      |    0 |
| 精确命中声明 IFC 文件             | 3252 |
| 精确未命中声明 IFC 文件           | 1108 |
| 大小写不敏感命中声明 IFC 文件     | 3296 |
| 大小写不敏感未命中声明 IFC 文件   | 1064 |
| 精确命中任意 IFC 文件             | 3252 |
| 任意 IFC 文件均未精确命中         | 1108 |
| 大小写不敏感命中任意 IFC 文件     | 3296 |
| 任意 IFC 文件均未大小写不敏感命中 | 1064 |
| 唯一 IFC 文件数                   |   12 |
| 唯一 IFCGUID 数                   | 3429 |

- `IFCFILE` 文件存在性为 100%。
- `IFCGUID` 精确命中率为 `3252 / 4360 = 74.59%`。
- `IFCGUID` 大小写不敏感命中率为 `3296 / 4360 = 75.60%`。
- 有 `44` 条属于精确未命中但大小写不敏感命中。
- 有 `1064` 条（24.40%）在当前 12 个 IFC 文件中均未命中（硬未命中）。

#### 按 IFC 文件统计

| IFC 文件                               | 总数 | 精确命中 | 大小写不敏感命中 | 精确未命中 | 精确命中率 |
| -------------------------------------- | ---: | -------: | ---------------: | ---------: | ---------: |
| 总图0317.ifc                           |  145 |      144 |              144 |          1 |     99.31% |
| 建筑部分0317.ifc                       |  960 |      864 |              870 |         96 |     90.00% |
| 基础0317.ifc                           |   95 |       75 |               75 |         20 |     78.95% |
| 结构0317.ifc                           |  260 |      258 |              258 |          2 |     99.23% |
| 暖通布置0317.ifc                       |   58 |       58 |               58 |          0 |    100.00% |
| 室内给排水0317.ifc                     |  353 |      353 |              353 |          0 |    100.00% |
| 给排水消防及排油添加主变水喷淋0401.ifc | 1332 |      597 |              597 |        735 |     44.82% |
| 警卫室建筑0317.ifc                     |   74 |       73 |               73 |          1 |     98.65% |
| 一次设备0402其他.ifc                   |  972 |      721 |              759 |        251 |     74.18% |
| 电气二次0317其他.ifc                   |    6 |        6 |                6 |          0 |    100.00% |
| 接地0317其他.ifc                       |   57 |       57 |               57 |          0 |    100.00% |
| 动力照明0317.ifc                       |   48 |       46 |               46 |          2 |     95.83% |

#### 硬未命中分型

硬未命中（`caseInsensitiveInAnyIfc = False`）共 1064 条。这些 CBM 记录均具有以下特征：

| 字段                 | 结果              |
| -------------------- | ----------------- |
| `ENTITYNAME`         | 全部为 `F4System` |
| `OBJECTMODELPOINTER` | 全部为空          |
| `BASEFAMILY`         | 全部有值          |
| `SUBDEVICE`          | 全部无            |
| `SUBDEVICES.NUM`     | 全部为 0          |

硬未命中按 IFCGUID 聚合后高度集中：

| IFCGUID                  | 数量 | 主要来源 IFC 文件              |
| ------------------------ | ---: | ------------------------------ |
| `3Zu5Bv0LOHrPC10026FoUj` |  740 | 给排水消防及排油添加主变水喷淋 |
| `3Aw$FV5MbAufEo59pkoNlf` |  193 | 一次设备0402其他               |

这两个 GUID 合计 933 / 1064，占硬未命中的 87.69%。经大小写不敏感的 Select-String 复核，均未在 12 个 IFC 文件中命中。

#### 判断与影响

`IFCFILE + IFCGUID` 不能统一视为"可直接定位 IFC 构件"的强关联，应分三类处理：

| 类型                  | 判断                                        |
| --------------------- | ------------------------------------------- |
| 精确命中              | 可作为强 IFC 构件关联                       |
| 大小写不敏感命中      | 可作为弱 IFC 构件关联，后续实现中需谨慎处理 |
| 任意 IFC 文件均未命中 | 不应直接用于 IFC 构件定位                   |

硬未命中的 IFCGUID 不宜直接判定为错误 GUID。根据 CBM 上下文，它们全部属于 `ENTITYNAME = F4System`、`OBJECTMODELPOINTER = 空` 的节点。更稳妥的解释是：

> CBM 层存在一批 F4System 节点带 IFCFILE + IFCGUID，但这些 GUID 在当前 IFC 文本中不存在。这些节点可能是系统、家族、分类、占位或导出残留关联，暂时不能作为可定位 IFC 构件处理。

命中组与未命中组的 CBM 字段集合一致；FAM 都是空 sidecar；`SYSCLASSIFYNAME` 均为"&其他"。因此硬未命中不是 FAM 字段问题，也不是 CBM 字段缺失问题。

从浏览器实现角度，应采用容错策略：

1. IFCFILE 存在且 IFCGUID 精确命中时 → 强 IFC 构件关联。
2. IFCGUID 仅大小写不敏感命中时 → 弱 IFC 构件关联，记录归一化警告。
3. IFCFILE 存在但 IFCGUID 未命中时 → 不阻断加载，保留 CBM 节点，诊断告警提示。
4. IFCFILE 缺失时 → 不阻断加载，保留 CBM 节点，提示 IFC 文件缺失。

当前结论只适用于当前 demo-substation，不应直接推广为全部 GIM 工程规则。后续浏览器实现应把 IFCGUID 视为可选定位能力，而不是强制加载前提。

---

## 3. DEV 层

### 3.1 字段结构

`.dev` 文件为 plain text key-value 格式。核心字段模式：

```text
SOLIDMODELS.NUM=N
SOLIDMODEL0=xxx.phm / xxx.dev
SOLIDMODEL1=xxx.phm / xxx.dev
...

SUBDEVICE0=xxx.dev
SUBDEVICE1=xxx.dev
...
```

| 字段              | 含义候选                                       | 可信度 |
| ----------------- | ---------------------------------------------- | ------ |
| `SOLIDMODELS.NUM` | 当前 DEV 引用的实体模型数量                    | 高     |
| `SOLIDMODELn`     | 第 n 个实体模型引用，目标可为 `.phm` 或 `.dev` | 高     |
| `SUBDEVICEn`      | 第 n 个子设备引用，目标为 `.dev`               | 高     |

> **同名不同语义**：CBM 的 `SUBDEVICEn=*.cbm` 是 CBM 层 F4System 内部子设备分组，DEV 的 `SUBDEVICEn=*.dev` 是 DEV 层子设备组合。两者同名但语义独立，解析时需按所在文件类型区分。

### 3.2 全量统计

#### 按文件数统计

| 样本            | DEV 总数 | 引用 PHM 的文件数 | SOLIDMODEL 引用 DEV 的文件数 | 存在 SUBDEVICE 的文件数 | PHM + SUBDEVICE 混合 |
| --------------- | -------: | ----------------: | ---------------------------: | -----------------------: | -------------------: |
| demo-line       |     4518 |              1836 |                         2682 |                        0 |                    0 |
| demo-line1      |     1148 |               563 |                          585 |                        0 |                    0 |
| demo-substation |     4179 |              4179 |                            0 |                      258 |                  258 |

> **说明**：两个线路样本的 DEV 文件均分为互斥两类——只引用 PHM 的叶子设备与只引用 DEV 的组合设备。demo-line 的 4518 个 DEV 中，1836 个引用 PHM（多为 `DEVICETYPE=BASE`），2682 个引用 DEV（多为 `DEVICETYPE=STRING`）；demo-line1 比例相似，563 个引用 PHM，585 个引用 DEV。demo-substation 的所有 4179 个 DEV 都引用 PHM，其中 258 个同时通过 `SUBDEVICES` 引用子 DEV。

#### 按引用数统计

| 样本            | SOLIDMODEL → PHM 引用数 | SOLIDMODEL → DEV 引用数 | SUBDEVICE → DEV 引用数 |
| --------------- | ----------------------: | ----------------------: | ---------------------: |
| demo-line       |                    1836 |                  138622 |                      0 |
| demo-line1      |                     563 |                   42021 |                      0 |
| demo-substation |                    4179 |                       0 |                   3894 |

> **demo-line1 与 demo-line 模式一致**：两个线路样本的字段模式完全相同，仅规模不同。demo-line1 的 42021 条 `SOLIDMODEL → DEV` 引用集中在 585 个 `DEVICETYPE=STRING` 类型 DEV 文件中（平均每个文件约 72 条子 DEV 引用），高于 demo-line 的 52 条/文件。

关键发现：

- 两个线路样本中，DEV 文件均分为互斥两类：直接引用 PHM 的叶子设备（demo-line 1836 个、demo-line1 563 个）和通过 `SOLIDMODELn` 引用其他 DEV 的组合设备（demo-line 2682 个、demo-line1 585 个）。`DEVICETYPE=STRING` 对应组合设备，其余类型（BASE/CROSS/FITTINGS/TOWER 等）对应叶子设备。
- 两个线路样本均未发现 `SUBDEVICEn` 字段。
- demo-substation 中，所有 DEV 都直接引用 PHM（4179 个文件，共 4179 条引用），258 个 DEV 同时存在 `SUBDEVICEn=*.dev`。
- demo-substation 中未发现 `SOLIDMODELn=*.dev`。
- 三个样本中均未发现 `.phm` / `.dev` 之外的 `SOLIDMODELn` 目标。

### 3.3 线路工程 DEV

#### DEVICETYPE 分布

| DEVICETYPE   | demo-line 文件数 | demo-line1 文件数 | 含义                 |
| ------------ | ---------------: | ----------------: | -------------------- |
| `STRING`      |             2682 |               585 | 绝缘子串（组合设备） |
| `BASE`        |             1300 |               157 | 基础构件（叶子设备） |
| `CROSS`       |              315 |               300 | 横担                 |
| `FITTINGS`    |              159 |                71 | 金具                 |
| `TOWER`       |               31 |                18 | 杆塔                 |
| `INSULATOR`   |               14 |                 7 | 独立绝缘子           |
| `DAMPER`      |                5 |                 2 | 防震锤               |
| `GROUNDWIRE`  |                3 |                 2 | 地线                 |
| `SPACER`      |                3 |                 2 | 间隔棒               |
| `OPGW`        |                3 |                 2 | 光纤复合架空地线     |
| `CONDUCTOR`   |                3 |                 2 | 导线                 |
| **合计**      |             4518 |              1148 |                      |

两个线路样本的 `DEVICETYPE` 分布形态一致：`STRING` 与 `BASE` 合计占 80% 以上，其余类型占比小。`DEVICETYPE=STRING` 全部为组合设备（引用 `.dev`），其余类型全部为叶子设备（引用 `.phm`）。

#### 引用模式

**模式一：DEV → PHM**

```text
SOLIDMODELS.NUM=1
SOLIDMODEL0=c66d61fe-a264-41ea-aa69-844dec863b0b.phm
```

**模式二：DEV → DEV（多子模型）**

```text
SOLIDMODELS.NUM=42
SOLIDMODEL0=bcf219cd-37ec-4cd4-95d9-4bb86e1570e3.dev
SOLIDMODEL1=599e49bd-32e6-4b0d-a17e-2ceb8aa829cb.dev
...
SOLIDMODEL41=782f183f-6242-456b-aba6-ff95000cbd62.dev
```

线路 DEV 中 `SOLIDMODELn` 既可指向 PHM 也可指向 DEV，因此不能简单写成 `DEV → PHM` 单一路径。

### 3.4 变电工程 DEV

两类引用模式：

**模式一：DEV → PHM**

```text
SOLIDMODELS.NUM=1
SOLIDMODEL0=43cc25d5-c095-427a-9f0d-9074ab5bf41c.phm
```

**模式二：DEV → PHM + SUBDEVICE → DEV（混合）**

```text
SUBDEVICE0=e5071d89-1e66-41ed-bde9-0622fdc6d59f.dev
SUBDEVICE1=c5c9f5e1-d911-409d-9b74-2dd581ff479e.dev
...
SUBDEVICE29=ae3b1d1c-3c4c-49cb-818b-4f9d0f9dff4d.dev
SOLIDMODELS.NUM=1
SOLIDMODEL0=1e90f88c-f2c4-4a98-9e67-88e78a68ef2e.phm
```

变电 DEV 通过 `SOLIDMODELn` 引用 PHM，通过 `SUBDEVICEn` 引用子 DEV。`SUBDEVICEn` 比线路中的 `SOLIDMODELn=xxx.dev` 更明确地表达子设备组合语义。

### 3.5 DEV → PHM 引用完整性

| 样本            | DEV→PHM 引用数 | 缺失 |
| --------------- | -------------: | ---: |
| demo-line       |           1836 |    0 |
| demo-line1      |            563 |    0 |
| demo-substation |           4179 |    0 |

三个样本的 DEV→PHM 引用完整性均为 100%。

### 3.6 DEV → DEV / SUBDEVICE 引用完整性

| 样本            | 引用类型         | 引用数 | 缺失 |
| --------------- | ---------------- | -----: | ---: |
| demo-line       | SOLIDMODEL → DEV | 138622 |    0 |
| demo-line1      | SOLIDMODEL → DEV |  42021 |    0 |
| demo-substation | SUBDEVICE → DEV  |   3894 |    0 |

> **demo-substation SUBDEVICE → DEV 引用数为 3894**，与 CBM 层 `SUBDEVICEn=*.cbm` 的引用数（3894）数值相同。这不是统计错误——DEV 层的 258 个 DEV 文件中 `SUBDEVICEn` 引用总数经实际脚本统计确为 3894，平均每个文件约 15 条子 DEV 引用。

> **两个线路样本的 `SOLIDMODEL → DEV` 引用数**：demo-line 为 138622 条（2682 个 STRING 文件，平均 52 条/文件），demo-line1 为 42021 条（585 个 STRING 文件，平均 72 条/文件）。两个样本的引用机制完全一致，仅规模不同。

线路样本通过 `SOLIDMODELn=*.dev` 引用子 DEV（无 SUBDEVICE 字段），变电样本通过 `SUBDEVICEn=*.dev` 引用子 DEV（无 SOLIDMODEL→DEV）。三个样本的 DEV 内部引用完整性均为 100%。

---

## 4. PHM 层

### 4.1 字段结构

`.phm` 文件为 plain text key-value 格式。核心字段模式：

```text
SOLIDMODELS.NUM=N
SOLIDMODEL0=xxx.mod / xxx.stl
TRANSFORMMATRIX0=...
COLOR0=...
SOLIDMODEL1=xxx.mod / xxx.stl
TRANSFORMMATRIX1=...
COLOR1=...
...
```

| 字段               | 含义候选                                     | 可信度 |
| ------------------ | -------------------------------------------- | ------ |
| `SOLIDMODELS.NUM`  | 当前 PHM 引用的实体模型数量                  | 高     |
| `SOLIDMODELn`      | 第 n 个实体模型引用，目标为 `.mod` 或 `.stl` | 高     |
| `TRANSFORMMATRIXn` | 第 n 个实体模型的空间变换矩阵                | 高     |
| `COLORn`           | 第 n 个实体模型的颜色                        | 高     |

当前只确认字段角色，不解析矩阵语义，不进行几何渲染。

### 4.2 线路工程 PHM

两个线路样本的 PHM 字段分布对比如下。

| 字段               | demo-line 数量 | demo-line1 数量 | 观察                           |
| ------------------ | -------------: | --------------: | ------------------------------ |
| `SOLIDMODELS.NUM`  |           1836 |             563 | 每个 PHM 均有实体模型数量      |
| `SOLIDMODEL0`      |           1836 |             563 | 每个 PHM 至少引用 1 个实体模型 |
| `TRANSFORMMATRIX0` |           1836 |             563 | 每个 PHM 至少有 1 个变换矩阵   |
| `COLOR0`           |           1836 |             563 | 每个 PHM 至少有 1 个颜色字段   |
| `SOLIDMODEL1`      |           1300 |             156 | 部分 PHM 引用第 2 个实体模型   |
| `TRANSFORMMATRIX1` |           1300 |             156 | 第 2 个实体模型对应变换矩阵    |
| `COLOR1`           |           1300 |             156 | 第 2 个实体模型对应颜色        |
| `SOLIDMODEL2+`     |              0 |               0 | 线路 PHM 最多引用 2 个实体模型 |

典型引用样例如下。

引用 `.mod` 的组合：

```text
SOLIDMODELS.NUM=2
SOLIDMODEL0=7c6cf87e-9d8c-443f-af96-ad0f81d83291.mod
SOLIDMODEL1=66d18b7e-0a1c-456a-b150-8d3d09288d24.mod
```

引用 `.stl` 的单体：

```text
SOLIDMODELS.NUM=1
SOLIDMODEL0=83ebec7e-7e02-4154-9807-1c59d7f7af45.stl
```

两个线路样本的 PHM 稳定承担组合模型引用角色，大部分引用 1~2 个实体模型，目标可以是 `.mod` 或 `.stl`。demo-line1 的 PHM 数量（563）与 demo-line1 中引用 PHM 的 DEV 文件数（563）完全一致，说明每个引用 PHM 的 DEV 对应唯一一个 PHM。

### 4.3 变电工程 PHM

变电 PHM 共 4179 个。

| 字段               | 数量 | 观察                                |
| ------------------ | ---: | ----------------------------------- |
| `SOLIDMODELS.NUM`  | 4179 | 每个 PHM 均有实体模型数量           |
| `SOLIDMODEL0`      | 4165 | 绝大多数 PHM 至少引用 1 个实体模型  |
| `TRANSFORMMATRIX0` | 4165 | 绝大多数 PHM 至少有 1 个变换矩阵    |
| `COLOR0`           | 4165 | 绝大多数 PHM 至少有 1 个颜色字段    |
| `SOLIDMODEL1`      |   86 | 少量 PHM 引用第 2 个实体模型        |
| `SOLIDMODEL2+`     | 少量 | 部分 PHM 是多实体组合模型           |
| `SOLIDMODEL16`     |   38 | 少量复杂 PHM 至少包含 17 个实体模型 |

普通 PHM 通常引用单个 `.mod`：

```text
SOLIDMODELS.NUM=1
SOLIDMODEL0=f0da98cf-841b-4a14-937c-56d9b1e08303.mod
```

复杂 PHM 可同时引用 `.mod` 和多个 `.stl`：

```text
SOLIDMODELS.NUM=17
SOLIDMODEL0=8ae3ef56-4616-4570-95a5-2464124788f9.mod
SOLIDMODEL1=1b09376b-7b7c-4ba1-80a9-6edfe52ea6c6.stl
SOLIDMODEL2=a30a6c55-0c28-4e24-9c07-fa35da9adeeb.stl
...
SOLIDMODEL16=aff58f93-a3bb-4b95-befe-3d16a6b5e89a.stl
```

变电 PHM 同样稳定承担 `PHM → MOD/STL` 的组合模型引用角色。以单实体 `.mod` 引用为主，少量复杂 PHM 组合 1 个 `.mod` 与多个 `.stl`。`TRANSFORMMATRIXn` 与 `COLORn` 和 `SOLIDMODELn` 成组出现。当前变电 3D 查看已有 IFC 主路径，PHM/MOD/STL 暂不进入渲染实现。

### 4.4 PHM → MOD/STL 引用完整性

| 样本            | 引用类型 | 引用数 | 缺失 |
| --------------- | -------- | -----: | ---: |
| demo-line       | PHM→MOD  |   2955 |    0 |
| demo-line       | PHM→STL  |    181 |    0 |
| demo-line1      | PHM→MOD  |    637 |    0 |
| demo-line1      | PHM→STL  |     82 |    0 |
| demo-substation | PHM→MOD  |   4135 |    0 |
| demo-substation | PHM→STL  |   1803 |    0 |

三个样本的 PHM→MOD/STL 引用完整性均为 100%。`SOLIDMODELn` 指向的 `.mod` 和 `.stl` 文件全部存在。

---

## 5. 跨层引用链汇总

### 5.1 完整跨层汇总

| 来源 | 目标 | 线路（demo-line） | 线路（demo-line1） | 变电（demo-substation） | 缺失 |
| ---- | ---- | ----------------: | -----------------: | ----------------------: | ---: |
| CBM  | CBM  |             38859 |               7052 |                   13344 |    0 |
| CBM  | DEV  |             21857 |               3900 |                    4179 |    0 |
| CBM  | FAM  |             21967 |               3925 |                    9134 |    0 |
| CBM  | IFC  |                 0 |                  0 |                    4384 |    0 |
| DEV  | PHM  |              1836 |                563 |                    4179 |    0 |
| DEV  | DEV  |            138622 |              42021 |                    3894 |    0 |
| PHM  | MOD  |              2955 |                637 |                    4135 |    0 |
| PHM  | STL  |               181 |                 82 |                    1803 |    0 |

> **DEV → DEV 引用数说明**：两个线路样本通过 `SOLIDMODELn=*.dev` 引用子 DEV（demo-line 138622 条、demo-line1 42021 条，均集中在 `DEVICETYPE=STRING` 文件中），变电样本通过 `SUBDEVICEn=*.dev` 引用子 DEV（3894 条，集中在 258 个含 SUBDEVICES 的 DEV 文件中）。两类工程的 DEV→DEV 引用机制不同但完整性均为 100%。

### 5.2 统一引用链图

基于当前三个 demo，CBM 层向下游的引用链如下：

```text
CBM
 ├─ SUBSYSTEMn / SECTIONn / STRAINSECTIONn / GROUPn / TOWERn / BASEn / STRINGn.STRING
 │   └─ → CBM （CBM 层级递归，仅 SUBDEVICEn 是 F4System 内部分组，不是主层级）
 ├─ BACKSTRING / FRONTSTRING
 │   └─ → CBM （线路 WIRE → 耐张段塔位引用）
 ├─ FILE.N.DEVn
 │   └─ → CBM （变电 FileDevRelation.cbm 反向索引表专用）
 ├─ OBJECTMODELPOINTER
 │   └─ → DEV
 │       ├─ SOLIDMODELn → PHM
 │       │   └─ SOLIDMODELn → MOD/STL
 │       └─ SOLIDMODELn / SUBDEVICEn → DEV （子模型/子设备组合）
 ├─ BASEFAMILY / BASEFAMILY1..N
 │   └─ → FAM （BASEFAMILY1..N 仅变电 F3System 使用）
 └─ IFCFILE + IFCGUID
     └─ → IFC （仅变电样本存在，IFCGUID 命中率约 75%）
```

其中：

- `CBM → CBM`：通过 `SUBSYSTEMn`（变电）或 `SECTIONn` / `STRAINSECTIONn` / `GROUPn` / `TOWERn` / `BASEn` / `STRINGn.STRING` / `BACKSTRING` / `FRONTSTRING`（线路）建立主层级递归；通过 `SUBDEVICEn` 实现 F4System 内部子设备分组（不是主层级）。
- `CBM → DEV`：通过 `OBJECTMODELPOINTER=*.dev` 建立，已校验。
- `CBM → FAM`：通过 `BASEFAMILY=*.fam` 或 `BASEFAMILY1..N=*.fam`（变电 F3System 多 FAM）建立，已校验。
- `CBM → IFC`：通过 `IFCFILE + IFCGUID` 建立，文件存在性 100%，但 IFCGUID 内部命中率约 75%（仅变电样本存在）。
- `DEV → PHM`：通过 `SOLIDMODELn=*.phm` 建立，已校验。
- `DEV → DEV`：线路样本通过 `SOLIDMODELn=*.dev`，变电样本通过 `SUBDEVICEn=*.dev`。
- `PHM → MOD/STL`：通过 `SOLIDMODELn=*.mod/*.stl` 建立，已校验。
- `MOD/STL`：作为底层几何资源，不进入当前 MVP 解析。

两类工程的 DEV 下游链路存在差异：

```text
demo-line / demo-line1:  DEV → PHM → MOD/STL
                          DEV → DEV → ...

demo-substation:          DEV → PHM → MOD/STL
                          DEV → SUBDEVICE → DEV → ...
```

---

## 6. 当前结论

三个 demo 的 CBM、DEV、PHM 三层文件级引用完整性均为 **100%**。所有引用字段（含原版本遗漏的线路 `FRONTSTRING` / `BACKSTRING` / `STRINGn.STRING` / `GROUPn` / `BASEn` / `TOWERn` / `STRAINSECTIONn` / `SECTIONn`，以及变电 `FileDevRelation.cbm` 的 `FILE.N.DEVn`）指向的目标文件均存在。

DEV/PHM 两层未发现超出当前预期的引用类型。两类工程的 DEV 引用模式存在差异——线路使用 `SOLIDMODELn=*.dev` 实现 DEV 组合，变电使用 `SUBDEVICEn=*.dev` 实现子设备组合——但在三个样本内引用完整性均为 100%。

IFCGUID → IFC 的文本命中校验存在约 25% 的硬未命中，集中在 F4System 节点，主要由两个高频 GUID 驱动。后续实现中应将 IFCGUID 视为可选定位能力，采用容错策略处理。

---

## 7. 尚未完成的校验

| 校验项                      | 状态                                           |
| --------------------------- | ---------------------------------------------- |
| CBM → CBM/DEV/FAM/IFC       | 已完成（含线路层级字段与变电 FileDevRelation） |
| DEV → PHM                   | 已完成                                         |
| DEV → DEV                   | 已完成                                         |
| PHM → MOD/STL               | 已完成                                         |
| IFCGUID → IFC 内部构件      | 已完成文本命中校验，存在硬未命中分型           |
| FAM 与 CBM/DEV 的字段一致性 | 已分析，详见 `06-cbm-fam-consistency.md`        |

当前不进入 MOD/STL 几何解析，不展开 IFC 构件属性分析。

---

## 附录 A：诊断脚本

以下 PowerShell 脚本用于 CBM / PHM / DEV 的字段探测与引用分析，保留为分析过程记录。

### A.1 CBM 引用字段全量统计（按扩展名 + 按字段分组）

```powershell
$ErrorActionPreference='SilentlyContinue'

foreach ($sample in @('demo-line','demo-line1','demo-substation')) {
  $cbmDir = "D:\vibe-coding\gim_viewer\demo\$sample\CBM"
  if (-not (Test-Path $cbmDir)) { continue }
  $cbmFiles = Get-ChildItem $cbmDir -Filter *.cbm -File
  $fieldCounts = @{}
  foreach ($f in $cbmFiles) {
    $content = Get-Content $f.FullName -ErrorAction SilentlyContinue
    if (-not $content) { continue }
    foreach ($line in $content) {
      if ($line -match '^\s*([^=]+\.NUM)\s*=') { continue }
      if ($line -match '^\s*([^=]+)=([^=]*)$') {
        $key = $Matches[1].Trim()
        $val = $Matches[2].Trim()
        if ($val -match '\.cbm$') {
          $normKey = $key -replace '\d+', 'N'
          if (-not $fieldCounts.ContainsKey($normKey)) { $fieldCounts[$normKey] = 0 }
          $fieldCounts[$normKey]++
        }
      }
    }
  }
  Write-Host "=== $sample fields with *.cbm values (grouped) ==="
  $total = 0
  $fieldCounts.GetEnumerator() | Sort-Object Value -Descending | ForEach-Object {
    Write-Host ("  {0,-35} {1}" -f $_.Key, $_.Value)
    $total += $_.Value
  }
  Write-Host ("  TOTAL: {0}" -f $total)
}
```

### A.2 PHM 字段扫描

```powershell
function Export-KeySurvey {
  param([string]$Root, [string]$Sample, [string]$Pattern, [string]$Output)
  Get-ChildItem $Root -Recurse -File -Filter $Pattern |
    ForEach-Object {
      $file = $_
      $rel = $file.FullName.Replace((Resolve-Path $Root).Path + "\", "")
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
      } catch {}
    } |
    Export-Csv $Output -NoTypeInformation -Encoding UTF8
}

Export-KeySurvey ".\demo\demo-line\Phm" "demo-line" "*.phm" ".\docs\schema\_generated\demo-line-phm-key-survey.csv"
Export-KeySurvey ".\demo\demo-substation\PHM" "demo-substation" "*.phm" ".\docs\schema\_generated\demo-substation-phm-key-survey.csv"
```

### A.3 DEV 引用探测

```powershell
Select-String -Path ".\demo\demo-line\Dev\*.dev" -Pattern "PHM|MODEL|POINTER|\.phm|\.dev" -CaseSensitive:$false |
  Select-Object -First 80 Path, LineNumber, Line |
  Format-Table -AutoSize

Select-String -Path ".\demo\demo-substation\DEV\*.dev" -Pattern "PHM|MODEL|POINTER|\.phm|\.dev" -CaseSensitive:$false |
  Select-Object -First 80 Path, LineNumber, Line |
  Format-Table -AutoSize
```
