# GIM → SQLite 存储方案可行性分析

> 目标：将 GIM 解压后的散文件转换为 SQLite 数据库，以数据库查询替代反复的 `File.text()` 解析，提升大型 GIM 文件的访问速度，并支持懒加载。

---

## 一、当前架构与性能瓶颈

### 1.1 现状数据流

```
.gim 文件
  ↓ libarchive.js (WASM) 解压
Map<path, File> (内存中 36113 个 File 对象)
  ↓ 递归 await f.text()
CBM 层级树 + FileDevRelation + IFCGUID 反向索引
  ↓ 用户点击
按需 await f.text() 读取 DEV/FAM 属性
  ↓
IFC 文件 → web-ifc 解析渲染
```

### 1.2 demo 数据规模

| 类型 | 数量 | 平均大小 | 总大小 | 访问模式 |
|---|---|---|---|---|
| CBM | 8701 | ~1 KB | ~9 MB | 启动时全量递归解析 |
| DEV | 4179 | ~2 KB | ~8 MB | 点击时按需读取 |
| FAM | 4179 | ~3 KB | ~12 MB | 点击时按需读取 |
| PHM | 4179 | ~5 KB | ~20 MB | 暂未使用 |
| MOD | 5982 | ~10 KB | ~60 MB | 暂未使用 |
| IFC | 12 | ~10 MB | ~120 MB | web-ifc 二进制解析 |
| **合计** | **36113** | — | **~230 MB** | — |

### 1.3 瓶颈定位

| 阶段 | 耗时原因 | 是否可优化 |
|---|---|---|
| 7z 解压 | libarchive.js WASM 单线程 | 否（已是最快方案） |
| **CBM 树构建** | 8700 次 `await f.text()` 串行解析 | **是，DB 可批量查询** |
| **FileDevRelation 解析** | 单文件大，但含 4645 条设备引用 | **是，DB 可结构化存储** |
| **属性面板读取** | 每次点击触发 `f.text()` + parseKeyValue | **是，DB 可缓存** |
| IFC 解析渲染 | web-ifc WASM 解析几何 | 否（独立流程） |
| IFC 名称索引 | 加载后批量 `getItemsData` | 否（依赖 web-ifc） |

**核心结论**：CBM/DEV/FAM 的小文件解析是主要可优化点，DB 化后可从"8700 次串行 IO"降为"1 次批量 SQL 查询"。

---

## 二、浏览器 SQLite 技术选型

### 2.1 方案对比

| 方案 | 持久化 | 性能 | 包体积 | 兼容性 | 适配度 |
|---|---|---|---|---|---|
| **sql.js** | 否（内存） | 快（WASM） | ~1 MB | 全平台 | ⭐⭐⭐⭐ |
| **absurd-sql** | 是（IndexedDB） | 中（IndexedDB 瓶颈） | ~1.5 MB | 现代浏览器 | ⭐⭐⭐ |
| **wa-sqlite + OPFS** | 是（OPFS） | 快（同步访问） | ~1 MB | Chrome 102+ | ⭐⭐⭐⭐⭐ |
| better-sqlite3 | 是（FS） | 极快 | — | 仅 Node.js | 不适用 |

### 2.2 推荐方案：sql.js（内存模式）

**理由**：
1. GIM 数据库本身不大（CBM+DEV+FAM ~30 MB），内存可容纳
2. 一次转换、多次查询，无需跨会话持久化（持久化由 IndexedDB 缓存原始 .gim 即可）
3. 全平台兼容，无 OPFS 版本要求
4. 查询性能远优于 IndexedDB 直查

**持久化策略**（可选增强）：
- 将转换后的 SQLite 二进制存入 IndexedDB，下次打开同一 .gim 直接加载
- Key 用 .gim 文件名 + 大小 + 修改时间哈希，避免重复转换

### 2.3 依赖

```json
{
  "devDependencies": {
    "sql.js": "^1.10.0"
  }
}
```

WASM 文件 `sql-wasm.wasm` 需放入 `public/` 目录离线加载。

---

## 三、数据库 Schema 设计

> 以下 schema 已对照 demo 实际数据核对，字段命名与原始键值保持一致。

### 3.0 demo 数据字段核对发现

核对 demo 实际文件后发现初版 schema 存在以下问题，已在 3.1-3.6 修正：

| 问题 | 影响 | 修正 |
|---|---|---|
| CBM 节点漏字段 | F3System 的 `SYSTEMNAME1..4`、`BASEFAMILY1..4`、`MATERIALSHEET` 未存储 | 新增 `cbm_extra_props` 表存变长字段 |
| CBM 漏 IFC.NUM 引用 | F1System 通过 `IFC.NUM`+`IFC0..N` 列出 12 个 IFC 文件，与设备级 `IFCFILE` 是两种机制 | 新增 `cbm_ifc_refs` 表 |
| DEV 的 `TRANSFORMMATRIX0..N` 重复键 | SUBDEVICE 段和 SOLIDMODEL 段都用 `TRANSFORMMATRIX0`，简单 KV 解析会覆盖丢数据 | 拆分 `dev_subdevices` + `dev_solidmodels` 两表 |
| PHM 同样有重复键问题 | `SOLIDMODEL0..N` + `TRANSFORMMATRIX0..N` + `COLOR0..N` | 新增 `phm_solidmodels` 表 |
| project.cbm 字段漏 | `BLHA`(经纬度)、`SCH`(调度文件)、`TYPE`(工程类型) 未存 | 加入 `cbm_nodes` 通用字段 |
| FileDevRelation 配对结构未体现 | 偶数条目含设备列表，奇数条目含 IFC 文件名，是配对关系 | `file_dev_relation` 表增加 `pair_index` 字段 |

**ENTITYNAME 类型分布**（demo 实测）：

| 类型 | 数量 | 层级 | 特有字段 |
|---|---|---|---|
| F1System | 1 | 工程级 | `IFC.NUM`+`IFC0..N`（列出全部 IFC） |
| F2System | 4 | 区域级 | `SUBSYSTEMS.NUM` |
| F3System | 85 | 子区域级 | `SYSTEMNAME1..4`、`BASEFAMILY1..4`、`MATERIALSHEET` |
| F4System | 2682 | 设备级 | `OBJECTMODELPOINTER`、`IFCFILE`+`IFCGUID`、`TRANSFORMMATRIX` |
| PARTINDEX | 2228 | 叶节点 | `PARTNAME`、`OBJECTMODELPOINTER` |

### 3.1 核心表

```sql
-- 元数据表：记录 GIM 文件信息
CREATE TABLE gim_meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);
-- 示例: ('source_file', 'demo-substation.gim')
--       ('extracted_at', '2026-06-23T10:00:00Z')
--       ('total_files', '36113')
--       ('blha', '27.52472222,112.01388890,150.00,0')  -- project.cbm 的 BLHA 字段

-- 文件内容表：所有文件的原始内容（按路径查询）
CREATE TABLE files (
  path    TEXT PRIMARY KEY,        -- 'CBM/project.cbm'
  dir     TEXT NOT NULL,           -- 'CBM' | 'DEV' | 'PHM' | 'MOD'
  ext     TEXT NOT NULL,           -- 'cbm' | 'dev' | 'fam' | 'ifc' | 'phm' | 'mod' | 'sch' | 'std' | 'sld' | 'stl'
  size    INTEGER NOT NULL,
  content TEXT,                    -- 文本内容（IFC/stl 等二进制为 NULL）
  blob    BLOB                     -- 二进制内容（IFC/stl 文件存此）
);
CREATE INDEX idx_files_dir ON files(dir);
CREATE INDEX idx_files_ext ON files(ext);
```

### 3.2 CBM 结构化表（关键优化点）

```sql
-- CBM 节点表：将 CBM 键值对结构化存储，避免每次解析
CREATE TABLE cbm_nodes (
  path           TEXT PRIMARY KEY,    -- 'CBM/<uuid>.cbm' 或 'CBM/project.cbm'
  parent_path    TEXT,                -- 父 CBM 路径（project.cbm 为 NULL）
  entity_name    TEXT,                -- ENTITYNAME: F1System|F2System|F3System|F4System|PARTINDEX
  classify_name  TEXT,                -- SYSCLASSIFYNAME（F1-F4）或 PARTNAME（PARTINDEX）
  display_name   TEXT,                -- 计算后的显示名（IFC Name 优先，回退到 classify_name）
  base_family    TEXT,                -- BASEFAMILY（单值，F4/PARTINDEX 用）
  dev_pointer    TEXT,                -- OBJECTMODELPOINTER → '<uuid>.dev'
  ifc_file       TEXT,                -- IFCFILE（设备级，如 '动力照明0317.ifc'）
  ifc_guid       TEXT,                -- IFCGUID（已去除尾部 $）
  transform      TEXT,                -- TRANSFORMMATRIX 原始字符串（16 个浮点数）
  material_sheet TEXT,                -- MATERIALSHEET（F1-F3 有此字段）
  sch            TEXT,                -- SCH（仅 project.cbm，调度文件引用）
  proj_type      TEXT,                -- TYPE（仅 project.cbm，如 'TS' 表示变电站）
  blha           TEXT,                -- BLHA（仅 project.cbm，经纬度高程）
  depth          INTEGER,             -- 在树中的深度（project.cbm=0）
  FOREIGN KEY (parent_path) REFERENCES cbm_nodes(path)
);
CREATE INDEX idx_cbm_parent ON cbm_nodes(parent_path);
CREATE INDEX idx_cbm_entity ON cbm_nodes(entity_name);
CREATE INDEX idx_cbm_ifc ON cbm_nodes(ifc_file, ifc_guid);
CREATE INDEX idx_cbm_dev ON cbm_nodes(dev_pointer);

-- CBM 层级关系表（邻接表，支持递归查询）
-- 注：CBM 有三种子节点引用方式，统一存此表
--   - SUBSYSTEM（project.cbm 用，单值）
--   - SUBSYSTEMS.NUM + SUBSYSTEM0..N（F1-F3 用）
--   - SUBDEVICES.NUM + SUBDEVICE0..N（F4 用）
CREATE TABLE cbm_children (
  parent_path  TEXT NOT NULL,
  child_path   TEXT NOT NULL,
  sort_order   INTEGER,               -- 在父节点中的顺序
  ref_type     TEXT NOT NULL,         -- 'SUBSYSTEM' | 'SUBSYSTEMS' | 'SUBDEVICES'
  PRIMARY KEY (parent_path, child_path),
  FOREIGN KEY (parent_path) REFERENCES cbm_nodes(path),
  FOREIGN KEY (child_path) REFERENCES cbm_nodes(path)
);
CREATE INDEX idx_cbm_children_parent ON cbm_children(parent_path);

-- CBM 子系统级 IFC 引用表（F1System 的 IFC.NUM + IFC0..N）
-- 与设备级 IFCFILE+IFCGUID 不同：子系统级只列 IFC 文件名，无 GUID
CREATE TABLE cbm_ifc_refs (
  cbm_path   TEXT NOT NULL,           -- 'CBM/<uuid>.cbm'
  ifc_file   TEXT NOT NULL,           -- '电气二次0317其他.ifc'
  sort_order INTEGER,
  PRIMARY KEY (cbm_path, ifc_file),
  FOREIGN KEY (cbm_path) REFERENCES cbm_nodes(path)
);

-- CBM 变长字段表（F3System 的 SYSTEMNAME1..4、BASEFAMILY1..4）
-- 这些字段按 entity 类型出现，不适合放固定列
CREATE TABLE cbm_extra_props (
  cbm_path TEXT NOT NULL,
  key      TEXT NOT NULL,             -- 'SYSTEMNAME1' | 'BASEFAMILY1' | ...
  value    TEXT,
  PRIMARY KEY (cbm_path, key),
  FOREIGN KEY (cbm_path) REFERENCES cbm_nodes(path)
);
```

### 3.3 FileDevRelation 结构化表

```sql
-- IFC 文件 ↔ 设备 CBM 映射表
-- FileDevRelation.cbm 结构：FILE.NUM=24，偶数条目含设备列表，奇数条目含 IFC 文件名
-- 每 2 个条目为一组：FILE0(设备列表)+FILE1(IFC文件名) → 1 个 IFC 文件
CREATE TABLE file_dev_relation (
  pair_index   INTEGER NOT NULL,      -- 配对组序号（0,1,2,...,11），共 12 组
  ifc_file     TEXT NOT NULL,         -- '电气二次0317其他.ifc'（来自奇数条目 FILE<i>.IFC）
  ifc_name     TEXT NOT NULL,         -- '电气二次0317'（来自偶数条目 FILE<i>.NAME）
  model_id     TEXT NOT NULL,         -- '电气二次0317其他'（ifc_file 去后缀）
  device_cbm   TEXT NOT NULL,         -- '<uuid>.cbm'
  sort_order   INTEGER,               -- 在 IFC 文件中的设备序号
  PRIMARY KEY (ifc_file, device_cbm)
);
CREATE INDEX idx_fdr_ifc ON file_dev_relation(ifc_file);
CREATE INDEX idx_fdr_dev ON file_dev_relation(device_cbm);
CREATE INDEX idx_fdr_pair ON file_dev_relation(pair_index);
```

### 3.4 DEV 结构化表

> ⚠️ DEV 文件存在**重复键问题**：`SUBDEVICE0..N` 段和 `SOLIDMODEL0..N` 段都使用 `TRANSFORMMATRIX0..N`，简单 KV 解析会覆盖丢数据，必须分表存储。

```sql
-- DEV 文件基本信息表
CREATE TABLE dev_nodes (
  path         TEXT PRIMARY KEY,      -- 'DEV/<uuid>.dev'
  base_family  TEXT,                  -- BASEFAMILY → '<uuid>.fam'
  symbol_name  TEXT,                  -- SYMBOLNAME（中文符号名）
  type         TEXT,                  -- TYPE: OTHERS|HVSwitchCabinet|SecondaryCabinet|...
  subdevices_num INTEGER,             -- SUBDEVICES.NUM
  solidmodels_num  INTEGER            -- SOLIDMODELS.NUM
);

-- DEV 子设备表（SUBDEVICE0..N + TRANSFORMMATRIX0..N 配对）
CREATE TABLE dev_subdevices (
  dev_path        TEXT NOT NULL,
  sort_order      INTEGER NOT NULL,   -- 0..N
  child_dev       TEXT NOT NULL,      -- '<uuid>.dev'
  transform_matrix TEXT,              -- 对应的 TRANSFORMMATRIX（16 个浮点数）
  PRIMARY KEY (dev_path, sort_order),
  FOREIGN KEY (dev_path) REFERENCES dev_nodes(path)
);

-- DEV 几何模型表（SOLIDMODEL0..N + TRANSFORMMATRIX0..N 配对）
-- 注意：TRANSFORMMATRIX 键名与 dev_subdevices 相同，必须分表
CREATE TABLE dev_solidmodels (
  dev_path        TEXT NOT NULL,
  sort_order      INTEGER NOT NULL,
  solid_model     TEXT NOT NULL,      -- '<uuid>.phm'
  transform_matrix TEXT,
  PRIMARY KEY (dev_path, sort_order),
  FOREIGN KEY (dev_path) REFERENCES dev_nodes(path)
);
```

### 3.5 FAM 属性表

```sql
-- FAM 文件分节属性
-- FAM 格式：[节名] 分节，每行 '键名=键名=值'（键名重复，取第二个 = 后的值）
CREATE TABLE fam_props (
  fam_path  TEXT NOT NULL,            -- 'DEV/<uuid>.fam' 或 'CBM/<uuid>.fam'
  section   TEXT NOT NULL,            -- '设计参数'
  key       TEXT NOT NULL,            -- 原始键名（如 '设备名称'）
  value     TEXT,                     -- 实际值（已去除 '键名=' 前缀）
  PRIMARY KEY (fam_path, section, key)
);
CREATE INDEX idx_fam_path ON fam_props(fam_path);
```

### 3.6 PHM 结构化表

> PHM 文件结构与 DEV 的 SOLIDMODELS 段类似，同样有重复键问题。

```sql
-- PHM 装配体表（SOLIDMODELS.NUM + SOLIDMODEL0..N + TRANSFORMMATRIX0..N + COLOR0..N）
CREATE TABLE phm_solidmodels (
  phm_path        TEXT NOT NULL,      -- 'PHM/<uuid>.phm'
  sort_order      INTEGER NOT NULL,
  solid_model     TEXT NOT NULL,      -- '<uuid>.mod' 或 '<uuid>.stl'
  transform_matrix TEXT,
  color           TEXT,               -- 'R,G,B,A'（如 '138,149,151,100'），可为空
  PRIMARY KEY (phm_path, sort_order)
);
CREATE INDEX idx_phm_path ON phm_solidmodels(phm_path);
```

### 3.7 IFC 元数据缓存表

```sql
-- IFC 构件 GUID → Name 缓存（避免每次重新查询 web-ifc）
CREATE TABLE ifc_elements (
  model_id   TEXT NOT NULL,           -- '电气二次0317其他'
  guid       TEXT NOT NULL,           -- IFC GUID（22 位 Base64，可含 $）
  local_id   INTEGER,                 -- web-ifc 内部 ID
  name       TEXT,                    -- IFC Name 字段（格式 '族:类型:实例ID'）
  ifc_class  TEXT,                    -- 'IfcWallStandardCase' 等
  PRIMARY KEY (model_id, guid)
);
CREATE INDEX idx_ifc_model ON ifc_elements(model_id);
```

---

## 四、性能收益分析

### 4.1 启动阶段对比

| 步骤 | 现状 | DB 方案 | 提升 |
|---|---|---|---|
| 解压 | ~3s（36113 文件） | ~3s（不变） | — |
| CBM 树构建 | ~2s（8700 次串行 `f.text()`） | ~50ms（1 次 SQL 查询全表） | **40x** |
| FileDevRelation 解析 | ~200ms | ~10ms（结构化查询） | 20x |
| 索引构建 | ~100ms（内存遍历） | ~0ms（DB 索引已建） | ∞ |
| **启动总计** | **~5.3s** | **~3.1s** | **1.7x** |

### 4.2 运行时按需查询对比

| 操作 | 现状 | DB 方案 | 提升 |
|---|---|---|---|
| 点击节点读 DEV 属性 | ~5ms（`f.text()` + parse） | ~1ms（SELECT） | 5x |
| 点击节点读 FAM 属性 | ~5ms | ~1ms | 5x |
| IFCGUID 反查设备 | O(n) 遍历 Map | O(log n) 索引查询 | 显著 |
| FileDevRelation 反查 | O(n) 遍历 | O(log n) 索引查询 | 显著 |

### 4.3 大文件场景预估

假设 GIM 文件规模扩大 10 倍（CBM 87000 个、DEV 42000 个）：

| 场景 | 现状预估 | DB 方案预估 |
|---|---|---|
| 启动 CBM 树构建 | ~20s | ~500ms |
| 启动总耗时 | ~30s | ~10s |
| 内存占用 | 全量 File 对象常驻 | 按需查询，内存占用低 |

### 4.4 懒加载收益

DB 方案天然支持懒加载：
- CBM 树可按深度分层加载（先显示根节点，展开时查子节点）
- DEV/FAM 属性仅在点击时查询
- IFC 文件 BLOB 按需读取（用户选择加载哪个 IFC）
- 大型 GIM（>500MB）可避免一次性加载所有文件到内存

---

## 五、不可优化部分

### 5.1 IFC 文件解析

web-ifc 接受 `Uint8Array` 输入，必须完整加载文件内容：
- DB 中 IFC 文件以 BLOB 存储
- 加载时 `SELECT blob FROM files WHERE path = ?` → 传给 web-ifc
- **收益**：避免 `File` 对象常驻内存，但解析耗时不变

### 5.2 7z 解压

libarchive.js WASM 解压是必经步骤，DB 化无法绕过。
- **缓解**：转换后的 SQLite 二进制可缓存到 IndexedDB，下次直接加载

### 5.3 3D 渲染

Three.js 渲染性能与存储方案无关。

---

## 六、实施路径

### 6.1 分阶段实施

**Phase 1 — 基础 DB 化（高收益、低风险）**：
1. 引入 sql.js，WASM 放入 `public/`
2. 实现 `GimDatabase` 类：`extractToDb(arrayBuffer) → Database`
3. 将所有文件内容写入 `files` 表（文本入 content，IFC/stl 入 blob）
4. 解析 CBM 文件写入 `cbm_nodes` + `cbm_children` + `cbm_ifc_refs` + `cbm_extra_props`
5. 解析 FileDevRelation 写入 `file_dev_relation` 表（注意偶奇配对）
6. 改造 `buildCbmTree`、`parseFileDevRelation` 为 SQL 查询

**Phase 2 — DEV/PHM 结构化（中等收益，需处理重复键）**：
7. 解析 DEV 文件写入 `dev_nodes` + `dev_subdevices` + `dev_solidmodels`（⚠️ 必须分段解析，避免 TRANSFORMMATRIX 覆盖）
8. 解析 PHM 文件写入 `phm_solidmodels` 表
9. 解析 FAM 文件写入 `fam_props` 表
10. 属性面板改为 SQL 查询

**Phase 3 — 持久化缓存（体验优化）**：
11. 转换后的 SQLite 二进制存入 IndexedDB
12. 下次打开同一 .gim 直接加载 DB，跳过解压+转换

**Phase 4 — 懒加载（大文件优化）**：
13. CBM 树分层加载（先加载 depth=0，展开时加载子节点）
14. IFC 文件 BLOB 按需读取

### 6.2 关键代码改造点

| 现有函数 | 改造方向 |
|---|---|
| `extractGimFile()` | 解压后写入 DB，返回 DB 句柄 |
| `buildCbmTree()` | `SELECT * FROM cbm_nodes` + `cbm_children` 一次查询构建树 |
| `parseFileDevRelation()` | `SELECT * FROM file_dev_relation` |
| `buildIfcGuidIndex()` | `SELECT path, ifc_file, ifc_guid FROM cbm_nodes WHERE ifc_guid != ''` |
| `showNodeProperties()` | `SELECT * FROM dev_nodes JOIN dev_subdevices` + `SELECT * FROM fam_props` |
| `loadIfcBuffer()` | `SELECT blob FROM files WHERE path = ?` |
| `discoverIfcFromCBM()` | `SELECT ifc_file FROM cbm_ifc_refs UNION SELECT ifc_file FROM cbm_nodes WHERE ifc_file != ''` |

### 6.3 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| sql.js WASM 加载失败 | 应用不可用 | 降级到现有 File 方案 |
| 转换耗时增加首次打开时间 | 体验下降 | IndexedDB 缓存 + 进度提示 |
| sql.js 内存占用 | 大文件 OOM | 按需查询，避免全量加载 |
| Schema 变更迁移 | 数据不一致 | 版本号字段 + 重建机制 |

---

## 七、结论与建议

### 7.1 可行性结论

**✅ 可行，推荐实施**。核心收益在于将 8700 次串行文件解析降为 1 次批量 SQL 查询，启动速度提升约 1.7x，大文件场景提升更显著。

### 7.2 推荐方案

- **技术栈**：sql.js（内存模式）+ IndexedDB 缓存
- **优先级**：Phase 1（基础 DB 化）收益最高，建议优先实施
- **IFC 文件**：以 BLOB 存储，加载时读出传给 web-ifc，不改变现有渲染流程

### 7.3 不建议的部分

- **不要将 IFC 内容结构化入库**：IFC 是 STEP 物理格式，web-ifc 已是最佳解析器
- **不要替换 libarchive.js**：解压是必经步骤，DB 化无法绕过
- **不要过度 normalize**：DEV/FAM 属性结构化是可选项，收益相对较小

### 7.4 预期效果

| 指标 | 现状 | DB 化后 | 备注 |
|---|---|---|---|
| demo 启动耗时 | ~5s | ~3s | 主要来自 CBM 树构建 |
| 10x 大文件启动 | ~30s | ~10s | 懒加载后可降至 ~5s |
| 内存占用 | ~230MB 常驻 | ~50MB（DB + 缓存） | 按需查询 |
| 属性查询 | ~5ms | ~1ms | SQL 索引 |
| 重复打开 | ~5s | ~1s | IndexedDB 缓存命中 |
