# 技术架构

> GIM 阅读器的技术选型、源码结构与模块关系。

---

## 1. 技术选型

| 层 | 技术 | 版本 | 用途 |
|---|---|---|---|
| 桌面框架 | Tauri 2 | 2.x | Rust 后端 + Vite 前端，离线运行，portable exe |
| 3D 渲染 | @thatopen/components (OBC) | ^3.4.6 | IFC Viewer 引擎 |
| IFC 解析 | web-ifc | ^0.0.77 | WASM 解析 IFC 二进制 |
| 3D 图形 | Three.js | ^0.184.0 | WebGL 渲染层 |
| 地图引擎 | maplibre-gl | ^5.24.0 | 线路地图底图（OSM raster） |
| 离线瓦片预研 | pmtiles | ^4.4.1 | PMTiles 矢量瓦片（默认关闭） |
| 压缩包解压 | libarchive.js | ^2.0.2 | WASM，支持 7z/ZIP/RAR |
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
│  ├─ gimExtractor.ts # GIMPKG* 头部检测 + 7z/ZIP 解压 + 文件展平
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
│  ├─ projectType.ts   # 工程类型检测（substation / transmission_line）
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
│  ├─ ifcSelectModal.ts # IFC 文件选择弹窗
│  ├─ cacheManagerView.ts # 缓存管理 modal
│  ├─ modelList.ts     # 模型列表
│  ├─ lineProjectView.ts # 线路工程面板（树 + 地图 + 属性）
│  ├─ lineMapView.ts     # Canvas 地图渲染（塔位/导线/跨越点/网格/比例尺/交互）
│  ├─ lineMapBaseLayer.ts # MapLibre 底图层（probe + overlay 桥接 + OSM/empty/pmtiles）
│  ├─ lineMapProjection.ts # 投影接口（MapLibre / Canvas）
│  ├─ lineMapStyle.ts   # MapLibre style 工厂（empty / osm-online / pmtiles）
│  └─ lineMapPmtiles.ts  # PMTiles protocol 管理（引用计数）
├─ services/      业务编排层
│  ├─ openGimService.ts          # GIM 打开流程（含缓存短路）
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
│  ├─ fileReader.ts   # 文件读取（getFileInfo/readFileBytes）
│  └─ database.ts     # SQLite 命令前端包装
├─ shared/
│  └─ html.ts         # HTML 转义工具
└─ utils/
   └─ logger.ts       # debugLog/debugWarn/debugError（按分类开关）
```

```
src-tauri/
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
│  src-tauri/  Rust 后端（SQLite + 文件）  │
└─────────────────────────────────────────┘
```

**分层规则**：

- `gim/` 不依赖 `services/`、`viewer/`、`ui/`、`desktop/`
- `viewer/` 不依赖 `services/`、`ui/`
- `ui/` 不直接碰数据库和 IFC Loader（通过 services 间接调用）
- `services/` 编排 `gim/` + `viewer/` + `ui/` + `desktop/`
- `desktop/` 仅封装 Tauri invoke

---

## 4. SQLite 表结构

### 变电工程表（7 张）

| 表 | 用途 |
|---|---|
| `gim_project` | 项目记录（path, sha256, size, parser_version, project_type） |
| `gim_entry` | GIM 内部文件清单（entry_path, entry_type, local_cache_path） |
| `cbm_node` | CBM 层级节点（树形结构，含 ifc_file/ifc_guid 引用） |
| `ifc_model` | IFC 文件索引（model_id, name, entry_path） |
| `file_dev_entry` | IFC 文件↔设备 CBM 映射 |
| `fam_property` | FAM 分节属性缓存（source_path, section_name, key, value） |
| `dev_property` | DEV 关键属性缓存（dev_path, key, value） |

### 线路工程表（6 张）

| 表 | 用途 |
|---|---|
| `line_cbm_node` | 线路 CBM 节点（含 F1-F4System / TOWER / WIRE / CROSS） |
| `line_cbm_child` | 线路 CBM 父子关系 |
| `line_cbm_ref` | 线路 CBM 引用（含 normalized_ref_value / file_name_lower） |
| `line_file_stat` | 线路文件统计 |
| `line_fam_property` | 线路 FAM 属性缓存 |
| `line_dev_property` | 线路 DEV 属性缓存 |

### 休眠表（Fragments 缓存，默认关闭）

| 表 | 用途 |
|---|---|
| `fragment_cache` | Fragments 二进制缓存（受 `ENABLE_FRAGMENTS_CACHE=false` 控制） |

### PARSER_VERSION 失效机制

- 定义在 `src-tauri/src/db.rs`：`pub const PARSER_VERSION: &str = "gim-parser-v5"`
- `validate_gim_cache` 检查 `parser_version_match`
- 版本不匹配 → 缓存无效 → 完整解压 → `save_gim_index` 先删后插全部表

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
npm run tauri:build  # 构建桌面 portable exe（nsis）
```

构建前自动执行 `scripts/copy-web-ifc-wasm.mjs` 复制 WASM 文件到 `public/wasm/`。

---

## 7. 关键设计

### 轻量启动

`main.ts` → `bootstrap.ts`：不立即创建 Viewer，3D 引擎按需懒加载。

### 缓存命中短路

二次打开同一 GIM 时：

1. Rust 计算 sha256 + file_size
2. `validate_gim_cache` 检查 parser_version + file_size + IFC 缓存文件存在性
3. 命中 → `get_gim_index` 读取全部索引 → 恢复到 AppState → 直接渲染树和面板（不读取原始 GIM、不解压、不创建 Viewer）

### 节点级 IFC 懒加载

点击节点 → 显示基础属性（CBM/FAM/DEV，优先 currentFiles 回退缓存）→ 懒加载对应 IFC → 高亮 + 完整属性

### 工程类型检测

通过 `.ifc` 文件存在性 + 线路专属 CBM/DEV/FAM 字段（`ENTITYNAME`/`GROUPTYPE`/`DEVICETYPE` 键值级匹配）区分变电与线路工程。

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
