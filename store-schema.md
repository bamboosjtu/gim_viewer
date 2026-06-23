# GIM → SQLite 存储方案可行性分析

> 目标：将 GIM 解压后的散文件转换为 SQLite 数据库，以数据库查询替代反复的 `File.text()` 解析，提升大型 GIM 文件的访问速度，并支持懒加载。
>
> **覆盖范围**：Schema 设计已对照变电工程（demo-substation）和线路工程（demo-line）两类数据核对。两类工程的差异在相关章节标注。

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

**变电工程（demo-substation）**：

| 类型 | 数量 | 平均大小 | 总大小 | 访问模式 |
|---|---|---|---|---|
| CBM | 8701 | ~1 KB | ~9 MB | 启动时全量递归解析 |
| DEV | 4179 | ~2 KB | ~8 MB | 点击时按需读取 |
| FAM | 4179 | ~3 KB | ~12 MB | 点击时按需读取 |
| PHM | 4179 | ~5 KB | ~20 MB | 暂未使用 |
| MOD | 5982 | ~10 KB | ~60 MB | 暂未使用 |
| IFC | 12 | ~10 MB | ~120 MB | web-ifc 二进制解析 |
| **合计** | **36113** | — | **~230 MB** | — |

**线路工程（demo-line）**：

| 类型 | 数量 | 平均大小 | 总大小 | 访问模式 |
|---|---|---|---|---|
| CBM | 27829 | ~0.8 KB | ~21 MB | 启动时全量递归解析（层级更深、引用键更多样） |
| FAM (Cbm) | 26485 | ~0.4 KB | ~10 MB | 点击时按需读取（扁平格式，无分节） |
| DEV | 4518 | ~7 KB | ~33 MB | 点击时按需读取 |
| FAM (Dev) | 4518 | ~0.4 KB | ~2 MB | 点击时按需读取 |
| PHM | 1836 | ~0.5 KB | ~1 MB | 渲染时读取（引用 .mod/.stl） |
| MOD | 1807 | ~48 KB | ~86 MB | 渲染时解析（4 种格式：HNum/CODE/type/Bolt） |
| STL | 181 | ~varies | 嵌入 MOD 目录 | 渲染时 STLLoader |
| IFC | **0** | — | — | **线路工程无 IFC** |
| **合计** | **~60652** | — | **~142 MB** | — |

**两类工程对比**：线路工程文件数是变电工程的 1.7 倍，但无 IFC 大文件，总大小反而更小；CBM 数量是变电工程的 3.2 倍，启动时解析压力更大。

### 1.3 瓶颈定位

| 阶段 | 耗时原因 | 是否可优化 |
|---|---|---|
| 7z 解压 | libarchive.js WASM 单线程 | 否（已是最快方案） |
| **CBM 树构建** | 变电 8700 / 线路 27800 次 `await f.text()` 串行解析 | **是，DB 可批量查询** |
| **FileDevRelation 解析** | 变电工程单文件大，含 4645 条设备引用；**线路工程无此文件** | **是，DB 可结构化存储** |
| **属性面板读取** | 每次点击触发 `f.text()` + parseKeyValue | **是，DB 可缓存** |
| IFC 解析渲染 | web-ifc WASM 解析几何（仅变电工程） | 否（独立流程） |
| IFC 名称索引 | 加载后批量 `getItemsData`（仅变电工程） | 否（依赖 web-ifc） |
| **.mod 几何解析** | 线路工程 1807 个 .mod（4 种格式）+ 181 个 .stl | **是，DB 可缓存解析结果** |

**核心结论**：CBM/DEV/FAM 的小文件解析是主要可优化点，DB 化后可从"数千次串行 IO"降为"1 次批量 SQL 查询"。线路工程因 CBM 数量更多（27800 vs 8700），收益更显著。

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

**变电工程 ENTITYNAME 类型分布**（demo-substation 实测）：

| 类型 | 数量 | 层级 | 特有字段 |
|---|---|---|---|
| F1System | 1 | 工程级 | `IFC.NUM`+`IFC0..N`（列出全部 IFC） |
| F2System | 4 | 区域级 | `SUBSYSTEMS.NUM` |
| F3System | 85 | 子区域级 | `SYSTEMNAME1..4`、`BASEFAMILY1..4`、`MATERIALSHEET` |
| F4System | 2682 | 设备级 | `OBJECTMODELPOINTER`、`IFCFILE`+`IFCGUID`、`TRANSFORMMATRIX` |
| PARTINDEX | 2228 | 叶节点 | `PARTNAME`、`OBJECTMODELPOINTER` |

**线路工程 ENTITYNAME 类型分布**（demo-line 实测）：

| 类型 | 数量 | 层级 | 特有字段 | 子节点引用键 |
|---|---|---|---|---|
| F1System | 1 | 工程级 | `MATERIALSHEET`（空） | `SECTIONS.NUM`+`SECTION<i>` |
| F2System | 1 | 系统级 | `MATERIALSHEET` | `STRAINSECTIONS.NUM`+`STRAINSECTION<i>` |
| F3System | 108 | 耐张段级 | — | `GROUPS.NUM`+`GROUP<i>` |
| F4System | 5861 | 设备组级 | `GROUPTYPE`(TOWER\|WIRE\|CROSS) | 因 GROUPTYPE 而异（见下） |
| Tower_Device | 4309 | 叶节点 | `OBJECTMODELPOINTER`、`TRANSFORMMATRIX` | — |
| Wire_Device | 11773 | 叶节点 | `OBJECTMODELPOINTER`、`BLHA`、`TRANSFORMMATRIX` | — |
| WIRE | 5460 | 叶节点 | `KVALUE`、`SPLIT`、`POINT<i>.BLHA`、`POINT<i>.MATRIX0` | — |
| CROSS | 315 | 叶节点 | `OBJECTMODELPOINTER` | — |

**线路工程 F4System 的 GROUPTYPE 差异**（schema 必须区分）：

| GROUPTYPE | 数量 | 子节点引用键 | 特有字段 |
|---|---|---|---|
| TOWER | 327 | `TOWERS.NUM`+`TOWER<i>`、`STRINGS.NUM`+`STRING<i>.STRING`+`STRING<i>.GPOINT`、`BASES.NUM`+`BASE<i>` | `BLHA`、`MODLEG` |
| WIRE | 5460 | `SUBDEVICES.NUM`+`SUBDEVICE<i>`、`BACKSTRING`、`FRONTSTRING` | `WIRETYPE`、`ISJUMPER` |
| CROSS | 74 | `SUBDEVICES.NUM`+`SUBDEVICE<i>` | — |

**两类工程关键差异对 Schema 的影响**：
1. **子节点引用键不统一**：变电工程统一 `SUBSYSTEMS.NUM`+`SUBSYSTEM<i>`，线路工程每层不同 → `cbm_children.ref_type` 字段需扩展枚举值
2. **线路工程无 IFC/FileDevRelation**：`cbm_ifc_refs`、`file_dev_relation`、`ifc_elements` 表为空，但不影响 schema 结构
3. **线路工程新增字段**：F4System 的 `GROUPTYPE`、WIRE 的 `POINT<i>.BLHA`/`POINT<i>.MATRIX0`、TOWER 的 `BLHA`/`MODLEG` → 需新增列或存入 `cbm_extra_props`
4. **.mod 格式分裂**：变电工程 .mod 统一 XML，线路工程 .mod 分 4 种文本格式 → `files` 表需记录 .mod 子格式，或新增 `mod_geometry` 表缓存解析结果

### 3.1 核心表

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
--       ('blha', '27.52472222,112.01388890,150.00,0')  -- project.cbm 的 BLHA 字段（仅变电工程）

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

### 3.2 CBM 结构化表（关键优化点）

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
  ifc_file       TEXT,                -- IFCFILE（仅变电工程设备级，如 '动力照明0317.ifc'）
  ifc_guid       TEXT,                -- IFCGUID（已去除尾部 $，仅变电工程）
  transform      TEXT,                -- TRANSFORMMATRIX 原始字符串（16 个浮点数）
  material_sheet TEXT,                -- MATERIALSHEET（F1-F3 有此字段，线路工程为空）
  sch            TEXT,                -- SCH（仅变电 project.cbm，调度文件引用）
  proj_type      TEXT,                -- TYPE（仅变电 project.cbm，如 'TS' 表示变电站；线路工程无此字段）
  blha           TEXT,                -- BLHA：变电 project.cbm 为 '经度,纬度,高程'（3值）；线路工程 F4System-TOWER/Wire_Device 为 '纬度,经度,高程,方位角'（4值）
  depth          INTEGER,             -- 在树中的深度（project.cbm=0）
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
CREATE INDEX idx_cbm_ifc ON cbm_nodes(ifc_file, ifc_guid);
CREATE INDEX idx_cbm_dev ON cbm_nodes(dev_pointer);
CREATE INDEX idx_cbm_group_type ON cbm_nodes(group_type);  -- 线路工程按 GROUPTYPE 筛选

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

-- CBM 子系统级 IFC 引用表（F1System 的 IFC.NUM + IFC0..N）
-- 与设备级 IFCFILE+IFCGUID 不同：子系统级只列 IFC 文件名，无 GUID
-- 注：仅变电工程有此数据，线路工程此表为空
CREATE TABLE cbm_ifc_refs (
  cbm_path   TEXT NOT NULL,           -- 'CBM/<uuid>.cbm'
  ifc_file   TEXT NOT NULL,           -- '电气二次0317其他.ifc'
  sort_order INTEGER,
  PRIMARY KEY (cbm_path, ifc_file),
  FOREIGN KEY (cbm_path) REFERENCES cbm_nodes(path)
);

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

### 3.3 FileDevRelation 结构化表

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

### 3.4 DEV 结构化表

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

### 3.6 PHM 结构化表

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

### 3.7 线路工程 .mod 几何缓存表（仅线路工程）

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

### 3.8 IFC 元数据缓存表

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

---

## 四、性能收益分析

### 4.1 启动阶段对比

**变电工程（demo-substation）**：

| 步骤 | 现状 | DB 方案 | 提升 |
|---|---|---|---|
| 解压 | ~3s（36113 文件） | ~3s（不变） | — |
| CBM 树构建 | ~2s（8700 次串行 `f.text()`） | ~50ms（1 次 SQL 查询全表） | **40x** |
| FileDevRelation 解析 | ~200ms | ~10ms（结构化查询） | 20x |
| 索引构建 | ~100ms（内存遍历） | ~0ms（DB 索引已建） | ∞ |
| **启动总计** | **~5.3s** | **~3.1s** | **1.7x** |

**线路工程（demo-line）**：

| 步骤 | 现状 | DB 方案 | 提升 |
|---|---|---|---|
| 解压 | ~4s（60652 文件） | ~4s（不变） | — |
| CBM 树构建 | ~6s（27800 次串行 `f.text()`，层级更深） | ~150ms（1 次 SQL 查询全表） | **40x** |
| FileDevRelation 解析 | 0ms（无此文件） | 0ms | — |
| 索引构建 | ~200ms（内存遍历，节点更多） | ~0ms（DB 索引已建） | ∞ |
| **启动总计** | **~10.2s** | **~4.2s** | **2.4x** |

**结论**：线路工程因 CBM 数量更多（27800 vs 8700）、层级更深（6 层 vs 5 层）、引用键更多样（11 种 vs 3 种），DB 化收益更显著。

### 4.2 运行时按需查询对比

| 操作 | 现状 | DB 方案 | 提升 |
|---|---|---|---|
| 点击节点读 DEV 属性 | ~5ms（`f.text()` + parse） | ~1ms（SELECT） | 5x |
| 点击节点读 FAM 属性 | ~5ms | ~1ms | 5x |
| IFCGUID 反查设备 | O(n) 遍历 Map | O(log n) 索引查询 | 显著 |
| FileDevRelation 反查 | O(n) 遍历 | O(log n) 索引查询 | 显著 |

### 4.3 大文件场景预估

假设 GIM 文件规模扩大 10 倍（变电 CBM 87000 个、线路 CBM 278000 个）：

| 场景 | 现状预估 | DB 方案预估 |
|---|---|---|
| 变电启动 CBM 树构建 | ~20s | ~500ms |
| 线路启动 CBM 树构建 | ~60s | ~1.5s |
| 启动总耗时（变电） | ~30s | ~10s |
| 启动总耗时（线路） | ~70s | ~12s |
| 内存占用 | 全量 File 对象常驻 | 按需查询，内存占用低 |

### 4.4 懒加载收益

DB 方案天然支持懒加载：
- CBM 树可按深度分层加载（先显示根节点，展开时查子节点）
- DEV/FAM 属性仅在点击时查询
- IFC 文件 BLOB 按需读取（用户选择加载哪个 IFC）
- 大型 GIM（>500MB）可避免一次性加载所有文件到内存

---

## 五、不可优化部分

### 5.1 IFC 文件解析（仅变电工程）

web-ifc 接受 `Uint8Array` 输入，必须完整加载文件内容：
- DB 中 IFC 文件以 BLOB 存储
- 加载时 `SELECT blob FROM files WHERE path = ?` → 传给 web-ifc
- **收益**：避免 `File` 对象常驻内存，但解析耗时不变
- **线路工程**：无 IFC 文件，此步骤跳过

### 5.2 7z 解压

libarchive.js WASM 解压是必经步骤，DB 化无法绕过。
- **缓解**：转换后的 SQLite 二进制可缓存到 IndexedDB，下次直接加载

### 5.3 3D 渲染

Three.js 渲染性能与存储方案无关。

### 5.4 悬链线计算（仅线路工程）

导地线悬链线根据两端挂点 BLHA + KVALUE + 物理参数实时计算，无法预存：
- DB 可缓存输入参数（WIRE CBM 的 POINT.BLHA + .mod 物理参数）
- 但悬链线采样点计算仍需在 JS 中完成

---

## 六、实施路径

### 6.1 分阶段实施

**Phase 1 — 基础 DB 化（高收益、低风险）**：
1. 引入 sql.js，WASM 放入 `public/`
2. 实现 `GimDatabase` 类：`extractToDb(arrayBuffer) → Database`
3. 将所有文件内容写入 `files` 表（文本入 content，IFC/stl 入 blob）
4. 解析 CBM 文件写入 `cbm_nodes` + `cbm_children` + `cbm_ifc_refs` + `cbm_extra_props`
   - ⚠️ 需识别工程类型：变电工程用 `SUBSYSTEMS.NUM`+`SUBSYSTEM<i>`，线路工程用 `SECTIONS`/`STRAINSECTIONS`/`GROUPS`/`TOWERS`/`STRINGS`/`BASES` 等多种引用键
   - ⚠️ 线路工程 F4System 需按 `GROUPTYPE` 分支处理子节点
5. 解析 FileDevRelation 写入 `file_dev_relation` 表（注意偶奇配对；线路工程无此文件，跳过）
6. 改造 `buildCbmTree`、`parseFileDevRelation` 为 SQL 查询

**Phase 2 — DEV/PHM 结构化（中等收益，需处理重复键）**：
7. 解析 DEV 文件写入 `dev_nodes` + `dev_subdevices` + `dev_solidmodels`（⚠️ 必须分段解析，避免 TRANSFORMMATRIX 覆盖）
   - ⚠️ 变电工程读 `TYPE` 字段，线路工程读 `DEVICETYPE` 字段，统一存 `device_type` 列
8. 解析 PHM 文件写入 `phm_solidmodels` 表
9. 解析 FAM 文件写入 `fam_props` 表
   - ⚠️ 变电工程有 `[节名]` 分节，线路工程无分节（扁平格式），统一用 `section` 列（线路存 NULL）
10. 属性面板改为 SQL 查询

**Phase 3 — 线路工程 .mod 几何缓存（仅线路工程需要）**：
11. 识别 .mod 文件格式（XML/HNUM/CODE/TYPE/BOLT），写入 `mod_files` 表
12. 解析 HNum 格式 .mod 写入 `mod_tower_geometry` + `mod_tower_members` + `mod_tower_gpoints`
13. 解析 CODE 格式 .mod 写入 `mod_cross_geometry` + `mod_cross_lines`
14. 解析 type 格式 .mod 写入 `mod_wire_params`
15. 渲染时从 DB 读取缓存，避免重复解析

**Phase 4 — 持久化缓存（体验优化）**：
16. 转换后的 SQLite 二进制存入 IndexedDB
17. 下次打开同一 .gim 直接加载 DB，跳过解压+转换

**Phase 5 — 懒加载（大文件优化）**：
18. CBM 树分层加载（先加载 depth=0，展开时加载子节点）
19. IFC 文件 BLOB 按需读取（变电工程）
20. .mod 几何按需读取（线路工程，仅渲染可见杆塔时加载）

### 6.2 关键代码改造点

| 现有函数 | 改造方向 |
|---|---|
| `extractGimFile()` | 解压后写入 DB，返回 DB 句柄；需识别工程类型（变电/线路） |
| `buildCbmTree()` | `SELECT * FROM cbm_nodes` + `cbm_children` 一次查询构建树；需处理 11 种 ref_type |
| `parseFileDevRelation()` | `SELECT * FROM file_dev_relation`（线路工程跳过） |
| `buildIfcGuidIndex()` | `SELECT path, ifc_file, ifc_guid FROM cbm_nodes WHERE ifc_guid != ''`（线路工程跳过） |
| `showNodeProperties()` | `SELECT * FROM dev_nodes JOIN dev_solidmodels` + `SELECT * FROM fam_props` |
| `loadIfcBuffer()` | `SELECT blob FROM files WHERE path = ?`（仅变电工程） |
| `discoverIfcFromCBM()` | `SELECT ifc_file FROM cbm_ifc_refs UNION SELECT ifc_file FROM cbm_nodes WHERE ifc_file != ''`（线路工程返回空） |
| **新增** `parseLineModGeometry()` | 解析线路工程 .mod（HNUM/CODE/TYPE/BOLT）写入 `mod_*` 表 |
| **新增** `loadTowerGeometry()` | `SELECT * FROM mod_tower_geometry/members/gpoints WHERE mod_path = ?` |
| **新增** `loadCrossGeometry()` | `SELECT * FROM mod_cross_geometry/lines WHERE mod_path = ?` |

### 6.3 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| sql.js WASM 加载失败 | 应用不可用 | 降级到现有 File 方案 |
| 转换耗时增加首次打开时间 | 体验下降 | IndexedDB 缓存 + 进度提示 |
| sql.js 内存占用 | 大文件 OOM | 按需查询，避免全量加载 |
| Schema 变更迁移 | 数据不一致 | 版本号字段 + 重建机制 |
| 线路工程 CBM 引用键多样 | 树构建遗漏子节点 | 按 ref_type 枚举全覆盖，单元测试验证 |
| 线路工程 .mod 格式分裂 | 解析器复杂度高 | 按格式分表存储，独立解析器 |
| 工程类型识别错误 | 字段映射错乱 | project.cbm 字段 + 目录大小写 + ENTITYNAME 分布三重判断 |

---

## 七、结论与建议

### 7.1 可行性结论

**✅ 可行，推荐实施**。核心收益在于将数千次串行文件解析降为 1 次批量 SQL 查询：
- 变电工程启动速度提升约 1.7x（8700 次 → 1 次查询）
- 线路工程启动速度提升约 2.4x（27800 次 → 1 次查询），收益更显著

### 7.2 推荐方案

- **技术栈**：sql.js（内存模式）+ IndexedDB 缓存
- **优先级**：Phase 1（基础 DB 化）收益最高，建议优先实施
- **IFC 文件**：以 BLOB 存储，加载时读出传给 web-ifc，不改变现有渲染流程（仅变电工程）
- **.mod 几何**：线路工程的 4 种 .mod 格式分表缓存解析结果（Phase 3）

### 7.3 不建议的部分

- **不要将 IFC 内容结构化入库**：IFC 是 STEP 物理格式，web-ifc 已是最佳解析器
- **不要替换 libarchive.js**：解压是必经步骤，DB 化无法绕过
- **不要过度 normalize**：DEV/FAM 属性结构化是可选项，收益相对较小
- **不要为线路工程引入 web-ifc**：线路工程无 IFC，强行转换 .mod 到 IFC 反而增加复杂度

### 7.4 预期效果

| 指标 | 变电工程现状 | 变电 DB 化后 | 线路工程现状 | 线路 DB 化后 |
|---|---|---|---|---|
| 启动耗时 | ~5s | ~3s | ~10s | ~4s |
| 10x 大文件启动 | ~30s | ~10s | ~70s | ~12s |
| 内存占用 | ~230MB 常驻 | ~50MB（DB + 缓存） | ~142MB 常驻 | ~40MB（DB + 缓存） |
| 属性查询 | ~5ms | ~1ms | ~5ms | ~1ms |
| .mod 几何解析 | — | — | 每次渲染重解析 | 首次解析后缓存 |
| 重复打开 | ~5s | ~1s | ~10s | ~1s |
