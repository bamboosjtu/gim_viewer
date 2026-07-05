# 变电 GIM 文件格式与可视化

> 变电站工程（GIMPKGS）的文件结构、解析流程与 3D 可视化。

## 0. 实现状态总览

| 能力 | 状态 | 实现位置 |
|---|---|---|
| GIM 容器解压 | ✅ 已实现 | `src/gim/gimExtractor.ts` |
| CBM 层级树解析 | ✅ 已实现 | `src/gim/cbmParser.ts` |
| FAM 分节属性解析 | ✅ 已实现 | `src/gim/famParser.ts` |
| FileDevRelation 解析 | ✅ 已实现 | `src/gim/fileDevParser.ts` |
| IFC 发现 + GUID 索引 + 名称查询 | ✅ 已实现 | `src/gim/gimIndexer.ts` / `src/viewer/ifcNameIndex.ts` |
| IFC 3D 渲染（OBC + web-ifc + Three.js） | ✅ 已实现 | `src/viewer/viewerEngine.ts` / `ifcLoader.ts` / `ifcEntryLoader.ts` |
| 节点级 IFC 懒加载 + Fragments 缓存 | ✅ 已实现 | `src/viewer/ifcEntryLoader.ts`（`.frag` 缓存） |
| 3D 点击拾取 + 高亮 + 相机定位 | ✅ 已实现 | `src/viewer/selection.ts` / `highlight.ts` / `camera.ts` |
| 层级树↔3D 联动 | ✅ 已实现 | `src/services/nodeInteractionService.ts` |
| 属性面板（CBM/FAM/DEV/IFC） | ✅ 已实现 | `src/ui/propsDrawer.ts` |
| SQLite 缓存（7 张表 + fragments_cache） | ✅ 已实现 | `src-tauri/src/db.rs`（v5 + fragments-cache-v2） |
| 缓存命中短路 | ✅ 已实现 | `src/services/openGimService.ts` / `gimIndexRestoreService.ts` |
| IFC 本地磁盘缓存 | ✅ 已实现 | `src/services/gimExtractedCacheService.ts` |
| 诊断快捷键（Ctrl+Shift+D） | ✅ 已实现 | `src/services/diagnosticSummaryService.ts` |
| **MOD 文件解析（XML primitive 14 类）** | ❌ 未实现 | 仅有路径记录，无 parser；设计稿见 [10-substation-mod-grammar.md](schema/10-substation-mod-grammar.md) |
| **STL 渲染** | ❌ 未实现 | 1803 个 unique STL 全部未渲染；详见 [12-stl-static-survey.md](schema/12-stl-static-survey.md) |
| **PHM TransformMatrix 应用** | ❌ 未实现 | 仅在属性面板作 monospace 文本展示；样本中 100% IDENTITY |
| **PHM COLOR 应用** | ❌ 未实现 | STL 引用非空时 COLOR 字段存在，但未应用到 Fragments material |
| **PHM 解析（SOLIDMODEL + TRANSFORMMATRIXn + COLORn）** | ❌ 未实现 | — |
| **EMPTY_DEVICE_XML 提示** | ❌ 未实现 | 44 个孤儿 MOD 静默忽略 |
| **装配节点无几何提示** | ❌ 未实现 | 14 个无 SOLIDMODEL 的 PHM 静默忽略 |
| **Geometry IR schema 落地** | ❌ 未实现 | 设计稿见 [13-geometry-ir-schema.md](schema/13-geometry-ir-schema.md) |

> 下一步实现路径见 §9。

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

**解压**：libarchive.js（WebAssembly）解压后展平为 `Map<path, File>`。

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
```

> 当前管线**仅支持 IFC**。MOD primitive、STL、PHM TransformMatrix / COLOR 全部未实现，详见 §9。

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
| STL 加载 | — | STL mesh 加载 | ❌ 未实现 |
| MOD primitive 加载 | — | XML primitive → Three geometry | ❌ 未实现 |
| PHM 解析 | — | SOLIDMODEL + TRANSFORMMATRIXn + COLORn | ❌ 未实现 |

### 层级树↔3D 联动

选中设备节点 → 高亮对应 IFC 构件 + 相机定位。✅ 已实现

---

## 7. SQLite 缓存

### 变电工程表（7 张）

| 表 | 用途 |
|---|---|
| `gim_project` | 项目记录（path, sha256, size, parser_version, project_type） |
| `gim_entry` | GIM 内部文件清单 |
| `cbm_node` | CBM 层级节点（树形结构，含 ifc_file/ifc_guid 引用） |
| `ifc_model` | IFC 文件索引 |
| `file_dev_entry` | IFC↔设备 CBM 映射 |
| `fam_property` | FAM 分节属性缓存 |
| `dev_property` | DEV 关键属性缓存 |

### 缓存命中流程

1. 用户选择 GIM → Rust 计算 sha256 + file_size
2. `validate_gim_cache`：检查 parser_version + file_size + IFC 缓存文件存在性
3. 命中 → 读取全部索引 → 恢复到 AppState → 直接渲染树和面板
4. 未命中 → 完整解压 → 解析 → 入库 → 缓存 IFC 文件到本地磁盘

### IFC 本地缓存

IFC 文件写入 `app_data_dir/extracted/{id}/`，路径遍历防护。

---

## 8. 属性面板

右侧可折叠抽屉，展示：

- **FAM 设计参数**：分节属性（从 fam_property 缓存或 currentFiles 读取）✅
- **DEV 设备信息**：关键属性（从 dev_property 缓存或 currentFiles 读取）✅
- **IFC 属性集**：web-ifc 原生属性 ✅
- **TRANSFORMMATRIX**：monospace 文本展示（非单位矩阵时显示）✅ 仅展示，未应用到 3D
- **MOD primitive 字段**：❌ 未实现（14 类 primitive 字段无解析）
- **EMPTY_DEVICE_XML 提示**：❌ 未实现（44 个孤儿 MOD 静默忽略）
- **装配节点无几何提示**：❌ 未实现（14 个无 SOLIDMODEL PHM 静默忽略）

缓存命中时（currentFiles=null）仍可显示 CBM/FAM/DEV 基础属性。

---

## 9. 下一步实现路径

> 基于 [13-geometry-ir-schema.md](schema/13-geometry-ir-schema.md) 的 IR 草案与 [10-substation-mod-grammar.md](schema/10-substation-mod-grammar.md) 的 primitive grammar，按优先级分阶段实施。

### 9.1 P0（MVP 必补）

| 任务 | 输入 | 输出 | 关键约束 |
|---|---|---|---|
| **IR schema 落地** | [13-geometry-ir-schema.md](schema/13-geometry-ir-schema.md) §2-§4 | `src/gim/geometry/ir.ts`（GimGeometrySource 联合类型 + 5 个 kind interface） | 顶层联合类型引用 interface，不 inline；NoneReason 含 `assembly-node-without-own-geometry` |
| **PHM 解析器** | `.phm` 文件 | `src/gim/geometry/phmParser.ts`（SOLIDMODELn + TRANSFORMMATRIXn + COLORn） | PHM TRANSFORMMATRIX 100% IDENTITY（[09-transform-chain-analysis.md](schema/09-transform-chain-analysis.md)），实际单级变换 |
| **xml-mod parser** | 14 类 primitive（Box/Cylinder/Sphere/...） | `src/gim/geometry/xmlModParser.ts` | 覆盖率 99.86%（[10-substation-mod-grammar.md](schema/10-substation-mod-grammar.md)）；9 类低样本 primitive 保留 fallback |
| **xml-mod 渲染** | XmlModEntity[] → Three.js geometry | `src/viewer/xmlModLoader.ts` | 与 IFC 渲染栈共存（不替换 ifcLoader）；86 个 STL+MOD 并存 PHM 需评估重复（[12-stl-static-survey.md](schema/12-stl-static-survey.md) §5） |

### 9.2 P1（MVP 可选，影响 STL 展示能力）

| 任务 | 输入 | 输出 | 关键约束 |
|---|---|---|---|
| **STL 渲染** | 1803 个 unique STL（demo-substation） | `src/viewer/stlLoader.ts`（THREE.STLLoader 或等价实现） | 全部为 binary STL（[12-stl-static-survey.md](schema/12-stl-static-survey.md)）；建议先做 30 个 STL-only PHM 试点 |
| **PHM COLOR 应用** | PHM COLORn 字段 | Fragments material 颜色覆盖 | STL 引用非空时 COLOR 存在，MOD 引用为空 |
| **EMPTY_DEVICE_XML 提示** | 44 个孤儿 MOD | UI 提示 + 诊断（reason: `empty-device-xml`） | 不参与渲染但应提示 |

### 9.3 P2（体验补齐）

| 任务 | 输入 | 输出 | 关键约束 |
|---|---|---|---|
| **装配节点无几何提示** | 14 个无 SOLIDMODEL PHM | UI 提示 + 诊断（reason: `assembly-node-without-own-geometry`） | 装配节点自身无几何但子设备几何完整，与 `phm-no-solidmodel` 区分 |
| **PHM TransformMatrix 应用** | PHM TRANSFORMMATRIXn | 实例化时附加 matrix | 当前样本 100% IDENTITY，实际单级变换（保留两级字段结构，实现按单级） |
| **缓存命中回放** | geometry_source 表（建议） | 缓存命中时直接恢复 IR | 正式 DDL 另起 [14-geometry-cache-schema.md](schema/14-geometry-cache-schema.md)（待建） |
| **节点联动扩展** | CBM 树 → MOD/STL 高亮 | 选中设备节点 → 高亮对应 MOD primitive + 相机定位 | 与现有 IFC 联动模式一致 |

### 9.4 关键约束（来自分析报告）

| 约束 | 来源 | 影响 |
|---|---|---|
| 14 类 primitive 覆盖率 99.86% | [10-substation-mod-grammar.md](schema/10-substation-mod-grammar.md) | 9 类低样本 primitive 需保留弱 schema fallback |
| 86 个 PHM 同时引用 STL + MOD | [12-stl-static-survey.md](schema/12-stl-static-survey.md) §5 | 需评估重复渲染风险（建议 MOD-first 或 STL-first 策略） |
| 1803 unique STL 全部为 binary | [12-stl-static-survey.md](schema/12-stl-static-survey.md) | 可统一用 THREE.STLLoader 二进制路径 |
| PHM TransformMatrix 100% IDENTITY | [09-transform-chain-analysis.md](schema/09-transform-chain-analysis.md) | 单级变换，两级字段结构保留 |
| F3System 多 FAM 引用 145 个文件 × 4 FAM | [06-cbm-fam-consistency.md](schema/06-cbm-fam-consistency.md) §3.3 | F3System 节点属性聚合需考虑多 FAM 合并展示 |
| Geometry IR 不在 SQLite 范围 | [13-geometry-ir-schema.md](schema/13-geometry-ir-schema.md) §1.3 | 正式 DDL 另起 14-geometry-cache-schema.md |

### 9.5 与现有 IFC 路径的兼容性

| 兼容点 | 策略 |
|---|---|
| 现有 `ifcLoader.ts` | 保留，IR 通过 `kind: "ifc"` 复用 |
| `CbmNode` 类型 | 保留 `ifcFile` / `ifcGuid` 字段，IR 不替代，仅消费 path/entityName/devPath |
| `AppState` | 新增可选字段 `geometryBundles` / `cachedGeometryPaths`（向后兼容） |
| SQLite 表 | 现有 7 张表 + fragments_cache 保留，新增 `geometry_source` 表为可选缓存（不破坏现有缓存命中） |
| 渲染栈 | IFC 走 OBC Fragments，MOD/STL 走 Three.js 直接 geometry，两者共存于同一 scene |
