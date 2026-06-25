# GIM 阅读器实施计划

> 本文件按里程碑组织 GIM 阅读器的演进路线。每个里程碑内步骤独立编号（`M1-1`、`M2-3`…），标注实现状态。
>
> 状态图例：✅ 已完成 ｜ 🚧 进行中 ｜ ⏳ 待实现 ｜ ➖ 可选/后置

## 里程碑总览

| 里程碑 | 名称 | 状态 | 核心交付 |
|---|---|---|---|
| **M1** | GIM 浏览器 WEB 版 | ✅ 完成 | 纯 Web 架构：GIM 解压 + CBM 层级树 + IFC 3D 渲染 + 属性面板 |
| **M2** | Tauri 单机版改造 | ✅ 基本完成 | 桌面化 + SQLite 索引缓存 + 缓存命中短路 + 节点级 IFC 懒加载 |
| **M3** | 线路 GIM 可视化 | 🚧 进行中 | 线路工程结构浏览（完成）+ 地图视图（待实现） |

**总体优先级**：先重构边界 → 再接 Tauri → 再接 SQLite 索引缓存 → 再做 Fragments 懒加载 → 最后做线路地图可视化。每步都有明确验收点，不容易把现有 GIM 阅读功能改坏。

---

## 技术路线选型

你当前项目适合走 **Tauri + Vite + TypeScript + SQLite** 路线，而非先上 Electron。理由：当前已是 Vite/TS 单页应用，`package.json` 仅有前端依赖（`vite`、`typescript`、`three`、`@thatopen/components`、`@thatopen/fragments`、`libarchive.js`、`web-ifc`），迁移到 Tauri 成本低。Tauri 支持任意能编译成 HTML/JS/CSS 的前端，并用 Rust 承担后端逻辑，也有官方 SQL 插件。([Tauri][1]) ([Tauri][2])

Electron 也能做，但 SQLite 通常涉及 `better-sqlite3` / `sqlite3` 这类原生 Node 模块，需针对 Electron ABI 重新编译，容易版本不匹配。([Electron][3]) 当前目标是快速产品化 GIM 阅读器，不建议先引入复杂度。

---

## 推荐总体结构

把项目从"一个 `main.ts` 应用"拆成 **前端 UI 层、GIM 解析层、模型渲染层、缓存数据库层、桌面能力层**：

```txt
gim-viewer-desktop/
├─ package.json
├─ vite.config.ts
├─ index.html
├─ src/
│  ├─ app/           # 应用入口与全局状态
│  │  ├─ main.ts
│  │  ├─ bootstrap.ts
│  │  └─ state.ts
│  ├─ ui/            # 纯 UI/DOM，不直接碰数据库和 IFC Loader
│  │  ├─ tabs.ts
│  │  ├─ cbmTreeView.ts
│  │  ├─ fileDevView.ts
│  │  ├─ propsDrawer.ts
│  │  └─ lineProjectView.ts
│  ├─ gim/           # GIM 解析层（纯逻辑，无 UI/Viewer 依赖）
│  │  ├─ gimExtractor.ts
│  │  ├─ cbmParser.ts
│  │  ├─ lineCbmParser.ts
│  │  ├─ famParser.ts
│  │  ├─ fileDevParser.ts
│  │  ├─ gimIndexer.ts
│  │  └─ types.ts
│  ├─ viewer/        # 3D 渲染层
│  │  ├─ viewerEngine.ts
│  │  ├─ selection.ts
│  │  ├─ highlight.ts
│  │  ├─ camera.ts
│  │  └─ resize.ts
│  ├─ desktop/       # Tauri 桥接层
│  │  ├─ fileDialog.ts
│  │  ├─ fileReader.ts
│  │  └─ database.ts
│  ├─ services/      # 业务编排层
│  │  ├─ openGimService.ts
│  │  ├─ openIfcService.ts
│  │  └─ nodeInteractionService.ts
│  └─ shared/
│     └─ html.ts
├─ src-tauri/
│  ├─ Cargo.toml
│  ├─ tauri.conf.json
│  └─ src/
│     ├─ lib.rs
│     ├─ main.rs
│     └─ db.rs
└─ public/
   ├─ worker-bundle.js   # libarchive.js Worker
   ├─ libarchive.wasm    # libarchive WASM
   ├─ web-ifc.wasm       # web-ifc WASM（离线运行）
   └─ icons/             # 线路地图杆塔符号资源（M3，可选）
      ├─ tower-tension.svg      # 可作为 canvas 离屏图片源；第一版默认 canvas 直接绘制
      └─ tower-suspension.svg
```

**分层边界**：
- `gim/` 只负责从 GIM、CBM、FAM、FileDevRelation 里解析数据
- `viewer/` 只负责 Three.js / That Open / Fragments 的 3D 行为
- `services/` 负责把"打开 GIM、检查缓存、解析、入库、懒加载"串起来
- `ui/` 只负责 DOM 渲染，不直接碰数据库和 IFC Loader
- `desktop/` 只负责 Tauri 桥接

---

## 数据库设计

**核心原则**：SQLite 存索引和元数据，大文件缓存存本地文件目录，数据库只存路径和校验信息。原因是 IFC、Fragments、几何缓存可能很大，全塞进 BLOB 会导致数据库膨胀、备份慢、VACUUM 慢。

### 通用表（M2 引入）

```sql
-- GIM 文件记录
CREATE TABLE gim_project (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  path TEXT,
  sha256 TEXT NOT NULL,
  size INTEGER,
  modified_ms INTEGER,
  parser_version TEXT,          -- 命中时 = PARSER_VERSION，失效时置 NULL
  project_type TEXT,            -- 'substation' | 'transmission_line' | 'hybrid' | 'unknown'
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- GIM 内部文件清单
CREATE TABLE gim_entry (
  project_id INTEGER NOT NULL,
  entry_path TEXT NOT NULL,
  entry_type TEXT NOT NULL,     -- CBM / FAM / IFC / DEV / OTHER
  local_cache_path TEXT,       -- IFC 本地缓存路径
  UNIQUE(project_id, entry_path)
);

-- CBM 层级节点（变电工程）
CREATE TABLE cbm_node (
  project_id INTEGER NOT NULL,
  node_id TEXT NOT NULL,
  parent_id TEXT,
  path TEXT NOT NULL,
  name TEXT, entity_name TEXT, classify_name TEXT,
  fam_path TEXT, dev_path TEXT,
  ifc_file TEXT, ifc_guid TEXT,
  transform_matrix TEXT,
  sort_order INTEGER DEFAULT 0
);

-- IFC 文件索引
CREATE TABLE ifc_model (
  project_id INTEGER NOT NULL,
  model_id TEXT NOT NULL,
  name TEXT, entry_path TEXT,
  UNIQUE(project_id, model_id)
);

-- FileDevRelation / FAM / DEV 属性缓存表（略，见 src-tauri/src/db.rs）
```

### 线路工程表（M3-3 / M3-3.5 引入）

```sql
-- 线路 CBM 节点（邻接表）
CREATE TABLE line_cbm_node (project_id, path, entity_name, classify_name, raw_json, ...);
CREATE TABLE line_cbm_child (project_id, parent_path, child_path, ref_type, sort_order, ...);
CREATE TABLE line_cbm_ref (
  project_id, node_path, ref_key, ref_value,
  -- M3-3.5 引入：归一化结果持久化，避免 Rust/TS 两边各自归一化产生微小差异
  normalized_ref_value TEXT,   -- 对 ref_value 走 normalizeGimPath 的结果
  file_name_lower TEXT,       -- ref_value 的文件名小写
  ref_kind TEXT               -- 见 LineRefKind 枚举（M3-3.5），写入时统一填好
);
CREATE TABLE line_file_stat (project_id, ext, count, ...);

-- 线路 FAM 属性缓存（M3-3.5 引入，支持 中文键=ENGLISH_KEY=值 扁平格式）
CREATE TABLE line_fam_property (
  project_id INTEGER NOT NULL,
  source_path TEXT NOT NULL,        -- 原始路径，归一化前（UI 展示）
  normalized_path TEXT NOT NULL,   -- 归一化后路径，索引 key
  file_name_lower TEXT NOT NULL,   -- 文件名小写（如 "xxx.fam"），兜底命中
  display_key TEXT,                 -- 中文键名（如 "杆塔编号"），无则 NULL
  prop_key TEXT NOT NULL,          -- ENGLISH_KEY 或普通 KEY
  prop_value TEXT,
  raw_line TEXT,                    -- 原始行，便于审计/兜底
  sort_order INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(project_id, normalized_path, prop_key, sort_order)
);

CREATE INDEX idx_line_fam_property_source
ON line_fam_property(project_id, normalized_path);

CREATE INDEX idx_line_fam_property_file
ON line_fam_property(project_id, file_name_lower);

CREATE INDEX idx_line_fam_property_key
ON line_fam_property(project_id, prop_key);

-- 线路 DEV 属性缓存（M3-3.5 引入，普通 KEY=VALUE）
CREATE TABLE line_dev_property (
  project_id INTEGER NOT NULL,
  source_path TEXT NOT NULL,
  normalized_path TEXT NOT NULL,
  file_name_lower TEXT NOT NULL,
  prop_key TEXT NOT NULL,
  prop_value TEXT,
  raw_line TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(project_id, normalized_path, prop_key, sort_order)
);

CREATE INDEX idx_line_dev_property_source
ON line_dev_property(project_id, normalized_path);

CREATE INDEX idx_line_dev_property_file
ON line_dev_property(project_id, file_name_lower);

CREATE INDEX idx_line_dev_property_key
ON line_dev_property(project_id, prop_key);
```

### 关键索引

```sql
CREATE INDEX idx_cbm_node_project_parent ON cbm_node(project_id, parent_id);
CREATE INDEX idx_cbm_node_ifc ON cbm_node(project_id, ifc_file, ifc_guid);
CREATE INDEX idx_line_cbm_child_parent ON line_cbm_child(project_id, parent_path);
```

---

## 打开 GIM 的四阶段流程

不要"打开后立刻全部解析、转换、加载"。拆成四阶段：

### 阶段 1：快速识别
用户选择 GIM → 计算 `size / mtime / sha256 / parser_version` → 查 `gim_project`：
- 命中（相同 hash + parser_version）→ 直接读 SQLite 索引，秒开层级树、文件设备、属性面板
- 未命中 → 进入导入流程

### 阶段 2：轻量解析并入库
只解析 `project.cbm` + `*.cbm` + `FileDevRelation.cbm` + `FAM/*.fam` + IFC 清单 + IFCGUID 映射。不加载 3D 模型。

### 阶段 3：按需转换 IFC（仅变电工程）
用户点击节点时判断对应 IFC 是否已有 Fragments 缓存：有则直接加载；无则从 IFC 转换并写入 `fragment_cache_path`。

### 阶段 4：属性懒加载
点击 CBM 节点 → 先显示已缓存属性 → 对应 IFC 已加载则补充 IFC 属性。点击 3D 构件 → 查 `element_property`，未命中则从模型读取并写入。

---

## Tauri 集成方式

Tauri 官方 SQL 插件可从前端 `@tauri-apps/plugin-sql` 访问数据库，但建议分两层：
- **轻量查询**：前端直接走 SQL 插件（读树、读属性、最近项目）
- **重任务**：封装为 Tauri command 让 Rust 处理（GIM 解包、hash、批量导入、缓存管理、AppData 目录）

推荐边界：

```txt
前端 TypeScript：UI、树、属性面板、3D viewer、调用服务
Tauri Rust：文件选择、AppData 路径、文件 hash、大文件复制/删除、SQLite migration、后台导入任务
```

大文件缓存进入本地目录，SQLite 只保存路径：

```txt
AppData/gim-viewer/
├─ gim-cache.db
├─ extracted/{projectId}/...
├─ fragments/{projectId}/{modelId}.frag
└─ logs/
```

---

# M1：GIM 浏览器 WEB 版 ✅ 完成

> 纯 Web 架构（Vite + TS，浏览器模式），实现 GIM 解压、CBM 层级树、IFC 3D 渲染、属性面板。无数据库、无 Tauri。

## M1 背景

项目最初是浏览器单页应用。M1 的目标是建立清晰的分层架构，把 `main.ts` 按职责拆分，为后续桌面化和数据库化打基础。不引入数据库、不引入 Tauri。

## M1-1：分层重构 ✅

**投喂指令**：

```txt
请把 src/main.ts 按职责拆分为 gim、viewer、ui、services 四层。
要求不改变现有功能，不引入数据库，不引入 Tauri。
拆分后 npm run build 必须通过。
```

**验收**：
- 浏览器模式仍可打开 IFC/GIM
- 属性面板、层级树、文件设备仍正常
- `main.ts` 只保留 bootstrap 逻辑

## M1-2：项目数据模型 ✅

**投喂指令**：

```txt
请新增 src/gim/types.ts，统一定义 GimProject、GimEntry、CbmNode、IfcModel、IfcElement、ElementProperty 等类型。
把散落在 main.ts 里的 interface 移到 types.ts。不要改变运行逻辑。
```

**验收**：
- 所有 parser、viewer、ui 都引用统一类型
- 不再重复定义 CbmNode、IfcEntry

---

# M2：Tauri 单机版改造 ✅ 基本完成

> 在 M1 的 Web 架构上接入 Tauri 2 + 原生 SQLite，实现离线桌面运行、索引缓存命中短路、节点级 IFC 懒加载。

## M2 背景

将 GIM 阅读器产品化为离线桌面工具。Tauri 负责窗口/文件/SQLite，前端保留 Web 渲染能力。二次打开同一 GIM 时跳过解压，秒开。

## M2-1：引入 Tauri 壳 ✅

**投喂指令**：

```txt
请在当前 Vite 项目中接入 Tauri 2。保留浏览器 dev 模式。新增 src-tauri 目录。
先只实现桌面窗口启动，不接数据库。
```

Tauri 文档的创建命令是 `npm create tauri-app@latest`，但已有 Vite 项目更适合增量接入，不重建项目。([Tauri][1])

**验收**：Tauri 桌面窗口可启动；`npm run dev` 浏览器模式仍可用。

## M2-2：SQLite migration ✅

**投喂指令**：

```txt
请为 Tauri 项目加入 SQLite 支持（rusqlite bundled）。
新增 migrations，创建 gim_project、gim_entry、cbm_node、ifc_model、element_property 等表。
新增 src-tauri/src/db.rs，先实现 initDb、upsert_gim_project、findProjectByHash。
```

Tauri SQL 插件需添加插件依赖、启用 SQLite feature，并在 capabilities 中授予 SQL 权限。([Tauri][2])

**验收**：数据库表创建成功；可写入/查询项目记录。

## M2-3：缓存命中短路 ✅

**投喂指令**：

```txt
请改造 openGimService。打开 GIM 时先计算文件 hash，再查询 gim_project。
如果命中缓存，则从 SQLite 加载层级树和文件设备面板，不重新解包。
如果未命中，则沿用原解析流程，并把解析结果写入 SQLite。暂时不做 IFC fragments 缓存。
```

**验收**：
- 第一次打开：正常解析并入库
- 第二次打开：不重新解析 CBM，直接显示树
- 清空数据库后：能重新导入

## M2-4：节点级 IFC 懒加载 ✅

**投喂指令**：

```txt
请实现 nodeInteractionService。当用户点击层级树节点或文件设备项时，
根据 node.ifcFile 判断对应 ifc_model 是否已加载。未加载则加载对应 IFC；已加载则只执行定位、高亮、属性显示。
```

**验收**：
- 打开 GIM 后不自动加载所有 IFC
- 点击某个节点才加载对应 IFC
- 多次点击同一个 IFC 不重复加载

## M2-5：Fragments 缓存 ⏳ 待定（当前优先级低）

**投喂指令**：

```txt
请为 ifc_model 增加 fragment_cache_path 使用逻辑。
IFC 首次加载并转换后，将转换结果保存到 AppData/cache/fragments/{projectId}/{modelId}.frag。
下次打开同一个 GIM 时，优先加载 fragment_cache_path。
如果缓存文件不存在或 parser_version 不一致，则重新转换。
```

> 这里需根据 That Open / Fragments 当前 API 确认"导出/导入 fragments"的具体方法。先让 Trae 在当前依赖版本中定位可用方法，再改代码，不要猜 API。

---

# M3：线路 GIM 可视化 🚧 进行中

> GIM 文件分变电工程和线路工程两类，前期按变电工程开发（M1/M2）。线路工程无 IFC 文件，无法复用 web-ifc 3D 渲染。M3 为线路工程建立独立的结构浏览（phase 1，已完成）和地图可视化（phase 2，待实现）。

## M3 背景

线路工程本质是**线性空间对象**——核心不是室内构件，而是"沿地理空间延展的塔位、线段、跨越物"。GIM 内已包含杆塔的 BLHA 坐标信息，足够做地图定位。即使没有 IFC，也可用：

- **塔位 = 铁塔示意图符号**（第一版 canvas 直接绘制，SVG/billboard 作为后续增强）
- **导线段 = 折线**
- **跨越物 = 特殊标记**

做一个实用的线路浏览 MVP。比"强行等 IFC"更符合线路工程数据特性。

### 可行性评级（综合 `gim-analysis.md` 与 `line-implement.md`）

| 功能 | 可行性 | 难度 | 阶段 |
|---|---|---|---|
| 塔位地图展示 | 很高（90%+） | 低 | M3-4 |
| 导线折线展示 | 高（80%+） | 中 | M3-4 |
| 跨越点展示 | 高 | 低 | M3-4 |
| 按 WIRETYPE 着色/分组 | 高 | 低 | M3-5 |
| 基于 KVALUE 的近似悬链线 | 中高（60~75%） | 高 | 后置（3D 阶段） |
| 真实杆塔/跨越物 3D `.mod` 渲染 | 中等 | 很高 | 后置（3D 阶段） |

### 数据基础（已在 phase 1 解析进 `GimGraph`）

| 数据 | 来源节点 | 字段 | demo-line 规模 |
|---|---|---|---|
| 杆塔坐标 | F4System (GROUPTYPE=TOWER) | `rawProps.BLHA` = 纬度,经度,高程,方位角 | 327 |
| 杆塔编号/呼高/转角 | F4System-TOWER 关联 FAM | 杆塔编号(N0)、呼高、转角 | 327 |
| 杆塔类型(耐张/直线) | Tower_Device 关联 DEV/FAM | 塔型、杆塔类型 | 327 |
| 导地线段路径 | WIRE | `POINT0.BLHA`、`POINT1.BLHA` + `KVALUE`、`SPLIT` | 5460 |
| 线型分类 | F4System (GROUPTYPE=WIRE) | `WIRETYPE` = CONDUCTOR/GROUNDWIRE/OPGW | 5460 |
| 跨越点 | F4System (GROUPTYPE=CROSS) → CROSS | CROSS 的 .mod POINT（经纬度） | 74 |

> **坐标格式陷阱**：BLHA = `纬度,经度,高程,方位角`（lat 在前，lng 在后），与 GeoJSON 的 `[lng,lat]`、Leaflet 的 `[lat,lng]` 顺序不同，提取时必须显式映射，不可整段透传。

## M3-1：线路工程类型识别 ✅

**实现内容**：新增 `src/gim/projectType.ts`，基于 `KEY=VALUE` 级别匹配（非子串检查）区分 `substation` / `transmission_line` / `hybrid` / `unknown`：
- 11 类精确键存在性信号 + 4 类实体值信号（`ENTITYNAME`/`GROUPTYPE`/`DEVICETYPE`）
- PascalCase 目录布局兜底（`Cbm/Dev/Mod` 存在且无 IFC → 强制 `transmission_line`）
- 大小写敏感区分：`Cbm/Dev/Mod/Phm`（线路）vs `CBM/DEV/MOD/PHM`（变电）

**验收**：demo-line → `transmission_line`，demo-substation → `substation`，无 WIREWEIGHT/CROSSSECTION 误判。

## M3-2：线路 CBM 解析与 GimGraph ✅

**实现内容**：
- 新增 `src/gim/gimGraphTypes.ts`（`GimGraph` / `GimGraphNode`，统一覆盖 8 种引用类型）
- 新增 `src/gim/lineCbmParser.ts`，支持 13 种子节点引用键（SECTIONS/STRAINSECTIONS/GROUPS/TOWERS/STRINGS/BASES/SUBDEVICES…）
- 修改 `openGimService.ts`：`transmission_line` 分支跳过 IFC 模态框和 ViewerRuntime 创建
- 新增 `src/ui/lineProjectView.ts`：复用层级树/文件摘要/属性面板

**验收**：demo-line 构建出 27829 节点的 GimGraph，层级树/文件摘要/属性面板可用；变电工程流程不受影响。

## M3-3：线路 SQLite 索引缓存 ✅

**实现内容**：
- `PARSER_VERSION` 升级至 `gim-parser-v4`
- Rust 侧新增 4 表：`line_cbm_node` / `line_cbm_child` / `line_cbm_ref` / `line_file_stat`
- 新增 Tauri 命令：`save_line_gim_graph` / `get_line_gim_graph` / 增强 `validate_gim_cache`
- 前端服务：`lineGraphPersistenceService.ts` / `lineGraphRestoreService.ts`
- `upsert_gim_project` 在 size/modified_ms/sha256 变化时置 `parser_version = NULL`
- `ProjectCacheDiagnostic` 扩展线路字段

**验收**：demo-line 首次打开写入 SQLite，二次打开从缓存恢复 27829 节点无丢失，跳过 CBM 重解析。

## M3-3.5：线路 FAM/DEV 属性解析与缓存 ⏳ 待实现

> **背景**：线路工程的杆塔编号、塔型、呼高、转角、导线型号、设备类型等字段不应只依赖 `currentFiles` 临时读取。当前 M3-3 只缓存了 `GimGraph`，二次打开时 `currentFiles=null`，无法再读取 FAM/DEV 原文。因此首次打开线路 GIM 后需把 FAM/DEV 属性持久化到 SQLite；二次打开时，地图数据提取（M3-4）应从 SQLite 恢复的属性缓存读取这些字段，而不是回头读原始 GIM 内文件。

### 新增数据库表

见上文「数据库设计 - 线路工程表」中的 `line_fam_property` / `line_dev_property`。两张表均带 `raw_line` 与 `sort_order`，保留原始行用于审计/兜底。

### PARSER_VERSION 升级

- 将 `PARSER_VERSION` 从 `gim-parser-v4` 升级到 `gim-parser-v5`
- 源码注释：`v5: adds transmission_line FAM/DEV attribute cache`

**版本含义**：

| 版本 | 含义 |
|---|---|
| `gim-parser-v4` | transmission_line **graph** cache（仅 `line_cbm_node/child/ref/file_stat`） |
| `gim-parser-v5` | transmission_line **graph + FAM/DEV attribute** cache（含 `line_fam_property` / `line_dev_property`） |

**失效语义**：旧 v4 线路缓存必须因版本不匹配（`parser_version_match=false`）或属性缺失（`line_fam_source_count=0`）而重建。重建走完整解压 + graph 写入 + 属性写入流程，并最终把 `parser_version` 置为 `v5`。

### 解析规则

1. **线路 FAM 支持扁平格式** `中文键名=ENGLISH_KEY=值`：
   - `display_key` = 中文键名（如 "杆塔编号"）
   - `prop_key` = ENGLISH_KEY（如 "N0"）
   - `prop_value` = 值
   - `raw_line` = 原始行
2. **普通 `KEY=VALUE` 行**：
   - `display_key` = `null`
   - `prop_key` = KEY
   - `prop_value` = VALUE
3. **DEV 文件**按普通 `KEY=VALUE` 解析：
   - `prop_key` = KEY，`prop_value` = VALUE，`raw_line` = 原始行

### FAM 行解析（值中包含等号的处理）

实际工程文件里，值可能也包含 `=`（如说明、公式、材料描述）。**不能简单 `split('=')` 后只取前三段**，否则属性值会被截断：

- 若一行包含**两个及以上** `=`：
  - 第一段为 `display_key`
  - 第二段为 `prop_key`
  - **第三段及以后重新用 `=` 拼回** `prop_value`（保留值中的等号）
- 若只包含**一个** `=`：
  - 第一段为 `prop_key`，第二段为 `prop_value`
- 空行、BOM、不可见控制字符要清理（trim + 去 BOM）
- 不符合上述格式的行：保留 `raw_line`，但**不生成 `prop_key`**，记入 parser warnings（不阻断解析）

### LineRefKind 枚举（强制常量）

`ref_kind` 字段必须使用统一枚举常量，**不允许手写字符串**，否则后续易出现 `fam` / `FAM` / `famFiles` / `refs.famFiles` 不一致，导致 `line_expected_fam_ref_count=0`。写入、恢复、诊断三处全部引用同一常量：

```ts
type LineRefKind =
  | 'cbmFiles'
  | 'devFiles'
  | 'famFiles'
  | 'phmFiles'
  | 'modFiles'
  | 'stlFiles'
  | 'wireFiles'
  | 'ifcFiles'
  | 'ifcGuids'
  | 'rawRefs';
```

> 此枚举必须与 `lineGraphPersistenceService.ts` 当前写入的 `ref_kind` 完全一致。覆盖率诊断统计期望引用时固定用 `ref_kind='famFiles'` / `ref_kind='devFiles'`。

### 新增前端类型

```ts
interface LineFamPropertyRecord {
  source_path: string;          // 原始路径，归一化前
  normalizedPath: string;       // 归一化后路径，用于索引 key
  display_key: string | null;
  prop_key: string;
  prop_value: string | null;
  raw_line: string | null;
  sort_order: number;
}

interface LineDevPropertyRecord {
  source_path: string;
  normalizedPath: string;
  prop_key: string;
  prop_value: string | null;
  raw_line: string | null;
  sort_order: number;
}

// 单个 FAM 文件内 prop_key → 属性数组（同 key 多值全部保留，不在缓存层丢弃重复 key）
type LineFamPropertyMap = Map<string, LineFamPropertyRecord[]>;
// 单个 DEV 文件内 prop_key → 属性数组
type LineDevPropertyMap = Map<string, LineDevPropertyRecord[]>;

// 属性索引：由 service/AppState 组装后传给 gim/ 层，gim/ 层不依赖 AppState
interface LineAttributeIndex {
  famBySourcePath: Map<string, LineFamPropertyMap>;       // key = normalizedPath
  famByFileNameLower: Map<string, LineFamPropertyMap>;    // key = 文件名小写（如 "xxx.fam"）
  devBySourcePath: Map<string, LineDevPropertyMap>;
  devByFileNameLower: Map<string, LineDevPropertyMap>;
}
```

**候选键取值工具**（gim 层提供，M3-4 复用）：

```ts
// 从 famMap 中按候选键列表取首个有效 prop_value（非空且非占位）
function pickFirstValue(
  famMap: LineFamPropertyMap | undefined,
  candidateKeys: string[]   // 如 ['N0', '杆塔编号', 'TOWERNO']
): string | undefined
```

读取 `towerNumber` 等字段时统一走 `pickFirstValue`，避免在缓存层丢弃同 key 多值记录（同 key 多值可能因 FAM 多节或重复声明存在，保留数组供审计）。

### 路径归一化

新增 `src/gim/linePathNormalize.ts`：

```ts
function normalizeGimPath(path: string): string
```

**规则**：

1. `\` 统一转 `/`
2. 移除空 segment（连续分隔符、首尾分隔符）
3. 识别并保留 GIM 内部顶层目录：`Cbm / Dev / Fam / Phm / Mod` 或 `CBM / DEV / FAM / PHM / MOD`
4. 对匹配索引统一使用 **lower-case key**（仅用于索引匹配，不改变原始路径）
5. 保留 `source_path` 原值用于 UI 展示

**双索引**：属性缓存需同时建立 source_path 索引与文件名小写索引（见 `LineAttributeIndex`），保证以下引用都能命中：

| 引用形态 | 命中索引 |
|---|---|
| `xxx.fam` | `famByFileNameLower` |
| `Fam/xxx.fam` | `famBySourcePath`（归一化后）/ `famByFileNameLower` |
| `demo-line/Fam/xxx.fam` | `famBySourcePath`（截取顶层目录后） |
| `Fam\xxx.fam` | `famBySourcePath`（`\` 转 `/` 后） |

### 新增服务/解析器

- `src/gim/lineFamParser.ts`
  - `parseLineFam(text: string): LineFamProperty[]`
  - 支持 `中文键=ENGLISH_KEY=值`，也支持普通 `KEY=VALUE`
  - 保留 `raw_line` 与 `sort_order`
- `src/gim/lineDevParser.ts`
  - `parseLineDev(text: string): LineDevProperty[]`
- `src/services/lineAttrPersistenceService.ts`
  - 从 `GimGraph` 的 refs 中收集所有 `.fam` / `.dev` 引用
  - 从 `currentFiles` 读取对应文件原文
  - 调用 `parseLineFam` / `parseLineDev` 后通过 Tauri command 写入 SQLite
- `src/services/lineAttrRestoreService.ts`
  - 从 SQLite 读取 `line_fam_property` / `line_dev_property`
  - 写入 `AppState`（**带 source_path 作用域，display_key 保留每个 FAM 文件自己的中文标签**）：
    ```ts
    cachedLineFamProperties: Map<string, LineFamPropertyMap>      // key = normalizedPath
    cachedLineFamDisplayKeys: Map<string, Map<string, string>>  // 外层 normalizedPath，内层 prop_key → display_key
    cachedLineDevProperties: Map<string, LineDevPropertyMap>     // key = normalizedPath
    ```
  - 同时建立文件名小写索引（`famByFileNameLower` / `devByFileNameLower`），供 M3-4 双路径命中
  - 暴露 `buildLineAttributeIndex(state): LineAttributeIndex`，由 `lineProjectView` 在渲染前组装传给 `extractLineMapData`

### Rust 新增 Tauri commands

**强制统一 command**（一个 Rust transaction 内完成全部写入，避免半成品缓存）：

```rust
save_line_project_cache(
  project_id: i64,
  graph_payload: LineGraphPayload,
  fam_props: Vec<LineFamPropertyRow>,
  dev_props: Vec<LineDevPropertyRow>
) -> Result<()>
```

> **强制约束**：`openGimService` 的**线路首次导入路径必须调用这个 command**，不得拆分为 graph + attributes 两次调用。这是 M3-3.5 的硬性要求。

**单事务顺序**：

1. 删除旧线路 graph 表：`line_cbm_node` / `line_cbm_child` / `line_cbm_ref` / `line_file_stat`
2. 删除旧线路属性表：`line_fam_property` / `line_dev_property`
3. 插入 graph payload（4 表）
4. 插入 FAM/DEV 属性（2 表）
5. 最后更新 `gim_project`：
   - `parser_version = 'gim-parser-v5'`
   - `project_type = 'transmission_line'`

> **关键**：`parser_version` 升级到 v5 必须是事务的最后一步。只有 graph + 属性全部写入成功才置 v5，避免"graph 写成功、属性写失败"时形成半成品完整缓存被误判为命中。

**关于 `save_line_gim_graph`**：
- 该 command 可以保留（向后兼容、单元测试、回滚场景）
- 但**生产线路导入路径不再单独调用它**——首次导入一律走 `save_line_project_cache`
- 若代码中发现 openGimService 在 transmission_line 分支调用了 `save_line_gim_graph` 而非 `save_line_project_cache`，视为实现缺陷

**读取 command**（不变）：
- `get_line_attributes(project_id)`：返回 fam + dev 全量属性，供前端 `lineAttrRestoreService` 还原到 AppState

### 性能与 payload 控制

demo-line 规模已不小（一次性 invoke 的 JSON 体积可能很大），统一事务正确但需给实现留性能保护：

- Rust 侧必须使用 **prepared statement 批量插入**，不要每行 prepare
- 前端调用 `save_line_project_cache` 前输出 payload 统计日志：
  ```
  nodes / children / refs / fam_props / dev_props / estimatedJsonSizeMB
  ```
- 若 `estimatedJsonSizeMB` 超过阈值（例如 **50MB**），后续切换为 **temp JSON file + Rust 读取文件入库** 方案（前端写临时文件，Rust 侧流式读取，避免 IPC 大 payload）
- 当前 demo-line 可先用一次性 invoke，但**必须记录耗时和 payload 大小**到日志

> 这不是阻塞项，但必须有日志。否则一旦导入卡住，很难判断是解析慢、IPC 大，还是 SQLite 插入慢。

### 缓存校验增强

`validate_gim_cache` 对 `transmission_line` 的 valid 条件从：

```text
parser_version_match && line_cbm_node_count > 0
```

增强为：

```text
project_type = transmission_line
&& parser_version_match           // = 'gim-parser-v5'
&& line_cbm_node_count > 0
&& line_fam_source_count > 0      // 至少一个 FAM 文件被缓存
```

> **不强制** `line_dev_source_count > 0`——某些线路 GIM 的 DEV 可能不完整，但必须诊断输出。FAM 是地图增强属性的核心来源，必须命中。

### ProjectCacheDiagnostic 新增字段

**计数类**：
- `line_fam_property_count`（属性行总数，向后兼容诊断）
- `line_dev_property_count`
- `line_fam_source_count`（distinct `source_path` 数，**参与 valid**）
- `line_dev_source_count`

**期望 vs 实际覆盖率**：
- `line_expected_fam_ref_count`：从 `line_cbm_ref` 统计 `ref_kind='famFiles'` 的 distinct `ref_value`
- `line_expected_dev_ref_count`：从 `line_cbm_ref` 统计 `ref_kind='devFiles'` 的 distinct `ref_value`
- `missing_line_fam_sources: string[]`：期望引用但属性表未缓存的 FAM source_path 列表
- `missing_line_dev_sources: string[]`：期望引用但属性表未缓存的 DEV source_path 列表

**统计方式**：actual FAM/DEV 分别从 `line_fam_property` / `line_dev_property` 统计 distinct `source_path`；与 `line_cbm_ref` 的期望引用集做差集得到 missing 列表。路径匹配走 `normalizeGimPath` 归一化后比较。

`has_index` 判定维持既有规则：`cbm_nodes_count > 0 || ifc_models_count > 0 || line_cbm_node_count > 0`（FAM/DEV 计数不参与 has_index，只参与 valid 判定）。

### 状态恢复顺序（强制）

两条路径必须严格按下列顺序执行，不得跳步或重排：

**A. 首次导入路径**（缓存未命中，`currentFiles` 非空）：

```text
extract GIM
  → detect transmission_line
  → buildLineGimGraph(files)                          // 构建 GimGraph
  → parseLineAttributes(graph, currentFiles)          // 解析 FAM/DEV 原文
  → save_line_project_cache(project_id, graph, fam, dev)   // 单事务写入 SQLite
  → restoreLineGraphToState(graph → state.currentGimGraph) // 内存恢复（不必再从 DB 读回）
  → restoreLineAttributesToState(fam, dev → state.cachedLine*)
  → renderLineProjectPanels(state)
```

> 关键：首次导入时 `parseLineAttributes` 的结果已在内存，**直接用于 restore**，不需要再调 `get_line_attributes` 回读 SQLite。

**B. 缓存命中路径**（`currentFiles=null`）：

```text
validate_gim_cache → valid=true
  → get_line_graph(project_id)           → restoreLineGraphToState
  → get_line_attributes(project_id)     → restoreLineAttributesToState
  → renderLineProjectPanels(state)
```

> 关键：缓存命中路径**不读取原始 GIM、不解压**，graph 与 attrs 全部从 SQLite 恢复，`currentFiles` 保持 `null`。`renderLineProjectPanels` 通过 `buildLineAttributeIndex(state)` 组装 attrs 传给 `extractLineMapData`。

### 验收

1. **首次打开** `demo-line.gim`：
   - 写入 line graph + line FAM/DEV attributes（同一事务）
   - `gim_project.parser_version = 'gim-parser-v5'`
   - `gim_project.project_type = 'transmission_line'`
   - `line_cbm_node_count > 0`
   - `line_fam_source_count > 0`
   - `line_dev_source_count > 0`
   - Console 出现：`[Tauri] 线路 FAM/DEV 属性已写入 SQLite`
2. **二次打开** `demo-line.gim`：
   - 不解压、不读取原始 GIM
   - 从 SQLite 恢复 GimGraph
   - 从 SQLite 恢复线路 FAM/DEV 属性
   - `state.currentFiles === null`
   - `state.cachedLineFamProperties.size > 0`
   - `state.cachedLineDevProperties.size > 0`
3. **Ctrl+Shift+D 诊断**显示：
   - `project_type = transmission_line`
   - `valid = true`
   - `parser_version = gim-parser-v5`
   - `line_cbm_node_count > 0`
   - `line_fam_source_count > 0`
   - `line_expected_fam_ref_count > 0`
   - `missing_line_fam_sources`：可为空或少量存在，但**必须输出该字段**（即使空数组也要返回）

## M3-4：地图数据提取层 ⏳ 待实现

新增 `src/gim/lineMapData.ts`（纯逻辑，无 UI/Viewer 依赖，符合 gim/ 分层边界）。

**投喂指令**：

```txt
请新增 src/gim/lineMapData.ts，从 GimGraph + LineAttributeIndex 提取地图展示所需的扁平数据结构 LineMapData。

【分层边界（强制）】
  - extractLineMapData(graph: GimGraph, attrs: LineAttributeIndex): LineMapData
  - gim/ 层只接收 graph + attrs 两个入参，禁止 import AppState、禁止读 state.currentFiles
  - attrs 由 lineProjectView 或 service 调用 buildLineAttributeIndex(state) 组装后传入

数据结构（放 gimGraphTypes.ts 或新建 lineMapTypes.ts）：
  TowerMarker  {
    cbmPath, lat, lng, elev, azimuth,
    towerNumber?: string, towerType?: string, towerHeight?: string, turnAngle?: string,
    dataQuality: 'full' | 'partial' | 'coords-only',
    famSource?: string,            // 命中的 FAM normalizedPath（用于诊断/UI）
    devSource?: string,            // 命中的 DEV normalizedPath
    nodeRef
  }
  WireSegment  { startLat, startLng, endLat, endLng, wireType, kValue?, split?, nodeRef }
  CrossMarker  { cbmPath, lat, lng, crossType?, name?, nodeRef }
  LineMapData  {
    towers: TowerMarker[],
    wires: WireSegment[],
    crosses: CrossMarker[],
    bbox: { minLat, maxLat, minLng, maxLng },
    warnings?: string[],
    stats: {                          // 覆盖率诊断
      towerTotal: number,
      towerWithBlha: number,
      towerWithFam: number,
      wireTotal: number,
      wireWithEndpoints: number,
      crossTotal: number,
      crossWithCoord: number
    },
    unresolved: {                    // 未解析引用（不阻断渲染）
      towers: string[],
      wires: string[],
      crosses: string[],
      famSources: string[],          // 期望但 attrs 未命中的 FAM
      devSources: string[]
    }
  }

提取规则（属性取自入参 attrs: LineAttributeIndex，不读 currentFiles/state）：
  1. 塔位坐标
     - 主来源：entityName=F4System 且 rawProps.GROUPTYPE=TOWER 的 rawProps.BLHA
     - 解析为 lat/lng/elev/azimuth（BLHA = 纬度,经度,高程,方位角，lat 在前 lng 在后，必须有单测防颠倒）
  2. 塔位属性（杆塔编号 / 塔型 / 呼高 / 转角）
     - 从节点 BASEFAMILY 或 refs.famFiles 找到候选 FAM 引用
     - 走 normalizeGimPath 归一化后查 attrs.famBySourcePath；未命中再回退 attrs.famByFileNameLower
     - 命中后在该 FAM 的 LineFamPropertyMap 中按候选键匹配（如杆塔编号可匹配 N0 / 杆塔编号 / TOWERNO 等多个候选）
     - 记 famSource = 命中的 normalizedPath；命中字段数决定 dataQuality：全命中=full，部分=partial，仅坐标=coords-only
  3. 设备类型
     - 从 OBJECTMODELPOINTER 或 refs.devFiles 找到候选 DEV 引用
     - 走 normalizeGimPath 后查 attrs.devBySourcePath / devByFileNameLower
     - 读取 DEVICETYPE / TYPE 等字段；记 devSource = 命中的 normalizedPath
     - 用于耐张塔/直线塔图标分类（DEVICETYPE=TOWER 时再细分）
  4. 导线属性
     - WIRE 坐标取自 POINT0.BLHA / POINT1.BLHA
     - wireType 从 topo.wireGroupByWirePath 获取（不再逐节点向上回溯）
     - 导线型号等增强字段从 attrs.famBySourcePath / devBySourcePath 读取
     - 端点兜底：WIRE 若无 POINT.BLHA，用 BACKSTRING/FRONTSTRING 经 topo.towerGroupByStringPath /
       topo.towerGroupByDevicePath 反查两端所属 TOWER F4 的 BLHA 补推（见下方拓扑索引）

【拓扑索引（强制）】
  GimGraph 是 children 树，想从 WIRE → F4(WIRE) → BACKSTRING/FRONTSTRING → Tower_Device →
  所属 TOWER F4 → BLHA 稳定反查，必须先建立拓扑索引。否则实现时只做 parentByPath，无法补推导线端点。

  extractLineMapData 开始时先 buildLineGraphTopoIndex(graph)，后续所有 wireType/端点兜底都读 topo：

  interface LineGraphTopoIndex {
    parentByPath: Map<string, GimGraphNode>;
    nodeByPath: Map<string, GimGraphNode>;
    towerGroupByDevicePath: Map<string, GimGraphNode>;   // Tower_Device → 所属 F4System(GROUPTYPE=TOWER)
    towerGroupByStringPath: Map<string, GimGraphNode>;    // STRING*.STRING 挂点 → 所属 TOWER F4
    wireGroupByWirePath: Map<string, GimGraphNode>;       // WIRE → 所属 F4System(GROUPTYPE=WIRE)
  }

  function buildLineGraphTopoIndex(graph: GimGraph): LineGraphTopoIndex

  使用约束：
    - wireType 从 topo.wireGroupByWirePath 获取
    - wire endpoint fallback 从 topo.towerGroupByStringPath / towerGroupByDevicePath 获取塔位 BLHA
    - topo 仅在 extractLineMapData 内部构建，不持久化、不回写 state
  5. 缓存命中要求（强制）
     - currentFiles=null 时仍必须能生成完整 LineMapData（attrs 由 SQLite 恢复，与 currentFiles 无关）
     - 不允许 M3-4 在缓存命中时再尝试读取原始 GIM 内文件
     - 若某塔位 FAM 缺失：不阻断地图渲染，把该塔 famSource 置空、dataQuality='coords-only'，
       并将该 source_path 记入 unresolved.famSources 和 warnings

遍历入口：GimGraph.nodesByPath
  - F4System + GROUPTYPE=TOWER  → TowerMarker
  - F4System + GROUPTYPE=CROSS  → CrossMarker（坐标从 CROSS 子节点的 .mod POINT 或 BLHA 取）
  - WIRE                        → WireSegment
  - 计算 bounding box 用于初始视图
  - 统计 stats 与 unresolved 在遍历结束时一次性填充

纯逻辑，不碰 DOM、不碰 DB、不碰 AppState。BLHA 解析单测覆盖。
```

**验收**：
- demo-line 提取 327 TowerMarker（lat≈26.5~26.9, lng≈112.4~112.7）+ 5460 WireSegment（wireType 覆盖三型）+ 74 CrossMarker
- BLHA 单测：`"26.84596049,112.43415192,63.880,420.507943"` → lat=26.84596049, lng=112.43415192（**BLHA = 纬度,经度，lat 在前 lng 在后，不可颠倒**）
- **分层边界**：`lineMapData.ts` 无 `import ... from '../app/state'`，`extractLineMapData` 签名严格为 `(graph, attrs) => LineMapData`
- `currentFiles=null` 时仍能生成完整 LineMapData（attrs 由 SQLite 恢复，与 currentFiles 无关），不抛错、不读原 GIM
- **缓存命中路径下** TowerMarker 至少能从属性缓存补充部分 `towerNumber` / `towerType` / `towerHeight` / `turnAngle`
- `TowerMarker` 包含：`lat/lng/elev/azimuth` + `towerNumber?/towerType?/towerHeight?/turnAngle?` + `dataQuality` + `famSource?/devSource?`
- 某塔位 FAM/DEV 缺失时，**只产生 `warnings` 与 `unresolved.famSources/devSources`**，不阻断地图渲染；该塔 `dataQuality='coords-only'`、`famSource` 置空
- **CROSS 验收（宽松）**：`stats.crossTotal = 74`，`stats.crossWithCoord = 实际可定位数量`；无坐标的 CROSS 进入 `unresolved.crosses`。在 `.mod` 解析后置（远期）的前提下，**不强制要求 74 个 CrossMarker 全部可定位**——只要 `crossTotal` 统计正确且无坐标的进入 unresolved 即通过
- `stats` 字段填充完整（`towerTotal`/`towerWithBlha`/`towerWithFam`/`wireTotal`/`wireWithEndpoints`/`crossTotal`/`crossWithCoord`），可用作 Ctrl+Shift+D 之外的运行时覆盖率诊断
- `npm run build` 通过

## M3-5：地图渲染层 ⏳ 待实现

新增 `src/ui/lineMapView.ts`（纯 UI/DOM，不直接碰 DB）。渲染到现有 `#viewport`（线路工程下原本空置，正好作地图画布）。

**投喂指令**：

```txt
请新增 src/ui/lineMapView.ts，在 #viewport 渲染线路工程 2D 地图。

渲染方式（第一版全 Canvas，降低命中测试/缩放同步/DOM 清理复杂度）：
  - canvas 画背景、导线折线、跨越点、塔位 marker、标签
  - 塔位符号用 canvas 直接绘制（或离屏图片 drawImage），327 基完全可单 canvas 承载
  - SVG/HTML overlay 作为后续增强（后置），不进第一版
  - 若后续引入 SVG overlay，必须和 Canvas 共用同一投影/缩放状态，并纳入 destroy() 统一清理
内容：
  1. 背景：浅色底 + 经纬度网格线 + 边框 + 比例尺
  2. 导地线：按 WIRETYPE 着色折线
       CONDUCTOR=#3b82f6（蓝）/ GROUNDWIRE=#6b7280（灰）/ OPGW=#10b981（绿）
  3. 跨越点：canvas 绘制特殊符号（⚠️ 或自定义图形）
  4. 杆塔：canvas 绘制塔位符号，按耐张/直线区分（耐张用菱形/实心，直线用圆形/空心，或离屏图 drawImage）
  5. 标注：杆塔标签按优先级取值
       优先级 1 → towerNumber（来自 cachedLineFamProperties）
       优先级 2 → name（GimGraphNode.name）
       优先级 3 → cbmPath 的文件名
       全部缺失时显示空标签，但 marker 仍绘制
  6. 图例：左下角线型图例

投影（等距矩形，小范围 138km 内近似）：
  centerLat = (minLat + maxLat) / 2
  centerLng = (minLng + maxLng) / 2
  x = (lng - centerLng) * cos(centerLat)   // 经度方向按纬度收敛修正
  y = lat - centerLat                       // 纬度方向线性
  再把 (x, y) 线性 fit 到 canvas 像素范围（保持 bbox 居中、留边距）。
  注意：BLHA = 纬度,经度（lat 在前 lng 在后），提取时 lat/lng 顺序不可颠倒；本公式中 x 用 lng、y 用 lat，与 BLHA 字段顺序无关，只与归一化后的 lat/lng 变量绑定。

交互：
  - 滚轮缩放、拖拽平移
  - 点击杆塔 → onTowerClick(nodeRef) 回调（绑到 showLineNodeProperties）
  - hover 杆塔 → tooltip 显示：杆塔编号 / 塔型 / 呼高 / 转角 / BLHA / FAM·DEV 是否命中
     · 若 FAM/DEV 属性缺失，tooltip 显示"属性未缓存"或"属性缺失"，但地图点仍显示
  - "回到全景"按钮 fit bbox

导出（返回 handle，便于生命周期管理）：
  interface LineMapViewHandle {
    fit(): void;        // 回到全景 bbox
    destroy(): void;    // 释放 canvas/SVG 资源，移除事件监听
  }
  renderLineMap(mapData, container, onTowerClick): LineMapViewHandle
```

**生命周期（强制）**：`lineProjectView` 或 AppState 保存当前 `LineMapViewHandle`，在以下场景调用 `destroy()`，防止线路 canvas 残留遮挡 IFC viewer：
- 打开新 GIM
- 切换到变电工程（走 3D 流程）
- 清空场景

**验收**：
- 打开 demo-line.gim 后视口显示线路走向图，327 基杆塔 + 跨越点可见
- 导地线按类型着色，图例可辨
- 耐张塔/直线塔图标区分
- 点击杆塔弹出属性面板，字段与层级树点击一致
- 缩放/平移流畅
- `renderLineMap` 返回 `LineMapViewHandle`，`handle.fit()` 可回到全景、`handle.destroy()` 释放后 DOM 中无残留 canvas/SVG
- `npm run build` 通过

## M3-6：UI 集成 ⏳ 待实现

修改 `src/ui/lineProjectView.ts`。

**投喂指令**：

```txt
请修改 src/ui/lineProjectView.ts 的 renderLineProjectPanels：
- 调用 buildLineAttributeIndex(state) 组装 LineAttributeIndex（从 cachedLineFamProperties/cachedLineDevProperties）
- 调用 extractLineMapData(state.currentGimGraph, attrs) 提取 LineMapData
- 调用 lineMapView.ts 的 renderLineMap 渲染到 #viewport，保存返回的 LineMapViewHandle 到 state/AppState
- 移除原有"线路工程当前以结构浏览为主，暂无 IFC 模型"提示
- 杆塔点击回调绑定 showLineNodeProperties（与层级树点击共用属性面板）
- 保留左侧层级树、文件设备摘要不变
- 在"打开新 GIM / 切换变电工程 / 清空场景"路径上调用已保存 handle 的 destroy()，避免 canvas 残留
- 不修改变电工程流程
```

**验收**：
- 打开线路 GIM → 视口自动渲染地图
- 层级树点击与地图点击共用属性面板，互不冲突
- 打开变电 GIM → 仍走原 3D 流程，不受影响；线路 canvas 已 destroy，无残留
- 切换 GIM / 清空场景时旧地图 handle 被 destroy
- `npm run build` 通过

## M3 后置项（可选，优先级低）

> **注意**：线路 FAM/DEV 属性缓存**不是后置项**，而是 M3-4 地图数据提取的前置条件，已前移到 **M3-3.5**。后置项只保留以下四项与"属性增强"无关的远期能力。

### 离线真实底图（phase 2）

- 引入地图库（MapLibre GL 或 Leaflet）+ **离线瓦片**（MBTiles / PMTiles），而非在线 OSM
- 理由：项目以"离线运行"为核心卖点，离线瓦片优先于在线底图
- 在 lineMapView 内抽象"底图层 + 矢量叠加层"接口，M3-5 canvas 与 phase 2 瓦片底图实现同一接口
- 首次打开时预缓存工程 bbox 范围瓦片到 AppData，实现离线真实底图
- 在线 OSM 仅作为开发便利，不作默认

### 派生空间缓存表（大文件场景）

当 GIM 规模显著增大（CBM > 10万）时，可新增派生表避免每次现算：
```sql
CREATE TABLE line_map_tower (project_id, node_path, name, lat, lon, elevation, group_type, icon_type, raw_json);
CREATE TABLE line_map_wire  (project_id, node_path, wire_type, start_lat, start_lon, end_lat, end_lon, kvalue, raw_json);
CREATE TABLE line_map_cross (project_id, node_path, lat, lon, cross_type, raw_json);
```
M3-4~6 阶段（327 杆塔 + 5460 线段）从 GimGraph 单遍派生即可（ms 级），无需派生表。

### 3D 线路场景（远期）

- 基于 `KVALUE` + 端点挂点做近似悬链线
- 地形/高程支持、3D 相机浏览
- 这是"线路几何引擎"的一部分，成本高，留待远期

### `.mod` 几何解析（远期）

- 读取 `.mod`（HNum 格式）解析杆塔钢结构、跨越物真实几何
- 用于真实杆塔/跨越物 3D 渲染，替代 M3-5 的 canvas 塔位符号（第一版为 canvas 绘制示意图）
- 依赖独立的 `.mod` 解析器，与 M3-4 的 BLHA 提取是两条路径，互不阻塞

---

# 你应该避免的组织方式

- **不要**继续把所有逻辑写在 `src/main.ts`。UI、GIM 解析、CBM 树、IFC 加载、属性面板、拾取、高亮已混在一起的趋势，再加数据库和桌面能力会迅速失控。
- **不要**把 SQLite 当成"文件仓库"。大文件缓存进 AppData 目录，SQLite 只存路径。
- **不要**让 Trae 一次性"改造成桌面版 + 数据库 + 懒加载"。按里程碑步骤投喂，每步有明确验收点。
- **不要**在做线路地图时引入 3D / Fragments / web-ifc（延续 phase 1 约束）。
- **不要**用子串检查（`text.includes('WIRE')`）识别工程类型，必须用 `KEY=VALUE` 级别匹配。

---

# 建议的最小版本目标

**第一版（M1+M2 闭环）**：

```txt
打开 GIM → 计算 hash → 未命中则解析 CBM/FileDevRelation/FAM → 入库 → 显示树
→ 点击节点才加载对应 IFC → 下次打开同一 GIM 时直接显示树
```

**第二版（M3 结构浏览）**：

```txt
打开线路 GIM → 识别为 transmission_line → 构建 GimGraph → 缓存到 SQLite → 显示层级树/文件摘要/属性
```

**第三版（M3 地图可视化，当前推进中）**：

```txt
打开线路 GIM → 视口渲染地图 → 杆塔贴图 + 导线折线 + 跨越点 → 点击联动属性面板
```

**远期**：Fragments 缓存（M2-5）、离线真实底图（M3 后置）、3D 线路场景（M3 远期）、全文搜索设备、多 GIM 项目管理、批量预转换。
