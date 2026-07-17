# CBM 文件格式

## 文件概述

CBM（Component/Composition Building Model）文件是 GIM 工程的核心索引文件，采用键值对文本格式（非 XML），每行一个键值对，格式为 `KEY=VALUE`。CBM 文件构成了 GIM 工程的层级树状结构，从工程入口到子系统、设备逐级引用。

CBM 文件有三种主要用途：

| 类型                    | 说明                                                           |
| ----------------------- | -------------------------------------------------------------- |
| **project.cbm**         | 工程入口文件，定义顶层子系统引用；变电样本还直接给出工程地理坐标、SCH 和 TYPE |
| **普通 \*.cbm**         | 层级模型文件，描述子系统/部件的组成结构                        |
| **FileDevRelation.cbm** | 文件-设备关系文件，描述 IFC 文件与设备的对应关系（仅变电工程） |

## 文件格式

- **编码**：UTF-8
- **行分隔符**：换行符
- **键值分隔符**：`=`
- **注释**：无标准注释语法
- **键名约定**：键名大小写不敏感，常见大小写混用（如 `SUBSYSTEMS.NUM` 与 `subsystem.num` 视为同一字段）

## 工程类型与字段差异

GIM 工程分为**变电工程**与**线路工程**两种类型。两者在 CBM 字段使用上存在显著差异，主要表现在层级递归字段、F4System 业务分支和设备分类字段。

| 工程类型 | GIMPKG 魔数 | 主层级字段                               | 叶子节点类型                                | IFC 引用 |
| -------- | ----------- | ---------------------------------------- | ------------------------------------------- | -------- |
| 变电     | `GIMPKGS`   | `SUBSYSTEMS`（F1/F2/F3 共用）            | `PARTINDEX`                                 | 有       |
| 线路     | `GIMPKGT`   | `SECTIONS` → `STRAINSECTIONS` → `GROUPS` | `Tower_Device`/`Wire_Device`/`WIRE`/`CROSS` | 无       |

---

## 通用字段

以下字段在变电工程与线路工程中均出现，语义一致：

| 字段                 | 格式                    | 说明                                         |
| -------------------- | ----------------------- | -------------------------------------------- |
| `ENTITYNAME`         | `<名称>`                | 实体名称，标识 CBM 在层级中的角色            |
| `BASEFAMILY`         | `<uuid>.fam`            | 单值 FAM 属性文件引用                        |
| `OBJECTMODELPOINTER` | `<uuid>.dev`            | DEV 物理模型引用（设备级叶子节点必备）       |
| `TRANSFORMMATRIX`    | 16 个浮点数（4×4 矩阵） | 设备局部坐标系到全局坐标系的变换矩阵         |
| `BLHA`               | `纬度,经度,海拔,方向角` | 工程地理坐标（杆塔/导线/工程入口均可能出现） |
| `MATERIALSHEET`      | （通常为空）            | 材料表占位                                   |
| `PARTNAME`           | `<名称>`                | 部件名称（如 `&其他`，仅 PARTINDEX 类型）    |

### project.cbm（工程入口）

| 字段        | 格式               | 说明                                             |
| ----------- | ------------------ | ------------------------------------------------ |
| `BLHA`      | `纬度,经度,海拔,0` | 工程地理坐标，第四个值固定为 0（仅变电工程出现） |
| `SUBSYSTEM` | `<uuid>.cbm`       | 引用一级子系统 CBM 文件（单值，变电/线路均使用） |
| `SCH`       | `project.sch`      | 引用逻辑模型索引文件（仅变电工程出现）           |
| `TYPE`      | `TS` 等            | 工程类型，`TS` 表示变电站（仅变电工程出现）      |

### FileDevRelation.cbm（文件-设备关系，仅变电）

| 字段                    | 格式         | 说明                                     |
| ----------------------- | ------------ | ---------------------------------------- |
| `FILE.NUM`              | `<N>`        | IFC 文件数量                             |
| `FILE<i>.NAME`          | `<名称>`     | 第 i 个 IFC 文件名称（不含 `.ifc` 后缀） |
| `FILE<i>.DEV.NUM`       | `<N>`        | 第 i 个文件包含的设备数量                |
| `FILE<i>.DEV0` ~ `DEVN` | `<uuid>.cbm` | 第 i 个文件包含的设备 CBM 引用           |

---

## 变电工程专用字段

### 层级字段

| ENTITYNAME  | 层级字段                           | 子节点 ENTITYNAME | 备注                               |
| ----------- | ---------------------------------- | ----------------- | ---------------------------------- |
| `F1System`  | `SUBSYSTEMS.NUM` + `SUBSYSTEM0..N` | `F2System`        | project.cbm 入口下的一级子系统     |
| `F2System`  | `SUBSYSTEMS.NUM` + `SUBSYSTEM0..N` | `F3System`        | 二级子系统                         |
| `F3System`  | `SUBSYSTEMS.NUM` + `SUBSYSTEM0..N` | `F4System`        | 三级子系统                         |
| `F4System`  | `SUBDEVICES.NUM` + `SUBDEVICE0..N` | `PARTINDEX`       | 设备级 CBM，子节点为 PARTINDEX     |
| `PARTINDEX` | （叶子节点）                       | -                 | 通过 `OBJECTMODELPOINTER` 指向 DEV |

### 设备分类字段

| 字段              | 格式       | 说明                                            |
| ----------------- | ---------- | ----------------------------------------------- |
| `SYSCLASSIFYNAME` | `<分类码>` | 设备分类码（如 `0AFD*002`、`GSK*010`、`&其他`） |
| `SYSTEMNAME1..4`  | `<名称>`   | 系统层级名称（如 `交流电气系统`、`110kV系统`）  |

### IFC 引用字段

| 字段                  | 出现位置 | 格式                     | 说明                                     |
| --------------------- | -------- | ------------------------ | ---------------------------------------- |
| `IFC.NUM` + `IFC0..N` | F1System | `<N>` + `<filename.ifc>` | 工程级 IFC 文件清单（多个 IFC 文件列表） |
| `IFCFILE`             | F4System | `<filename.ifc>`         | 单值 IFC 文件引用                        |
| `IFCGUID`             | F4System | `<GUID>`                 | 与 `IFCFILE` 配对的 IFC 构件 GUID        |

### 多值 FAM 引用

变电工程部分 F3System/F4System 携带多个 FAM 引用：

| 字段                          | 格式         | 说明                  |
| ----------------------------- | ------------ | --------------------- |
| `BASEFAMILY1` ~ `BASEFAMILYN` | `<uuid>.fam` | 多个 FAM 属性文件引用 |

### 变电 F4System 角色

变电 F4System 通过 `OBJECTMODELPOINTER` / `IFCFILE` / `SUBDEVICES.NUM` 三组字段非空组合形成三种角色：

| 角色                 | `OBJECTMODELPOINTER` | `IFCFILE` | `SUBDEVICES.NUM` | 备注                      |
| -------------------- | -------------------- | --------- | ---------------- | ------------------------- |
| 设备入口（含子设备） | 非空                 | 空        | >0               | 引用 DEV 并包含子设备分组 |
| IFC 构件入口         | 空                   | 非空      | 通常为 0         | 关联 IFC 构件             |
| 容器节点             | 空                   | 空        | 通常为 0         | 仅作层级容器（罕见）      |

`PARTINDEX`（叶子节点）始终携带 `OBJECTMODELPOINTER`，不携带 `IFCFILE`。

---

## 线路工程专用字段

### 层级字段

| ENTITYNAME | 层级字段                                   | 子节点 ENTITYNAME                           | 备注                               |
| ---------- | ------------------------------------------ | ------------------------------------------- | ---------------------------------- |
| `F1System` | `SECTIONS.NUM` + `SECTION0..N`             | `F2System`                                  | 一级标段                           |
| `F2System` | `STRAINSECTIONS.NUM` + `STRAINSECTION0..N` | `F3System`                                  | 耐张段层级                         |
| `F3System` | `GROUPS.NUM` + `GROUP0..N`                 | `F4System`                                  | 分组层级                           |
| `F4System` | 见下表（按 GROUPTYPE 分支）                | `Tower_Device`/`Wire_Device`/`WIRE`/`CROSS` | 杆塔/导线/地线/跨越分组            |
| 叶子节点   | （无）                                     | -                                           | 通过 `OBJECTMODELPOINTER` 指向 DEV |

### 线路 F4System 业务分支

线路 F4System 通过 `GROUPTYPE` 区分三种业务分组，分别使用不同引用字段：

| GROUPTYPE | 引用字段                                                                                                | 子节点 ENTITYNAME      | 备注                                |
| --------- | ------------------------------------------------------------------------------------------------------- | ---------------------- | ----------------------------------- |
| `TOWER`   | `TOWERS.NUM` + `TOWER0..N`、`STRINGS.NUM` + `STRINGn.STRING`/`STRINGn.GPOINT`、`BASES.NUM` + `BASE0..N` | `Tower_Device`         | 杆塔分组，含塔位/导线串/基础        |
| `WIRE`    | `BACKSTRING` + `FRONTSTRING` + `SUBDEVICES.NUM` + `SUBDEVICE0..N`                                       | `Wire_Device` / `WIRE` | 导线/地线分组，含前后耐张串与子导线 |
| `CROSS`   | `SUBDEVICES.NUM` + `SUBDEVICE0..N`                                                                      | `CROSS`                | 跨越分组                            |

### 线路业务字段

| 字段                       | 出现位置         | 格式                            | 说明                                              |
| -------------------------- | ---------------- | ------------------------------- | ------------------------------------------------- |
| `GROUPTYPE`                | F4System         | `TOWER`/`WIRE`/`CROSS`          | F4System 业务分组类型                             |
| `TOWERS.NUM` + `TOWER0..N` | F4System (TOWER) | `<N>` + `<uuid>.cbm`            | 杆塔设备引用列表                                  |
| `MODLEG`                   | F4System (TOWER) | `0.000,0.000,0.000,0.000`       | 杆塔腿部偏移（4 个浮点数）                        |
| `BASES.NUM` + `BASE0..N`   | F4System (TOWER) | `<N>` + `<uuid>.cbm`            | 基础引用列表                                      |
| `WIRETYPE`                 | F4System (WIRE)  | `CONDUCTOR`/`OPGW`/`GROUNDWIRE` | 导线/光缆/地线类型                                |
| `ISJUMPER`                 | F4System (WIRE)  | `0`/`1`                         | 是否为跳线                                        |
| `BACKSTRING`               | F4System (WIRE)  | `<uuid>.cbm`                    | 后侧耐张串 CBM 引用                               |
| `FRONTSTRING`              | F4System (WIRE)  | `<uuid>.cbm`                    | 前侧耐张串 CBM 引用                               |
| `STRINGS.NUM`              | F4System (TOWER) | `<N>`                           | 导线/地线串数量                                   |
| `STRINGn.STRING`           | F4System (TOWER) | `<uuid>.cbm`                    | 第 n 个导线/地线串 CBM 引用                       |
| `STRINGn.GPOINT`           | F4System (TOWER) | `<挂点描述>`                    | 第 n 个导线串的挂点信息（如 `后导1_S1/后导1_S2`） |

### 线路导线几何字段（仅 WIRE 实体）

线路 `WIRE` 实体（导线/地线/OPGW）携带几何与张力参数：

| 字段             | 格式                    | 说明         |
| ---------------- | ----------------------- | ------------ |
| `KVALUE`         | `<浮点数>`              | 弧垂系数     |
| `SPLIT`          | `<整数>`                | 导线分裂数   |
| `POINT0.BLHA`    | `纬度,经度,海拔,方向角` | 起点地理坐标 |
| `POINT0.MATRIX0` | 16 个浮点数（4×4 矩阵） | 起点变换矩阵 |
| `POINT1.BLHA`    | `纬度,经度,海拔,方向角` | 终点地理坐标 |
| `POINT1.MATRIX0` | 16 个浮点数（4×4 矩阵） | 终点变换矩阵 |

---

## 引用关系

### 变电工程引用关系

```text
project.cbm
├── <uuid>.cbm                          → 一级子系统 (F1System)
│   ├── BASEFAMILY                      → 属性文件
│   ├── SUBSYSTEMS.NUM + SUBSYSTEM0..N  → 二级子系统 (F2System)
│   │   ├── BASEFAMILY
│   │   ├── SUBSYSTEMS.NUM + SUBSYSTEM0..N → 三级子系统 (F3System)
│   │   │   ├── BASEFAMILY1..N          → 多个属性文件
│   │   │   ├── SYSCLASSIFYNAME/SYSTEMNAME1..4
│   │   │   └── SUBSYSTEMS.NUM + SUBSYSTEM0..N → 设备级 (F4System)
│   │   │       ├── BASEFAMILY
│   │   │       ├── OBJECTMODELPOINTER  → DEV 物理模型（设备入口）
│   │   │       ├── IFCFILE + IFCGUID   → IFC 构件（IFC 入口）
│   │   │       ├── SUBDEVICES.NUM + SUBDEVICE0..N → 子设备 CBM
│   │   │       │   └── PARTINDEX
│   │   │       │       └── OBJECTMODELPOINTER → DEV
│   │   │       └── TRANSFORMMATRIX
│   ├── IFC.NUM + IFC0..N              → 工程级 IFC 文件清单
│   └── ...
├── project.sch                         → 逻辑模型索引
└── FileDevRelation.cbm                 → 文件-设备关系
    └── FILE<i>.DEV0..N                → 设备 CBM
```

### 线路工程引用关系

```text
project.cbm
└── SUBSYSTEM                          → 一级标段 (F1System)
    ├── BASEFAMILY                     → 属性文件
    ├── SECTIONS.NUM + SECTION0..N     → 二级标段 (F2System)
    │   ├── BASEFAMILY
    │   ├── STRAINSECTIONS.NUM + STRAINSECTION0..N → 三级耐张段 (F3System)
    │   │   ├── BASEFAMILY
    │   │   ├── GROUPS.NUM + GROUP0..N → F4System 分组
    │   │   │   │
    │   │   │   ├── [GROUPTYPE=TOWER]
    │   │   │   │   ├── TOWERS.NUM + TOWER0..N     → Tower_Device
    │   │   │   │   │   └── OBJECTMODELPOINTER     → DEV
    │   │   │   │   ├── STRINGS.NUM + STRINGn.STRING → WIRE 实体
    │   │   │   │   │   └── POINTn.BLHA/MATRIX0     → 导线几何
    │   │   │   │   └── BASES.NUM + BASE0..N       → 基础 CBM
    │   │   │   │
    │   │   │   ├── [GROUPTYPE=WIRE]
    │   │   │   │   ├── WIRETYPE                    → CONDUCTOR/OPGW/GROUNDWIRE
    │   │   │   │   ├── BACKSTRING/FRONTSTRING      → 耐张串 CBM
    │   │   │   │   ├── ISJUMPER                    → 跳线标识
    │   │   │   │   └── SUBDEVICES.NUM + SUBDEVICE0..N → Wire_Device/WIRE
    │   │   │   │       └── OBJECTMODELPOINTER      → DEV
    │   │   │   │
    │   │   │   └── [GROUPTYPE=CROSS]
    │   │   │       └── SUBDEVICES.NUM + SUBDEVICE0..N → CROSS
    │   │   │           └── OBJECTMODELPOINTER      → DEV
```

---

## 示例

### 变电 project.cbm

```
BLHA=27.52472222,112.01388890,150.00,0
SUBSYSTEM=868b296f-6ec0-4069-b73b-5833d4a789f3.cbm
SCH=project.sch
TYPE=TS
```

### 变电 F1System（工程级 IFC 清单）

```
ENTITYNAME=F1System
BASEFAMILY=de7332ee-b45d-4a60-836c-ac005a8404d5.fam
SUBSYSTEMS.NUM=14
SUBSYSTEM0=12c4b313-077c-4b81-8a29-83c4680058cc.cbm
SUBSYSTEM1=fb9668c9-f316-4b10-91f6-ca63b23bd63b.cbm
...
IFC.NUM=12
IFC0=电气二次0317其他.ifc
IFC1=动力照明0317.ifc
...
IFC11=总图0317.ifc
MATERIALSHEET=
```

### 变电 F3System（多值 FAM 引用 + SYSCLASSIFYNAME）

```
ENTITYNAME=F3System
SYSCLASSIFYNAME=0AFD*002
SYSTEMNAME1=交流电气系统
SYSTEMNAME2=110kV系统
SYSTEMNAME3=#2主变 110kV进线间隔
SYSTEMNAME4=
BASEFAMILY1=e941d639-3ba0-4348-933f-09cd8da077eb.fam
BASEFAMILY2=59fd06e0-7d14-486e-a499-9c3e5aaa2669.fam
BASEFAMILY3=cb4b66cb-c8b0-4845-9242-ae1d2ea9d67d.fam
BASEFAMILY4=1e65e90f-903e-4f51-abf5-ebe29b713305.fam
SUBSYSTEMS.NUM=1
SUBSYSTEM0=2002dd4c-2820-4b42-8ceb-df30a58bd284.cbm
IFC.NUM=0
MATERIALSHEET=
```

### 变电 F4System（设备入口，含子设备）

```
ENTITYNAME=F4System
SYSCLASSIFYNAME=GSK*010
BASEFAMILY=f3eb5fbc-c170-49ba-9cec-d815564261d2.fam
OBJECTMODELPOINTER=8a67e3f4-2de0-4635-883e-52e32f0099a7.dev
TRANSFORMMATRIX=1.77635683940025E-15,1,0,0,-1,1.77635683940025E-15,0,0,0,0,1,0,22155.2215374794,7260.25593439498,5720,1
SUBDEVICES.NUM=10
SUBDEVICE0=785b326a-2354-4afc-a69f-8157a9944c89.cbm
SUBDEVICE1=8e4642a6-8498-4342-9a43-48dcf0d034f0.cbm
...
SUBDEVICE9=533a51e9-ae68-4821-b1b9-d0ba4cd565a2.cbm
IFCFILE=
IFCGUID=
```

### 变电 F4System（IFC 构件入口）

```
ENTITYNAME=F4System
SYSCLASSIFYNAME=&其他
BASEFAMILY=27551fff-ef9d-4e9f-9df6-fb90852a3049.fam
OBJECTMODELPOINTER=
TRANSFORMMATRIX=1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1
SUBDEVICES.NUM=0
IFCFILE=一次设备0402其他.ifc
IFCGUID=3IkIXpOtfAOw9VSEpBZvgb
```

### 变电 PARTINDEX（设备叶子节点）

```
ENTITYNAME=PARTINDEX
PARTNAME=&其他
BASEFAMILY=8fdd7f5e-bdfb-4e5e-ac24-2f144ca3a0dd.fam
OBJECTMODELPOINTER=5d11f03d-9dd0-4185-bba4-1e640de4aa8a.dev
```

### 变电 FileDevRelation.cbm

```
FILE.NUM=24
FILE0.NAME=电气二次0317
FILE0.DEV.NUM=112
FILE0.DEV0=4883d8d8-84cf-4e6f-bf5f-1a59a1689032.cbm
FILE0.DEV1=676d8f7b-0bd5-4ffd-a563-1b83baf9aa68.cbm
...
FILE1.NAME=动力照明0317
FILE1.DEV.NUM=...
```

### 线路 project.cbm

```
SUBSYSTEM=ef3e9326-34f7-345e-bde5-d20d26cdfdcb.cbm
```

### 线路 F1System（一级标段）

```
ENTITYNAME=F1System
BASEFAMILY=ef3e9326-34f7-345e-bde5-d20d26cdfdcb.fam
SECTIONS.NUM=1
SECTION0=11954750-7456-db7b-a6ab-3781b60932d5.cbm
MATERIALSHEET=
```

### 线路 F2System（耐张段层级）

```
ENTITYNAME=F2System
BASEFAMILY=11954750-7456-db7b-a6ab-3781b60932d5.fam
STRAINSECTIONS.NUM=108
STRAINSECTION0=f6b39757-77da-6b6f-9492-71d632125116.cbm
STRAINSECTION1=faa8ea93-c122-4bea-a92f-fd66ed0ca64b.cbm
...
STRAINSECTION107=f38f0fa4-db2f-4944-9a18-de1753249c26.cbm
MATERIALSHEET=
```

### 线路 F3System（分组层级）

```
ENTITYNAME=F3System
BASEFAMILY=001f89fb-a2f1-439e-b690-032304505194.fam
GROUPS.NUM=88
GROUP0=e88204e1-785f-4db0-adfe-05417e0eb398.cbm
GROUP1=a1c6b87c-e320-4619-8e5a-62282bf88944.cbm
...
GROUP87=1ebbe897-54ab-4665-bc95-767638f73793.cbm
```

### 线路 F4System（GROUPTYPE=TOWER，杆塔分组）

```
ENTITYNAME=F4System
GROUPTYPE=TOWER
BASEFAMILY=
BLHA=26.43345609,112.65348589,57.850,284.524710
MODLEG=0.000,0.000,0.000,0.000
TOWERS.NUM=1
TOWER0=d949f3fe-96a2-4bac-a2f1-c58114a38858.cbm
STRINGS.NUM=16
STRING0.STRING=09956ca3-ab5e-4a39-acec-24b7a9eac2bf.cbm
STRING0.GPOINT=跳1-3
STRING1.STRING=2a6b43dc-52a4-4802-b879-18908588baed.cbm
STRING1.GPOINT=跳2-2
...
STRING15.STRING=ffa92bcb-001e-4b9c-b25d-ead339ce2a2a.cbm
STRING15.GPOINT=后地2
BASES.NUM=4
BASE0=1dba7727-f088-4e85-ad89-324f295ea792.cbm
BASE1=e43ca05e-9a32-474a-a1e0-eca91376bb4f.cbm
BASE2=2676b903-b039-424f-afcd-53ed9ab40620.cbm
BASE3=4fd20b6a-b250-4e3b-a7da-4eff79c00322.cbm
SUBDEVICES.NUM=0
```

### 线路 F4System（GROUPTYPE=WIRE，导线分组）

```
ENTITYNAME=F4System
GROUPTYPE=WIRE
BASEFAMILY=
WIRETYPE=CONDUCTOR
ISJUMPER=0
BACKSTRING=e0a63cbe-af3b-4de2-859c-b18e66bae48d.cbm
FRONTSTRING=d1c9a7e2-5216-44a3-b78f-2306e4f205e9.cbm
SUBDEVICES.NUM=1
SUBDEVICE0=ab7cc27c-3546-4fbb-9fae-2174e237604e.cbm
```

### 线路 F4System（GROUPTYPE=CROSS，跨越分组）

```
ENTITYNAME=F4System
GROUPTYPE=CROSS
BASEFAMILY=
SUBDEVICES.NUM=5
SUBDEVICE0=01f2ef66-fb7d-4cf4-bf56-ab068de0b952.cbm
SUBDEVICE1=5708ee8d-9203-40ad-905f-f7b946804f31.cbm
...
SUBDEVICE4=dee3c6b7-4a5b-4fd7-83bb-795492fd0f3e.cbm
```

### 线路 Tower_Device（杆塔设备叶子节点）

```
OBJECTMODELPOINTER=ae7a8a20-17d9-4615-9eba-22d92528cc07.dev
BASEFAMILY=001602eb-d1b3-46a1-80b5-e528546bd13d.fam
TRANSFORMMATRIX=0.000845734,0.999999816,-0.000001631,0.000000000,-0.999999468,0.000846439,0.000000284,0.000000000,0.000000000,0.000000000,1.000000000,0.000000000,13.320131911,0.000000000,63.057068639,1.000000000
ENTITYNAME=Tower_Device
```

### 线路 Wire_Device（导线设备叶子节点）

```
OBJECTMODELPOINTER=0eb4d76d-466c-41c2-84c2-f3165573a55b.dev
BASEFAMILY=000c8f31-4906-4cfe-b149-714c587df56e.fam
BLHA=26.50945790,112.64429204,113.100000,269.822044
TRANSFORMMATRIX=-0.001263811,0.969847850,-0.243707919,0.000000000,-0.999999152,-0.001302546,0.000002210,0.000000000,-0.000315298,0.243707715,0.969848674,0.000000000,14.094673270,6.655182628,39.748769477,1.000000000
ENTITYNAME=Wire_Device
```

### 线路 WIRE（导线实体，含几何参数）

```
ENTITYNAME=WIRE
BASEFAMILY=002070df-1f04-441e-8814-b7e50191d314.fam
OBJECTMODELPOINTER=b8e35f99-1f8e-4e8b-a541-ce842851c779.dev
KVALUE=0.0003450882
SPLIT=1
POINT0.BLHA=26.62254011,112.60955074,106.200,322.080817
POINT0.MATRIX0=-0.614549362,0.788878370,0.000000000,0.000000000,-0.788878370,-0.614549362,0.000000000,0.000000000,0.000000000,0.000000000,1.000000000,0.000000000,-15.950649389,0.309754186,45.482025794,1.000000000
POINT1.BLHA=26.62060670,112.61237487,91.470,322.080459
POINT1.MATRIX0=-0.614554285,0.788874534,0.000000000,0.000000000,-0.788874534,-0.614554285,0.000000000,0.000000000,0.000000000,0.000000000,1.000000000,0.000000000,-14.499347056,-0.310169624,54.482007655,1.000000000
```

### 线路 CROSS（跨越实体）

```
OBJECTMODELPOINTER=156d7c03-b2b9-45cf-88cf-32e6878230ea.dev
BASEFAMILY=00aed16c-0bef-4d5b-be2c-cd77dada7d59.fam
ENTITYNAME=CROSS
```
