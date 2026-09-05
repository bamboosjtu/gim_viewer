# 本地缓存设计

> GIM 阅读器的三层缓存架构：SQLite 语义索引 + 磁盘源文件 + 可选运行时几何缓存。
>
> 设计目标：二次打开同一 GIM 工程时跳过解压与解析，秒开层级树与属性面板；首次打开时构建索引并缓存大文件，供后续懒加载。

---

## 1. 架构总览

```
首次打开 .gim：
  检测 GIMPKG* 头部 → Rust 磁盘优先逐条解压 → manifest + DiskBackedFile Map
    ├─ 解析 CBM/DEV/FAM/PHM → 写入 SQLite 索引表
    ├─ IFC/DEV/PHM/MOD/STL 文件 → 写入磁盘缓存（app_data_dir/extracted/{id}/）
    └─ parser_version = PARSER_VERSION 写入 gim_project

二次打开同一 .gim（缓存命中短路）：
  Rust 计算 sha256 + file_size → validate_gim_cache
    ├─ 命中 → get_gim_index 读取全部索引 → 恢复到 AppState → 直接渲染（不读 GIM、不解压、不创建 Viewer）
    └─ 未命中 → 完整解压 → 解析 → 入库 → 缓存文件
```

缓存层的职责划分：

| 层 | 存储 | 内容 | 访问方式 |
|---|---|---|---|
| Layer 1 源文件 | `app_data_dir/extracted/{id}/` | IFC/DEV/PHM/MOD/STL/CBM/FAM 等解压条目 | Tauri IPC（按 `entry_path` 懒读） |
| Layer 2 语义索引 | `app_data_dir/gim_cache.db` | CBM 树/属性/引用链/文件清单 | Tauri IPC（SQL 查询） |
| Layer 3 运行时缓存 | `app_data_dir/fragments/{id}/`、`glbcache/{id}/` | Fragments `.frag`、DEV→GLB | Tauri IPC（受身份校验后读取） |

### 1.1 磁盘优先解包边界

Tauri 原生 `extract_gim_archive(file_path, project_id)` 不再把解压结果重新拼成
`[manifest][全部条目 blob]`。Rust 只读取最多 1 MiB 头部定位压缩数据，然后逐条解压、
原子写入 `extracted/{project_id}/{entry_path}`，IPC 返回 manifest（路径、大小、缓存路径）。
前端用 `DiskBackedFile` 保持现有 `Map<string, File>` 解析边界；只有 parser 调用
`text()` / `arrayBuffer()` 时才通过 `read_cached_entry(project_id, entry_path)` 读取当前条目。
因此原生解包的条目内容内存峰值约为最大单文件加解码器工作集，而不是整个 GIM 展开体积。

浏览器或无 `project_id` 的兼容调用仍可使用 inline blob；该路径不用于 Tauri 生产打开流程。

---

## 2. SQLite 索引缓存

### 2.1 表结构总览

共 16 张表（含 3 张几何引用链表 + 1 张休眠表），按工程类型分组：

| 分组 | 表数 | 用途 |
|---|---|---|
| 项目元数据 | 2 | `gim_project`（含 parser_version + project_type）、`substation_gim_entry`（文件清单） |
| 变电工程索引 | 5 | CBM 树、IFC 索引、FileDevRelation、FAM/DEV 属性 |
| 线路工程索引 | 6 | 线路 CBM 节点/父子/引用/统计、FAM/DEV 属性 |
| 几何引用链 | 3 | DEV SOLIDMODEL、DEV SUBDEVICE、PHM SOLIDMODEL（v6 新增） |
| 休眠 | 1 | `substation_fragment_cache`（Fragments 二进制预编译，默认关闭） |

### 2.2 项目元数据表

```sql
-- 项目记录：唯一标识一个 GIM 工程
CREATE TABLE gim_project (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL UNIQUE,           -- .gim 文件绝对路径
  name TEXT NOT NULL,                  -- 工程名称（来自 GIMPKG* 头部）
  size INTEGER NOT NULL,               -- 文件大小（字节）
  modified_ms INTEGER NOT NULL,        -- 文件修改时间（毫秒）
  sha256 TEXT NOT NULL,                -- 文件 SHA-256（缓存命中主键）
  parser_version TEXT,                 -- 解析器版本（v3 后新增，用于失效判定）
  project_type TEXT,                   -- 'substation' | 'transmission_line' | 'hybrid' | 'unknown'
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  last_opened_at_ms INTEGER NOT NULL
);

-- GIM 内部文件清单：记录解压后的所有文件路径与类型
CREATE TABLE substation_gim_entry (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  entry_path TEXT NOT NULL,            -- 'CBM/project.cbm' / 'DEV/abc.dev' / 'MOD/xyz.mod' ...
  file_name TEXT NOT NULL,
  entry_type TEXT NOT NULL,            -- 'CBM' | 'DEV' | 'PHM' | 'MOD' | 'STL' | 'IFC' | 'FAM' ...
  file_size INTEGER NOT NULL,
  local_cache_path TEXT,               -- 磁盘缓存绝对路径（IFC/DEV/PHM/MOD 缓存后填充）
  created_at_ms INTEGER NOT NULL,
  UNIQUE(project_id, entry_path)
);
```

### 2.3 变电工程索引表（5 张）

```sql
-- CBM 层级节点：树形结构，含 IFC 引用
CREATE TABLE substation_cbm_node (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  node_key TEXT NOT NULL,              -- 节点唯一键（CBM 文件路径或合成键）
  parent_key TEXT,                     -- 父节点键（project.cbm 为 NULL）
  path TEXT NOT NULL,                  -- CBM 文件路径
  name TEXT NOT NULL,                  -- 显示名（IFC Name 优先，回退 classify_name）
  entity_name TEXT,                    -- ENTITYNAME: F1System|F2System|F3System|F4System|PARTINDEX
  classify_name TEXT,                  -- SYSCLASSIFYNAME
  fam_path TEXT,                       -- BASEFAMILY → '<uuid>.fam'
  dev_path TEXT,                       -- OBJECTMODELPOINTER → '<uuid>.dev'
  ifc_file TEXT,                       -- IFCFILE（设备级）
  ifc_guid TEXT,                       -- IFCGUID（已去尾部 $）
  transform_matrix TEXT,               -- TRANSFORMMATRIX（16 浮点数，列主序）
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at_ms INTEGER NOT NULL,
  UNIQUE(project_id, node_key)
);

-- IFC 文件索引
CREATE TABLE substation_ifc_model (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  model_id TEXT NOT NULL,              -- 'ifc_<path hash>'（规范化 entry_path 的稳定 runtime ID）
  name TEXT NOT NULL,                  -- IFC 显示名
  entry_path TEXT NOT NULL,            -- 'DEV/电气二次0317其他.ifc'
  created_at_ms INTEGER NOT NULL,
  UNIQUE(project_id, model_id)
);

-- IFC ↔ 设备 CBM 映射（FileDevRelation.cbm 解析结果）
CREATE TABLE substation_file_dev_entry (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  model_id TEXT NOT NULL,
  ifc_name TEXT NOT NULL,
  ifc_file TEXT NOT NULL,
  device_count INTEGER NOT NULL,
  device_cbm TEXT NOT NULL,            -- '<uuid>.cbm'
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at_ms INTEGER NOT NULL
);

-- FAM 分节属性缓存
CREATE TABLE substation_fam_property (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  source_path TEXT NOT NULL,           -- 'DEV/<uuid>.fam'
  section_name TEXT NOT NULL,          -- '设计参数'（变电工程有分节）
  prop_key TEXT NOT NULL,
  prop_value TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at_ms INTEGER NOT NULL,
  UNIQUE(project_id, source_path, section_name, prop_key)
);

-- DEV 关键属性缓存
CREATE TABLE substation_dev_property (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  dev_path TEXT NOT NULL,
  prop_key TEXT NOT NULL,
  prop_value TEXT,
  created_at_ms INTEGER NOT NULL,
  UNIQUE(project_id, dev_path, prop_key)
);
```

### 2.4 线路工程索引表（6 张）

```sql
-- 线路 CBM 节点（含 F1-F4System / TOWER / WIRE / CROSS）
CREATE TABLE powerline_cbm_node (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  path TEXT NOT NULL,
  name TEXT,
  entity_name TEXT,                    -- F1System|F2System|F3System|F4System|Tower_Device|Wire_Device|WIRE|CROSS
  classify_name TEXT,
  raw_props_json TEXT NOT NULL,        -- 原始字段 JSON（含 GROUPTYPE/WIRETYPE/ISJUMPER/KVALUE 等）
  sort_order INTEGER,
  created_at_ms INTEGER NOT NULL,
  UNIQUE(project_id, path)
);

-- 线路 CBM 父子关系（邻接表，支持 13 种 ref_type）
CREATE TABLE powerline_cbm_child (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  parent_path TEXT NOT NULL,
  child_path TEXT NOT NULL,
  sort_order INTEGER,
  ref_type TEXT NOT NULL,              -- SUBSYSTEM|SECTIONS|STRAINSECTIONS|GROUPS|TOWERS|STRINGS|BASES|SUBDEVICES|BACKSTRING|FRONTSTRING
  extra TEXT,                          -- STRINGS 的 GPOINT 挂点名称等附加信息
  created_at_ms INTEGER NOT NULL,
  UNIQUE(project_id, parent_path, child_path, ref_type)
);

-- 线路 CBM 引用（OBJECTMODELPOINTER / BASEFAMILY 等）
CREATE TABLE powerline_cbm_ref (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  node_path TEXT NOT NULL,
  ref_kind TEXT NOT NULL,
  ref_key TEXT,
  ref_value TEXT NOT NULL,             -- 裸文件名（如 'x.fam'）
  normalized_ref_value TEXT,           -- 归一化完整路径（如 'Cbm/x.fam'）
  file_name_lower TEXT,                -- 统一小写键空间（诊断用）
  sort_order INTEGER,
  created_at_ms INTEGER NOT NULL
);

-- 线路文件统计
CREATE TABLE powerline_file_stat (
  project_id INTEGER NOT NULL,
  file_type TEXT NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY(project_id, file_type)
);

-- 线路 FAM 属性（扁平格式，display_key 为中文展示键）
CREATE TABLE powerline_fam_property (
  project_id INTEGER NOT NULL,
  source_path TEXT NOT NULL,
  normalized_path TEXT NOT NULL,
  file_name_lower TEXT NOT NULL,
  display_key TEXT,                    -- 中文展示键
  prop_key TEXT NOT NULL,              -- 英文键
  prop_value TEXT,
  raw_line TEXT,
  sort_order INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY(project_id, normalized_path, prop_key, sort_order)
);

-- 线路 DEV 属性
CREATE TABLE powerline_dev_property (
  project_id INTEGER NOT NULL,
  source_path TEXT NOT NULL,
  normalized_path TEXT NOT NULL,
  file_name_lower TEXT NOT NULL,
  prop_key TEXT NOT NULL,
  prop_value TEXT,
  raw_line TEXT,
  sort_order INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY(project_id, normalized_path, prop_key, sort_order)
);
```

### 2.5 几何引用链表（3 张，v6 新增）

> 缓存命中场景下避免逐文件读取数千个 DEV/PHM 来发现 MOD/STL 几何源。

```sql
-- DEV SOLIDMODELS 段（DEV → PHM/DEV 引用 + TRANSFORMMATRIX）
CREATE TABLE substation_dev_solid_model (
  project_id INTEGER NOT NULL,
  dev_path TEXT NOT NULL,
  solid_model_path TEXT NOT NULL,      -- '<uuid>.phm' 或 '<uuid>.dev'（线路工程递归）
  transform_matrix TEXT,
  sort_order INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY(project_id, dev_path, sort_order)
);

-- DEV SUBDEVICES 段（DEV → 子 DEV 引用 + TRANSFORMMATRIX）
CREATE TABLE substation_dev_sub_device (
  project_id INTEGER NOT NULL,
  dev_path TEXT NOT NULL,
  child_dev_path TEXT NOT NULL,
  transform_matrix TEXT,
  sort_order INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY(project_id, dev_path, sort_order)
);

-- PHM SOLIDMODELS 段（PHM → MOD/STL 引用 + TRANSFORMMATRIX + COLOR）
CREATE TABLE substation_phm_solid_model (
  project_id INTEGER NOT NULL,
  phm_path TEXT NOT NULL,
  solid_model_path TEXT NOT NULL,      -- '<uuid>.mod' 或 '<uuid>.stl'
  transform_matrix TEXT,
  color TEXT,                          -- 'R,G,B,A'
  sort_order INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY(project_id, phm_path, sort_order)
);
```

### 2.6 Fragments 二进制缓存表（默认关闭）

```sql
-- Fragments 缓存记录（受 ENABLE_FRAGMENTS_CACHE=false 控制，默认关闭）
CREATE TABLE substation_fragment_cache (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  entry_path TEXT NOT NULL,            -- 'DEV/abc.ifc'
  model_id TEXT NOT NULL,              -- 稳定 runtime modelId（ifc_<path hash>）
  source_gim_sha256 TEXT NOT NULL,     -- 生成 fragment 时的 GIM 内容身份
  source_ifc_size INTEGER NOT NULL,    -- 原始 IFC 大小（校验用）
  fragment_file_size INTEGER NOT NULL, -- .frag 文件大小
  fragments_version TEXT NOT NULL,     -- 基础版本 + @thatopen/fragments/web-ifc 实际版本（兼容性校验）
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  UNIQUE(project_id, entry_path)
);
```

缓存的启用条件、校验和回退行为见 §4。

### 2.7 解析缓存版本域

解析缓存从 v22 起按工程类型隔离：

- `LINE_PARSER_VERSION = gim-line-parser-v1`：线路 graph、FAM/DEV 属性和 semantic pack。
- `SUBSTATION_PARSER_VERSION = gim-substation-parser-v22`：变电 CBM/FAM/DEV、IFC Spatial Semantic 和关系索引。
- `PARSER_VERSION = gim-parser-v22` 保留为旧库兼容/诊断字段，不再单独决定线路或变电缓存是否有效。

写入时机：首次导入或重建索引时，线路事务更新 `line_parser_version`，变电事务更新 `substation_parser_version`；旧共享字段同时写入以兼容旧版本诊断。校验时 `validate_gim_cache` 按 `project_type` 选择对应 domain。旧库只有共享字段时，明确识别为线路且版本为 v21/v22 的记录迁移到线路域，变电 v22 记录迁移到变电域；无法识别工程类型的记录不猜测域并按 miss 处理。

失效行为：对应 domain 版本不匹配 → 缓存无效 → 完整解压/重建对应工程索引；变电 domain 升级不会触发线路缓存重建，反之亦然。

### 2.8 缓存校验逻辑（validate_gim_cache）

按 `project_type` 分支校验：

**变电工程（substation）**：
- `substation_parser_version_match`
- `cbm_nodes_count > 0` && `ifc_models_count > 0` && `ifc_entry_count > 0`
- `cached_ifc_count == ifc_entry_count`（所有 IFC 磁盘缓存文件存在且大小匹配）
- `missing_cache_paths.is_empty()`

Fragments 运行时缓存另需同时满足：

- `project_id + entry_path` 命中记录；
- `source_gim_sha256` 与当前工程 SHA-256（大小写不敏感）一致且非空；
- `fragments_version` 与当前 OBC/web-ifc 运行时版本一致；
- `.frag` 文件存在、非空且实际大小等于记录的 `fragment_file_size`
  （记录的 `source_ifc_size` 仅作辅助诊断）。

**线路工程（transmission_line）**：
- `line_parser_version_match`
- `line_cbm_node_count > 0`
- `line_fam_source_count > 0`（v5 新增，FAM 属性必须存在）

线路工程不检查 IFC 缓存（线路工程无 IFC 文件）。

### 2.9 缓存命中短路流程

1. 用户选择 GIM → Rust 计算 `sha256 + file_size`
2. 查 `gim_project` 表：`sha256` 匹配 → 取 `project_id`
3. `validate_gim_cache(project_id)` → 返回 `valid` + 诊断字段
4. 命中 → `get_gim_index` 一次性读取全部索引表 → `restoreGimIndexToState` 恢复到 AppState → 直接渲染树和面板
5. 未命中 → 完整解压 → 解析 → `save_gim_index`（先删后插）→ 缓存 IFC/DEV/PHM/MOD 文件到磁盘

命中后**不读取原始 GIM、不解压、不创建 Viewer**，秒开层级树。

---

## 3. 磁盘文件缓存

### 3.1 目录结构

```
app_data_dir/
├─ gim_cache.db                          # SQLite 数据库
├─ extracted/{project_id}/               # 解压文件缓存
│  ├─ DEV/abc.dev
│  ├─ DEV/abc.ifc                        # 变电工程 IFC 文件
│  ├─ PHM/xyz.phm
│  ├─ MOD/uvw.mod
│  └─ MOD/uvw.stl
└─ fragments/{project_id}/               # Fragments 预编译缓存（默认关闭）
   └─ DEV_abc.ifc.frag
```

### 3.2 IFC 文件缓存（变电工程）

原生 Tauri 首次打开时由 Rust 解压器直接逐条写入；WASM 回退路径由
`desktop/src/services/gimExtractedCacheService.ts` `cacheIfcEntries` 调用
`write_cache_file_binary` 写入：
- 首次打开变电 GIM 时，遍历 `ifcEntries`，逐个写入 `extracted/{id}/{entry_path}`
- 写入后 `substation_gim_entry.local_cache_path` 记录绝对路径
- 节点点击懒加载时：优先 `currentFiles`（浏览器内存文件或 Tauri `DiskBackedFile`），
  内容按需通过 `read_cached_entry(projectId, entryPath)` / `readCachedIfc`（IFC 专用别名）读取

### 3.3 DEV/PHM/MOD/STL 文件缓存（变电工程）

由 `cacheGeometryFiles` 遍历 `files` Map，缓存所有 DEV/PHM/MOD 文件（STL 由 `modGeometryDiscovery` 引用链发现后按需缓存）：
- 缓存命中场景下，`buildGeometryFilesMapFromCache` 从磁盘批量读取 DEV/PHM 构建临时 Map
- `ensureModFilesInCacheMap` 按需补充 MOD 文件（仅读取被引用的 MOD，非全量）
- `batch_read_cached_files` 一次 IPC 批量读取多文件，避免数千次往返

### 3.4 路径遍历防护

`cache_file_path` 函数（`desktop/src-tauri/src/db.rs`）实现三层防护：
1. `validate_entry_path` 组件级校验：只允许 `Normal` 组件，拒绝 `..` 和 `\..\`
2. 拼接后 `canonicalize` 根目录，确保 `root` 已存在
3. `full.starts_with(&canonical_root)` defense-in-depth 校验最终路径仍在根目录下

---

## 4. Fragments 二进制缓存（默认关闭）

Fragments 缓存已经接入加载器，但 `ENABLE_FRAGMENTS_CACHE=false` 时不参与默认路径。
开启灰度覆盖后，流程为：

1. `validateFragmentCache` 在不读取 IFC buffer 的情况下检查记录和文件；
2. 命中后读取 `.frag`，调用 `ctx.fragments.core.load`，并校验模型是否进入运行时集合；
3. 缓存无效、文件损坏或加载校验失败时回退 `getIfcBuffer()` + `ctx.ifcLoader.load`；
4. IFC 成功加载后序列化 `.frag` 并写入记录，写入失败不提交完整缓存状态。

校验条件：

- `project_id + entry_path` 记录存在；
- `source_gim_sha256` 与当前 GIM SHA-256 一致且非空；
- `fragments_version` 与当前 OBC/web-ifc 运行时版本一致；
- `.frag` 存在、非空且实际大小等于记录的 `fragment_file_size`。

命中路径不会读取 IFC buffer，因此可跳过大文件 IPC 和 web-ifc 解析；缓存域只影响
对应 IFC，不改变 CBM/FAM/DEV 或线路语义缓存。默认开关是否调整由
[dev-log.md](dev-log.md) 管理。

---

## 5. 缓存管理

### 5.1 Tauri commands

| command | 说明 |
|---|---|
| `list_cached_projects` | 返回项目列表（按 `last_opened_at_ms` DESC） |
| `delete_project_cache` | 事务删除 13 张索引表 + `gim_project` 记录 + 磁盘目录 |
| `get_project_diagnostic` | 返回单个项目完整诊断（表行数 + 校验状态 + 工程类型） |
| `validate_gim_cache` | 校验缓存完整性（只读，不修复） |
| `write_cache_file_binary` | 以 Raw IPC 写入单个缓存文件（路径遍历防护） |
| `read_cached_ifc` | 读取单个 IFC 缓存文件 |
| `read_cached_entry` | 按 `project_id + entry_path` 懒读任意解压条目 |
| `batch_read_cached_files` | 批量读取缓存文件（一次 IPC 替代 N 次） |

### 5.2 删除策略

- DB：事务删除 13 张索引表（`substation_gim_entry` / `substation_cbm_node` / `substation_ifc_model` / `substation_file_dev_entry` / `substation_fam_property` / `substation_dev_property` / `powerline_cbm_node` / `powerline_cbm_child` / `powerline_cbm_ref` / `powerline_file_stat` / `powerline_fam_property` / `powerline_dev_property` / `substation_fragment_cache`）+ `gim_project` 记录
- 磁盘：best-effort 删除 `app_data_dir/extracted/{id}/` 和 `fragments/{id}/`
- 按 `project_id` 精确删除，不影响其他项目
- 删除当前查看工程时视图不立即关闭，重新打开该 GIM 会重新解压重建

### 5.3 缓存管理 UI

`desktop/src/ui/cacheManagerView.ts` 提供缓存管理 modal：
- 列出所有已缓存项目（名称、大小、最后打开时间、工程类型）
- 单项删除 + 全部清空
- 删除前确认对话框

---

## 6. 设计约束

- **不持久化底图状态**：`basemapStatusService` 为内存单例，工程切换时重置，不写入 SQLite
- **不缓存 MapLibre 瓦片**：OSM 在线瓦片不下载、不缓存，遵循 OSM 使用条款
- **线路工程不缓存 IFC**：线路工程无 IFC 文件，`validate_gim_cache` 跳过 IFC 校验分支
- **Fragments 缓存默认关闭**：`ENABLE_FRAGMENTS_CACHE=false`，灰度开启时按版本和源 SHA 校验
- **解析缓存按工程域失效**：线路和变电使用独立 parser version；对应域版本变化才重建该域索引
- **磁盘缓存 best-effort 删除**：DB 事务成功即视为项目已删除，磁盘文件删除失败不阻断（下次启动可手动清理）
