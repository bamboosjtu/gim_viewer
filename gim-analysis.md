# GIM 文件分析报告

> 基于 `demo/` 目录下的真实 GIM 数据，对 FileDevRelation、CBM 层级、DEV/FAM 属性、IFC 文件内容的系统分析。
>
> **覆盖范围**：
> - 第一~四章基于 `demo/demo-substation`（变电工程）得出
> - 第五章基于 `demo/demo-line`（线路工程）补充，对比两类工程的差异

---

## 一、FileDevRelation.cbm 格式与 IFC-设备映射

**文件路径**: `demo/demo-substation/CBM/FileDevRelation.cbm`

### 1.1 整体结构

该文件采用标准的 `KEY=VALUE` 键值对格式，核心结构为：

- **`FILE.NUM=24`** — 声明共有 24 个 FILE 条目
- 24 个条目以 **奇偶配对** 的方式组织：
  - **偶数索引 (0,2,4,...)**: 记录 IFC 文件名称 + 关联的设备 CBM 列表
  - **奇数索引 (1,3,5,...)**: 记录对应的 IFC 文件名（含 `.ifc` 后缀）

### 1.2 键值对结构详解

每个偶数索引条目包含：

| 键 | 示例值 | 说明 |
|---|---|---|
| `FILE<i>.NAME` | `电气二次0317` | IFC 文件名称（不含后缀） |
| `FILE<i>.DEV.NUM` | `112` | 该 IFC 文件关联的设备数量 |
| `FILE<i>.DEV0` ~ `FILE<i>.DEVN` | `<uuid>.cbm` | 设备 CBM 文件引用 |

每个奇数索引条目包含：

| 键 | 示例值 | 说明 |
|---|---|---|
| `FILE<i>.NAME` | `电气二次0317其他` | IFC 文件名称（不含后缀） |
| `FILE<i>.IFC` | `电气二次0317其他.ifc` | 实际的 IFC 文件名（含后缀） |

**关键发现**: 偶数条目和奇数条目的 NAME 并非完全一致。偶数条目是"主文件"（含设备列表），奇数条目是"其他/补充文件"（直接引用 IFC 文件，无设备列表）。

### 1.3 完整映射表

| IFC 文件名 | 设备数量 | 对应的 IFC 文件 |
|---|---|---|
| 电气二次0317 | 112 | 电气二次0317其他.ifc |
| 动力照明0317 | 48 | 动力照明0317.ifc |
| 给排水消防及排油添加主变水喷淋0401 | 1332 | 给排水消防及排油添加主变水喷淋0401.ifc |
| 基础0317 | 95 | 基础0317.ifc |
| 建筑部分0317 | 960 | 建筑部分0317.ifc |
| 接地0317 | 57 | 接地0317其他.ifc |
| 结构0317 | 260 | 结构0317.ifc |
| 警卫室建筑0317 | 74 | 警卫室建筑0317.ifc |
| 暖通布置0317 | 58 | 暖通布置0317.ifc |
| 室内给排水0317 | 353 | 室内给排水0317.ifc |
| 一次设备0402 | 1151 | 一次设备0402其他.ifc |
| 总图0317 | 145 | 总图0317.ifc |
| **总计** | **4695** | |

### 1.4 设备级 CBM 文件类型

**类型一: F4System（系统级设备 CBM）**

```
ENTITYNAME=F4System
SYSCLASSIFYNAME=FCA*001
BASEFAMILY=<uuid>.fam
OBJECTMODELPOINTER=<uuid>.dev
TRANSFORMMATRIX=1.77635683940025E-15,1,0,0,-1,...,45758.92,7382.14,5750,1
SUBDEVICES.NUM=35
SUBDEVICE0=<uuid>.cbm
IFCFILE=
IFCGUID=
```

**类型二: PARTINDEX（叶节点设备 CBM）**

```
ENTITYNAME=PARTINDEX
PARTNAME=&其他
BASEFAMILY=<uuid>.fam
OBJECTMODELPOINTER=<uuid>.dev
```

PARTINDEX 类型的 CBM 是层级树的叶子节点，没有 SUBDEVICES，直接通过 OBJECTMODELPOINTER 引用 DEV 文件。

**类型三: 纯 IFC 引用型设备 CBM**

```
ENTITYNAME=F4System
SYSCLASSIFYNAME=&其他
OBJECTMODELPOINTER=
SUBDEVICES.NUM=0
IFCFILE=动力照明0317.ifc
IFCGUID=09ssGQVjn9HAfLFsEV54b$
```

这类 CBM 的 `OBJECTMODELPOINTER` 为空，`IFCFILE` + `IFCGUID` 非空，设备信息直接存在于 IFC 文件中。

### 1.5 CBM 层级引用关系

```
project.cbm (工程入口)
├── <uuid>.cbm (一级子系统)
│   ├── BASEFAMILY → <uuid>.fam (属性定义)
│   ├── SUBSYSTEM0..N → <uuid>.cbm (下级子系统)
│   │   ├── BASEFAMILY → <uuid>.fam
│   │   ├── OBJECTMODELPOINTER → <uuid>.dev (设备几何模型)
│   │   ├── SUBDEVICE0..N → <uuid>.cbm (子设备)
│   │   │   └── ... (递归到 PARTINDEX 叶节点)
│   │   └── IFCFILE / IFCGUID (IFC 关联)
│   └── IFC.NUM / IFC0..N → <filename.ifc>
│
└── FileDevRelation.cbm (文件-设备关系索引)
    ├── FILE0 (电气二次0317) → 112 个设备 CBM
    ├── FILE2 (动力照明0317) → 48 个设备 CBM
    ├── FILE4 (给排水消防...) → 1332 个设备 CBM
    └── ... (共 12 个 IFC 文件, 4695 个设备)
```

**设备引用 IFC 文件的两种方式**:
1. **直接引用**: 通过 `IFCFILE=<filename.ifc>` + `IFCGUID=<guid>` 键值对
2. **间接引用**: 通过 CBM 层级树中的 `IFC.NUM` / `IFC0..N` 键值对

---

## 二、DEV 与 FAM 文件关联分析

### 2.1 DEV 文件结构

DEV 文件采用 `KEY=VALUE` 格式，核心字段：

| 字段 | 示例值 | 说明 |
|---|---|---|
| `BASEFAMILY` | `<uuid>.fam` | 引用属性文件（与 DEV UUID 不同名） |
| `SOLIDMODELS.NUM` | `1` | 几何模型引用数量 |
| `SOLIDMODEL0` | `<uuid>.phm` | 引用 PHM 装配体文件 |
| `TRANSFORMMATRIX0` | `1,0,0,0,...` | 几何变换矩阵 |
| `SYMBOLNAME` | `土建接口` | 中文符号名称 |
| `TYPE` | `OTHERS` | 设备类型分类 |
| `SUBDEVICES.NUM` | `2` | 子设备数量 |
| `SUBDEVICE0` | `<uuid>.dev` | 子设备 DEV 引用 |

**TYPE 字段分布**: OTHERS（95%+）、HVSwitchCabinet、SecondaryCabinet、FrameCapacitor、HGIS、ACIsolatingSwitch

**关键发现**: DEV 文件本身**不包含 IFC 引用**，IFC 引用发生在 CBM 层级。

### 2.2 FAM 文件结构

FAM 文件采用分节格式，每节用 `[节名]` 标识：

```
[设计参数]
键名=键名=值
```

**特征**:
- 属性键值对格式为 `键名=键名=值`（键名重复两次，解析时取第二个 `=` 后的值）
- 实际 demo 数据中仅出现 `[设计参数]` 一个分类节
- HVSwitchCabinet 类型 FAM 有 33 个属性（电气参数、物理参数、制造信息）
- FrameCapacitor 类型 FAM 有 34 个属性

**DEV 目录 vs CBM 目录的 FAM**:
- DEV 目录下的 FAM **无 BASEFAMILY 继承链**
- CBM 目录下的 FAM 才有 `BASEFAMILY` 字段用于继承

### 2.3 DEV-FAM 关联模式

1. DEV 和 FAM 是**一对多**关系（多个 DEV 可引用同一 FAM）
2. DEV UUID 与 FAM UUID **无对应关系**，通过 `BASEFAMILY` 显式关联
3. DEV 目录下 FAM 不使用继承链
4. IFC 引用不在 DEV 层，发生在 CBM 层级

### 2.4 完整关联链路示例

以土建接口设备为例：

```
CBM (4883d8d8-...cbm)
  ├── OBJECTMODELPOINTER → DEV (85b2e6b9-...dev)
  │   ├── BASEFAMILY → FAM (f9a7e758-...fam) [设计参数]
  │   ├── SOLIDMODEL0 → PHM (装配体)
  │   └── SUBDEVICE0 → 子设备 DEV (递归)
  ├── BASEFAMILY → FAM (CBM 目录, 可能有继承)
  ├── SUBDEVICES.NUM=35 → 35 个子设备 CBM
  └── IFCFILE / IFCGUID (可能为空)
```

---

## 三、IFC 文件详细分析

### 3.1 FILE_HEADER 对比

| 属性 | 警卫室建筑0317.ifc | 建筑部分0317.ifc |
|---|---|---|
| 格式 | IFC2X3 | IFC2X3 |
| 导出工具 | Revit 2017 | Revit 2017 |
| 文件行数 | 9,029 | 209,332 |
| 估算实体数 | ~9,020 | ~209,323 |
| 规模比 | 1x | 23x |

### 3.2 实体类型统计

| 实体类型 | 警卫室 | 建筑部分 |
|---|---|---|
| IfcWallStandardCase | 27 | 120 |
| IfcSlab | 22 | 69 |
| IfcDoor | 9 | 56 |
| IfcWindow | 15 | 127 |
| IfcOpeningElement | 24 | 221 |
| IfcColumn | 0 | 146 |
| IfcBuildingElementProxy | 0 | 217 |
| IfcRailing | 0 | 59 |
| IfcStair | 0 | 20 |
| IfcBuildingStorey | 2 | 7 |

### 3.3 异同对比

**相同点**:
- 均为 IFC2X3 格式，Revit 2017 导出
- 属于同一项目，坐标系统一致
- 核心构件类型一致（墙、楼板、门、窗、开口）

**不同点**:
- 规模差异 23 倍
- 建筑部分多了柱、栏杆、楼梯、代理元素
- 几何表达：警卫室以 ExtrudedAreaSolid 为主，建筑部分大量使用 FacetedBrep + BooleanClippingResult

### 3.4 Pset_ 属性集分析

- 警卫室 76 个 Pset_ 实例，建筑部分 858 个
- 全部为 IFC 标准定义（Pset_WallCommon、Pset_SlabCommon 等）
- **无 GIM 自定义扩展属性集**

### 3.5 Revit 中文属性集

非 Pset_ 开头的属性集名称（Revit 导出）:
其他、尺寸标注、构造数据、约束、结构、材质和装饰、分析属性、图形、常规、钢筋保护层

### 3.6 Name 字段模式

IFC 实体的 Name 字段遵循 Revit 命名规则: `族:类型:实例ID`

示例: `基本墙:外墙 - 225mm 涂料层 2:2866580`

### 3.7 GIM 设备 ID 对应字段分析

**结论: IFC 文件内部没有直接关联 GIM 设备 ID 的字段**

- IFC 实体 GUID（22 位 Base64）与 GIM UUID 格式完全不同
- Name 末尾数字 ID 是 Revit 内部 ID，非 GIM 设备 ID
- "类型 ID" 属性值仍为 Revit 类型名称
- 搜索 "GIM" 关键字仅 1 处偶然匹配（GUID 字符串中）

---

## 四、需求与可行性分析

### 4.1 两条关联路径

**路径 A — IFCGUID 桥接（精确到实体，覆盖率低）**:
```
CBM 设备 → IFCFILE + IFCGUID → IFC 实体
```
仅适用于 CBM 中 IFCFILE + IFCGUID 非空的设备。

**路径 B — FileDevRelation 索引（精确到设备节点，覆盖全部 4695 个设备）**:
```
FileDevRelation → FILE.DEV0..N → 设备 CBM → DEV → FAM
```
覆盖所有设备，但无法精确定位到 IFC 文件中的具体构件。

### 4.2 可行性评估

| 功能 | 可行性 | 难度 | 依赖 |
|------|--------|------|------|
| IFC 构件数量统计 | 高 | 低 | web-ifc 已支持 |
| CBM 层级树展示 | 高 | 中 | 解析 CBM 键值对 |
| 层级树选中→FAM 属性 | 高 | 中 | CBM + DEV + FAM 解析 |
| 3D 点击→高亮 IFC 构件 | 高 | 低 | web-ifc raycasting |
| 3D 点击→IFC 属性 | 高 | 低 | web-ifc 属性读取 |
| 3D 点击→GIM 设备属性 | 中 | 高 | 需建 IFCGUID 反向索引 |
| IFC↔GIM 双向联动 | 中 | 高 | 路径 A + 路径 B 结合 |

### 4.3 分阶段实施路径

**Phase 1（基础，高可行性）** — 已完成:
1. IFC 构件数量统计面板
2. CBM 层级树 UI
3. 层级树节点选中 → 展示 FAM 属性表

**Phase 2（进阶，中等可行性）** — 已完成:
4. 3D 点击 IFC 构件 → 展示 IFC 原生属性（Revit 导出的属性集）
5. 构建 IFCGUID 反向索引 → 3D 点击可关联到 GIM 设备

**Phase 3（完整联动）** — 已完成:
6. 层级树选中设备 → 3D 视图高亮对应 IFC 构件
7. FileDevRelation 驱动的 IFC 文件↔设备双向浏览

### 4.4 核心结论

1. **IFC 与 GIM 无直接关联** — IFC 文件内部不包含 GIM 设备 ID，需通过 CBM 层级中的 `IFCFILE`+`IFCGUID` 字段间接桥接
2. **两条可行路径**: 路径 A（IFCGUID 精确桥接，覆盖率低）和路径 B（FileDevRelation 全量索引，覆盖 4695 个设备）
3. **IFC 名称索引**: IFC 构件的 Name 属性（格式 `族:类型:实例ID`）可用于在层级树中显示有意义的设备名称，替代 CBM 中的 `&其他` 占位符
4. **坐标系差异**: CBM 的 TRANSFORMMATRIX 使用测量坐标系（大数值），IFC 模型使用局部坐标系，两者不能直接混用

---

## 五、线路工程（demo-line）分析

> 基于 `demo/demo-line`（衡阳西（喜阳）—苏耽Ⅱ回 500kV 线路工程，138.59km，327 基杆塔）的补充分析，对比变电工程的差异。

### 5.1 整体结构对比

| 维度 | 变电工程（demo-substation） | 线路工程（demo-line） |
|---|---|---|
| 目录名 | `CBM/DEV/MOD/PHM`（大写） | `Cbm/Dev/Mod/Phm`（首字母大写） |
| IFC 文件 | 12 个，~120MB | **无 IFC 文件** |
| FileDevRelation.cbm | 有（4695 设备） | **无** |
| project.cbm 字段 | BLHA/TYPE/SCH/SUBSYSTEM | **仅 SUBSYSTEM**（52 字节） |
| 几何表达 | IFC (STEP 物理格式) | **.mod（自定义文本）+ .stl（二进制）** |
| 文件总数 | 36113 | ~60652 |
| 数据规模 | ~230 MB | ~142 MB |

**文件分布**（demo-line）：

| 目录 | 文件数 | 大小 | 主要扩展名 |
|---|---|---|---|
| Cbm | 49796 | 21.5 MB | .cbm (27829), .fam (26485) |
| Dev | 9036 | 32.7 MB | .dev (4518), .fam (4518) |
| Mod | 1988 | 86.5 MB | .mod (1807), .stl (181) |
| Phm | 1836 | 0.9 MB | .phm (1836) |

### 5.2 CBM 层级结构（与变电工程完全不同）

变电工程使用 `SUBSYSTEMS.NUM`+`SUBSYSTEM0..N` 统一的子节点引用方式，线路工程则**每一级使用不同的引用键**：

```
project.cbm (工程入口，仅 SUBSYSTEM 字段)
└── F1System (1个，线路工程级)
    ├── BASEFAMILY → FAM (线路工程属性)
    ├── SECTIONS.NUM + SECTION0..N → F2System (1个，线路系统级)
    │   ├── BASEFAMILY → FAM (线路系统属性)
    │   └── STRAINSECTIONS.NUM + STRAINSECTION0..N → F3System (108个，耐张段)
    │       ├── BASEFAMILY → FAM (耐张段电气参数)
    │       └── GROUPS.NUM + GROUP0..N → F4System (5861个，设备组)
    │           ├── GROUPTYPE=TOWER (327个，杆塔组)
    │           │   ├── BLHA (杆塔经纬度)
    │           │   ├── TOWERS.NUM + TOWER0..N → Tower_Device (杆塔实体)
    │           │   ├── STRINGS.NUM + STRING<i>.STRING + STRING<i>.GPOINT → Tower_Device (绝缘子串)
    │           │   └── BASES.NUM + BASE0..N → Tower_Device (基础)
    │           ├── GROUPTYPE=WIRE (5460个，导地线段)
    │           │   ├── WIRETYPE=CONDUCTOR|GROUNDWIRE|OPGW
    │           │   ├── BACKSTRING / FRONTSTRING → Tower_Device (两端绝缘子串)
    │           │   └── SUBDEVICES.NUM + SUBDEVICE0..N → Wire_Device (线段实体)
    │           └── GROUPTYPE=CROSS (74个，交叉跨越)
    │               └── SUBDEVICES.NUM + SUBDEVICE0..N → CROSS (跨越实体)
    └── MATERIALSHEET (空)
```

**各层级引用键对照**：

| 层级 | ENTITYNAME | 子节点引用键 | 数量 |
|---|---|---|---|
| 工程入口 | (project.cbm) | `SUBSYSTEM` (单值) | 1 |
| 工程级 | F1System | `SECTIONS.NUM` + `SECTION<i>` | 1 |
| 系统级 | F2System | `STRAINSECTIONS.NUM` + `STRAINSECTION<i>` | 1 |
| 耐张段级 | F3System | `GROUPS.NUM` + `GROUP<i>` | 108 |
| 设备组级 | F4System | 因 GROUPTYPE 而异（见下表） | 5861 |
| 叶节点 | Tower_Device / Wire_Device / WIRE / CROSS | `OBJECTMODELPOINTER` → DEV | 21857 |

**F4System 的 GROUPTYPE 差异**：

| GROUPTYPE | 数量 | 子节点引用方式 | 特有字段 |
|---|---|---|---|
| TOWER | 327 | `TOWERS.NUM`+`TOWER<i>`、`STRINGS.NUM`+`STRING<i>.STRING`+`STRING<i>.GPOINT`、`BASES.NUM`+`BASE<i>` | `BLHA`、`MODLEG` |
| WIRE | 5460 | `SUBDEVICES.NUM`+`SUBDEVICE<i>`、`BACKSTRING`、`FRONTSTRING` | `WIRETYPE`、`ISJUMPER` |
| CROSS | 74 | `SUBDEVICES.NUM`+`SUBDEVICE<i>` | — |

### 5.3 ENTITYNAME 分布对比

| 变电工程 | 数量 | 线路工程 | 数量 |
|---|---|---|---|
| F1System | 1 | F1System | 1 |
| F2System | 4 | F2System | 1 |
| F3System | 85 | F3System | 108 |
| F4System | 2682 | F4System | 5861 |
| PARTINDEX | 2228 | — | — |
| — | — | Tower_Device | 4309 |
| — | — | Wire_Device | 11773 |
| — | — | WIRE | 5460 |
| — | — | CROSS | 315 |

**关键差异**：
- 线路工程**无 PARTINDEX** 叶节点，改用 `Tower_Device`/`Wire_Device`/`WIRE`/`CROSS` 四种设备实体
- 线路工程的叶节点数量（21857）远多于变电工程（2228），因为每基杆塔有多个绝缘子串、每段线有多个线段实体

### 5.4 WIRE 实体的特殊结构（导地线悬链线）

WIRE 实体是线路工程独有的，用于描述导地线的悬链线段，**不通过 TRANSFORMMATRIX 定位，而是通过多点经纬度定义**：

```
ENTITYNAME=WIRE
BASEFAMILY=<uuid>.fam
OBJECTMODELPOINTER=<uuid>.dev
KVALUE=0.0003450882          # K 值（应力参数）
SPLIT=1                       # 分裂根数
POINT0.BLHA=26.62254011,112.60955074,106.200,322.080817   # 起点：纬度,经度,高程,方位角
POINT0.MATRIX0=<16个浮点数>                                # 起点变换矩阵
POINT1.BLHA=26.62060670,112.61237487,91.470,322.080459    # 终点
POINT1.MATRIX0=<16个浮点数>                                # 终点变换矩阵
```

**特征**：
- `POINT<i>.BLHA` = 纬度,经度,高程,方位角（4 个值，变电工程 BLHA 是 3 值）
- `POINT<i>.MATRIX0` = 该点的局部坐标系变换矩阵
- 一根导线段通常有 2 个 POINT（起终点），悬链线由 web-ifc 之外的算法计算

### 5.5 FAM 属性文件格式

**变电工程 FAM**：分节格式 `[节名]`，属性行为 `中文键名=englishKey=值`
**线路工程 FAM**：**无分节**，直接 `中文键名=ENGLISH_KEY=值`（扁平结构）

**典型 FAM 内容示例**：

| FAM 类型 | 关键属性 |
|---|---|
| F1System（工程级） | 设计阶段工程名称、工程编号(1316A023000109)、设计电压(AC500kV)、线路长度(138.59km)、杆塔基数(327)、导线用量、塔材量 |
| F2System（系统级） | 电压等级、导线分裂数(4)、气象条件(15、20、30)、回路数 |
| F3System（耐张段） | 导线型号(JL/G1A-630/45)、地线型号(OPGW-17-150-5)、K 值、代表档距、各工况温度(低温/大风/覆冰/高温/雷电/操作/安装) |
| F4System-TOWER（杆塔） | 呼高(26m)、杆塔高(46.5m)、塔重(15740kg)、杆塔编号(N0)、档距(75.248m)、转角、Kv值、配腿 |
| Tower_Device-DEV（杆塔设计参数） | 塔型(LMJ)、杆塔结构类型(钢管杆)、杆塔类型(耐张塔)、回路数(2)、设计风速(27m/s)、设计覆冰(15mm)、呼高范围 |
| Tower_Device-STRING（绝缘子串） | 是否绝缘、放电间隙、物资编码 |
| Wire_Device（线段） | 最大使用张力、年平均运行张力、最大设计应力、安全系数 |
| CROSS（交叉跨越） | 电压等级(AC220V)、各工况K值、名称(电力线)、权属、里程信息 |

### 5.6 DEV 文件结构

线路工程 DEV 文件用 `DEVICETYPE` 字段（变电工程用 `TYPE`）分类：

| DEVICETYPE | 数量 | 说明 |
|---|---|---|
| STRING | 2682 | 绝缘子串 |
| BASE | 1300 | 基础 |
| CROSS | 315 | 交叉跨越物 |
| FITTINGS | 159 | 金具 |
| TOWER | 31 | 杆塔（仅 31 种塔型模板，327 基杆塔复用） |
| INSULATOR | 14 | 绝缘子 |
| DAMPER | 5 | 防振锤 |
| GROUNDWIRE | 3 | 地线 |
| SPACER | 3 | 间隔棒 |
| OPGW | 3 | 光纤复合架空地线 |
| CONDUCTOR | 3 | 导线 |

**DEV 文件字段**（以 TOWER 为例）：
```
DEVICETYPE=TOWER
SYMBOLNAME=TOWER
BASEFAMILY=<uuid>.fam
SOLIDMODELS.NUM=1
SOLIDMODEL0=<uuid>.phm
TRANSFORMMATRIX0=<16个浮点数>
```

**与变电工程 DEV 的差异**：
- 用 `DEVICETYPE` 替代 `TYPE`，值域完全不同（变电工程是 OTHERS/HVSwitchCabinet 等）
- 无 `SUBDEVICES.NUM`（线路工程的子设备关系在 CBM 层表达）
- `SYMBOLNAME` 值为英文（TOWER/WIRE/EQUIPMENT），变电工程为中文（土建接口等）

### 5.7 几何模型（.mod 文件）格式

线路工程的 .mod 文件**不是 XML**（与变电工程完全不同），而是按用途分为 4 种文本格式：

#### 5.7.1 杆塔几何（HNum 格式，31 个文件）

```
HNum,1
H,26000.000,Body1
Body1
HBody1,46500.000
P,1,-27000.000,-0.000,46500.000     # 点定义：编号,x,y,z
P,2,-27000.000,-0.000,34000.000
...
R,1,2,,Q235,100.000000,500.000000,8.000000,0   # 杆件：起点,终点,规格,材质,...
R,2,3,φ325.000000X6.000000,Q235
...
G,G,前地1,-27000.000,-2.000,34000.000  # 挂点：类型(G=挂点),子类型(G=地线/C=导线),名称,x,y,z
G,C,前导1,-21000.000,-500.000,26000.000
```

**字段说明**：
- `HNum` / `H` / `Body` / `HBody`：高度分段定义
- `P,<id>,<x>,<y>,<z>`：节点坐标（332 个点）
- `R,<from>,<to>,<spec>,<material>,...`：杆件记录（638 条），定义钢结构成员
- `G,<type>,<name>,<x>,<y>,<z>`：绝缘子串挂点（24 个），`前导`/`后导`为导线挂点，`前地`/`后地`为地线挂点

#### 5.7.2 交叉跨越几何（CODE 格式，315 个文件）

```
CODE=201
POINTNUM=4
POINT1=1,26.57769030,112.62875108,81.959975,13    # 点：编号,纬度,经度,高程,?
POINT2=2,26.57775523,112.62872826,81.959975,13
POINT3=3,26.57769941,112.62853199,81.959975,13
POINT4=4,26.57763453,112.62855482,81.959975,13
LINENUM=4
LINE1=1,2    # 线段：起点,终点
LINE2=2,3
LINE3=3,4
LINE4=4,1
```

**特征**：用经纬度+高程定义跨越物（如电力线、公路、河流）的多边形轮廓。

#### 5.7.3 导地线参数（type 格式，161 个文件）

```
TYPE=OPGW-17-150-5
SECTIONALAREA=145.90          # 截面积
OUTSIDEDIAMETER=16.60         # 外径
WIREWEIGHT=853.00             # 单位长度重量
COEFFICIENTOFELASTICITY=132000.00    # 弹性系数
EXPANSIONCOEFFICIENTOFWIRE=13.80     # 线膨胀系数
RATEDSTRENGTH=122000.00       # 额定拉断力
```

**特征**：无几何，仅物理参数。导线/地线/OPGW 的几何由悬链线算法根据两端挂点和张力参数实时计算。

#### 5.7.4 基础螺栓（Bolt 格式，1300 个文件）

```
Bolt
BoltNum=4
Bolt1=M64,232.000000,2,49.100000,104.860000,2,1,150.000000,20.000000,2160.000000,1,30;210,165.000000,165.000000,0.000000
Bolt2=M64,...
```

**特征**：定义基础地脚螺栓的规格和位置。

#### 5.7.5 STL 文件（181 个）

二进制 STL 格式，用于复杂曲面几何（如绝缘子串、金具）。示例文件 320584 字节 = 84 头 + 6410 三角形 × 50 字节。

### 5.8 坐标系统

线路工程**全程使用 BLHA（经纬度+高程+方位角）地理坐标系**，而非变电工程的局部测量坐标系：

| 出现位置 | 格式 | 示例 |
|---|---|---|
| F4System-TOWER 的 `BLHA` | 纬度,经度,高程,方位角 | `26.84596049,112.43415192,63.880,420.507943` |
| Wire_Device 的 `BLHA` | 纬度,经度,高程,方位角 | `26.50945790,112.64429204,113.100000,269.822044` |
| WIRE 的 `POINT<i>.BLHA` | 纬度,经度,高程,方位角 | `26.62254011,112.60955074,106.200,322.080817` |
| CROSS 的 .mod POINT | 编号,纬度,经度,高程,? | `1,26.57769030,112.62875108,81.959975,13` |

**关键差异**：变电工程 BLHA 仅出现在 project.cbm（3 值：经纬度高程），线路工程 BLHA 出现在每个杆塔/线段（4 值，多一个方位角），用于还原线路走向。

### 5.9 线路工程无 IFC 的渲染策略

变电工程依赖 web-ifc 解析 IFC 渲染，线路工程**完全无 IFC**，渲染需另辟蹊径：

| 几何类型 | 数据来源 | 渲染方式 |
|---|---|---|
| 杆塔钢结构 | .mod (HNum 格式) 的 P/R 记录 | 自定义解析 → Three.js BufferGeometry（钢梁圆柱/方管） |
| 绝缘子串/金具 | .stl 二进制 | Three.js STLLoader |
| 导地线悬链线 | WIRE CBM 的 POINT.BLHA + KVALUE + .mod 物理参数 | 悬链线公式计算 → Three.js Line/CatmullRomCurve3 |
| 交叉跨越 | .mod (CODE 格式) 的 POINT/LINE | Three.js LineSegments |
| 基础螺栓 | .mod (Bolt 格式) | 可选渲染（通常隐藏） |

### 5.10 线路工程的需求与可行性

| 功能 | 可行性 | 难度 | 依赖 |
|---|---|---|---|
| CBM 层级树展示 | 高 | 中 | 解析多种子节点引用键（SECTION/STRAINSECTION/GROUP/TOWER/STRING/...） |
| 杆塔 3D 渲染 | 高 | 高 | 自定义 .mod (HNum) 解析器 |
| 导地线悬链线渲染 | 高 | 高 | BLHA→局部坐标转换 + 悬链线算法 |
| 绝缘子串渲染 | 高 | 低 | STLLoader |
| 交叉跨越渲染 | 高 | 中 | .mod (CODE) 解析 |
| 属性面板（FAM） | 高 | 低 | 解析扁平 KEY=VALUE |
| 杆塔点击→属性 | 高 | 中 | raycast + BLHA 定位 |
| 无 FileDevRelation | — | — | 线路工程无此文件，设备浏览通过 CBM 树 |

### 5.11 核心结论（线路工程补充）

1. **两类工程本质不同**：变电工程是"建筑+设备"模型（IFC + 实体），线路工程是"路径+杆塔+导线"模型（地理坐标 + 参数化几何）
2. **无 IFC 依赖**：线路工程完全脱离 web-ifc，需自定义 .mod 解析器和悬链线计算
3. **层级引用键多样化**：变电工程统一用 `SUBSYSTEMS.NUM`+`SUBSYSTEM<i>`，线路工程每层不同（SECTION/STRAINSECTION/GROUP/TOWER/STRING/BASE/SUBDEVICE）
4. **地理坐标系**：线路工程全程使用 BLHA（经纬度+方位角），需墨卡托/UTM 投影转换到 3D 场景坐标
5. **.mod 格式分裂**：变电工程 .mod 统一为 XML，线路工程 .mod 按用途分 4 种文本格式（HNum/CODE/type/Bolt），无统一解析器
6. **无 FileDevRelation**：线路工程无文件-设备索引，设备浏览完全依赖 CBM 树遍历
7. **FAM 无分节**：线路工程 FAM 是扁平 `中文=ENGLISH=value`，无 `[节名]` 头
