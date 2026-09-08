# 技术架构

> GIM 阅读器的技术选型、源码结构与模块关系。

---

## 1. 技术选型

| 层 | 技术 | 版本 | 用途 |
|---|---|---|---|
| 桌面框架 | Tauri 2 | 2.x | Rust 后端 + Vite 前端，离线运行，portable ZIP |
| 3D 渲染 | @thatopen/components (OBC) | ^3.4.6 | IFC Viewer 引擎 |
| IFC 解析 | web-ifc | ^0.0.77 | WASM 解析 IFC 二进制 |
| 3D 图形 | Three.js | ^0.184.0 | WebGL 渲染层 |
| 地图引擎 | maplibre-gl | ^5.24.0 | 线路地图底图（OSM raster） |
| 离线瓦片预研 | pmtiles | ^4.4.1 | PMTiles 矢量瓦片（默认关闭） |
| 原生压缩包解压 | sevenz-rust + zip | 0.6 / 2.x | Tauri 磁盘优先逐条解压（生产路径） |
| 浏览器回退解压 | libarchive.js | ^2.0.2 | WASM，支持 7z/ZIP/RAR |
| 本地数据库 | rusqlite | 0.31 | bundled SQLite，Rust 侧管理 |
| 相机控制 | camera-controls | ^3.1.2 | Three.js 相机扩展 |
| 构建 | Vite + TypeScript 5.3 | — | 严格模式 |

### WASM 资产

| 文件 | 位置 | 用途 |
|---|---|---|
| `web-ifc.wasm` / `web-ifc-mt.wasm` | `public/wasm/` | IFC 解析（从 node_modules 复制，`scripts/copy-web-ifc-wasm.mjs`） |
| `libarchive.wasm` + `worker-bundle.js` | `public/` | 7z/ZIP 解压 Worker |

### Tauri 配置要点

- 窗口 `visible: false`，启动后 `getCurrentWindow().show()` 显示，消除白屏
- CSP：`script-src 'self' 'wasm-unsafe-eval'`、`connect-src 'self' ipc: http://ipc.localhost https://tile.openstreetmap.org`、`img-src 'self' data: blob: https://tile.openstreetmap.org`
- 构建目标：`nsis`（Windows 安装包）

---

## 2. 源码结构

```
src/
├─ app/           应用入口与全局状态
│  ├─ main.ts         入口（调用 bootstrap）
│  ├─ bootstrap.ts   启动流程（懒加载 Viewer，绑定按钮事件，Ctrl+Shift+D 诊断）
│  └─ state.ts        AppState 全局状态
├─ config/        功能开关与调试配置
│  ├─ features.ts     ENABLE_MAPLIBRE_EXPERIMENT / LINE_BASEMAP_MODE / ENABLE_FRAGMENTS_CACHE / ENABLE_PMTILES_EXPERIMENT
│  └─ debug.ts        DEBUG_RUNTIME_LOGS / DEBUG_IFC_LOAD / DEBUG_GIM_CACHE / DEBUG_LINE_MAP / DEBUG_FRAGMENTS
├─ gim/           GIM 解析层（纯逻辑，无 UI/Viewer 依赖）
│  ├─ gimExtractor.ts # 浏览器 GIMPKG* 头部检测 + WASM 解压 + 文件展平
│  ├─ modelIdentity.ts # IFC entry_path 规范化与稳定 runtime modelId
│  ├─ cbmParser.ts    # 变电 CBM 层级树解析 + parseKeyValue
│  ├─ famParser.ts    # 变电 FAM 分节属性解析
│  ├─ fileDevParser.ts# 变电 FileDevRelation 解析
│  ├─ gimIndexer.ts   # IFC 发现 + GUID 索引 + 名称查询
│  ├─ lineCbmParser.ts # 线路 CBM 解析（支持 13 种引用键）
│  ├─ lineFamParser.ts # 线路 FAM 解析
│  ├─ lineDevParser.ts # 线路 DEV 解析
│  ├─ lineMapData.ts   # 线路地图数据提取（塔位/导线/跨越点 + 统计）
│  ├─ lineAttributeTypes.ts # 线路属性共享类型
│  ├─ linePathNormalize.ts # 路径归一化（file_name_lower 统一键空间）
│  ├─ lineRefKind.ts   # 线路引用类型常量（10 种）
│  ├─ gimGraphTypes.ts # 线路图节点/边类型
│  ├─ projectType.ts   # 解压内容校验/回退工程类型检测
  ├─ entityName.ts    # ENTITYNAME 大小写归一化（十样本实证三态变体，docs/schema/04）
│  └─ types.ts         # 统一类型定义
├─ viewer/        3D 渲染层（仅变电工程使用）
│  ├─ viewerEngine.ts  # OBC 引擎初始化
│  ├─ viewerRuntime.ts# Viewer 单例懒加载
│  ├─ ifcLoader.ts    # IFC 加载 + Fragments 转换
│  ├─ ifcEntryLoader.ts # 节点级 IFC 懒加载（含 Fragments 缓存休眠分支）
│  ├─ ifcNameIndex.ts # GUID→Name 批量查询
│  ├─ highlight.ts    # 构件高亮 + 拾取
│  ├─ camera.ts       # 相机定位
│  ├─ selection.ts    # 点击拾取事件
│  └─ wasmAssets.ts    # web-ifc WASM 路径解析
├─ ui/            纯 UI 层（不直接碰数据库和 IFC Loader）
│  ├─ dom.ts          # DOM 元素引用
│  ├─ tabs.ts         # 标签页切换
│  ├─ cbmTreeView.ts  # 变电 CBM 层级树渲染
│  ├─ fileDevView.ts  # 文件设备面板渲染
│  ├─ propsDrawer.ts  # 属性面板（基础版 + 完整版）
│  ├─ cacheManagerView.ts # 缓存管理 modal
│  ├─ modelList.ts     # 模型列表
│  ├─ lineProjectView.ts # 线路工程面板（树 + 地图 + 属性）
│  ├─ lineMapView.ts     # Canvas 地图渲染（塔位/导线/跨越点/网格/比例尺/交互）
│  ├─ lineMapBaseLayer.ts # MapLibre 底图层（probe + overlay 桥接 + OSM/empty/pmtiles）
│  ├─ lineMapProjection.ts # 投影接口（MapLibre / Canvas）
│  ├─ lineMapStyle.ts   # MapLibre style 工厂（empty / osm-online / pmtiles）
│  └─ lineMapPmtiles.ts  # PMTiles protocol 管理（引用计数）
├─ services/      业务编排层
│  ├─ openGimService.ts          # 顶层入口：Shared Core 后 dispatch 到 Runtime
│  ├─ gimSourceService.ts        # source header/magic、source identity 与类型映射
│  ├─ gimOpenCore.ts             # Shared Core：session、解压输入、清理/性能边界
│  ├─ powerlineRuntime.ts        # 线路 cache/Worker/graph/属性/地图生命周期
│  ├─ substationRuntime.ts       # 变电 CBM/IFC/Fragments/DEV/MOD/STL 生命周期
│  ├─ substationBackgroundRuntime.ts # 变电 post-interactive 轻/重任务协调
│  ├─ substationSpatialSemanticCache.ts # 变电空间语义 snapshot/validate/hydrate
│  ├─ devGeometryTelemetry.ts    # DEV cold/warm 聚合阶段诊断
│  ├─ openIfcService.ts          # IFC 文件打开
│  ├─ nodeInteractionService.ts  # 节点点击懒加载 IFC
│  ├─ gimIndexPersistenceService.ts # 变电索引入库 payload 构建
│  ├─ gimIndexRestoreService.ts  # 变电索引恢复到 AppState
│  ├─ gimExtractedCacheService.ts# IFC 文件本地缓存
│  ├─ lineGraphPersistenceService.ts # 线路图入库（graph + FAM/DEV 单事务）
│  ├─ lineGraphRestoreService.ts # 线路图恢复
│  ├─ lineAttrPersistenceService.ts # 线路 FAM/DEV 属性入库
│  ├─ lineAttrRestoreService.ts # 线路属性恢复
│  ├─ basemapStatusService.ts   # 底图运行状态（内存单例，供诊断使用）
│  ├─ diagnosticSummaryService.ts # 诊断摘要（Markdown 风格）
│  └─ projectCleanupService.ts  # 清空场景
├─ desktop/       Tauri 桥接层
│  ├─ runtime.ts      # isTauri() 环境检测
│  ├─ fileDialog.ts   # 文件选择对话框
│  ├─ fileReader.ts   # 文件读取（getFileInfo/readFileHead/readFileBytes）
│  └─ database.ts     # SQLite 命令前端包装
├─ shared/
│  └─ html.ts         # HTML 转义工具
└─ utils/
   └─ logger.ts       # debugLog/debugWarn/debugError（按分类开关）
```

```
desktop/src-tauri/
├─ Cargo.toml
├─ tauri.conf.json    # CSP + 窗口配置
└─ src/
   ├─ lib.rs          # Tauri setup + invoke_handler 注册
   ├─ main.rs         # 入口
   └─ db.rs           # SQLite 全部操作（表结构 + 命令）
```

---

## 3. 分层边界

```
┌─────────────────────────────────────────┐
│  app/        启动 + 全局状态              │
├─────────────────────────────────────────┤
│  services/   业务编排（调用 gim/viewer/ui/desktop）│
├──────────────┬──────────────┬──────────┤
│  gim/        │  viewer/     │  ui/      │
│  纯解析       │  纯 3D       │  纯 DOM   │
├──────────────┴──────────────┴──────────┤
│  desktop/    Tauri 桥接                  │
├─────────────────────────────────────────┤
│  desktop/src-tauri/  Rust 后端（SQLite + 文件）  │
└─────────────────────────────────────────┘
```

**分层规则**：

- `gim/` 不依赖 `services/`、`viewer/`、`ui/`、`desktop/`
- `viewer/` 不依赖 `services/`、`ui/`
- `ui/` 不直接碰数据库和 IFC Loader（通过 services 间接调用）
- `services/gimOpenCore.ts` 只提供共用基础设施；不持有 Line/Substation domain model
- `services/powerlineRuntime.ts` 与 `services/substationRuntime.ts` 互不依赖
- `services/openGimService.ts` 只负责入口、source identity/session 和 Runtime dispatch
- `services/` 编排 `gim/` + `viewer/` + `ui/` + `desktop/`
- `desktop/` 仅封装 Tauri invoke

---

## 4. SQLite 表结构

### 变电工程表（9 张 + 共享项目表，2026-08 起统一以 `substation_` 前缀命名）

| 表 | 用途 |
|---|---|
| `gim_project` | 项目记录（共享表：path, sha256, size, parser_version, project_type） |
| `substation_gim_entry` | GIM 内部文件清单（entry_path, entry_type, local_cache_path） |
| `substation_cbm_node` | CBM 层级节点（树形结构，含 ifc_file/ifc_guid 引用） |
| `substation_ifc_model` | IFC 文件索引（model_id, name, entry_path） |
| `substation_file_dev_entry` | IFC 文件↔设备 CBM 映射 |
| `substation_fam_property` | FAM 分节属性缓存（source_path, section_name, key, value） |
| `substation_dev_property` | DEV 关键属性缓存（dev_path, key, value） |
| `substation_dev_solid_model` | DEV→PHM 几何引用链缓存 |
| `substation_dev_sub_device` | DEV 子设备引用链缓存 |
| `substation_phm_solid_model` | PHM→MOD/STL 几何引用链缓存 |

### 线路工程表（6 张，2026-08 起统一以 `powerline_` 前缀命名）

| 表 | 用途 |
|---|---|
| `powerline_cbm_node` | 线路 CBM 节点（含 F1-F4System / TOWER / WIRE / CROSS） |
| `powerline_cbm_child` | 线路 CBM 父子关系 |
| `powerline_cbm_ref` | 线路 CBM 引用（含 normalized_ref_value / file_name_lower） |
| `powerline_file_stat` | 线路文件统计 |
| `powerline_fam_property` | 线路 FAM 属性缓存 |
| `powerline_dev_property` | 线路 DEV 属性缓存 |

### 休眠表（Fragments 缓存，默认关闭）

| 表名 | 说明 |
|---|---|
| `substation_fragment_cache` | Fragments 二进制缓存（受 `ENABLE_FRAGMENTS_CACHE=false` 控制，绑定源 GIM SHA-256） |

### 解析缓存版本域与失效机制

- 定义在 `desktop/src-tauri/src/db.rs`：`LINE_PARSER_VERSION = "gim-line-parser-v1"`、`SUBSTATION_PARSER_VERSION = "gim-substation-parser-v22"`；`PARSER_VERSION = "gim-parser-v22"` 仅保留兼容/诊断
- `validate_gim_cache` 按 `project_type` 校验对应 domain 字段；变电 Semantic Core 升级不会使线路 graph/属性/semantic pack 失效
- 对应 domain 版本不匹配 → 缓存无效 → 完整解压/重建对应工程索引；旧共享版本按工程类型兼容迁移
- 2026-08 v17：表名规范化迁移——变电表统一 `substation_` 前缀、线路表统一
  `powerline_` 前缀（`gim_project` 为两类工程共用的项目记录表，保持中性命名）；
  init_db 自动 DROP 旧命名表回收空间

---

## 5. 功能开关

定义在 `src/config/features.ts`：

| 开关 | 默认 | 说明 |
|---|---|---|
| `ENABLE_FRAGMENTS_CACHE` | `false` | Fragments 缓存（休眠） |
| `ENABLE_MAPLIBRE_EXPERIMENT` | `true` | MapLibre overlay（MVP 默认启用） |
| `ENABLE_PMTILES_EXPERIMENT` | `false` | PMTiles 离线瓦片预研（休眠） |
| `LINE_BASEMAP_MODE` | `'osm-online'` | 底图模式（MVP 统一 OSM） |

---

## 6. 构建命令

```bash
npm run dev          # Vite 开发服务器（浏览器模式）
npm run tauri:dev    # Tauri 开发模式（桌面应用）
npm run build        # TypeScript 编译 + Vite 构建
npm run tauri:build  # 构建 NSIS 安装版 + 内置 WebView2 的 portable ZIP
```

构建前自动执行 `scripts/copy-web-ifc-wasm.mjs` 复制 WASM 文件到 `public/wasm/`。
首次发布构建还会执行 `scripts/prepare-webview2-fixed-runtime.mjs`，从微软官方下载并缓存
x64 WebView2 Fixed Runtime。构建完成后 `scripts/package-portable.mjs` 将 release exe 与
`webview2-fixed-runtime/` 组装为 portable 目录和 ZIP，并校验运行时核心文件；不能将 NSIS
安装器或裸 `target/release/gim-viewer.exe` 误称为 portable 版本。
Fixed Runtime 仅通过 `tauri.portable.conf.json` 注入 release 构建，`tauri:dev` 仍使用系统运行时。

---

## 7. 关键设计

### 轻量启动

`main.ts` → `bootstrap.ts`：不立即创建 Viewer，3D 引擎按需懒加载。

### GIM 打开流程与 Runtime 边界

当前入口按以下顺序执行：

```text
inspect source
  → source identity / sha256 / magic / project type
  → cleanup / ProjectLoadSession
  → dispatch
      ├─ openPowerlineProject
      └─ openSubstationProject
```

Shared Core 位于 `gimSourceService.ts`、`gimOpenCore.ts` 和桌面桥接基础设施中，负责
读取 GIM header、归一化 source identity、文件授权、SHA、解压 primitive、路径/缓存
桥接、清理和 session/perf guard。`GIMPKGT` 选择 `transmission_line`，`GIMPKGS` 选择
`substation`；选择结果不从 SQLite 的旧 `project_type` 反推。

`detectGimProjectType` 仍在解压后运行，但定位为内容校验、未知 magic 的 fallback 和
magic/content mismatch 诊断。`hybrid` 只作为诊断状态：source magic 已知时由 magic
优先，magic 未知时回退到 Substation Runtime，不新增第三个 Runtime。若 source inspection
与 extraction 观察到的非空 magic 不一致，Shared Core 立即以
`SOURCE_CHANGED_DURING_OPEN` 安全失败，不进入任何 Runtime，也不把解压结果绑定到旧的
source identity。

Powerline Runtime 独立拥有线路 cache validation、semantic pack/SQLite warm path、冷
Line Parser Worker、GimGraph/FAM/DEV 属性提交和地图/树 UI。Substation Runtime 独立拥有
CBM/FAM/DEV/FileDevRelation、IFC/Fragments、DEV GLB 以及 MOD/STL 回退和 3D/tree UI。
两边共用 `ProjectLoadSession` guard，所有异步提交仍须通过 `state.isCurrentSession`。

变电 Runtime 的产品就绪时刻按依赖拆分，而不是把全部 IFC 作为首屏门槛：

```text
CBM/FAM/DEV/FileDevRelation
  → coreSemanticReady
  → 基础 tree/search/properties
  → 首个可用 IFC + coordinate anchor + camera/selection 初始化
  → firstUsableGeometryReady / interactive
  → 变电 Background Coordinator 排队：空间 cache restore / STD-SLD / 其余 IFC
  → remaining IFC 按既有顺序串行完成 / allIfcReady
  → cache miss 的空间 semantic rebuild 与 DEV geometry 进入串行 heavy lane
  → fullModelReady
```

`spatialSemanticReady` 是独立的 IFC 空间语义投影：`interactive` 后先读取独立的
`substation-spatial-semantic-v1` derived snapshot；命中时只做 JSON deserialize、引用校验
和 Map hydrate，不重新扫描 IFC STEP。miss、损坏、版本/source SHA 不匹配或引用完整性失败
都会进入 cache miss，等 `allIfcReady` 后由 Background Coordinator 串行执行 rebuild，成功
后再通过原子缓存写入替换 snapshot。首个有效 Fragments 模型足以建立当前坐标锚点；仅当
该尝试没有可用基准时，后台尾部才做一次 coordinate fallback。
STD/SLD 解析或缓存恢复、SLD 渲染和 gridId 联动注册也在 `interactive` 之后才启动；
冷启动的 GIM index、文件/几何引用链持久化同样由 coordinator 延后到 all-IFC 之后的低优先级
任务。remaining IFC 仍按既有顺序串行加载；空间 cache restore、STD/SLD 等轻任务通过显式
队列管理，空间 rebuild 与 DEV geometry 不并发。各自失败只降级对应功能或缓存写入，不回滚
已经可交互的 IFC。
每个阶段继续携带同一个 `ProjectLoadSession`，旧工程的 IFC、空间语义和几何结果不能提交
到新工程。缓存命中和冷启动遵循相同的时刻语义。

### 缓存命中短路

二次打开同一 GIM 时：

1. Shared Core 读取 source header/magic，并由 Rust 计算 sha256 + file_size
2. 已选 Runtime 以显式 `expected_project_type` 调用 `validate_gim_cache`；SQLite 中的旧
   `project_type` 只用于 mismatch 诊断，不决定校验分支
3. 线路命中 → semantic pack/SQLite graph + 属性恢复 → 地图/树 UI
4. 变电命中 → CBM/FAM/DEV/FileDevRelation 恢复并提交 `coreSemanticReady` → 基础
   tree/search/properties → 首个 IFC 后 `firstUsableGeometryReady` / `interactive` →
   coordinator 尝试空间 snapshot restore、STD/SLD；其余 IFC 串行加载并记录 `allIfcReady`；
   spatial miss 完成 rebuild 后才与 DEV geometry 进入串行 heavy lane
5. 语义缓存未命中才提取原始 GIM；几何域的既有版本/manifest 策略保持不变

### 节点级 IFC 懒加载

点击节点 → 显示基础属性（CBM/FAM/DEV，优先 currentFiles 回退缓存）→ 懒加载对应 IFC → 高亮 + 完整属性

Tauri 首次解包不把整个归档复制到前端：`extract_gim_archive(file_path, project_id)` 返回
manifest，条目内容由 `DiskBackedFile` 在 `text()` / `arrayBuffer()` 时调用
`read_cached_entry(project_id, entry_path)` 按需读取；浏览器路径仍使用内存 `Map<File>`。

### 渐进式 DEV GLB 几何管线（首次打开）

`src/services/progressiveGeometryService.ts`，`allIfcReady` 后由变电 Background Coordinator
以后台 heavy task 启动：

- **统一序列化与渲染**：按唯一 DEV 迭代 `serializeDevToGlb（MOD/STL 只解析 1 遍）
  → writeGlbFile 落盘 → 逐 CBM 实例渲染到场景`，替代原
  "MOD 逐实例解析渲染 + GLB 序列化"两遍解析流程（首次打开耗时约减半）
- **渐进显示**：每编译一个 DEV 场景立即更新，toast 显示 `正在后台编译几何模型 (X/Y)...`
- **同 DEV 多实例**：共享一次序列化，逐实例应用 CBM 累积矩阵（数学与 GLB 快速路径一致）
- **浏览器模式**：无 projectId / 非 Tauri 时跳过落盘与版本文件，仅渐进渲染
- **中断安全**：项目切换 token 中断即退出且不写版本标记 →
  下次打开 `geometry_cache_version_match=false` 仅重建 geometry domain
- **二次打开**：`tryDevGlbFastPath` 先读取 `geometry-cache-v5-dev-status` 的 DEV manifest，按 unique DEV 通过 `batch_read_glb_files` 二进制 envelope 批读；`empty` 为合法空结果，单个 DEV 的 GLB 不完整或读取/解析失败只做该 DEV 的 scoped 原始 MOD/STL 回退，manifest/source 结构损坏才整体重建 geometry cache。
- **Phase 3/4 telemetry**：cold/warm geometry 只记录聚合 histogram 与最慢 DEV 摘要，覆盖 discovery、source/MOD/STL/mesh/bake/glTF composite、GLB read/write/parse、template parse、placement matrix、bbox、scene commit、placement slice/yield；同时记录 shared/fallback DEV、shared resource 数量和 placement slice p50/p95/max。IFC loader 另记录 Fragments cache composite、web-ifc/conversion + model callback composite、RAF/stable validation，无法拆分的第三方内部阶段明确保持 composite。

### DEV Geometry Runtime v2（Phase 4）

`devGlbTemplateRuntime.ts` 是变电 Runtime 内部的 session-local geometry ownership 边界，
不是跨工程全局缓存：

- cold 的 `serializeDevToGlb` 和 warm 的 GLB bytes 都进入同一个 `DevGlbTemplatePool`；每个
  normalized DEV 在当前 `ProjectLoadSession` 内只做一次 GLTF parse，随后保留静态 hierarchy
  作为 template。
- placement 只 clone Object3D 节点，复用 template 的 BufferGeometry、base Material 和
  texture；CBM 的 mm→m 仿射按“原 Mesh local matrix × CBM”精确组合，project source 矩阵仍在
  root 上使用 exact Matrix4，不经过 TRS 分解。`state.loadedXmlModGroups` 仍以
  `instanceKey → placement Group` 记录每个实例。
- SkinnedMesh、morph/animation、非有限矩阵、可变 render/material state 等无法证明静态可共享
  的 DEV，只在 DEV 粒度回退到 legacy placement，不把整个工程退回 raw MOD。
- template pool 拥有 shared GPU resources，placement 只拥有节点和高亮 clone material；工程清理
  先移除 placement，再由 pool exactly-once dispose shared resources。legacy fallback 的资源仍按
  placement 独占清理。
- placement commit 使用保守 `maxSliceMs=6`、`maxPlacementsPerSlice=32`，每个 slice 后重新
  检查 session/geometry token；cold DEV compiler 仍保持“编译一个 DEV → yield → 下一个 DEV”的
  渐进边界，未引入 IFC 并发、Worker 或 InstancedMesh。

### 工程类型检测

打开前优先读取 `GIMPKGT` / `GIMPKGS` source magic。解压后仍通过 `.ifc` 文件存在性 +
线路专属 CBM/DEV/FAM 字段（`ENTITYNAME`/`GROUPTYPE`/`DEVICETYPE` 键值级匹配）执行
`detectGimProjectType` 内容校验和 fallback；它不再把缓存中的 `project_type` 当作 source
identity。若 extraction magic 与打开前的 source magic 不一致，则以
`SOURCE_CHANGED_DURING_OPEN` 终止本次打开。

### 底图运行状态（内存单例）

`src/services/basemapStatusService.ts` 维护当前线路工程底图的运行状态：

- 5 种状态：`canvas-only` / `osm-online` / `osm-unavailable-fallback` / `empty` / `pmtiles`
- 由 `lineProjectView.ts` 在以下节点上报：
  - Canvas-only 初始渲染 → `setBasemapStatus('canvas-only', ...)`
  - MapLibre overlay 成功 → `setBasemapStatus('osm-online', ...)`
  - OSM 回退 → `setBasemapStatus('osm-unavailable-fallback', { fallbackReason })`
  - `destroyLineMapView` → `resetBasemapStatus()`
- 诊断 JSON 包含 `basemap` 字段（Ctrl+Shift+D），控制台额外输出 `[底图状态]` 可读摘要
- 仅内存状态，不持久化到 SQLite，工程切换时重置
