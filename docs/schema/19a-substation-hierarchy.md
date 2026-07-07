# 19a: 变电站 CBM 层级树 F2/F3/F4 结构分析

> 样本：`demo/demo-substation/`
> 日期：2026-07-07
> 性质：只读分析，未修改代码

## 1. CBM 树整体结构概览

| 层级 | ENTITYNAME | 数量 | 说明 |
|------|-----------|-----:|------|
| L0 | F1System | 1 | 全站根节点 |
| L1 | F2System | 14 | 专业分项（U/A/S/G） |
| L2 | F3System | 145 | 子系统/间隔级 |
| L3 | F4System | 4645 | 设备/构件级 |
| L4 | PARTINDEX | 3894 | 部件索引（叶子节点） |

F1System（`868b296f-...cbm`）含 `SUBSYSTEMS.NUM=14` 和 `IFC.NUM=12`（12 个工程级 IFC 文件）。

### F1 工程级 IFC 文件清单（12 个）

| 索引 | IFC 文件名 | 推断专业 |
|-----:|-----------|---------|
| 0 | 电气二次0317其他.ifc | 电气二次（A） |
| 1 | 动力照明0317.ifc | 电气（A） |
| 2 | 给排水消防及排油添加主变水喷淋0401.ifc | 给排水（G） |
| 3 | 基础0317.ifc | 建筑/结构（U） |
| 4 | 建筑部分0317.ifc | 建筑（U） |
| 5 | 接地0317其他.ifc | 电气接地（A） |
| 6 | 结构0317.ifc | 结构（U） |
| 7 | 警卫室建筑0317.ifc | 建筑（U） |
| 8 | 暖通布置0317.ifc | 暖通（S） |
| 9 | 室内给排水0317.ifc | 给排水（G） |
| 10 | 一次设备0402其他.ifc | 电气一次（A） |
| 11 | 总图0317.ifc | 总图（U） |

## 2. F2System 层分析

### 2.1 全部 14 个 F2 节点明细

| F1 SUBSYSTEM 索引 | F2 文件名（缩写） | SYSCLASSIFYNAME | 专业 | F3 子节点数 |
|----------------:|------------------|:---------------:|:----:|----------:|
| 0 | 12c4b313-...cbm | A | 安装工程 | 12 |
| 1 | fb9668c9-...cbm | U | 建筑工程 | 1 |
| 2 | 7705f20a-...cbm | U | 建筑工程 | 1 |
| 3 | a6f96246-...cbm | U | 建筑工程 | 2 |
| 4 | ec3418d2-...cbm | A | 安装工程 | 1 |
| 5 | 9e87ed16-...cbm | U | 建筑工程 | 3 |
| 6 | a265a683-...cbm | U | 建筑工程 | 1 |
| 7 | e2f10bce-...cbm | U | 建筑工程 | 1 |
| 8 | 23331c54-...cbm | U | 建筑工程 | 1 |
| 9 | b4c5624c-...cbm | S | 暖通工程 | 1 |
| 10 | fd8247ee-...cbm | G | 给排水工程 | 1 |
| 11 | faac7370-...cbm | A | 安装工程 | 118 |
| 12 | b236b240-...cbm | U | 建筑工程 | 1 |
| 13 | 22fd995d-...cbm | U | 建筑工程 | 1 |

### 2.2 专业分布统计

| SYSCLASSIFYNAME | 专业名称 | F2 节点数 | F3 子节点总数 |
|:---------------:|---------|--------:|------------:|
| U | 建筑工程 | 9 | 12 |
| A | 安装工程 | 3 | 131 |
| S | 暖通工程 | 1 | 1 |
| G | 给排水工程 | 1 | 1 |
| **合计** | | **14** | **145** |

**关键发现**：安装工程（A）虽仅 3 个 F2 节点，但承载 145 个 F3 中的 131 个（90.3%），其中 `faac7370` 单节点含 118 个 F3 子节点，是全站最大的电气系统分支。

### 2.3 F2 排序验证

原始 CBM 数据**并非** U→A→S→G 排序，而是混合顺序（A,U,U,U,A,U,U,U,U,S,G,A,U,U）。

代码层（[cbmParser.ts](../../src/gim/cbmParser.ts) 第 194-200 行）强制排序为 `[9个U] → [3个A] → [1个S] → [1个G]`，已正确实现。

## 3. F3System 层深度分析

### 3.1 SYSCLASSIFYNAME 编码前缀分类

| 前缀模式 | 所属 F2 专业 | SYSTEMNAME1 | 含义 |
|---------|:----------:|------------|------|
| `0ANX*` | A | 交流电气系统 | 跨电压等级系统/网络/监控 |
| `0ATA*` | A | 交流电气系统 | 220kV 变压器系统/主变本体 |
| `0AXB*` | A | 交流电气系统 | 防雷接地系统/接地 |
| `0AEC`~`0AKN` | A | 交流电气系统 | 各类电气子系统 |
| `0SAZ*` | U | 构筑物 | 辅助及附属构筑物 |
| `0SPZ*` | U | 构筑物 | 生产构筑物 |
| `1BAZ*` | U | 建筑物 | 辅助及附属建筑物 |
| `1BPZ*` | U | 建筑物 | 生产建筑物 |
| `0F*F*` | S | 空调系统 | 空调子系统 |
| `0M*B*` | G | 排水系统 | 排水子系统 |

**编码结构**：`[0|1][专业字母][子类字母][子类字母][*或字母][序号]`
- 第 1 位 `0`/`1`：`1B` 系列为建筑物，`0S` 系列为构筑物
- 第 2 位：专业大类（A=电气、S=构筑物、B=建筑物、F=暖通、M=给排水）

### 3.2 SYSTEMNAME1-4 字段含义

SYSTEMNAME1~4 呈递进语义结构（系统大类→小类→具体系统→详细名称）：

| F3 SYSCLASSIFYNAME | SYSTEMNAME1 | SYSTEMNAME2 | SYSTEMNAME3 | SYSTEMNAME4 | F4 子节点数 |
|:------------------:|------------|------------|------------|------------|----------:|
| 0ANXS011 | 交流电气系统 | 跨电压等级系统 | 调度数据网 | 调度数据网设备 | 3 |
| 0ANXA011 | 交流电气系统 | 跨电压等级系统 | 一体化监控 | 一体化监控系统 | 17 |
| 0ATA*140 | 交流电气系统 | 220kV变压器系统 | 3号备用主变本体系统 | (空) | 1 |
| 0AXB*001 | 交流电气系统 | 防雷接地系统 | 接地系统 | (空) | 57 |
| 0SPZ*001 | 构筑物 | 生产构筑物 | 其它 | (空) | 6 |
| 1BPZ*001 | 建筑物 | 生产建筑物 | 其它 | (空) | 48 |
| 0SAZ*001 | 构筑物 | 辅助及附属构筑物 | 其它 | (空) | 145~972 |
| 1BAZ*001 | 建筑物 | 辅助及附属建筑物 | 其它 | (空) | 828 |
| 0F*F*001 | 空调系统 | - | 其它空调系统 | (空) | 58 |
| 0M*B*001 | 排水系统 | - | 工业废水排水系统 | (空) | 353 |

### 3.3 当前命名问题

| 问题 | 示例 | 影响 |
|------|------|------|
| SYSTEMNAME3 为"其它"占位符 | "构筑物 / 生产构筑物 / 其它" | U 专业大量 F3 不可区分 |
| SYSTEMNAME2 为"-"占位符 | "空调系统 / - / 其它空调系统" | S/G 专业显示含无意义"-" |
| SYSTEMNAME4 常为空 | "交流电气系统 / 跨电压等级系统 / 调度数据网 / " | 末尾多余分隔符 |
| 同名 F3 大量重复 | 多个"构筑物 / 辅助及附属构筑物 / 其它" | U 专业 9 个 F2 下有多个同名 F3 |

## 4. F4System 层深度分析

### 4.1 F4 角色分布（三种角色）

| F4 角色 | 数量 | OBJECTMODELPOINTER | IFCFILE | SUBDEVICES.NUM | 占比 |
|---------|-----:|:-----------------:|:-------:|:--------------:|-----:|
| IFC 构件入口 | 4360 | 空 | 非空 | 通常 0 | 93.9% |
| 设备入口（含子设备） | 285 | 非空（指向 .dev） | 空 | >0 | 6.1% |

### 4.2 IFC 构件入口 F4

SYSCLASSIFYNAME 统一为 `&其他`（GIM 占位符），语义由 IFCFILE+IFCGUID 承载。多个 F4 节点可引用同一 IFCFILE+IFCGUID。

样本（`4883d8d8-...cbm`）：
```
ENTITYNAME=F4System
SYSCLASSIFYNAME=&其他
IFCFILE=电气二次0317其他.ifc
IFCGUID=2g1Mblmeb5pAsmQ9eqoxPi
```

### 4.3 设备入口 F4

样本（`676d8f7b-...cbm`）：
```
ENTITYNAME=F4System
SYSCLASSIFYNAME=FCA*002
OBJECTMODELPOINTER=9b10f67a-ce87-496c-a6c6-c39963037da3.dev
TRANSFORMMATRIX=1.77635683940025E-15,1,0,0,-1,...,45758.92,6782.14,5750,1
SUBDEVICES.NUM=35
```

### 4.4 DEV SYMBOLNAME 示例

| DEV 文件 | SYMBOLNAME | TYPE |
|---------|-----------|------|
| 85b2e6b9-...dev | 第一平面调度数据网及电能量采集柜 | SecondaryCabinet |
| 9b10f67a-...dev | 第二平面调度数据网设备柜 | SecondaryCabinet |

### 4.5 DEV TYPE 分布（4179 个 DEV）

| TYPE | 数量 | 含义 |
|------|-----:|------|
| OTHERS | 3870 | 通用设备（93%） |
| SecondaryCabinet | 106 | 二次柜 |
| HVSwitchCabinet | 81 | 高压开关柜 |
| FrameCapacitor | 36 | 框架式电容器 |
| HGIS | 32 | 复合组合电器 |
| LightningArrester | 24 | 避雷器 |
| OilImmersedTransformer | 3 | 油浸变压器 |
| GIS | 5 | 组合电器 |
| ACIsolatingSwitch | 6 | 交流隔离开关 |
| DryTypeReactor | 6 | 干式电抗器 |

## 5. F2→F3→F4 层级关系映射表

### 5.1 链路 1：A 专业 - 设备入口链路（电气二次设备）

```
F1System: 868b296f-...cbm
  └─ F2System: 12c4b313-...cbm  [A, 安装工程]
       └─ F3System: e051bade-...cbm  [0ANXS011, 交流电气系统/跨电压等级系统/调度数据网/调度数据网设备]
            ├─ F4System: 4883d8d8-...cbm  [IFC入口, &其他, IFCFILE=电气二次0317其他.ifc]
            ├─ F4System: 676d8f7b-...cbm  [设备入口, FCA*002, DEV=9b10f67a...dev, 35 SUBDEVICES]
            │     └─ DEV: 9b10f67a-ce87-496c-a6c6-c39963037da3.dev
            │           [SYMBOLNAME=第二平面调度数据网设备柜, TYPE=SecondaryCabinet]
            └─ F4System: 3d243ce0-...cbm  [第3个子节点]
```

### 5.2 链路 2：U 专业 - 建筑构筑物 IFC 链路

```
F1System: 868b296f-...
  └─ F2System: fb9668c9-...cbm  [U, 建筑工程]
       └─ F3System: b25ac385-...cbm  [0SPZ*001, 构筑物/生产构筑物/其它]
            ├─ F4System: 1ea1e296-...cbm  [IFC入口, &其他]
            │     └─ IFC: 电气二次0317其他.ifc
            └─ ... (共6个F4子节点)
```

> **注意**：U 专业 F3 下的 F4 子节点可引用"电气二次0317其他.ifc"，说明 F4 的 IFCFILE 不受 F3 父节点专业限制——F4 按 IFC 构件粒度组织。

### 5.3 链路 3：S 专业 - 暖通 IFC 链路

```
F1System: 868b296f-...
  └─ F2System: b4c5624c-...cbm  [S, 暖通工程]
       └─ F3System: d162fc8d-...cbm  [0F*F*001, 空调系统/-/其它空调系统]
            ├─ F4System: b2b71cc6-...cbm  [IFC入口, &其他]
            │     └─ IFC: 暖通布置0317.ifc
            └─ ... (共58个F4子节点)
```

### 5.4 链路 4：G 专业 - 给排水 IFC 链路

```
F1System: 868b296f-...
  └─ F2System: fd8247ee-...cbm  [G, 给排水工程]
       └─ F3System: 79baff7a-...cbm  [0M*B*001, 排水系统/-/工业废水排水系统]
            ├─ F4System: f26feab6-...cbm  [IFC入口, &其他]
            │     └─ IFC: 室内给排水0317.ifc
            └─ ... (共353个F4子节点)
```

### 5.5 层级关系总结

| 维度 | 发现 |
|------|------|
| F2→F3 映射 | 1:1 为主，但 A 专业的 3 个 F2 承载 131/145=90.3% 的 F3 |
| F3→F4 映射 | 1~972 跨度极大；U 专业 F3 普遍承载数百个 F4（IFC 构件） |
| F4 角色 | 93.9% 为 IFC 构件入口（&其他），6.1% 为设备入口（带 DEV 引用） |
| 专业隔离 | F4 的 IFCFILE 不受 F3 父节点专业限制 |
| 设备入口分布 | 设备入口 F4（285个）集中在 A 专业的 F3 子树下 |

## 6. F1~F4 完整命名优化方案

### 6.1 总览

| 层级 | 当前状态 | 优化方案 | 实现方式 |
|------|---------|---------|---------|
| F1System | ✅ 已实现 | 工程类型名（变电工程/建筑工程） | GIM 魔数 → `getProjectTypeName()` |
| F2System | ✅ 已实现 | 专业名（建筑工程/安装工程/暖通工程/给排水工程）+ U→A→S→G 排序 | `mapF2ClassifyName()` |
| F3System | ❌ 待优化 | 方案 A（过滤占位符）+ 方案 B（F4 反推） | 修改 `extractDisplayName()` + 子节点信息收集 |
| F4System | ✅ 已实现 | 设备入口：DEV SYMBOLNAME；IFC 入口：过滤"&其他" | `isDeviceLayer()` + `isPlaceholderName()` |

### 6.2 F1System（已实现）

**方案**：根据 GIM 魔数显示工程类型名

| 魔数 | 显示名称 |
|------|---------|
| GIMPKGS | 变电工程 |
| GIMPKGT | 线路工程 |
| 其他 GIMPKG 变体 | 建筑工程 |

**代码位置**：[gimExtractor.ts](../../src/gim/gimExtractor.ts) `getProjectTypeName()` → [cbmParser.ts](../../src/gim/cbmParser.ts) `buildCbmTree(files, projectTypeName)`

### 6.3 F2System（已实现）

**方案**：将 SYSCLASSIFYNAME 单字符映射为工程专业名，并按 U→A→S→G 排序

| SYSCLASSIFYNAME | 显示名称 | 排序权重 |
|:---------------:|---------|:--------:|
| U | 建筑工程 | 0 |
| A | 安装工程 | 1 |
| S | 暖通工程 | 2 |
| G | 给排水工程 | 3 |

**代码位置**：[cbmParser.ts](../../src/gim/cbmParser.ts) `mapF2ClassifyName()` + F1System 子节点排序逻辑

### 6.4 F3System（待优化）

#### 6.4.1 方案 A：过滤占位符 + 智能拼接

修改 `extractDisplayName()` 中 systemNames 收集逻辑，跳过 `-`、`其它`、`其他`、空字符串：

| F3 SYSCLASSIFYNAME | 当前显示 | 优化后显示 |
|----|---------|-----------|
| 0ANXS011 | 交流电气系统 / 跨电压等级系统 / 调度数据网 / 调度数据网设备 | 交流电气系统 / 跨电压等级系统 / 调度数据网 / 调度数据网设备（不变） |
| 0SPZ*001 | 构筑物 / 生产构筑物 / 其它 | 构筑物 / 生产构筑物 |
| 0F*F*001 | 空调系统 / - / 其它空调系统 | 空调系统 / 其它空调系统 |
| 0M*B*001 | 排水系统 / - / 工业废水排水系统 | 排水系统 / 工业废水排水系统 |

**问题**：U 专业大量 F3 过滤后变为"构筑物 / 辅助及附属构筑物"，同专业下多个 F3 仍然同名无法区分。

#### 6.4.2 方案 B：F4 子节点信息反推（推荐实施）

**可行性分析**：
- 变电工程设备数百个，首次加载时已全遍历 CBM 树（构建所有 F4 节点）
- 首次解析结果会缓存到 SQLite `cbm_node` 表的 `name` 字段
- 后续缓存命中直接读取，无需再计算
- 首次本身就会对文件进行全遍历，额外开销可忽略

**反推策略**：在 `buildCbmTree()` 构建 F3 节点时，收集其 F4 子节点的信息，生成区分性后缀：

| F4 子节点类型 | 收集的信息 | 拼接方式 |
|-------------|-----------|---------|
| 设备入口（有 DEV） | DEV SYMBOLNAME（如"第二平面调度数据网设备柜"） | 取前 2~3 个设备名，用 `、` 连接 |
| IFC 构件入口（有 IFCFILE） | IFCFILE 文件名（去 `.ifc` 后缀，如"建筑部分0317"） | 去重后取前 2~3 个，用 `、` 连接 |

**命名规则**：
- 方案 A 过滤后名称仍有歧义（多个同名）时，追加 `（含{设备/IFC名}等）`
- 方案 A 过滤后名称唯一时，不追加后缀
- 设备入口优先于 IFC 构件入口（设备名更具体）

**示例**：

| F3 SYSCLASSIFYNAME | 方案 A 显示 | 方案 B 优化后 |
|----|---------|-------------|
| 0SAZ*001 (972 F4，全 IFC 入口) | 构筑物 / 辅助及附属构筑物 | 构筑物 / 辅助及附属构筑物（含建筑部分0317、结构0317等） |
| 0SAZ*001 (145 F4，混合) | 构筑物 / 辅助及附属构筑物 | 构筑物 / 辅助及附属构筑物（含第一平面调度数据网柜、建筑部分0317等） |
| 1BPZ*001 (48 F4，全 IFC 入口) | 建筑物 / 生产建筑物 | 建筑物 / 生产建筑物（含基础0317、结构0317等） |
| 0ANXS011 (3 F4，含设备入口) | 交流电气系统 / 跨电压等级系统 / 调度数据网 / 调度数据网设备 | 交流电气系统 / 跨电压等级系统 / 调度数据网 / 调度数据网设备（不变，已唯一可读） |
| 0ATA*140 (1 F4，设备入口) | 交流电气系统 / 220kV变压器系统 / 3号备用主变本体系统 | 交流电气系统 / 220kV变压器系统 / 3号备用主变本体系统（不变，SYSTEMNAME3 已可读） |

**实施要点**：
1. 在 `buildCbmTree()` 构建 F3 节点时，先递归构建 F4 子节点
2. 收集 F4 子节点的 `devSymbolName`（设备入口）和 `ifcFile`（IFC 入口）
3. 设备名优先：若 F4 子节点有 devSymbolName，取前 2~3 个作为后缀
4. 无设备名时用 IFC 文件名：去重后取前 2~3 个
5. 拼接：`{方案A名称}（含{后缀}等）`
6. 结果存入 `node.name`，随 CBM 树持久化到 SQLite `cbm_node.name`
7. 缓存命中时直接读取，零额外开销

### 6.5 F4System（已实现）

**方案**：根据 F4 角色类型分别处理

| F4 角色 | 处理方式 | 示例 |
|---------|---------|------|
| 设备入口（有 DEV） | 优先用 DEV SYMBOLNAME | "第二平面调度数据网设备柜" |
| IFC 构件入口（SYSCLASSIFYNAME=&其他） | 过滤占位符，回退到 IFC Name | IFC Name 非"&其他"时用 IFC Name，否则用 CBM 名称 |
| 设备入口 + 子设备展开 | PARTINDEX/DEV_SUBDEVICE 用子设备 SYMBOLNAME | 子设备名 |

**代码位置**：[cbmParser.ts](../../src/gim/cbmParser.ts) `isDeviceLayer()` + [gimIndexer.ts](../../src/gim/gimIndexer.ts) `getNodeDisplayName()` + [ifcNameIndex.ts](../../src/viewer/ifcNameIndex.ts) `isPlaceholderIfcName()`

### 6.6 完整层级树命名预期效果

以 demo-substation 为例，优化后的层级树显示效果：

```
变电工程
├─ 建筑工程（U×9）
│  ├─ 建筑工程                         ← F2(12c4b313, U)
│  │  └─ 构筑物 / 生产构筑物（含基础0317等）  ← F3(0SPZ*001) 方案B
│  │       ├─ 建筑部分0317 - 墙体         ← F4(IFC入口, IFC Name)
│  │       └─ ...
│  ├─ 建筑工程                         ← F2(fb9668c9, U)
│  │  └─ 构筑物 / 辅助及附属构筑物（含建筑部分0317等）  ← F3(0SAZ*001) 方案B
│  │       └─ ... (972个F4)
│  └─ ...
├─ 安装工程（A×3）
│  ├─ 安装工程                         ← F2(12c4b313, A)
│  │  ├─ 交流电气系统 / 跨电压等级系统 / 调度数据网 / 调度数据网设备  ← F3(0ANXS011) 方案A
│  │  │    ├─ 第二平面调度数据网设备柜     ← F4(设备入口, DEV SYMBOLNAME)
│  │  │    └─ 电气二次0317 - 构件         ← F4(IFC入口, IFC Name)
│  │  └─ 交流电气系统 / 220kV变压器系统 / 3号备用主变本体系统  ← F3(0ATA*140) 方案A
│  │       └─ 3号备用主变压器           ← F4(设备入口, DEV SYMBOLNAME)
│  ├─ 安装工程                         ← F2(faac7370, A, 118个F3)
│  │  └─ ... (118个F3子节点)
│  └─ ...
├─ 暖通工程（S×1）
│  └─ 暖通工程
│      └─ 空调系统 / 其它空调系统        ← F3(0F*F*001) 方案A
│           └─ ... (58个F4)
└─ 给排水工程（G×1）
   └─ 给排水工程
       └─ 排水系统 / 工业废水排水系统    ← F3(0M*B*001) 方案A
            └─ ... (353个F4)
```

### 6.7 实施优先级

| 优先级 | 方案 | 涉及层级 | 改动范围 | 缓存策略 |
|:------:|------|---------|---------|---------|
| P0 | 方案 A：过滤占位符 | F3 | `extractDisplayName()` | name 存入 cbm_node 表 |
| P1 | 方案 B：F4 反推 | F3 | `buildCbmTree()` 收集子节点信息 | 首次遍历时计算，存入 cbm_node 表 |
| — | F1/F2/F4 | 已实现 | 无需改动 | 已持久化 |

## 7. 变电站标准规范对照

依据《变电站设计规范》(GB 50216)、《220kV～500kV变电所设计技术规程》(DL/T 5218)：

| CBM 层级 | 对应变电站设计层级 | 规范依据 |
|---------|------------------|---------|
| F1System | 全站/整个变电站工程 | DL/T 5218 总则 |
| F2System (U) | 建筑工程分项 | GB 50216 建筑分册 |
| F2System (A) | 安装工程分项（电气一次+二次） | DL/T 5218 电气部分 |
| F2System (S) | 暖通工程分项 | GB 50216 暖通分册 |
| F2System (G) | 给排水工程分项 | GB 50216 给排水分册 |
| F3System (A/0ANX*) | 电气二次系统（调度数据网、一体化监控） | DL/T 5218 二次系统 |
| F3System (A/0ATA*) | 主变系统（220kV 变压器本体） | DL/T 5218 主变压器 |
| F3System (A/0AXB*) | 防雷接地系统 | DL/T 5218 过电压保护与接地 |
| F3System (U/0SAZ*) | 辅助及附属构筑物 | GB 50216 辅助建筑 |
| F3System (U/0SPZ*) | 生产构筑物（配电装置楼等） | GB 50216 生产建筑 |
| F3System (U/1BAZ*) | 辅助及附属建筑物 | GB 50216 辅助建筑 |
| F3System (U/1BPZ*) | 生产建筑物（主控楼等） | GB 50216 生产建筑 |
| F3System (S/0F*F*) | 空调系统 | GB 50216 暖通空调 |
| F3System (G/0M*B*) | 排水系统 | GB 50216 给排水 |
| F4System (设备入口) | 具体物理设备（开关柜、变压器等） | 设备订货技术条件 |
| F4System (IFC入口) | 建筑/结构 IFC 构件（墙、板、柱等） | IFC 标准 + GIM 扩展 |
| PARTINDEX | 设备部件索引 | 设备装配明细 |

**F3System 层级推断**：F3 对应变电站设计中的**子系统/间隔级**：
- 电气专业的 F3 对应**间隔（Bay）**概念，如"220kV 变压器系统/3 号备用主变本体系统"
- 建筑专业的 F3 对应**建筑/构筑物单体**，如"生产建筑物"对应主控楼
- 暖通/给排水的 F3 对应**子系统**，如"空调系统"、"排水系统"

## 8. 关键文件路径索引

| 类别 | 文件路径 |
|------|---------|
| 工程入口 | `demo/demo-substation/CBM/project.cbm` |
| F1 根节点 | `demo/demo-substation/CBM/868b296f-6ec0-4069-b73b-5833d4a789f3.cbm` |
| F2 A(12子) | `demo/demo-substation/CBM/12c4b313-077c-4b81-8a29-83c4680058cc.cbm` |
| F2 G | `demo/demo-substation/CBM/fd8247ee-07f2-4e09-8d09-7b87471b921f.cbm` |
| F2 S | `demo/demo-substation/CBM/b4c5624c-7978-4298-92b3-9df862c95eb6.cbm` |
| F3 A 样本 | `demo/demo-substation/CBM/e051bade-398e-4a43-96f9-1a5286b7a9b1.cbm` |
| F3 U 样本 | `demo/demo-substation/CBM/b25ac385-ed64-448e-b45d-43d686ac65ab.cbm` |
| F3 S 样本 | `demo/demo-substation/CBM/d162fc8d-e6d1-405c-8975-f9b0ba400618.cbm` |
| F3 G 样本 | `demo/demo-substation/CBM/79baff7a-18f8-4650-8cc3-cf62e207b541.cbm` |
| F4 设备入口 | `demo/demo-substation/CBM/676d8f7b-0bd5-4ffd-a563-1b83baf9aa68.cbm` |
| F4 IFC 入口 | `demo/demo-substation/CBM/4883d8d8-84cf-4e6f-bf5f-1a59a1689032.cbm` |
| DEV 样本 1 | `demo/demo-substation/DEV/85b2e6b9-415f-416a-91ef-e3e2aa471022.dev` |
| DEV 样本 2 | `demo/demo-substation/DEV/9b10f67a-ce87-496c-a6c6-c39963037da3.dev` |
| CBM 规范 | `docs/schema/cbm.md` |
| 字段统计 | `docs/schema/04-cbm-field-dictionary.md` |
| DEV 规范 | `docs/schema/dev.md` |
| 命名实验 | `docs/schema/18b-experiment-cbm-tree-dev-subdevices.md` |
| 排序代码 | `src/gim/cbmParser.ts` 第 194-200 行 |
