# 桌面工具改造

> **实施状态（2026-06 更新）**：第一步~第六步已全部完成，第七步（Fragments 缓存）待定。
> 当前项目已基于 Tauri 2 + SQLite 实现完整缓存命中短路 + 节点级 IFC 懒加载 + FAM/DEV 属性缓存。
> 详见 AGENTS.md 的"缓存架构"和"已实现功能"章节。

你现在这个项目适合走 **Tauri + Vite + TypeScript + SQLite** 路线，而不是先上 Electron。理由很直接：当前项目已经是 Vite/TS 单页应用，`package.json` 里只有 `vite`、`typescript`、`three`、`@thatopen/components`、`@thatopen/fragments`、`libarchive.js`、`web-ifc` 等前端依赖，迁移到 Tauri 的成本较低。 Tauri 本身支持任意能编译成 HTML/JS/CSS 的前端，并用 Rust 承担后端逻辑；它也有官方 SQL 插件，可通过 SQLite/MySQL/PostgreSQL 驱动访问数据库。([Tauri][1]) ([Tauri][2])

Electron 也能做，但 SQLite 通常会涉及 `better-sqlite3` / `sqlite3` 这类原生 Node 模块。Electron 官方文档明确说明原生 Node 模块需要针对 Electron ABI 重新编译，否则容易出现模块版本不匹配问题。([Electron][3]) 你当前目标是快速把 GIM 阅读器产品化，不建议先把复杂度引到 Electron 原生模块构建上。

## 推荐总体结构

先把项目从“一个 `main.ts` 应用”拆成 **前端 UI 层、GIM 解析层、模型渲染层、缓存数据库层、桌面能力层**。

建议目录如下：

```txt
gim-viewer-desktop/
├─ package.json
├─ vite.config.ts
├─ index.html
├─ src/
│  ├─ app/
│  │  ├─ main.ts
│  │  ├─ App.ts
│  │  └─ bootstrap.ts
│  │
│  ├─ ui/
│  │  ├─ layout/
│  │  │  ├─ sidebar.ts
│  │  │  ├─ propsDrawer.ts
│  │  │  └─ tabs.ts
│  │  ├─ tree/
│  │  │  ├─ cbmTreeView.ts
│  │  │  └─ fileDevView.ts
│  │  └─ dialogs/
│  │     └─ ifcSelectDialog.ts
│  │
│  ├─ gim/
│  │  ├─ gimExtractor.ts
│  │  ├─ cbmParser.ts
│  │  ├─ famParser.ts
│  │  ├─ fileDevParser.ts
│  │  ├─ gimIndexer.ts
│  │  └─ types.ts
│  │
│  ├─ ifc/
│  │  ├─ ifcLoader.ts
│  │  ├─ ifcNameIndex.ts
│  │  ├─ ifcPropertyReader.ts
│  │  └─ ifcTypes.ts
│  │
│  ├─ viewer/
│  │  ├─ viewerEngine.ts
│  │  ├─ selection.ts
│  │  ├─ highlight.ts
│  │  ├─ camera.ts
│  │  └─ resize.ts
│  │
│  ├─ db/
│  │  ├─ db.ts
│  │  ├─ migrations.ts
│  │  ├─ gimRepository.ts
│  │  ├─ nodeRepository.ts
│  │  ├─ ifcRepository.ts
│  │  └─ cacheRepository.ts
│  │
│  ├─ desktop/
│  │  ├─ fileDialog.ts
│  │  ├─ appPaths.ts
│  │  └─ tauriBridge.ts
│  │
│  ├─ services/
│  │  ├─ openGimService.ts
│  │  ├─ importGimService.ts
│  │  ├─ lazyLoadService.ts
│  │  └─ cacheValidationService.ts
│  │
│  └─ shared/
│     ├─ hash.ts
│     ├─ logger.ts
│     ├─ errors.ts
│     └─ constants.ts
│
├─ src-tauri/
│  ├─ Cargo.toml
│  ├─ tauri.conf.json
│  ├─ capabilities/
│  │  └─ default.json
│  ├─ migrations/
│  │  ├─ 0001_init.sql
│  │  ├─ 0002_cache.sql
│  │  └─ 0003_indexes.sql
│  └─ src/
│     ├─ lib.rs
│     └─ main.rs
│
└─ docs/
   ├─ architecture.md
   ├─ db-schema.md
   └─ import-flow.md
```

重点不是目录多，而是边界清楚：

`gim/` 只负责从 GIM、CBM、FAM、FileDevRelation 里解析数据。
`viewer/` 只负责 Three.js / That Open / Fragments 的 3D 行为。
`db/` 只负责 SQLite 读写。
`services/` 负责把“打开 GIM、检查缓存、解析、入库、懒加载”串起来。
`ui/` 只负责 DOM 或组件渲染，不直接碰数据库和 IFC Loader。

## 数据库设计建议

不要只想着“把 GIM 存到 SQLite”。更合理的是：**SQLite 存索引和元数据，大文件缓存存在本地文件目录，数据库只存路径和校验信息**。

原因是 IFC、Fragments、几何缓存可能很大，全部塞进 SQLite BLOB 会导致数据库膨胀、备份慢、VACUUM 慢、读写锁明显。SQLite 适合存结构化索引、节点关系、属性、文件哈希、缓存状态。

建议最小表结构：

```sql
-- GIM 文件记录
CREATE TABLE gim_project (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  source_path TEXT,
  file_size INTEGER,
  file_mtime INTEGER,
  file_hash TEXT NOT NULL,
  parser_version TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- GIM 内部文件清单
CREATE TABLE gim_entry (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  entry_path TEXT NOT NULL,
  entry_type TEXT NOT NULL, -- CBM / FAM / IFC / DEV / OTHER
  file_name TEXT,
  file_size INTEGER,
  file_hash TEXT,
  local_cache_path TEXT,
  UNIQUE(project_id, entry_path)
);

-- CBM 层级节点
CREATE TABLE cbm_node (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  parent_id TEXT,
  path TEXT NOT NULL,
  name TEXT,
  entity_name TEXT,
  classify_name TEXT,
  fam_path TEXT,
  dev_path TEXT,
  ifc_file TEXT,
  ifc_guid TEXT,
  transform_matrix TEXT,
  sort_order INTEGER DEFAULT 0,
  UNIQUE(project_id, path)
);

-- IFC 文件索引
CREATE TABLE ifc_model (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  ifc_file TEXT NOT NULL,
  original_entry_path TEXT,
  fragment_cache_path TEXT,
  status TEXT NOT NULL DEFAULT 'pending', -- pending / converted / failed
  converted_at INTEGER,
  UNIQUE(project_id, model_id)
);

-- IFC GUID 与节点关系
CREATE TABLE ifc_element (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  ifc_guid TEXT NOT NULL,
  local_id INTEGER,
  cbm_node_id TEXT,
  name TEXT,
  entity_type TEXT,
  UNIQUE(project_id, model_id, ifc_guid)
);

-- 属性缓存
CREATE TABLE element_property (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  model_id TEXT,
  ifc_guid TEXT,
  cbm_node_id TEXT,
  source TEXT NOT NULL, -- cbm / fam / ifc
  section TEXT,
  prop_key TEXT NOT NULL,
  prop_value TEXT
);

-- 缓存任务状态
CREATE TABLE import_task (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  task_type TEXT NOT NULL, -- extract / parse_cbm / convert_ifc / build_index
  status TEXT NOT NULL,    -- pending / running / done / failed
  progress REAL DEFAULT 0,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

关键索引：

```sql
CREATE INDEX idx_cbm_node_project_parent ON cbm_node(project_id, parent_id);
CREATE INDEX idx_cbm_node_ifc ON cbm_node(project_id, ifc_file, ifc_guid);
CREATE INDEX idx_ifc_element_guid ON ifc_element(project_id, model_id, ifc_guid);
CREATE INDEX idx_property_node ON element_property(project_id, cbm_node_id);
CREATE INDEX idx_property_ifc ON element_property(project_id, model_id, ifc_guid);
```

## 打开 GIM 的流程

建议不要做成“打开后立刻全部解析、全部转换、全部加载”。应该拆成四个阶段。

### 阶段 1：快速识别

用户选择 GIM 后，先计算：

```txt
file_size
mtime
sha256 或 xxhash
parser_version
```

然后查 `gim_project`：

```txt
相同 hash + 相同 parser_version 命中：
  直接读取 SQLite 索引，秒开层级树、文件设备、属性面板基础信息

未命中：
  进入导入流程
```

### 阶段 2：轻量解析并入库

只解析：

```txt
CBM/project.cbm
CBM/*.cbm
CBM/FileDevRelation.cbm
FAM/*.fam
IFC 文件清单
IFCGUID 映射
```

这一步不要加载 3D 模型。目标是让左侧层级树和文件设备面板先可用。

### 阶段 3：按需转换 IFC

用户点击某个模型、节点、文件设备时，再判断对应 IFC 是否已有 Fragments 缓存：

```txt
有 fragment_cache_path：
  直接加载 fragments

没有：
  从 GIM 解包出的 IFC 或本地缓存 IFC 转换
  转换完成后写入 fragment_cache_path
  更新 ifc_model.status = converted
```

这才是真正提升二次加载速度的关键。缓存原始 IFC 的收益有限，缓存转换后的几何结果收益更大。

### 阶段 4：属性懒加载

属性也不要一次性全取。建议：

```txt
点击 CBM 节点：
  先显示 CBM / FAM 已缓存属性
  如果对应 IFC 已加载，再补充 IFC 属性

点击 3D 构件：
  根据 model_id + local_id / guid 查询 ifc_element
  命中数据库则显示缓存属性
  未命中则从模型读取，随后写入 element_property
```

## Tauri 集成方式

Tauri 官方 SQL 插件可以在前端通过 `@tauri-apps/plugin-sql` 访问数据库，文档示例是 `Database.load('sqlite:test.db')`，并支持迁移机制。([Tauri][2]) 但你的场景里，我建议分两层：

轻量查询可以从前端直接走 SQL 插件，例如读取树、读取属性、更新最近打开项目。

重任务不要放前端直接跑，例如 GIM 解包、hash、批量导入、Fragments 缓存管理。最好封装为 Tauri command，让 Rust 或受控后端命令处理文件路径、AppData 目录、缓存目录、导入任务状态。

推荐边界：

```txt
前端 TypeScript：
  UI、树、属性面板、3D viewer、调用服务

Tauri Rust：
  文件选择
  AppData 路径
  文件 hash
  大文件复制/删除
  SQLite migration 初始化
  后台导入任务入口
```

## Trae 开发顺序

不要让 Trae 一次性“改造成桌面版 + 数据库 + 懒加载”。这样很容易把现有可运行状态破坏。按下面顺序投喂任务。

### 第一步：先重构，不改功能 ✅ 已完成

让 Trae 做：

```txt
请把 src/main.ts 按职责拆分为 gim、viewer、ui、services 四层。
要求不改变现有功能，不引入数据库，不引入 Tauri。
拆分后 npm run build 必须通过。
```

验收标准：

```txt
浏览器模式仍可打开 IFC/GIM
属性面板、层级树、文件设备仍正常
main.ts 只保留 bootstrap 逻辑
```

### 第二步：引入项目数据模型 ✅ 已完成

让 Trae 做：

```txt
请新增 src/gim/types.ts，统一定义 GimProject、GimEntry、CbmNode、IfcModel、IfcElement、ElementProperty 等类型。
把散落在 main.ts 里的 interface 移到 types.ts。
不要改变运行逻辑。
```

验收标准：

```txt
所有 parser、viewer、ui 都引用统一类型
不再重复定义 CbmNode、IfcEntry
```

### 第三步：引入 Tauri 壳 ✅ 已完成

让 Trae 做：

```txt
请在当前 Vite 项目中接入 Tauri 2。
保留浏览器 dev 模式。
新增 src-tauri 目录。
先只实现桌面窗口启动，不接数据库。
```

Tauri 文档的创建命令包括 `npm create tauri-app@latest`，但你是已有 Vite 项目，更适合“在现有项目中增量接入”，不要重建项目。([Tauri][1])

### 第四步：加 SQLite migration ✅ 已完成

让 Trae 做：

```txt
请为 Tauri 项目加入 SQLite 支持。
新增 migrations，并创建 gim_project、gim_entry、cbm_node、ifc_model、ifc_element、element_property、import_task 表。
新增 src/db/db.ts 和 repository 层。
先只实现 initDb、insertProject、findProjectByHash。
```

Tauri SQL 插件需要添加插件依赖、启用 SQLite feature，并在 capabilities 中授予 SQL 权限；官方文档也说明默认会阻止潜在危险命令，需要通过 capabilities 开启权限。([Tauri][2])

### 第五步：实现缓存命中 ✅ 已完成

让 Trae 做：

```txt
请改造 openGimService。
打开 GIM 时先计算文件 hash，再查询 gim_project。
如果命中缓存，则从 SQLite 加载层级树和文件设备面板，不重新解包。
如果未命中，则沿用原解析流程，并把解析结果写入 SQLite。
暂时不做 IFC fragments 缓存。
```

验收标准：

```txt
第一次打开：正常解析并入库
第二次打开：不重新解析 CBM，直接显示树
清空数据库后：能重新导入
```

### 第六步：实现 IFC 懒加载 ✅ 已完成

让 Trae 做：

```txt
请实现 lazyLoadService。
当用户点击层级树节点或文件设备项时，根据 node.ifcFile 判断对应 ifc_model 是否已加载。
未加载则加载对应 IFC。
已加载则只执行定位、高亮、属性显示。
```

验收标准：

```txt
打开 GIM 后不自动加载所有 IFC
点击某个节点才加载对应 IFC
多次点击同一个 IFC 不重复加载
```

### 第七步：实现 Fragments 缓存 ⏳ 待定（当前优先级低）

这一步最后做：

```txt
请为 ifc_model 增加 fragment_cache_path 使用逻辑。
IFC 首次加载并转换后，将转换结果保存到 AppData/cache/fragments/{projectId}/{modelId}.frag。
下次打开同一个 GIM 时，优先加载 fragment_cache_path。
如果缓存文件不存在或 parser_version 不一致，则重新转换。
```

这里需要根据 That Open / Fragments 当前 API 确认“导出/导入 fragments”的具体方法。不要让 Trae 猜 API；先让它在当前依赖版本中定位可用方法，再改代码。

## 你应该避免的组织方式

不要继续把所有逻辑写在 `src/main.ts`。当前项目已经有 UI、GIM 解析、CBM 树、IFC 加载、属性面板、拾取、高亮等混在一起的趋势，后面再加数据库和桌面能力会迅速失控。

不要把 SQLite 当成“文件仓库”。大文件缓存建议进入：

```txt
AppData/
└─ gim-viewer/
   ├─ gim-cache.db
   ├─ extracted/
   │  └─ {projectId}/...
   ├─ fragments/
   │  └─ {projectId}/{modelId}.frag
   └─ logs/
```

SQLite 只保存：

```txt
项目记录
文件 hash
节点索引
GUID 映射
属性
缓存路径
导入状态
```

## 建议的最小版本目标

第一版桌面工具不要追求完整数据库化。先实现这个闭环：

```txt
打开 GIM
→ 计算 hash
→ 未命中则解析 CBM/FileDevRelation/FAM
→ 入库
→ 显示树
→ 点击节点才加载对应 IFC
→ 下次打开同一 GIM 时直接显示树
```

第二版再做：

```txt
IFC 转 Fragments 缓存
属性缓存
最近打开项目
缓存清理
导入进度
```

第三版再做：

```txt
全文搜索设备
按专业/系统过滤
离线项目库
多 GIM 项目管理
批量预转换
```

你的项目当前阶段，优先级应该是：**先重构边界，再接 Tauri，再接 SQLite 索引缓存，最后做 Fragments 懒加载缓存**。这样 Trae 每一步都有明确验收点，不容易把现有 GIM 阅读功能改坏。

[1]: https://v2.tauri.app/start/ "What is Tauri? | Tauri"
[2]: https://tauri.app/plugin/sql/ "SQL | Tauri"
[3]: https://www.electronjs.org/docs/latest/tutorial/using-native-node-modules "Native Node Modules | Electron"
