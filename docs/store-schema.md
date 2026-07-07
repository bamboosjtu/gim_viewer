# GIM → SQLite 存储方案可行性分析

> 目标：将 GIM 解压后的散文件转换为 SQLite 数据库，以数据库查询替代反复的 `File.text()` 解析，提升大型 GIM 文件的访问速度，并支持懒加载。
>
> **技术路线**：Tauri（Rust 后端 + WebView 前端），SQLite 由 Rust 原生驱动，替代原纯 Web 方案的 sql.js。
>
> **覆盖范围**：
> - 第一章：两类工程共有的架构、瓶颈、技术选型、通用 Schema
> - 第二章：变电工程特有数据与 Schema（IFC、FileDevRelation）
> - 第三章：线路工程特有数据与 Schema（.mod 几何缓存）

---

## 一、通用部分

### 1.1 现状数据流

```
.gim 文件
  ↓ 检测 GIMPKG* 头部（GIMPKGS=变电 / GIMPKGT=线路）→ 在头部之后 1MB 窗口内搜索 7z/ZIP 签名 → 切到真实压缩数据
  ↓ libarchive.js (WASM) 解压
Map<path, File> (内存中数万个 File 对象)
  ↓ 递归 await f.text()
CBM 层级树 + (变电: FileDevRelation + IFCGUID 反向索引)
  ↓ 用户点击
按需 await f.text() 读取 DEV/FAM 属性
  ↓
(变电: IFC 文件 → web-ifc 解析渲染 / 线路: .mod 几何 → 自定义渲染)
```

### 1.2 demo 数据规模对比

| 类型 | 变电工程（demo-substation） | 线路工程（demo-line） |
|---|---|---|
| CBM | 8701 个，~9 MB | 27829 个，~21 MB |
| DEV | 4179 个，~8 MB | 4518 个，~33 MB |
| FAM | 4179 个，~12 MB | 31003 个（Cbm+Dev），~12 MB |
| PHM | 4179 个，~20 MB | 1836 个，~1 MB |
| MOD | 5982 个，~60 MB | 1807 个，~86 MB |
| STL | 0 | 181 个 |
| IFC | 12 个，~120 MB | **0** |
| **合计** | **36113 文件，~230 MB** | **~60652 文件，~142 MB** |

**两类工程对比**：线路工程文件数是变电工程的 1.7 倍，但无 IFC 大文件，总大小反而更小；CBM 数量是变电工程的 3.2 倍，启动时解析压力更大。

### 1.3 瓶颈定位

| 阶段 | 耗时原因 | 是否可优化 |
|---|---|---|
| 7z 解压 | libarchive.js WASM 单线程 | **是，Tauri 可用 Rust 原生解压** |
| **CBM 树构建** | 变电 8700 / 线路 27800 次 `await f.text()` 串行解析 | **是，DB 可批量查询** |
| **属性面板读取** | 每次点击触发 `f.text()` + parseKeyValue | **是，DB 可缓存** |
| IFC 解析渲染 | web-ifc WASM 解析几何（仅变电工程） | 否（独立流程） |
| **.mod 几何解析** | 线路工程 1807 个 .mod（4 种格式）+ 181 个 .stl | **是，DB 可缓存解析结果** |

**核心结论**：CBM/DEV/FAM 的小文件解析是主要可优化点，DB 化后可从"数万次串行 IO"降为"1 次批量 SQL 查询"。线路工程因 CBM 数量更多（27800 vs 8700），收益更显著。

### 1.4 技术选型：Tauri + 原生 SQLite

#### 1.4.1 方案对比

| 方案 | 持久化 | 性能 | 包体积 | 适配度 |
|---|---|---|---|---|
| **Tauri + rusqlite**（推荐） | 是（本地文件） | 极快（原生） | 无额外 | ⭐⭐⭐⭐⭐ |
| Tauri + sqlx | 是（本地文件） | 极快（原生+异步） | 无额外 | ⭐⭐⭐⭐⭐ |
| sql.js（纯 Web） | 否（内存） | 快（WASM） | ~1 MB | ⭐⭐⭐ |
| wa-sqlite + OPFS | 是（OPFS） | 快 | ~1 MB | ⭐⭐⭐⭐ |

#### 1.4.2 推荐方案：Tauri + rusqlite

**理由**：
1. **原生性能**：rusqlite 是 SQLite C 库的 Rust 绑定，性能远超 sql.js（WASM），无 JIT 开销
2. **天然持久化**：SQLite 数据库文件直接写入本地磁盘，无需 IndexedDB 中转
3. **无大小限制**：本地文件系统无浏览器存储配额限制（IndexedDB 通常 2GB 上限）
4. **多线程**：Rust 后端可多线程解析 GIM 文件，不阻塞 UI
5. **解压加速**：可用 Rust 原生 7z/ZIP 库（如 `sevenz-rust`、`zip-rs`）替代 libarchive.js，性能提升 3-10 倍
6. **内存友好**：大文件可流式处理，无需全部加载到内存

**架构变化**：

```
原纯 Web 方案:
  浏览器 → libarchive.js(WASM) 解压 → File 对象 → sql.js(WASM) → 查询

Tauri 方案:
  Tauri 后端(Rust) → 原生 7z 解压 → 原生 SQLite 写入 → 前端通过 IPC 查询
                                                       ↓
                              前端(WebView): Three.js 渲染 + web-ifc(IFC 解析)
```

#### 1.4.3 依赖

**Rust 后端（`src-tauri/Cargo.toml`）**：
```toml
[dependencies]
rusqlite = { version = "0.31", features = ["bundled"] }  # SQLite，bundled 内置编译
sevenz-rust = "0.6"      # 7z 解压（备选：zip-rs 用于 ZIP）
tauri = { version = "2", features = ["...]"] }
serde = { version = "1", features = ["derive"] }
```

**前端无需 SQLite 依赖**，所有 DB 操作通过 Tauri IPC（`invoke`）调用 Rust 后端。

### 1.5 通用 Schema 设计

> 以下 schema 适用于两类工程，工程类型特有表在第二、三章定义。

#### 1.5.1 核心表

```sql
-- 元数据表：记录 GIM 文件信息
CREATE TABLE gim_meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);
-- 示例: ('source_file', 'demo-substation.gim' 或 'demo-line.gim')
--       ('extracted_at', '2026-06-23T10:00:00Z')
--       ('total_files', '36113' 或 '60652')
--       ('project_type', 'TS'（变电站）或 'LINE'（线路），根据 project.cbm 内容判断）

-- 文件内容表：所有文件的原始内容（按路径查询）
CREATE TABLE files (
  path    TEXT PRIMARY KEY,        -- 'CBM/project.cbm'（变电）或 'Cbm/project.cbm'（线路）
  dir     TEXT NOT NULL,           -- 'CBM' | 'DEV' | 'PHM' | 'MOD'（变电，大写）或 'Cbm' | 'Dev' | 'Phm' | 'Mod'（线路，首字母大写）
  ext     TEXT NOT NULL,           -- 'cbm' | 'dev' | 'fam' | 'ifc' | 'phm' | 'mod' | 'sch' | 'std' | 'sld' | 'stl'
  size    INTEGER NOT NULL,
  content TEXT,                    -- 文本内容（IFC/stl 等二进制为 NULL）
  blob    BLOB                     -- 二进制内容（IFC/stl 文件存此）
);
CREATE INDEX idx_files_dir ON files(dir);
CREATE INDEX idx_files_ext ON files(ext);
```

#### 1.5.2 CBM 结构化表（关键优化点）

```sql
-- CBM 节点表：将 CBM 键值对结构化存储，避免每次解析
CREATE TABLE cbm_nodes (
  path           TEXT PRIMARY KEY,    -- 'CBM/<uuid>.cbm' 或 'CBM/project.cbm'（线路工程为 'Cbm/<uuid>.cbm'）
  parent_path    TEXT,                -- 父 CBM 路径（project.cbm 为 NULL）
  entity_name    TEXT,                -- ENTITYNAME: 变电(F1System|F2System|F3System|F4System|PARTINDEX) 线路(F1System|F2System|F3System|F4System|Tower_Device|Wire_Device|WIRE|CROSS)
  classify_name  TEXT,                -- SYSCLASSIFYNAME（变电 F1-F4）或 PARTNAME（PARTINDEX）
  display_name   TEXT,                -- 计算后的显示名（IFC Name 优先，回退到 classify_name 或杆塔编号）
  base_family    TEXT,                -- BASEFAMILY（单值，F4/PARTINDEX/Tower_Device/Wire_Device 用）
  dev_pointer    TEXT,                -- OBJECTMODELPOINTER → '<uuid>.dev'
  transform      TEXT,                -- TRANSFORMMATRIX 原始字符串（16 个浮点数）
  material_sheet TEXT,                -- MATERIALSHEET（F1-F3 有此字段，线路工程为空）
  blha           TEXT,                -- BLHA：变电 project.cbm 为 '经度,纬度,高程'（3值）；线路工程为 '纬度,经度,高程,方位角'（4值）
  depth          INTEGER,             -- 在树中的深度（project.cbm=0）
  -- 变电工程特有字段（线路工程为 NULL）：
  ifc_file       TEXT,                -- IFCFILE（仅变电工程设备级，如 '动力照明0317.ifc'）
  ifc_guid       TEXT,                -- IFCGUID（已去除尾部 $，仅变电工程）
  sch            TEXT,                -- SCH（仅变电 project.cbm，调度文件引用）
  proj_type      TEXT,                -- TYPE（仅变电 project.cbm，如 'TS' 表示变电站；线路工程无此字段）
  -- 线路工程特有字段（变电工程为 NULL）：
  group_type     TEXT,                -- GROUPTYPE（仅线路 F4System）：'TOWER' | 'WIRE' | 'CROSS'
  wire_type      TEXT,                -- WIRETYPE（仅线路 F4System-WIRE）：'CONDUCTOR' | 'GROUNDWIRE' | 'OPGW'
  is_jumper      INTEGER,             -- ISJUMPER（仅线路 F4System-WIRE）：0 | 1
  k_value        REAL,                -- KVALUE（仅线路 WIRE 实体）：应力参数
  split_num      INTEGER,             -- SPLIT（仅线路 WIRE 实体）：分裂根数
  mod_leg        TEXT,                -- MODLEG（仅线路 F4System-TOWER）：塔腿调整值
  FOREIGN KEY (parent_path) REFERENCES cbm_nodes(path)
);
CREATE INDEX idx_cbm_parent ON cbm_nodes(parent_path);
CREATE INDEX idx_cbm_entity ON cbm_nodes(entity_name);
CREATE INDEX idx_cbm_dev ON cbm_nodes(dev_pointer);
CREATE INDEX idx_cbm_group_type ON cbm_nodes(group_type);  -- 线路工程按 GROUPTYPE 筛选
CREATE INDEX idx_cbm_ifc ON cbm_nodes(ifc_file, ifc_guid);  -- 变电工程按 IFC 查询

-- CBM 层级关系表（邻接表，支持递归查询）
-- 注：CBM 有多种子节点引用方式，统一存此表
--   变电工程：
--     - SUBSYSTEM（project.cbm 用，单值）
--     - SUBSYSTEMS.NUM + SUBSYSTEM0..N（F1-F3 用）
--     - SUBDEVICES.NUM + SUBDEVICE0..N（F4 用）
--   线路工程：
--     - SUBSYSTEM（project.cbm 用，单值）
--     - SECTIONS.NUM + SECTION0..N（F1System 用）
--     - STRAINSECTIONS.NUM + STRAINSECTION0..N（F2System 用）
--     - GROUPS.NUM + GROUP0..N（F3System 用）
--     - TOWERS.NUM + TOWER0..N（F4System-TOWER 用）
--     - STRINGS.NUM + STRING<i>.STRING（F4System-TOWER 用，绝缘子串，附 GPOINT 挂点信息）
--     - BASES.NUM + BASE0..N（F4System-TOWER 用，基础）
--     - SUBDEVICES.NUM + SUBDEVICE0..N（F4System-WIRE/CROSS 用）
--     - BACKSTRING / FRONTSTRING（F4System-WIRE 用，单值引用两端绝缘子串）
CREATE TABLE cbm_children (
  parent_path  TEXT NOT NULL,
  child_path   TEXT NOT NULL,
  sort_order   INTEGER,               -- 在父节点中的顺序
  ref_type     TEXT NOT NULL,         -- 'SUBSYSTEM' | 'SUBSYSTEMS' | 'SUBDEVICES' | 'SECTIONS' | 'STRAINSECTIONS' | 'GROUPS' | 'TOWERS' | 'STRINGS' | 'BASES' | 'BACKSTRING' | 'FRONTSTRING'
  extra        TEXT,                  -- 附加信息（如 STRINGS 的 GPOINT 挂点名称 '前导6'/'后地6'）
  PRIMARY KEY (parent_path, child_path, ref_type),
  FOREIGN KEY (parent_path) REFERENCES cbm_nodes(path),
  FOREIGN KEY (child_path) REFERENCES cbm_nodes(path)
);
CREATE INDEX idx_cbm_children_parent ON cbm_children(parent_path);

-- CBM 变长字段表（变电 F3System 的 SYSTEMNAME1..4、BASEFAMILY1..4；线路 WIRE 的 POINT<i>.BLHA/MATRIX0）
-- 这些字段按 entity 类型出现，不适合放固定列
CREATE TABLE cbm_extra_props (
  cbm_path TEXT NOT NULL,
  key      TEXT NOT NULL,             -- 'SYSTEMNAME1' | 'BASEFAMILY1' | 'POINT0.BLHA' | 'POINT0.MATRIX0' | ...
  value    TEXT,
  PRIMARY KEY (cbm_path, key),
  FOREIGN KEY (cbm_path) REFERENCES cbm_nodes(path)
);
```

#### 1.5.3 DEV 结构化表

> ⚠️ DEV 文件存在**重复键问题**：`SUBDEVICE0..N` 段和 `SOLIDMODEL0..N` 段都使用 `TRANSFORMMATRIX0..N`，简单 KV 解析会覆盖丢数据，必须分表存储。
>
> **两类工程差异**：变电工程用 `TYPE` 字段分类（OTHERS/HVSwitchCabinet/...），线路工程用 `DEVICETYPE` 字段分类（TOWER/STRING/BASE/CROSS/...）。Schema 用统一列 `device_type` 存两者。

```sql
-- DEV 文件基本信息表
CREATE TABLE dev_nodes (
  path         TEXT PRIMARY KEY,      -- 'DEV/<uuid>.dev'（线路工程为 'Dev/<uuid>.dev'）
  base_family  TEXT,                  -- BASEFAMILY → '<uuid>.fam'
  symbol_name  TEXT,                  -- SYMBOLNAME：变电为中文（土建接口），线路为英文（TOWER/WIRE/EQUIPMENT）
  device_type  TEXT,                  -- 变电 TYPE（OTHERS|HVSwitchCabinet|...）或线路 DEVICETYPE（TOWER|STRING|BASE|CROSS|FITTINGS|INSULATOR|DAMPER|GROUNDWIRE|SPACER|OPGW|CONDUCTOR）
  subdevices_num INTEGER,             -- SUBDEVICES.NUM（变电工程有；线路工程 DEV 无此字段，子设备在 CBM 层）
  solidmodels_num  INTEGER            -- SOLIDMODELS.NUM
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

#### 1.5.4 FAM 属性表

```sql
-- FAM 文件分节属性
-- 变电工程 FAM 格式：[节名] 分节，每行 '中文键名=englishKey=值'（取第二个 = 后的值）
-- 线路工程 FAM 格式：无分节（扁平），每行 '中文键名=ENGLISH_KEY=值'
-- 统一处理：线路工程 section 字段存 NULL 或 '默认'
CREATE TABLE fam_props (
  fam_path  TEXT NOT NULL,            -- 'DEV/<uuid>.fam' 或 'CBM/<uuid>.fam'（线路工程为 'Dev/...' 或 'Cbm/...'）
  section   TEXT,                     -- '设计参数'（变电工程）；NULL 或 '默认'（线路工程无分节）
  key       TEXT NOT NULL,            -- 原始键名（如 '设备名称' 或 '呼高'）
  value     TEXT,                     -- 实际值（已去除 '键名=' 前缀）
  PRIMARY KEY (fam_path, section, key)
);
CREATE INDEX idx_fam_path ON fam_props(fam_path);
```

#### 1.5.5 PHM 结构化表

> PHM 文件结构与 DEV 的 SOLIDMODELS 段类似，同样有重复键问题。两类工程 PHM 格式一致。

```sql
-- PHM 装配体表（SOLIDMODELS.NUM + SOLIDMODEL0..N + TRANSFORMMATRIX0..N + COLOR0..N）
CREATE TABLE phm_solidmodels (
  phm_path        TEXT NOT NULL,      -- 'PHM/<uuid>.phm'（线路工程为 'Phm/<uuid>.phm'）
  sort_order      INTEGER NOT NULL,
  solid_model     TEXT NOT NULL,      -- '<uuid>.mod' 或 '<uuid>.stl'（线路工程有 STL）
  transform_matrix TEXT,
  color           TEXT,               -- 'R,G,B,A'（如 '138,149,151,100'），可为空
  PRIMARY KEY (phm_path, sort_order)
);
CREATE INDEX idx_phm_path ON phm_solidmodels(phm_path);
```

### 1.6 通用性能收益分析

#### 1.6.1 启动阶段对比

**变电工程（demo-substation）**：

| 步骤 | 现状（纯 Web） | Tauri 方案 | 提升 |
|---|---|---|---|
| 解压 | ~3s（libarchive.js WASM） | ~0.5s（Rust 原生 7z） | **6x** |
| CBM 树构建 | ~2s（8700 次串行 `f.text()`） | ~30ms（1 次 SQL 查询全表） | **60x** |
| FileDevRelation 解析 | ~200ms | ~5ms（结构化查询） | 40x |
| 索引构建 | ~100ms（内存遍历） | ~0ms（DB 索引已建） | ∞ |
| **启动总计** | **~5.3s** | **~0.6s** | **9x** |

**线路工程（demo-line）**：

| 步骤 | 现状（纯 Web） | Tauri 方案 | 提升 |
|---|---|---|---|
| 解压 | ~4s（libarchive.js WASM） | ~0.7s（Rust 原生 7z） | **6x** |
| CBM 树构建 | ~6s（27800 次串行 `f.text()`） | ~100ms（1 次 SQL 查询全表） | **60x** |
| 索引构建 | ~200ms（内存遍历） | ~0ms（DB 索引已建） | ∞ |
| **启动总计** | **~10.2s** | **~0.8s** | **13x** |

**结论**：Tauri 方案因原生解压 + 原生 SQLite 双重加速，启动性能提升显著。线路工程因 CBM 数量更多，收益更突出。

#### 1.6.2 运行时按需查询对比

| 操作 | 现状（纯 Web） | Tauri 方案 | 提升 |
|---|---|---|---|
| 点击节点读 DEV 属性 | ~5ms（`f.text()` + parse） | ~0.5ms（SELECT，原生 SQLite） | 10x |
| 点击节点读 FAM 属性 | ~5ms | ~0.5ms | 10x |
| IFCGUID 反查设备 | O(n) 遍历 Map | O(log n) 索引查询 | 显著 |
| FileDevRelation 反查 | O(n) 遍历 | O(log n) 索引查询 | 显著 |

#### 1.6.3 大文件场景预估

假设 GIM 文件规模扩大 10 倍（变电 CBM 87000 个、线路 CBM 278000 个）：

| 场景 | 现状预估（纯 Web） | Tauri 方案预估 |
|---|---|---|
| 变电启动 CBM 树构建 | ~20s | ~300ms |
| 线路启动 CBM 树构建 | ~60s | ~1s |
| 启动总耗时（变电） | ~30s | ~1s |
| 启动总耗时（线路） | ~70s | ~1.5s |
| 内存占用 | 全量 File 对象常驻 | 按需查询，内存占用低 |

#### 1.6.4 懒加载收益

DB 方案天然支持懒加载：
- CBM 树可按深度分层加载（先显示根节点，展开时查子节点）
- DEV/FAM 属性仅在点击时查询
- IFC 文件 BLOB 按需读取（用户选择加载哪个 IFC）
- .mod 几何按需读取（线路工程，仅渲染可见杆塔时加载）
- 大型 GIM（>500MB）可避免一次性加载所有文件到内存

---

## 二、变电工程

> 变电工程特有数据：IFC 文件、FileDevRelation、DEV 子设备层级。

### 2.1 变电工程特有 Schema

#### 2.1.1 CBM 子系统级 IFC 引用表

```sql
-- F1System 的 IFC.NUM + IFC0..N
-- 与设备级 IFCFILE+IFCGUID 不同：子系统级只列 IFC 文件名，无 GUID
-- 注：仅变电工程有此数据，线路工程此表为空
CREATE TABLE cbm_ifc_refs (
  cbm_path   TEXT NOT NULL,           -- 'CBM/<uuid>.cbm'
  ifc_file   TEXT NOT NULL,           -- '电气二次0317其他.ifc'
  sort_order INTEGER,
  PRIMARY KEY (cbm_path, ifc_file),
  FOREIGN KEY (cbm_path) REFERENCES cbm_nodes(path)
);
```

#### 2.1.2 FileDevRelation 结构化表

```sql
-- IFC 文件 ↔ 设备 CBM 映射表
-- FileDevRelation.cbm 结构：FILE.NUM=24，偶数条目含设备列表，奇数条目含 IFC 文件名
-- 每 2 个条目为一组：FILE0(设备列表)+FILE1(IFC文件名) → 1 个 IFC 文件
-- 注：仅变电工程有此文件，线路工程此表为空
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

#### 2.1.3 DEV 子设备表

```sql
-- DEV 子设备表（SUBDEVICE0..N + TRANSFORMMATRIX0..N 配对）
-- 注：仅变电工程 DEV 有此数据，线路工程此表为空
CREATE TABLE dev_subdevices (
  dev_path        TEXT NOT NULL,
  sort_order      INTEGER NOT NULL,   -- 0..N
  child_dev       TEXT NOT NULL,      -- '<uuid>.dev'
  transform_matrix TEXT,              -- 对应的 TRANSFORMMATRIX（16 个浮点数）
  PRIMARY KEY (dev_path, sort_order),
  FOREIGN KEY (dev_path) REFERENCES dev_nodes(path)
);
```

#### 2.1.4 IFC 元数据缓存表

```sql
-- IFC 构件 GUID → Name 缓存（避免每次重新查询 web-ifc）
-- 注：仅变电工程有 IFC 文件，线路工程此表为空
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

### 2.2 变电工程不可优化部分

**IFC 文件解析**：web-ifc 接受 `Uint8Array` 输入，必须完整加载文件内容：
- DB 中 IFC 文件以 BLOB 存储
- 加载时通过 Tauri IPC 读取 BLOB → 传给前端 web-ifc
- **收益**：避免 `File` 对象常驻内存，但 web-ifc 解析耗时不变
- 线路工程无 IFC 文件，此步骤跳过

---

## 三、线路工程

> 线路工程特有数据：.mod 几何文件（4 种格式），需缓存解析结果。

### 3.1 线路工程特有 Schema：.mod 几何缓存

> 线路工程 .mod 文件格式分裂为 4 种，解析耗时且重复。DB 化后可缓存解析结果，避免每次渲染重新解析。
>
> 变电工程 .mod 为 XML，由现有渲染流程处理，此表为空。

```sql
-- .mod 文件格式标识表
CREATE TABLE mod_files (
  path        TEXT PRIMARY KEY,       -- 'Mod/<uuid>.mod'
  mod_format  TEXT NOT NULL,          -- 'XML'（变电）| 'HNUM'（杆塔几何）| 'CODE'（交叉跨越）| 'TYPE'（导线参数）| 'BOLT'（基础螺栓）
  parsed      INTEGER DEFAULT 0       -- 是否已解析缓存
);

-- 杆塔几何表（HNum 格式 .mod 解析结果）
CREATE TABLE mod_tower_geometry (
  mod_path   TEXT NOT NULL,           -- 'Mod/<uuid>.mod'
  point_id   INTEGER NOT NULL,        -- P 记录的编号
  x          REAL NOT NULL,
  y          REAL NOT NULL,
  z          REAL NOT NULL,
  PRIMARY KEY (mod_path, point_id),
  FOREIGN KEY (mod_path) REFERENCES mod_files(path)
);
CREATE INDEX idx_mod_tower_path ON mod_tower_geometry(mod_path);

-- 杆塔杆件表（HNum 格式 .mod 的 R 记录）
CREATE TABLE mod_tower_members (
  mod_path   TEXT NOT NULL,
  sort_order INTEGER NOT NULL,
  from_point INTEGER NOT NULL,        -- 起点编号
  to_point   INTEGER NOT NULL,        -- 终点编号
  spec       TEXT,                    -- 规格（如 'φ325.000000X6.000000'）
  material   TEXT,                    -- 材质（如 'Q235'）
  extra      TEXT,                    -- 其余字段原始字符串
  PRIMARY KEY (mod_path, sort_order),
  FOREIGN KEY (mod_path) REFERENCES mod_files(path)
);

-- 杆塔挂点表（HNum 格式 .mod 的 G 记录，绝缘子串安装点）
CREATE TABLE mod_tower_gpoints (
  mod_path   TEXT NOT NULL,
  gpoint_name TEXT NOT NULL,          -- '前导1' | '后导1' | '前地1' | '后地1' | ...
  gtype      TEXT,                    -- 'C'（导线）| 'G'（地线）
  x          REAL NOT NULL,
  y          REAL NOT NULL,
  z          REAL NOT NULL,
  PRIMARY KEY (mod_path, gpoint_name),
  FOREIGN KEY (mod_path) REFERENCES mod_files(path)
);

-- 交叉跨越几何表（CODE 格式 .mod 解析结果）
CREATE TABLE mod_cross_geometry (
  mod_path   TEXT NOT NULL,
  point_id   INTEGER NOT NULL,        -- POINT 记录的编号
  lat        REAL NOT NULL,           -- 纬度
  lon        REAL NOT NULL,           -- 经度
  alt        REAL NOT NULL,           -- 高程
  extra      TEXT,                    -- 第5个字段（用途未知）
  PRIMARY KEY (mod_path, point_id),
  FOREIGN KEY (mod_path) REFERENCES mod_files(path)
);

-- 交叉跨越线段表（CODE 格式 .mod 的 LINE 记录）
CREATE TABLE mod_cross_lines (
  mod_path   TEXT NOT NULL,
  sort_order INTEGER NOT NULL,
  from_point INTEGER NOT NULL,
  to_point   INTEGER NOT NULL,
  PRIMARY KEY (mod_path, sort_order),
  FOREIGN KEY (mod_path) REFERENCES mod_files(path)
);

-- 导地线参数表（type 格式 .mod 解析结果，KEY=VALUE 扁平存储）
CREATE TABLE mod_wire_params (
  mod_path TEXT NOT NULL,
  key      TEXT NOT NULL,             -- 'TYPE' | 'SECTIONALAREA' | 'OUTSIDEDIAMETER' | 'WIREWEIGHT' | ...
  value    TEXT,
  PRIMARY KEY (mod_path, key),
  FOREIGN KEY (mod_path) REFERENCES mod_files(path)
);
```

### 3.2 线路工程不可优化部分

**悬链线计算**：导地线悬链线根据两端挂点 BLHA + KVALUE + 物理参数实时计算，无法预存：
- DB 可缓存输入参数（WIRE CBM 的 POINT.BLHA + .mod 物理参数）
- 但悬链线采样点计算仍需在前端 JS 中完成

---

## 四、实施路径

### 4.1 分阶段实施

**Phase 1 — Tauri 基础架构搭建**：
1. 初始化 Tauri 项目，配置 `src-tauri/`
2. Rust 后端集成 `rusqlite`（bundled SQLite）+ `sevenz-rust`（7z 解压）
3. 实现 Tauri IPC 命令：`extract_gim(path) → db_path`
4. 实现原生 7z 解压 + 文件内容写入 `files` 表
5. 前端改造 `extractGimFile()` 为 `invoke('extract_gim', ...)`

**Phase 2 — CBM 结构化（高收益）**：
6. Rust 后端解析 CBM 文件写入 `cbm_nodes` + `cbm_children` + `cbm_extra_props`
   - ⚠️ 需识别工程类型：变电工程用 `SUBSYSTEMS.NUM`+`SUBSYSTEM<i>`，线路工程用 `SECTIONS`/`STRAINSECTIONS`/`GROUPS`/`TOWERS`/`STRINGS`/`BASES` 等多种引用键
   - ⚠️ 线路工程 F4System 需按 `GROUPTYPE` 分支处理子节点
7. 实现 Tauri IPC 命令：`query_cbm_tree() → tree_json`、`query_node_detail(path) → detail_json`
8. 前端改造 `buildCbmTree()` 为 IPC 调用

**Phase 3 — DEV/PHM/FAM 结构化**：
9. Rust 后端解析 DEV 文件写入 `dev_nodes` + `dev_solidmodels`（⚠️ 必须分段解析，避免 TRANSFORMMATRIX 覆盖）
   - ⚠️ 变电工程读 `TYPE` 字段，线路工程读 `DEVICETYPE` 字段，统一存 `device_type` 列
   - 变电工程额外写入 `dev_subdevices` 表
10. 解析 PHM 文件写入 `phm_solidmodels` 表
11. 解析 FAM 文件写入 `fam_props` 表
    - ⚠️ 变电工程有 `[节名]` 分节，线路工程无分节（扁平格式），统一用 `section` 列（线路存 NULL）
12. 属性面板改为 IPC 查询

**Phase 4 — 变电工程 IFC 集成**：
13. 解析 FileDevRelation 写入 `file_dev_relation` 表（注意偶奇配对）
14. 解析 F1System 的 IFC.NUM 写入 `cbm_ifc_refs` 表
15. IFC 文件以 BLOB 存储，加载时通过 IPC 读取传给前端 web-ifc
16. IFC 名称索引写入 `ifc_elements` 表

**Phase 5 — 线路工程 .mod 几何缓存**：
17. 识别 .mod 文件格式（XML/HNUM/CODE/TYPE/BOLT），写入 `mod_files` 表
18. 解析 HNum 格式 .mod 写入 `mod_tower_geometry` + `mod_tower_members` + `mod_tower_gpoints`
19. 解析 CODE 格式 .mod 写入 `mod_cross_geometry` + `mod_cross_lines`
20. 解析 type 格式 .mod 写入 `mod_wire_params`
21. 渲染时通过 IPC 查询缓存，避免前端重复解析

**Phase 6 — 持久化缓存（体验优化）**：
22. SQLite 数据库文件持久化到 Tauri app data 目录
23. 下次打开同一 .gim 直接加载已有 DB，跳过解压+转换
24. 用 .gim 文件名 + 大小 + 修改时间哈希作为缓存 Key

**Phase 7 — 懒加载（大文件优化）**：
25. CBM 树分层加载（先加载 depth=0，展开时查子节点）
26. IFC 文件 BLOB 按需读取（变电工程）
27. .mod 几何按需读取（线路工程，仅渲染可见杆塔时加载）

### 4.2 关键代码改造点

| 现有函数 | 改造方向 |
|---|---|
| `extractGimFile()` | 改为 `invoke('extract_gim', { path })`，Rust 后端原生解压 + 写 DB |
| `buildCbmTree()` | 改为 `invoke('query_cbm_tree')`，Rust 后端 `SELECT * FROM cbm_nodes` + `cbm_children` |
| `parseFileDevRelation()` | 改为 `invoke('query_file_dev_relation')`（线路工程跳过） |
| `buildIfcGuidIndex()` | 改为 `invoke('query_ifc_index')`（线路工程跳过） |
| `showNodeProperties()` | 改为 `invoke('query_node_detail', { path })`，返回 DEV + FAM 数据 |
| `loadIfcBuffer()` | 改为 `invoke('read_ifc_blob', { path })`（仅变电工程） |
| `discoverIfcFromCBM()` | 改为 `invoke('discover_ifc')`，后端 `SELECT ifc_file FROM cbm_ifc_refs UNION ...`（线路工程返回空） |
| **新增** `parseLineModGeometry()` | Rust 后端解析线路工程 .mod（HNUM/CODE/TYPE/BOLT）写入 `mod_*` 表 |
| **新增** `loadTowerGeometry()` | `invoke('query_tower_geometry', { mod_path })` |
| **新增** `loadCrossGeometry()` | `invoke('query_cross_geometry', { mod_path })` |

### 4.3 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| Tauri IPC 通信开销 | 频繁调用延迟累积 | 批量查询接口，减少 IPC 次数；大对象用 Tauri Events 推送 |
| Rust 学习曲线 | 开发效率下降 | 核心解析逻辑参考现有 TS 实现，逐步迁移 |
| web-ifc 前端依赖 | IFC 解析仍在前端 | IFC BLOB 通过 IPC 传给前端，web-ifc 流程不变 |
| SQLite 并发 | 读写冲突 | rusqlite 默认串行，解析阶段单写、查询阶段多读 |
| 线路工程 CBM 引用键多样 | 树构建遗漏子节点 | 按 ref_type 枚举全覆盖，单元测试验证 |
| 线路工程 .mod 格式分裂 | 解析器复杂度高 | 按格式分表存储，Rust 独立解析器 |
| 工程类型识别错误 | 字段映射错乱 | project.cbm 字段 + 目录大小写 + ENTITYNAME 分布三重判断 |

---

## 五、结论与建议

### 5.1 可行性结论

**✅ 强烈推荐，Tauri 方案收益显著**。核心收益：
- **启动速度**：变电工程从 ~5s 降至 ~0.6s（9x），线路工程从 ~10s 降至 ~0.8s（13x）
- **解压加速**：Rust 原生 7z 解压比 libarchive.js WASM 快 6 倍
- **查询加速**：原生 SQLite 比 sql.js WASM 快 2-5 倍，比 File.text() 串行解析快 60 倍
- **持久化**：本地文件系统无大小限制，无需 IndexedDB

### 5.2 推荐方案

- **技术栈**：Tauri 2 + rusqlite（bundled SQLite）+ sevenz-rust（7z 解压）
- **架构**：Rust 后端负责解压 + DB 写入 + 查询；前端 WebView 负责 Three.js 渲染 + web-ifc（IFC 解析）
- **通信**：Tauri IPC（invoke）用于请求-响应，Tauri Events 用于进度推送
- **优先级**：Phase 1-2（Tauri 基础 + CBM 结构化）收益最高，建议优先实施

### 5.3 不建议的部分

- **不要将 IFC 内容结构化入库**：IFC 是 STEP 物理格式，web-ifc 已是最佳解析器，保持前端解析
- **不要在前端引入 SQLite**：Tauri 方案下 SQLite 归 Rust 后端，前端无需 sql.js
- **不要保留 libarchive.js**：Tauri 方案下用 Rust 原生解压，彻底移除 WASM 解压依赖
- **不要过度 normalize**：DEV/FAM 属性结构化是可选项，收益相对较小
- **不要为线路工程引入 web-ifc**：线路工程无 IFC，强行转换 .mod 到 IFC 反而增加复杂度

### 5.4 预期效果

| 指标 | 变电工程现状（纯 Web） | 变电 Tauri 后 | 线路工程现状（纯 Web） | 线路 Tauri 后 |
|---|---|---|---|---|
| 启动耗时 | ~5s | ~0.6s | ~10s | ~0.8s |
| 10x 大文件启动 | ~30s | ~1s | ~70s | ~1.5s |
| 解压耗时 | ~3s（WASM） | ~0.5s（原生） | ~4s（WASM） | ~0.7s（原生） |
| 属性查询 | ~5ms | ~0.5ms | ~5ms | ~0.5ms |
| .mod 几何解析 | — | — | 每次渲染重解析 | 首次解析后缓存 |
| 持久化 | IndexedDB（2GB 限制） | 本地文件（无限制） | IndexedDB（2GB 限制） | 本地文件（无限制） |
| 重复打开 | ~5s | ~0.1s | ~10s | ~0.1s |
| 内存占用 | ~230MB 常驻 | ~50MB | ~142MB 常驻 | ~40MB |

### 5.5 迁移路径

从纯 Web 迁移到 Tauri 的建议顺序：
1. **保留前端代码**：Three.js 渲染、web-ifc、UI 逻辑基本不变
2. **新增 Rust 后端**：解压 + SQLite 逻辑从 TS 迁移到 Rust
3. **替换 IO 层**：`File.text()` → `invoke('query_...')`，`libarchive.js` → Rust 原生
4. **渐进迁移**：可先迁移 CBM 解析（收益最大），DEV/FAM/IFC 后续逐步迁移
5. **保留降级能力**：开发阶段可保留纯 Web 模式作为 fallback，便于调试
