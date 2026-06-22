# GIM 文件分析报告

> 基于 `demo/` 目录下的真实 GIM 数据，对 FileDevRelation、CBM 层级、DEV/FAM 属性、IFC 文件内容的系统分析。

---

## 一、FileDevRelation.cbm 格式与 IFC-设备映射

**文件路径**: `demo/CBM/FileDevRelation.cbm`

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
