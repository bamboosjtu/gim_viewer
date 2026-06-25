# CBM 文件格式

## 文件概述

CBM（Component/Composition Building Model）文件是 GIM 工程的核心索引文件，采用键值对文本格式（非 XML），每行一个键值对，格式为 `KEY=VALUE`。CBM 文件构成了 GIM 工程的层级树状结构，从工程入口到子系统、设备逐级引用。

CBM 文件有三种主要用途：

| 类型 | 说明 |
|------|------|
| **project.cbm** | 工程入口文件，定义工程地理坐标和顶层子系统引用 |
| **普通 \*.cbm** | 层级模型文件，描述子系统/部件的组成结构 |
| **FileDevRelation.cbm** | 文件-设备关系文件，描述 IFC 文件与设备的对应关系 |

## 文件格式

- **编码**：UTF-8
- **行分隔符**：换行符
- **键值分隔符**：`=`
- **注释**：无标准注释语法

## 字段说明

### project.cbm（工程入口文件）

| 字段 | 格式 | 说明 |
|------|------|------|
| `BLHA` | `纬度,经度,海拔,0` | 工程地理坐标，第四个值固定为 0 |
| `SUBSYSTEM` | `<uuid>.cbm` | 引用一级子系统 CBM 文件（可多条） |
| `SCH` | `project.sch` | 引用逻辑模型索引文件 |
| `TYPE` | `TS` 等 | 工程类型，`TS` 表示变电站 |

### 普通 \*.cbm（层级模型文件）

| 字段 | 格式 | 说明 |
|------|------|------|
| `ENTITYNAME` | `<名称>` | 实体名称，如 `F1System`、`PARTINDEX` |
| `BASEFAMILY` | `<uuid>.fam` | 引用对应的属性文件 |
| `SUBSYSTEMS.NUM` | `<N>` | 子系统数量 |
| `SUBSYSTEM0` ~ `SUBSYSTEMN` | `<uuid>.cbm` | 引用下级子系统 CBM 文件 |
| `IFC.NUM` | `<N>` | IFC 文件数量 |
| `IFC0` ~ `IFCN` | `<filename.ifc>` | 引用 IFC 文件 |
| `MATERIALSHEET` | （可为空） | 材料表 |
| `PARTNAME` | `<名称>` | 部件名称，如 `&其他` |
| `OBJECTMODELPOINTER` | `<uuid>.dev` | 引用设备模型文件 |

### FileDevRelation.cbm（文件-设备关系）

| 字段 | 格式 | 说明 |
|------|------|------|
| `FILE.NUM` | `<N>` | IFC 文件数量 |
| `FILE<i>.NAME` | `<名称>` | 第 i 个 IFC 文件名称（不含 `.ifc` 后缀） |
| `FILE<i>.DEV.NUM` | `<N>` | 第 i 个文件包含的设备数量 |
| `FILE<i>.DEV0` ~ `FILE<i>.DEVN` | `<uuid>.cbm` | 第 i 个文件包含的设备 CBM 引用 |

## 引用关系

```
project.cbm
├── <uuid>.cbm          → 一级子系统
│   ├── <uuid>.fam      → 属性文件
│   ├── <uuid>.cbm      → 下级子系统
│   │   ├── <uuid>.fam
│   │   ├── <uuid>.dev  → 设备模型
│   │   └── ...
│   ├── <filename.ifc>  → IFC 文件
│   └── ...
├── project.sch         → 逻辑模型索引
└── FileDevRelation.cbm → 文件-设备关系
    └── <uuid>.cbm      → 设备 CBM
```

## 示例

### project.cbm

```
BLHA=31.2304,121.4737,10.5,0
SUBSYSTEM=a1b2c3d4-e5f6-7890-abcd-ef1234567890.cbm
SCH=project.sch
TYPE=TS
```

### 普通层级 CBM 文件

```
ENTITYNAME=F1System
BASEFAMILY=b2c3d4e5-f6a7-8901-bcde-f12345678901.fam
SUBSYSTEMS.NUM=2
SUBSYSTEM0=c3d4e5f6-a7b8-9012-cdef-123456789012.cbm
SUBSYSTEM1=d4e5f6a7-b8c9-0123-defa-234567890123.cbm
IFC.NUM=1
IFC0=building.ifc
MATERIALSHEET=
PARTINDEX=0
```

### 设备级 CBM 文件

```
ENTITYNAME=PARTINDEX
BASEFAMILY=e5f6a7b8-c9d0-1234-efab-345678901234.fam
PARTNAME=&其他
OBJECTMODELPOINTER=f6a7b8c9-d0e1-2345-fabc-456789012345.dev
```

### FileDevRelation.cbm

```
FILE.NUM=2
FILE0.NAME=building_floor1
FILE0.DEV.NUM=3
FILE0.DEV0=a1b2c3d4-e5f6-7890-abcd-ef1234567890.cbm
FILE0.DEV1=b2c3d4e5-f6a7-8901-bcde-f12345678901.cbm
FILE0.DEV2=c3d4e5f6-a7b8-9012-cdef-123456789012.cbm
FILE1.NAME=building_floor2
FILE1.DEV.NUM=1
FILE1.DEV0=d4e5f6a7-b8c9-0123-defa-234567890123.cbm
```
