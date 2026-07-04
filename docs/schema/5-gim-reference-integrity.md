# GIM 引用完整性

目标：确认 CBM/DEV/PHM 层引用是否闭合。

## 1. 范围与方法

### 校验范围

当前覆盖 3 个 demo 的 GIM 文件：

- `demo-line`、`demo-line1`（线路工程）
- `demo-substation`（变电工程）

校验层次为 CBM、DEV、PHM 三层的文件级引用目标是否存在。不递归展开完整模型树，不解析 PHM / MOD / STL 几何。

### CBM 层校验字段

| 字段                 | 引用目标 | 说明                  |
| -------------------- | -------- | --------------------- |
| `SUBDEVICEn`         | `.cbm`   | CBM 指向子 CBM 节点   |
| `OBJECTMODELPOINTER` | `.dev`   | CBM 指向 DEV 物理模型 |
| `IFCFILE`            | `.ifc`   | CBM 指向 IFC 文件     |
| `BASEFAMILY`         | `.fam`   | CBM 指向 FAM 属性文件 |

### 校验方法

1. 扫描样本目录下所有文件，建立文件名索引。
2. 扫描所有 `.cbm` 文件。
3. 提取以上 4 个引用字段。
4. 使用大小写不敏感的文件名匹配，判断引用目标是否存在。
5. 输出引用明细 CSV 和汇总统计。

当前生成文件：

```text
docs/schema/_generated/demo-line-cbm-integrity.csv
docs/schema/_generated/demo-substation-cbm-integrity.csv
```

`_generated` 目录为临时分析输出，不进入版本管理。

---

## 2. CBM 层

### 2.1 线路工程

| 指标     |  line | line1 |
| -------- | ----: | ----: |
| 引用总数 | 61376 | 14877 |
| 成功引用 | 61376 | 14877 |
| 缺失引用 |     0 |     0 |
| CBM 引用 | 17552 |  7052 |
| DEV 引用 | 21857 |  3900 |
| FAM 引用 | 21967 |  3925 |
| IFC 引用 |     0 |     0 |
| 缺失 CBM |     0 |     0 |
| 缺失 DEV |     0 |     0 |
| 缺失 FAM |     0 |     0 |
| 缺失 IFC |     0 |     0 |

按引用目标类型分布：

| 目标类型 |  line | line1 |
| -------- | ----: | ----: |
| CBM      | 17552 |  7052 |
| DEV      | 21857 |  3900 |
| FAM      | 21967 |  3925 |

CBM 层所有引用均可解析到实际文件，两个样本均无缺失引用，且未发现 IFC 引用。

### 2.2 变电工程

| 指标     |  数量 |
| -------- | ----: |
| 引用总数 | 20987 |
| 成功引用 | 20987 |
| 缺失引用 |     0 |
| CBM 引用 |  3894 |
| DEV 引用 |  4179 |
| IFC 引用 |  4360 |
| FAM 引用 |  8554 |
| 缺失 CBM |     0 |
| 缺失 DEV |     0 |
| 缺失 IFC |     0 |
| 缺失 FAM |     0 |

按引用目标类型分布：

| 目标类型 | 数量 |
| -------- | ---: |
| CBM      | 3894 |
| DEV      | 4179 |
| IFC      | 4360 |
| FAM      | 8554 |

CBM 层所有引用均可解析到实际文件，包括 IFC 引用（线路样本中不存在的引用类型）。

### 2.3 IFCGUID → IFC 内部命中校验

CBM 通过 `IFCFILE + IFCGUID` 指向 IFC 内部构件。本节校验这些 GUID 是否能在对应 IFC 文件文本中命中（仅文本级匹配，不解析 IFC 语义）。

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

### 字段结构

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

### 全量统计

| 样本            | DEV 总数 | 引用 PHM | SOLIDMODEL 引用 DEV | 存在 SUBDEVICE | PHM + SUBDEVICE 混合 | 其他 SOLIDMODEL 目标 |
| --------------- | -------: | -------: | ------------------: | -------------: | -------------------: | -------------------: |
| demo-line       |     4518 |     1836 |                2682 |              0 |                    0 |                    0 |
| demo-substation |     4179 |     4179 |                   0 |            258 |                  258 |                    0 |

关键发现：

- demo-line 中，DEV 分为两类：一类直接引用 PHM（1836），一类通过 `SOLIDMODELn` 引用其他 DEV（2682）。二者不混合。
- demo-line 中未发现 `SUBDEVICEn` 字段。
- demo-substation 中，所有 DEV 都直接引用 PHM（4179），258 个 DEV 同时存在 `SUBDEVICEn=*.dev`。
- demo-substation 中未发现 `SOLIDMODELn=*.dev`。
- 两个 demo 中均未发现 `.phm` / `.dev` 之外的 `SOLIDMODELn` 目标。

### 线路工程 DEV

两类引用模式：

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

### 变电工程 DEV

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

### DEV → DEV / SUBDEVICE 引用完整性

| 样本            | 引用类型         | 引用数 | 缺失 |
| --------------- | ---------------- | -----: | ---: |
| demo-line       | SOLIDMODEL → DEV |   2682 |    0 |
| demo-substation | SUBDEVICE → DEV  |   3894 |    0 |

线路样本通过 `SOLIDMODELn=*.dev` 引用子 DEV（无 SUBDEVICE 字段），变电样本通过 `SUBDEVICEn=*.dev` 引用子 DEV（无 SOLIDMODEL→DEV）。两个样本的 DEV 内部引用完整性均为 100%。

### DEV → PHM 引用完整性

| 样本            | DEV→PHM 引用数 | 缺失 |
| --------------- | -------------: | ---: |
| demo-line       |           1836 |    0 |
| demo-substation |           4179 |    0 |

两个样本的 DEV→PHM 引用完整性均为 100%。

---

## 4. PHM 层

### 字段结构

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

### 线路工程 PHM

线路 PHM 共 1836 个。

| 字段               | 数量 | 观察                           |
| ------------------ | ---: | ------------------------------ |
| `SOLIDMODELS.NUM`  | 1836 | 每个 PHM 均有实体模型数量      |
| `SOLIDMODEL0`      | 1836 | 每个 PHM 至少引用 1 个实体模型 |
| `TRANSFORMMATRIX0` | 1836 | 每个 PHM 至少有 1 个变换矩阵   |
| `COLOR0`           | 1836 | 每个 PHM 至少有 1 个颜色字段   |
| `SOLIDMODEL1`      | 1300 | 部分 PHM 引用第 2 个实体模型   |
| `TRANSFORMMATRIX1` | 1300 | 第 2 个实体模型对应变换矩阵    |
| `COLOR1`           | 1300 | 第 2 个实体模型对应颜色        |

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

线路 PHM 稳定承担组合模型引用角色，大部分引用 1~2 个实体模型，目标可以是 `.mod` 或 `.stl`。

### 变电工程 PHM

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

### PHM → MOD/STL 引用完整性

| 样本            | 引用类型 | 引用数 | 缺失 |
| --------------- | -------- | -----: | ---: |
| demo-line       | PHM→MOD  |   2955 |    0 |
| demo-line       | PHM→STL  |    181 |    0 |
| demo-substation | PHM→MOD  |   4135 |    0 |
| demo-substation | PHM→STL  |   1803 |    0 |

两个样本的 PHM→MOD/STL 引用完整性均为 100%。`SOLIDMODELn` 指向的 `.mod` 和 `.stl` 文件全部存在。

---

## 5. 跨层引用链图

| 来源 | 目标 | 线路数量 | 变电数量 | 缺失 |
| ---- | ---- | -------: | -------: | ---: |
| DEV  | PHM  |     1836 |     4179 |    0 |
| DEV  | DEV  |     2682 |     3894 |    0 |
| PHM  | MOD  |     2955 |     4135 |    0 |
| PHM  | STL  |      181 |     1803 |    0 |

基于当前两个 demo，CBM 层向下游的三条引用链如下：

```text
CBM
 ├─ OBJECTMODELPOINTER → DEV
 │   ├─ SOLIDMODEL → PHM
 │   │   └─ SOLIDMODEL → MOD/STL
 │   └─ SOLIDMODEL/SUBDEVICE → DEV
 ├─ BASEFAMILY → FAM
 ├─ SUBDEVICE → CBM
 └─ IFCFILE + IFCGUID → IFC
```

其中：

- `CBM → DEV`：通过 `OBJECTMODELPOINTER=*.dev` 建立，已校验。
- `CBM → FAM`：通过 `BASEFAMILY=*.fam` 建立，已校验。
- `CBM → CBM`：通过 `SUBDEVICEn=*.cbm` 建立递归层级，已校验。
- `CBM → IFC`：通过 `IFCFILE + IFCGUID` 建立，文件存在性 100%，但 IFCGUID 内部命中率约 75%（仅变电样本存在）。
- `DEV → PHM`：通过 `SOLIDMODELn=*.phm` 建立，已校验。
- `DEV → DEV`：线路样本通过 `SOLIDMODELn=*.dev`，变电样本通过 `SUBDEVICEn=*.dev`。
- `PHM → MOD/STL`：通过 `SOLIDMODELn=*.mod/*.stl` 建立，已校验。
- `MOD/STL`：作为底层几何资源，不进入当前 MVP 解析。

两个样本的 DEV 下游链路存在差异：

```text
demo-line:         DEV → PHM → MOD/STL
                   DEV → DEV → ...

demo-substation:   DEV → PHM → MOD/STL
                   DEV → SUBDEVICE → DEV → ...
```

---

## 6. 当前结论

两个 demo 的 CBM、DEV、PHM 三层文件级引用完整性均为 **100%**。所有 `OBJECTMODELPOINTER`、`BASEFAMILY`、`SUBDEVICEn`、`IFCFILE`、`SOLIDMODELn` 指向的目标文件均存在。

DEV/PHM 两层未发现超出当前预期的引用类型。两个样本的 DEV 引用模式存在差异——线路使用 `SOLIDMODELn=*.dev` 实现 DEV 组合，变电使用 `SUBDEVICEn=*.dev` 实现子设备组合——但在各自样本内引用完整性均为 100%。

IFCGUID → IFC 的文本命中校验存在约 25% 的硬未命中，集中在 F4System 节点，主要由两个高频 GUID 驱动。后续实现中应将 IFCGUID 视为可选定位能力，采用容错策略处理。

---

## 7. 尚未完成的校验

| 校验项                      | 状态                                 |
| --------------------------- | ------------------------------------ |
| CBM → DEV/FAM/CBM/IFC       | 已完成                               |
| DEV → PHM                   | 已完成                               |
| DEV → DEV                   | 已完成                               |
| PHM → MOD/STL               | 已完成                               |
| IFCGUID → IFC 内部构件      | 已完成文本命中校验，存在硬未命中分型 |
| FAM 与 CBM/DEV 的字段一致性 | 待分析                               |

当前不进入 MOD/STL 几何解析，不展开 IFC 构件属性分析。

---

## 附录 A：诊断脚本

以下 PowerShell 脚本用于 PHM 和 DEV 的字段探测与引用分析，保留为分析过程记录。

### PHM 字段扫描

```powershell
cd D:\vibe-coding\gim_viewer

function Export-KeySurvey {
  param(
    [string]$Root,
    [string]$Sample,
    [string]$Pattern,
    [string]$Output
  )

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
      } catch {
      }
    } |
    Export-Csv $Output -NoTypeInformation -Encoding UTF8
}

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

### DEV 引用探测

```powershell
Select-String -Path ".\demo\demo-line\Dev\*.dev" -Pattern "PHM|MODEL|POINTER|\.phm|\.dev" -CaseSensitive:$false |
  Select-Object -First 80 Path, LineNumber, Line |
  Format-Table -AutoSize

Select-String -Path ".\demo\demo-substation\DEV\*.dev" -Pattern "PHM|MODEL|POINTER|\.phm|\.dev" -CaseSensitive:$false |
  Select-Object -First 80 Path, LineNumber, Line |
  Format-Table -AutoSize
```
