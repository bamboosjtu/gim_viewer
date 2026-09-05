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
| IFC Spatial Semantic Core（selective/two-pass + placement 闭包） | ✅ 已实现（v1） | `desktop/src/gim/ifcSpatialParser.ts`；启动阶段仅保留空间/导航/关系/单位，属性由 Fragments 按需读取 |
| IFC 3D 渲染（OBC + web-ifc + Three.js） | ✅ 已实现 | `desktop/src/viewer/viewerEngine.ts` / `ifcLoader.ts` / `ifcEntryLoader.ts` |
| 节点级 IFC 懒加载 + Fragments 缓存 | ✅ 已实现 | `desktop/src/viewer/ifcEntryLoader.ts`（`.frag` 缓存） |
| 3D 点击拾取 + 高亮 + 相机定位 | ✅ 已实现 | `desktop/src/viewer/selection.ts` / `highlight.ts` / `camera.ts` |
| 层级树↔3D 联动 | ✅ 已实现 | `desktop/src/services/nodeInteractionService.ts` |
| 属性面板（CBM/FAM/DEV/IFC + 语义字典） | ✅ 已实现 | `desktop/src/ui/propsDrawer.ts` / `propertyDictionary.ts` |
| SQLite 缓存（索引、属性、Fragments、几何引用链） | ✅ 已实现 | `desktop/src-tauri/src/db.rs`（变电 `SUBSTATION_PARSER_VERSION=gim-substation-parser-v22`；线路使用独立 domain） |
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

- 变电语义缓存使用独立的 `SUBSTATION_PARSER_VERSION=gim-substation-parser-v22`；线路使用 `LINE_PARSER_VERSION=gim-line-parser-v1`。旧 `PARSER_VERSION=gim-parser-v22` 字段仅作兼容/诊断，并按工程类型迁移，不会因变电 Semantic Core 升级而误使线路缓存失效。本版本引入 IFC Spatial Semantic Core selective/two-pass scan：Pass1 只保留空间/导航对象、必要 IFCREL、单位并收集 placement 候选偏移，Pass2 只物化实际引用的 placement 闭包；属性集、工程量、材质、分类、类型和分组不进入启动索引。几何 GLB 缓存版本为 `geometry-cache-v5-dev-status`，与语义版本独立。Fragments 缓存另绑定源 GIM SHA-256 与 `fragments-cache-v6` 运行时版本，旧记录缺少源 SHA 时视为失效。
- 首次打开 GIM 时，通过 `cacheGeometryFiles` 缓存 DEV/PHM/MOD/STL 文件到 `app_data_dir/extracted/{projectId}/`（复用 `writeCacheFile`，沿用路径遍历防护）。
- IFC 加载完成后自动启动渐进式 DEV GLB 管线（`progressiveGeometryService`），按 DEV 粒度一次解析、落盘并逐实例渲染 IFC 之外的 MOD/STL；用户无需逐节点点击才能看到几何。
- 每个 unique DEV 在 `_manifest.json` 中记录 `status=glb|empty` 与字节数。缓存命中场景（`currentFiles=null`）先按 manifest 建立 DEV→CBM placement 映射，以 GIMR 二进制 envelope 分批读取 GLB；同一 DEV 的 GLB 最多读取一次，`empty` 不读取也不触发回退，随后每个 placement 独立加载并应用 CBM 矩阵。单个 DEV 的 GLB 缺失、大小/header 不符、真实读取或解析失败只隔离该 DEV，并按 DEV path 做 scoped 原始 MOD/STL 回退；manifest/source 结构损坏或版本失效才重建整个 geometry cache。
- 旧缓存或写入/序列化未完成时不提交几何版本标记；geometry cache 与 CBM/IFC 语义缓存独立，几何版本失效不会重新解压或重建语义索引。partial failure 的成功 GLB 保留在场景中，避免将单个坏 DEV 放大为全项目 MOD/STL 长尾。
- 缓存命中场景的节点按需回放仍由 `nodeInteractionService` 通过 `buildGeometryFilesMapFromCache` / `ensureModFilesInCacheMap` 读取 DEV/PHM/MOD/STL；GLB fast path 不可用时保留原始文件解析。
- PHM 的 `COLORn` 与文件级 `max(A)` 已随几何引用链缓存；重放时对 MOD/STL 实例应用 RGB、透明度和 A=0 不透明哨兵规则。

> 未完成事项与下一步性能/功能工作统一维护在 [dev-log.md](dev-log.md)；本文件只描述当前实现和稳定边界。

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

### IFC Spatial Semantic Core v1

启动阶段采用两遍选择性扫描（`ifcSpatialParser.ts`）：

1. Pass1 只保留空间/导航对象、单位和用于 containment、decomposition、host、
   boundary 及关系计数的 IFCREL；IFC 属性、材质、分类、类型和分组只保留诊断计数。
2. Pass2 从导航对象实际引用的 `ObjectPlacement` 出发，按引用闭包物化
   `IFCLOCALPLACEMENT`、`IFCAXIS2PLACEMENT*`、点和方向；无关的几何点/方向不进入
   长期 detail map。
3. 选中构件后的参数详情由 Fragments `getItemsData()` 按需读取，避免启动时构造
   全量属性对象。

空间对象、直接/分解/宿主关系和 CBM↔IFC 链接的字段定义与样本边界见
[Schema 目录](schema/README.md)；性能待办不在本文件重复记录。

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
| 几何缓存 | `desktop/src/services/gimExtractedCacheService.ts` `cacheGeometryFiles` / `desktop/src/services/modAutoLoadService.ts` | DEV/PHM/MOD/STL 文件 + 引用链缓存；warm 先走 DEV GLB manifest/batch fast path | ✅ |
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
3. 命中 → 读取全部索引 → 恢复到 AppState → 直接渲染树和面板；几何恢复先读取 DEV GLB manifest，按 unique DEV 二进制批读并实例化 placement，只有 fast path 不完整或读取/解析失败时才按需读取 DEV/PHM/MOD/STL 原始文件
4. 未命中 → 完整解压 → 解析 → 入库 → 缓存 IFC/DEV/PHM/MOD/STL 文件与几何引用链到本地磁盘

### 本地磁盘缓存

IFC + DEV/PHM/MOD/STL 几何文件写入 `app_data_dir/extracted/{id}/`，路径遍历防护。`cacheGeometryFiles` 在首次打开时缓存可达几何文件；`substation_dev_solid_model`、`substation_dev_sub_device`、`substation_phm_solid_model` 保存引用链与 PHM 颜色刻度。渐进管线另在 `app_data_dir/glbcache/{id}/` 写入 DEV 粒度 GLB 与 `_manifest.json`：每个 unique DEV 必须有 `status=glb`（带 size）或 `status=empty`（size=0），仅 manifest 完整且版本标记写入成功才算 warm cache 完整。

### 7.1 DEV GLB warm fast path（geometry-cache-v5）

- manifest 以大小写不敏感的 `DEV/<name>.dev` 为唯一键；同一 DEV 被多个 CBM placement 引用时只批量读取一次 GLB bytes，随后每个 placement 独立 `loadDevGlb`，继续应用各自 CBM 累积矩阵。
- Rust `batch_read_glb_files` 返回 GIMR v2 二进制 envelope，前端按最多 256 个文件或预计 64 MiB 分批；不使用旧 JSON 数组响应。
- `empty` 是合法确定性结果：不读文件、不解析、不触发原始 MOD fallback。单个 DEV 的 manifest 缺项、GLB 缺失/截断/header 或 size 不符、真实读取/解析错误只进入该 DEV 的 scoped fallback；manifest/source 结构损坏或版本失效才重建整个 geometry cache。
- profile 随 `finishModStl` 写入诊断：`cbmInstanceCount`、`uniqueDevCount`、`glbDevCount`、`emptyDevCount`、`glbBatchReadMs`、`glbReadBytes`、`glbParseCount`、`glbParseMs`、`rawModFallbackCount`、`failedDevCount`、`failedDevPaths`、`failureType`、`partialRawFallbackCount`、`partialRawFallbackInstanceCount`、`successfulGlbDevCount`、`successfulGlbInstanceCount`、`fullProjectRawFallbackCount` 及 scoped fallback 的耗时/行数。
- `GEOMETRY_CACHE_VERSION` 由 `geometry-cache-v4-phm-color` bump 为 `geometry-cache-v5-dev-status`；旧 manifest（缺少 status）会被视为不完整并重新生成。

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

## 9. 当前实现边界

### 9.1 语义与几何管线

- IFC Spatial Semantic Core 采用 selective/two-pass scan：首遍只保留空间/导航对象、必要关系和单位；次遍只物化导航对象引用到的 placement 闭包。属性集、工程量、材质、分类、类型和分组由 Fragments 在属性面板按需读取。
- IFC 通过 OBC Fragments 加载到 Three.js；DEV→PHM→MOD/STL 通过 Geometry IR 和渐进式 DEV GLB 管线渲染到同一场景。PHM 的变换矩阵和颜色覆盖在实例级应用。
- 每个 unique DEV 的几何缓存 manifest 记录 `status=glb|empty`。合法 `empty` 是成功结果；单个 DEV 的 GLB 读取或解析失败只触发该 DEV 的 scoped raw MOD/STL fallback，整体 manifest/source 损坏才重建几何缓存。

### 9.2 缓存与交互

- 语义缓存按线路/变电工程域隔离版本；几何缓存和 Fragments 缓存拥有独立版本与源 SHA 校验。几何缓存失效不会重新解压或重建 CBM、FAM、DEV 和 IFC Spatial 索引。
- 首次打开完成 IFC 首批加载后，几何在后台渐进显示；缓存命中时从磁盘 manifest 和二进制 batch 恢复。项目切换由 `ProjectLoadSession` 和 geometry token 隔离旧任务。
- 属性抽屉提供“概览 / 参数 / 关系 / 来源”四页签，技术标识和长路径折叠，来源按钮负责定位到可读业务对象或图纸。

### 9.3 已知边界

- 无几何的 MOD 或没有自有 `SOLIDMODEL` 的装配节点当前不伪造模型，只保留空结果；明确原因提示列在 [dev-log.md](dev-log.md)。
- Fragments 缓存代码可灰度使用但默认关闭；线路不启用独立 3D Viewer。
- 变电数据格式与导出工具存在差异，新增样本的字段语义以 [Schema 研究](schema/README.md) 的跨样本证据为准。

未完成的性能提升、功能特性和产品决策不在本文件展开，统一维护在 [dev-log.md](dev-log.md)。
