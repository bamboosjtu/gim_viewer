# 变电 GIM 文件格式与可视化

> 变电站工程（GIMPKGS）的文件结构、解析流程与 3D 可视化。

## 0. 实现状态总览

| 能力 | 状态 | 实现位置 |
|---|---|---|
| GIM 容器解压 | ✅ 已实现 | `desktop/src/gim/gimExtractor.ts` |
| CBM 层级树解析 | ✅ 已实现 | `desktop/src/gim/cbmParser.ts` |
| FAM 分节属性解析 | ✅ 已实现 | `desktop/src/gim/famParser.ts` |
| FileDevRelation 解析 | ✅ 已实现 | `desktop/src/gim/fileDevParser.ts` |
| IFC 发现 + GUID 索引 + 名称查询 | ✅ 已实现 | `desktop/src/gim/gimIndexer.ts` / `desktop/src/viewer/ifcNameIndex.ts` |
| IFC 3D 渲染（OBC + web-ifc + Three.js） | ✅ 已实现 | `desktop/src/viewer/viewerEngine.ts` / `ifcLoader.ts` / `ifcEntryLoader.ts` |
| 节点级 IFC 懒加载 + Fragments 缓存 | ✅ 已实现 | `desktop/src/viewer/ifcEntryLoader.ts`（`.frag` 缓存） |
| 3D 点击拾取 + 高亮 + 相机定位 | ✅ 已实现 | `desktop/src/viewer/selection.ts` / `highlight.ts` / `camera.ts` |
| 层级树↔3D 联动 | ✅ 已实现 | `desktop/src/services/nodeInteractionService.ts` |
| 属性面板（CBM/FAM/DEV/IFC + 语义字典） | ✅ 已实现 | `desktop/src/ui/propsDrawer.ts` / `propertyDictionary.ts` |
| SQLite 缓存（索引、属性、Fragments、几何引用链） | ✅ 已实现 | `desktop/src-tauri/src/db.rs`（当前 `PARSER_VERSION=gim-parser-v19`） |
| 缓存命中短路 | ✅ 已实现 | `desktop/src/services/openGimService.ts` / `gimIndexRestoreService.ts` |
| IFC/DEV/PHM/MOD/STL 本地磁盘缓存 | ✅ 已实现 | `desktop/src/services/gimExtractedCacheService.ts` |
| 诊断快捷键（Ctrl+Shift+D） | ✅ 已实现 | `desktop/src/services/diagnosticSummaryService.ts` |
| **MOD 文件解析（XML primitive 14 类）** | ✅ 已实现 | `desktop/src/gim/geometry/xmlModParser.ts`（14 类，11 强类型 + 3 弱 schema fallback）；设计稿见 [10-substation-mod-grammar.md](schema/10-substation-mod-grammar.md) |
| **DEV 解析（SOLIDMODELS + SUBDEVICES）** | ✅ 已实现 | `desktop/src/gim/geometry/devParser.ts`（两块索引独立，行主序矩阵） |
| **PHM 解析（SOLIDMODEL + TRANSFORMMATRIXn + COLORn）** | ✅ 已实现 | `desktop/src/gim/geometry/phmParser.ts` |
| **Geometry IR schema 落地** | ✅ 已实现 | `desktop/src/gim/geometry/ir.ts`（5 kind 联合 + 14 类 primitive 类型）；设计稿见 [13-geometry-ir-schema.md](schema/13-geometry-ir-schema.md) |
| **xml-mod 渲染集成（CBM→DEV→PHM→MOD）** | ✅ 已实现 | `desktop/src/viewer/xmlModGeometry.ts` / `xmlModLoader.ts` / `desktop/src/services/modGeometryDiscovery.ts` / `desktop/src/services/nodeInteractionService.ts` |
| **PHM TransformMatrix 应用** | ✅ 已实现 | `desktop/src/viewer/xmlModLoader.ts` `applyPlacementTransformToSceneUnits`（顶点烘焙 DEV/PHM/CBM/SUBDEVICE 累积矩阵，避免 Object3D.applyMatrix4 decompose 精度损失） |
| **xml-mod 自动加载（IFC 加载完成后）** | ✅ 已实现（渐进式管线） | `desktop/src/services/openGimService.ts` `loadAllIfcFiles` 后台任务 → `progressiveGeometryService.ts` |
| **DEV/PHM/MOD/STL 文件磁盘缓存** | ✅ 已实现 | `desktop/src/services/gimExtractedCacheService.ts` `cacheGeometryFiles`（首次打开时缓存，缓存命中按需读取） |
| **缓存命中场景回放 xml-mod 几何** | ✅ 已实现 | `desktop/src/services/nodeInteractionService.ts` `buildGeometryFilesMapFromCache` / `ensureModFilesInCacheMap` |
| **STL 渲染** | ⚠️ 已实现加载器与首次打开渐进渲染；缓存命中默认不主动加载 STL | `desktop/src/viewer/stlLoader.ts` / `desktop/src/services/glbCacheService.ts`；几何角色见 [12-stl-static-survey.md](schema/12-stl-static-survey.md) |
| **PHM COLOR 应用** | ✅ 已实现 | `desktop/src/viewer/xmlModGeometry.ts` `applyPhmColorOverride`；按文件级 `max(A)` 区分百分制/字节制，缓存保存刻度 |
| **EMPTY_DEVICE_XML 提示** | ❌ 未实现（P1） | 44 个孤儿 MOD 静默忽略（解析为 isEmpty=true，渲染为空 Group） |
| **装配节点无几何提示** | ❌ 未实现（P2） | 14 个无 SOLIDMODEL 的 PHM 静默忽略 |

### 当前版本关键改动

- `PARSER_VERSION` 当前为 `gim-parser-v19`；几何 GLB 缓存版本为 `geometry-cache-v4-phm-color`。任一版本变化都会使旧缓存失效并触发重建。Fragments 缓存另绑定源 GIM SHA-256 与 `fragments-cache-v6` 运行时版本，旧记录缺少源 SHA 时视为失效。
- 首次打开 GIM 时，通过 `cacheGeometryFiles` 缓存 DEV/PHM/MOD/STL 文件到 `app_data_dir/extracted/{projectId}/`（复用 `writeCacheFile`，沿用路径遍历防护）。
- IFC 加载完成后自动启动渐进式 DEV GLB 管线（`progressiveGeometryService`），按 DEV 粒度一次解析、落盘并逐实例渲染 IFC 之外的 MOD/STL；用户无需逐节点点击才能看到几何。
- 缓存命中场景（`currentFiles=null`）下，`nodeInteractionService` 通过 `buildGeometryFilesMapFromCache` / `ensureModFilesInCacheMap` 从磁盘按需读取 DEV/PHM/MOD/STL；GLB 快速路径失败时回退到原始文件解析。
- PHM 的 `COLORn` 与文件级 `max(A)` 已随几何引用链缓存；重放时对 MOD/STL 实例应用 RGB、透明度和 A=0 不透明哨兵规则。

> P0 实现路径及仍待补齐的 P1/P2 见 §9。

---

## 1. GIM 文件容器

`.gim` 文件是自定义格式（非标准 ZIP）：

```
偏移 0:    GIMPKG* 头部（变长，含项目编号和名称，零填充）
偏移 N:    7z 或 ZIP 压缩数据（在头部之后 1MB 窗口内搜索签名定位）
```

| 头部魔数 | 工程类型 |
|---|---|
| `GIMPKGS` | 变电站（Transformer Substation） |

**压缩数据定位**：在 GIMPKG* 头部之后 1MB 窗口内搜索：

- 7z 签名：`37 7A BC AF 27 1C`
- ZIP 签名：`50 4B 03 04`

**解压**：Tauri 生产路径由 Rust `sevenz-rust/zip` 从磁盘逐条解压并返回
manifest + `DiskBackedFile`（条目按需读取）；浏览器或原生能力不可用时回退
libarchive.js（WebAssembly）并展平为 `Map<path, File>`。

---

## 2. 解压后目录结构

```
XX变电站新建.gim/
├── CBM/     # 工程层级结构文件（.cbm / .fam）
├── DEV/     # 设备定义与IFC文件（.dev / .fam / .ifc）
├── PHM/     # 组合模型文件（.phm）
└── MOD/     # 基础几何模型文件（.mod）
```

| 目录 | 文件类型 | 职责 |
|---|---|---|
| CBM/ | `.cbm`, `.fam` | 构建工程层级树，从工程根到设备级 |
| DEV/ | `.dev`, `.fam`, `.ifc` | 设备属性与参数，IFC 承载三维建筑信息模型 |
| PHM/ | `.phm` | 组合模型，将多个 MOD 组装为可复用设备模型 |
| MOD/ | `.mod` | 基础几何模型（XML 格式），定义最底层几何形状与材质 |

---

## 3. CBM 层级结构

入口文件：`CBM/project.cbm`

```
BLHA=<纬度>,<经度>,<海拔>,<方向角>
SUBSYSTEM=<UUID>.cbm
SCH=project.sch
TYPE=TS
```

### 层级树

```
project.cbm（工程根）
└── 一级子系统.cbm（F1System）
    ├── 二级子系统.cbm
    │   └── 三级子系统.cbm → ... → 设备级.cbm
    ├── IFC0~N → *.ifc（DEV目录）
    └── SCH → project.sch → *.std + *.sld
```

### 引用键

| 键 | 含义 |
|---|---|
| `SUBSYSTEMS.NUM` / `SUBSYSTEM0~N` | 子系统 CBM 文件引用 |
| `IFC.NUM` / `IFC0~N` | IFC 文件引用（位于 DEV 目录） |
| `OBJECTMODELPOINTER` | 设备到 DEV 文件的引用 |
| `BASEFAMILY` | 基础族文件引用（.fam） |
| `SCH` | 逻辑模型引用（.sch） |

---

## 4. IFC 文件

变电工程包含 12 个 IFC 文件（示例工程），按专业分组：

| 专业 | 示例 IFC 文件 |
|---|---|
| 电气 | 电气二次、动力照明、接地、一次设备 |
| 建筑 | 建筑部分、警卫室建筑 |
| 结构 | 基础、结构 |
| 给排水 | 给排水消防、室内给排水 |
| 暖通 | 暖通布置 |
| 总图 | 总图 |

### FileDevRelation

`FileDevRelation.cbm` 记录 IFC 文件与设备的映射关系（示例工程共 24 条映射）。

---

## 5. 逻辑模型

```
project.cbm → SCH=project.sch → zjx.std + zjx.sld
```

| 文件 | 格式 | 职责 |
|---|---|---|
| `project.sch` | 文本 | 逻辑模型入口，引用 std 和 sld |
| `zjx.std` | XML | 变电站逻辑模型定义（电压等级、间隔、设备） |
| `zjx.sld` | SVG | 主接线图（电气元件符号和连接关系） |

---

## 6. 解析与可视化流程

```
读取 .gim 文件                                       ✅ 已实现
  ↓
检测 GIMPKGS 头部                                    ✅ 已实现
  ↓
定位 7z/ZIP 压缩数据偏移                             ✅ 已实现
  ↓
libarchive.js 解压 → Map<path, File>                ✅ 已实现
  ↓
遍历 CBM 树 → 发现 IFC 文件                          ✅ 已实现
  ↓
用户选择 IFC                                         ✅ 已实现
  ↓
web-ifc 解析 IFC → OBC Fragments 转换 → Three.js    ✅ 已实现
  ↓
点击拾取 → 高亮构件 + 展示 IFC 属性 + 关联 GIM 设备  ✅ 已实现
  ↓
IFC 加载完成后自动启动渐进式 MOD/STL 几何管线       ✅ 已实现
  ↓
缓存 DEV/PHM/MOD/STL 文件与几何引用链                ✅ 已实现
```

> 当前管线支持 **IFC + xml-mod + STL**（渐进式 DEV GLB 管线：IFC 优先加载，MOD/STL 后台编译为
> GLB 并逐实例渐进渲染，详见 [architecture.md](architecture.md) §关键设计）。PHM COLOR 已在 MOD/STL
> 实例加载和缓存回放时应用，详见 §9。

### 3D 渲染栈

| 层 | 模块 | 职责 | 状态 |
|---|---|---|---|
| 引擎 | `viewer/viewerEngine.ts` | OBC Components 初始化 | ✅ |
| 单例 | `viewer/viewerRuntime.ts` | Viewer 懒加载（首次加载 IFC 时创建） | ✅ |
| 加载 | `viewer/ifcLoader.ts` | IFC → Fragments 转换 | ✅ |
| 懒加载 | `viewer/ifcEntryLoader.ts` | 节点级按需加载（含 Fragments 缓存休眠分支） | ✅ |
| 拾取 | `viewer/selection.ts` + `viewer/highlight.ts` | raycast 高亮 + 构件选中 | ✅ |
| 相机 | `viewer/camera.ts` | 构件定位 | ✅ |
| 名称索引 | `viewer/ifcNameIndex.ts` | GUID→Name 批量查询 | ✅ |
| DEV 解析 | `desktop/src/gim/geometry/devParser.ts` | SOLIDMODELS + SUBDEVICES 两块（行主序矩阵） | ✅ |
| PHM 解析 | `desktop/src/gim/geometry/phmParser.ts` | SOLIDMODEL + TRANSFORMMATRIXn + COLORn + colorMaxA | ✅ |
| xml-mod 解析 | `desktop/src/gim/geometry/xmlModParser.ts` | XML primitive 14 类（11 强类型 + 3 弱 schema fallback） | ✅ |
| xml-mod 渲染 | `desktop/src/viewer/xmlModGeometry.ts` / `xmlModLoader.ts` | XmlModPrimitive → BufferGeometry + Transform + PHM 颜色覆盖 | ✅ |
| 引用链发现 | `desktop/src/services/modGeometryDiscovery.ts` | CBM → DEV → PHM → MOD/STL（递归 + 防环） | ✅ |
| 自动加载 | `desktop/src/services/progressiveGeometryService.ts` `runProgressiveDevGlbPipeline` | IFC 加载完成后后台渐进渲染全部 DEV 几何（按 DEV 编译） | ✅ |
| 几何缓存 | `desktop/src/services/gimExtractedCacheService.ts` `cacheGeometryFiles` | DEV/PHM/MOD/STL 文件 + 引用链缓存 | ✅ |
| STL 加载 | `desktop/src/viewer/stlLoader.ts` | Binary/ASCII STL → Three.js mesh；首次打开由 GLB 管线承载 | ✅ |

### 层级树↔3D 联动

选中设备节点 → 高亮对应 IFC 构件 + 相机定位。✅ 已实现

---

## 7. SQLite 缓存

### 变电工程表（核心 8 张 + 几何引用链 3 张）

| 表 | 用途 |
|---|---|
| `gim_project` | 项目记录（path, sha256, size, parser_version, project_type） |
| `substation_gim_entry` | GIM 内部文件清单 |
| `substation_cbm_node` | CBM 层级节点（树形结构，含 ifc_file/ifc_guid 引用） |
| `substation_ifc_model` | IFC 文件索引 |
| `substation_file_dev_entry` | IFC↔设备 CBM 映射 |
| `substation_fam_property` | FAM 分节属性缓存 |
| `substation_dev_property` | DEV 关键属性缓存 |
| `substation_fragment_cache` | IFC Fragments 文件缓存索引 |
| `substation_dev_solid_model` / `substation_dev_sub_device` | DEV → PHM/DEV 引用与装配矩阵 |
| `substation_phm_solid_model` | PHM → MOD/STL 引用、变换、颜色与 `phm_color_max_a` |

### 缓存命中流程

1. 用户选择 GIM → Rust 计算 sha256 + file_size
2. `validate_gim_cache`：检查 parser_version + file_size + IFC 缓存文件存在性
3. 命中 → 读取全部索引 → 恢复到 AppState → 直接渲染树和面板；按需从磁盘读取 DEV/PHM/MOD/STL 文件回放几何
4. 未命中 → 完整解压 → 解析 → 入库 → 缓存 IFC/DEV/PHM/MOD/STL 文件与几何引用链到本地磁盘

### 本地磁盘缓存

IFC + DEV/PHM/MOD/STL 几何文件写入 `app_data_dir/extracted/{id}/`，路径遍历防护。`cacheGeometryFiles` 在首次打开时缓存可达几何文件；`substation_dev_solid_model`、`substation_dev_sub_device`、`substation_phm_solid_model` 保存引用链与 PHM 颜色刻度。

---

## 8. 属性面板

右侧可折叠抽屉采用“概览 / 参数 / 关系 / 来源”四页签，属性字典和完整展示约定见
[design/property_dictionary.md](design/property_dictionary.md)：

- **概览**：CBM/DEV/IFC 的可读名称、实体类型、系统/空间状态、数量和关键业务字段；项目编号、Default、Building 等通用技术节点不再挤占首屏。
- **参数**：FAM 分节属性、DEV 设备信息、IFC Pset/工程量和 MOD primitive 字段；未知字段保留原值并默认折叠到“技术字段”。
- **关系**：父子节点、IFC 空间包含/继承、CBM↔IFC 关联以及几何来源关系。
- **来源**：CBM/DEV/FAM/PHM/MOD/STL/IFC/SLD 统一显示“定位/查看/切换”按钮，正文不直接显示 GUID 文件名和长路径；点击按钮再回到业务节点或图纸。
- **TRANSFORMMATRIX**：仅在技术字段中以等宽文本展示；几何加载时仍应用 DEV/PHM/CBM/SUBDEVICE 累积变换。
- **PHM COLOR**：在 MOD/STL 实例级应用 RGB、透明度和 A=0 不透明哨兵；`max(A)>100` 按字节制，否则按百分制。
- **EMPTY_DEVICE_XML / 装配节点无几何**：当前仍保留为 P1/P2 诊断待办，不伪造几何；解析结果不会阻塞其它设备展示。

缓存命中时（`currentFiles=null`）仍可显示 CBM/FAM/DEV 基础属性；来源按钮和 MOD/STL 按需回放复用磁盘缓存与几何引用链。

---

## 9. 下一步实现路径

> 基于 [13-geometry-ir-schema.md](schema/13-geometry-ir-schema.md) 的 IR 草案与 [10-substation-mod-grammar.md](schema/10-substation-mod-grammar.md) 的 primitive grammar，按优先级分阶段实施。
>
> **P0 已完成**：IR schema + PHM/DEV/xml-mod parser + 14 类 primitive 渲染 + xml-mod 自动加载 + 缓存命中场景回放 + 属性字典/来源按钮；当前工作树验证为 `npm test` 544/544，样本回归 12/12。

### 9.1 P0（已完成）

| 任务 | 输入 | 输出 | 关键约束 |
|---|---|---|---|
| ~~IR schema 落地~~ | [13-geometry-ir-schema.md](schema/13-geometry-ir-schema.md) §2-§4 | `desktop/src/gim/geometry/ir.ts` | ✅ 5 kind 联合 + 14 类 primitive 类型 |
| ~~PHM 解析器与颜色刻度~~ | `.phm` 文件 | `desktop/src/gim/geometry/phmParser.ts` | ✅ SOLIDMODELn + TRANSFORMMATRIXn + COLORn 一一对应，并统计 `colorMaxA` |
| ~~xml-mod parser~~ | 14 类 primitive | `desktop/src/gim/geometry/xmlModParser.ts` | ✅ 覆盖率 99.86%，11 强类型 + 3 弱 schema fallback |
| ~~xml-mod 渲染~~ | XmlModEntity[] → Three.js geometry | `desktop/src/viewer/xmlModLoader.ts` / `xmlModGeometry.ts` | ✅ 与 IFC 渲染栈共存，独立 `loadedXmlModGroups` 跟踪；PHM 颜色覆盖隔离共享材质 |
| ~~DEV/PHM/MOD/STL 文件磁盘缓存~~ | 首次打开时缓存 | `desktop/src/services/gimExtractedCacheService.ts` `cacheGeometryFiles` | ✅ 复用缓存写入，路径遍历防护；几何引用链同步入库 |
| ~~xml-mod 自动加载~~ | IFC 加载完成后 | `desktop/src/services/progressiveGeometryService.ts` | ✅ 渐进式 DEV GLB 管线统一处理 MOD/STL |
| ~~缓存命中场景回放~~ | `currentFiles=null` | `desktop/src/services/nodeInteractionService.ts` `buildGeometryFilesMapFromCache` / `ensureModFilesInCacheMap` | ✅ 通过 `readCachedIfc` 从磁盘按需读取，缓存键含几何版本 |
| ~~属性语义与来源路由~~ | CBM/FAM/DEV/IFC 属性 | `desktop/src/ui/propertyDictionary.ts` / `propsDrawer.ts` / `cbmTreeView.ts` | ✅ 四页签、P0/P1/P2 字典、技术字段折叠、来源按钮跳转 |

### 9.2 P1（MVP 可选，影响 STL 展示能力）

| 任务 | 输入 | 输出 | 关键约束 |
|---|---|---|---|
| **STL 渲染增强** | 变电 STL（含 binary/ASCII 兼容） | `desktop/src/viewer/stlLoader.ts` + 渐进式 GLB | 基础加载与首次打开已完成；缓存命中默认按需加载，仍需大样本性能验收 |
| ~~**PHM COLOR 应用**~~ | PHM COLORn 字段 | `desktop/src/viewer/xmlModGeometry.ts` `applyPhmColorOverride` | ✅ 已完成；实例材质 clone，A=0 哨兵、百分制/字节制均有测试 |
| **EMPTY_DEVICE_XML 提示** | 44 个孤儿 MOD | UI 提示 + 诊断（reason: `empty-device-xml`） | 不参与渲染但应提示，尚未实现 |

### 9.3 P2（体验补齐）

| 任务 | 输入 | 输出 | 关键约束 |
|---|---|---|---|
| **装配节点无几何提示** | 14 个无 SOLIDMODEL PHM | UI 提示 + 诊断（reason: `assembly-node-without-own-geometry`） | 装配节点自身无几何但子设备几何完整，与 `phm-no-solidmodel` 区分 |
| **缓存命中回放 SQLite 化** | geometry_source 表（建议） | 缓存命中时直接从 SQLite 恢复 IR | 正式 DDL 另起 16-geometry-cache-schema.md（待建）；当前通过磁盘缓存 + 按需读取替代 |
| **节点联动扩展** | CBM 树 → MOD/STL 高亮 | 选中设备节点 → 高亮对应 MOD primitive + 相机定位 | 与现有 IFC 联动模式一致 |

### 9.4 关键约束（来自分析报告）

| 约束 | 来源 | 影响 |
|---|---|---|
| 14 类 primitive 覆盖率 99.86% | [10-substation-mod-grammar.md](schema/10-substation-mod-grammar.md) | 9 类低样本 primitive 需保留弱 schema fallback |
| 86 个 PHM 同时引用 STL + MOD | [12-stl-static-survey.md](schema/12-stl-static-survey.md) §5 | 当前实例级材质覆盖已隔离；仍需评估重复渲染风险（建议 MOD-first 或 STL-first 策略） |
| STL 以 binary 为主、个别样本含 ASCII | [12-stl-static-survey.md](schema/12-stl-static-survey.md) | `stlLoader` 先按长度公式判定 binary，再兼容 `solid` ASCII 分支 |
| PHM TransformMatrix 随导出软件变化 | [09-transform-chain-analysis.md](schema/09-transform-chain-analysis.md) | 运行时无条件应用 DEV/PHM/CBM/SUBDEVICE 两级累积矩阵；不能写死为 IDENTITY |
| F3System 多 FAM 引用 145 个文件 × 4 FAM | [06-cbm-fam-consistency.md](schema/06-cbm-fam-consistency.md) §3.3 | F3System 节点属性聚合需考虑多 FAM 合并展示 |
| Geometry IR 不在 SQLite 范围 | [13-geometry-ir-schema.md](schema/13-geometry-ir-schema.md) §1.3 | 正式 DDL 另起 16-geometry-cache-schema.md |

### 9.5 与现有 IFC 路径的兼容性

| 兼容点 | 策略 |
|---|---|
| 现有 `ifcLoader.ts` | 保留，IR 通过 `kind: "ifc"` 复用 |
| `CbmNode` 类型 | 保留 `ifcFile` / `ifcGuid` 字段，IR 不替代，仅消费 path/entityName/devPath |
| `AppState` | 新增可选字段 `geometryBundles` / `cachedGeometryPaths`（向后兼容） |
| SQLite 表 | 现有 7 张表 + fragments_cache 保留，新增 `geometry_source` 表为可选缓存（不破坏现有缓存命中） |
| 渲染栈 | IFC 走 OBC Fragments，MOD/STL 走 Three.js 直接 geometry，两者共存于同一 scene |
