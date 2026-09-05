# 线路 GIM 文件格式与可视化

> 输电线路工程（GIMPKGT）的文件结构、解析流程、地图渲染与树↔图联动。

## 0. 实现状态总览

| 能力 | 状态 | 实现位置 |
|---|---|---|
| GIM 容器解压 | ✅ 已实现 | `desktop/src/gim/gimExtractor.ts` |
| 工程类型识别 | ✅ 已实现 | `desktop/src/gim/projectType.ts` |
| CBM 层级解析（F1-F4System） | ✅ 已实现 | `desktop/src/gim/lineCbmParser.ts` |
| DEV/FAM 解析 | ✅ 已实现 | `desktop/src/gim/lineDevParser.ts` / `lineFamParser.ts` |
| 引用链索引（含 .cbm/.dev/.fam/.phm/.mod/.stl） | ✅ 已实现 | `desktop/src/gim/lineRefKind.ts` / `gimGraphTypes.ts` |
| 地图数据提取（塔位/导线/跨越点） | ✅ 已实现 | `desktop/src/gim/lineMapData.ts` |
| 2D 地图渲染（Canvas + MapLibre overlay） | ✅ 已实现 | `desktop/src/ui/lineMapView.ts` / `lineMapBaseLayer.ts` |
| OSM 在线底图 + 不可用回退 | ✅ 已实现 | `desktop/src/ui/lineMapBaseLayer.ts` / `lineMapStyle.ts` |
| 树↔地图双向联动 | ✅ 已实现 | `desktop/src/ui/lineMapView.ts` / `lineProjectView.ts` |
| SQLite 缓存（6 张表） | ✅ 已实现 | `desktop/src-tauri/src/db.rs`（v6） |
| 悬链线参数**审计**（只读，Ctrl+Shift+C） | ✅ 已实现 | `desktop/src/services/lineGeometryAuditService.ts` 等 4 个服务 |
| **Geometry IR schema 落地（统一 IR）** | ✅ 已实现 | `desktop/src/gim/geometry/ir.ts` 含 `line-text-mod` kind 类型定义；设计稿见 [13-geometry-ir-schema.md](schema/13-geometry-ir-schema.md) |
| MOD 文件解析（4 类文本格式族） | ✅ 已实现并接入属性面板 | `desktop/src/gim/geometry/lineModParser.ts` + `desktop/src/services/lineModRuntimeService.ts` |
| HNum 杆塔骨架可视化（TEXT_HNUM_COMMA_RECORD） | ✅ 选中杆塔后在属性面板“来源”页签显示 SVG 形状预览 | `desktop/src/ui/lineProjectView.ts` |
| Bolt 属性面板（TEXT_SECTION_KV_RECORD） | ✅ 已实现 | `desktop/src/ui/lineProjectView.ts`，摘要 + 单表格展示 BoltNum/BoltN，未确认字段折叠 |
| Tower_Device/WIRE 参数面板（TEXT_KEY_VALUE） | ✅ 已实现 | `desktop/src/ui/lineProjectView.ts`，按 key set 分流 |
| STL 渲染（Wire_Device 100% 触达 STL） | ⚠️ 解析与引用已接入；来源页提供可读按钮追溯，线路不单独创建 3D Viewer | `desktop/src/services/lineModRuntimeService.ts`；`desktop/src/ui/lineProjectView.ts` |
| 悬链线/弧垂渲染 | ⚠️ 实验实现默认开启 | 2D 屏幕方向示意曲线；KVALUE/MATRIX0/WIRETYPE 语义与 hit-test 尚未收口 |
| 3D 线路（独立 viewer） | ⏸ 产品边界：不启用；线路仅保留“模型”地图工作区，杆塔形状在来源页预览 | — |
| PHM TransformMatrix 应用 | ⚠️ 线路不实例化 3D；PHM 实例矩阵保留在来源/技术字段，供后续几何能力使用 | 属性面板保留来源和技术字段 |

> 未完成的性能提升和功能决策统一维护在 [dev-log.md](dev-log.md)；本文件只描述当前实现和稳定边界。

---

## 1. GIM 文件容器

| 头部魔数 | 工程类型 |
|---|---|
| `GIMPKGT` | 输电线路（Transmission Line） |

与变电工程共享相同的容器格式：

- GIMPKG* 头部（变长，含项目编号和名称，零填充）
- 1MB 窗口内搜索 7z（`37 7A BC AF 27 1C`）或 ZIP（`50 4B 03 04`）签名
- Tauri 生产路径：Rust `sevenz-rust/zip` 磁盘优先逐条解压；浏览器/能力回退路径使用 libarchive.js（WebAssembly）

### 目录命名差异

| 工程 | 目录命名 |
|---|---|
| 变电（GIMPKGS） | 大写：`CBM/` `DEV/` `PHM/` `MOD/` |
| 线路（GIMPKGT） | PascalCase：`Cbm/` `Dev/` `Phm/` `Mod/` |

解析器通过 `lowerFileName()` 兼容大小写，以文件名小写作为统一查找键。

---

## 2. CBM 层级结构

线路 CBM 每层引用键不同（变电工程统一用 `SUBSYSTEM<i>`）：

```
project.cbm
└── F1System（SECTIONS.NUM + SECTION<i>）
    └── F2System（STRAINSECTIONS.NUM + STRAINSECTION<i>）
        └── F3System（GROUPS.NUM + GROUP<i>）
            └── F4System
                ├── GROUPTYPE=TOWER
                │   ├── TOWERS.NUM + TOWER<i> → Tower_Device
                │   ├── STRINGS.NUM + STRING<i>.STRING（递归）+ STRING<i>.GPOINT（挂点名）
                │   ├── BASES.NUM + BASE<i>
                │   └── SUBDEVICES.NUM + SUBDEVICE<i>
                └── GROUPTYPE=WIRE
                    ├── BACKSTRING / FRONTSTRING
                    └── SUBDEVICES.NUM + SUBDEVICE<i>
```

### 叶子节点

| 实体 | 引用键 | 含义 |
|---|---|---|
| `Tower_Device` | `OBJECTMODELPOINTER`(→.dev), `BASEFAMILY`(→.fam) | 塔位设备 |
| `Wire_Device` | 同上 | 导线设备 |
| `WIRE` | 同上 + `WIRETYPE` | 导线段（CONDUCTOR/GROUNDWIRE/OPGW） |
| `CROSS` | 同上 | 跨越点 |

### 引用类型（LineRefKind）

`desktop/src/gim/lineRefKind.ts` 定义 10 种引用类型：

| 常量 | ref_kind 值 | 说明 |
|---|---|---|
| `CBM_FILES` | `cbmFiles` | CBM 文件引用 |
| `DEV_FILES` | `devFiles` | DEV 文件引用 |
| `FAM_FILES` | `famFiles` | FAM 文件引用 |
| `PHM_FILES` | `phmFiles` | PHM 文件引用 |
| `MOD_FILES` | `modFiles` | MOD 文件引用 |
| `STL_FILES` | `stlFiles` | STL 文件引用 |
| `WIRE_FILES` | `wireFiles` | WIRE 文件引用 |
| `IFC_FILES` | `ifcFiles` | IFC 文件引用 |
| `IFC_GUIDS` | `ifcGuids` | IFC GUID 引用（保留，当前未使用） |
| `RAW_REFS` | `rawRefs` | 原始键值对（非数组型引用） |

---

## 3. 坐标系统

### BLHA 格式

塔位坐标存储在 `F4System(GROUPTYPE=TOWER)` 节点的 `rawProps.BLHA`：

```
BLHA=<纬度>,<经度>,<海拔>,<方向角>
```

### GeoJSON 映射

BLHA 纬度在前，GeoJSON 经度在前：

```
BLHA[lat, lng, elev, azimuth] → GeoJSON [lng, lat]
```

### 导线端点

WIRE 节点的 `POINT0.BLHA` 和 `POINT1.BLHA` 存储导线两端坐标，`WIRETYPE` 区分类型：

| WIRETYPE | 含义 |
|---|---|
| `CONDUCTOR` | 导线 |
| `GROUNDWIRE` | 地线 |
| `OPGW` | 光纤复合架空地线 |

---

## 4. 地图数据提取

`desktop/src/gim/lineMapData.ts` 的 `extractLineMapData(graph, attrs)` 将 GIM 图转为扁平地图数据：

### 数据结构

| 类型 | 字段 | 来源 |
|---|---|---|
| `TowerMarker` | lat/lng/elev/azimuth/towerNumber/towerType/towerHeight/turnAngle | F4System(TOWER) 的 rawProps.BLHA + FAM/DEV 属性 |
| `WireSegment` | startLat/startLng/endLat/endLng/wireType/kValue/split | WIRE 节点的 POINT0/1.BLHA + WIRETYPE |
| `CrossMarker` | lat/lng/crossType/name | F4System(CROSS) 的 BLHA |

### 数据质量分级

`TowerMarker.dataQuality`：

| 等级 | 含义 |
|---|---|
| `full` | 有坐标 + FAM 命中 |
| `partial` | 有坐标 + FAM 未命中 |
| `coords-only` | 仅有坐标 |

### 统计

`LineMapStats`：塔位总数、有坐标塔位、有 FAM 塔位、导线段总数、有端点导线、跨越点总数、有坐标跨越点。

### 未解析引用

`LineMapUnresolved`：未定位塔位/导线/跨越点、FAM 未命中引用、DEV 未命中引用（不阻断渲染）。

---

## 5. 地图渲染

### 渲染架构

```
┌─────────────────────────────────────────┐
│  MapLibre 底图层（z-index: 0）           │  OSM raster 瓦片
├─────────────────────────────────────────┤
│  Canvas overlay（z-index: 2，透明）      │  塔位/导线/跨越点/网格/比例尺
├─────────────────────────────────────────┤
│  控件层（z-index: 20）                   │  tooltip / fit 按钮 / 图层面板
└─────────────────────────────────────────┘
```

### 模块分工

| 模块 | 职责 |
|---|---|
| `ui/lineMapView.ts` | Canvas 渲染（塔位/导线/跨越点/经纬度网格/比例尺/hover/click/tooltip） |
| `ui/lineMapBaseLayer.ts` | MapLibre 底图层（probe + overlay 桥接 + pointer 事件转发） |
| `ui/lineMapProjection.ts` | 投影接口（`createMapLibreProjection` / `createCanvasProjection`） |
| `ui/lineMapStyle.ts` | MapLibre style 工厂（`createOsmOnlineRasterStyle` / `createEmptyLineMapStyle` / `createPmtilesLineMapStyle`） |
| `ui/lineMapPmtiles.ts` | PMTiles protocol 管理（引用计数，默认关闭） |
| `ui/lineProjectView.ts` | 线路工程面板编排（树 + 地图 + 属性 + 生命周期） |

### MVP 底图策略

| 模式 | 说明 | 状态 |
|---|---|---|
| `osm-online` | OSM online raster（MVP 默认） | ✅ 启用 |
| Canvas-only | OSM 不可用时自动回退 | ✅ 兜底 |
| `pmtiles` | 本地 PMTiles 矢量瓦片 | 休眠（`ENABLE_PMTILES_EXPERIMENT=false`） |
| `empty` | 纯色 background | 代码保留 |

### OSM 在线底图

- 瓦片源：`https://tile.openstreetmap.org/{z}/{x}/{y}.png`（HTTPS，单服务器，无 a/b/c 子域）
- `tileSize: 256`（OSM 标准）
- `attribution: '© OpenStreetMap contributors'`（ODbL 许可）
- `attributionControl: { compact: false }`（始终展开）

### OSM 不可用回退

当 OSM tile 错误累积达 **3 次** 时触发 `onBasemapUnavailable` 回调：

1. 清理 MapLibre interaction listeners
2. 销毁 Canvas overlay handle
3. 销毁 MapLibre probe（`map.remove()`）
4. 重新渲染 Canvas-only（恢复经纬度网格、比例尺、hover/click/tooltip/树联动）
5. UI 提示：`OSM 在线底图不可用，已切换为 Canvas 地图模式`

**error listener 生命周期**：OSM 模式下 `onLoad` 不移除 error listener（需持续监听 load 后的 tile error），`destroy()` 时显式 `map.off`。

### 投影桥接

| 模式 | 投影方法 |
|---|---|
| MapLibre overlay | `map.project({ lng, lat })` → 屏幕像素 |
| Canvas-only | 等距投影（Equirectangular） |

Canvas overlay 委托底图层的 `project()` 方法，两种模式共用同一渲染逻辑。

---

## 6. Canvas 地图元素

| 元素 | 渲染 |
|---|---|
| 塔位 | 直线塔（圆形）/ 耐张塔（菱形），按 DEVICETYPE 区分 |
| 导线 | 两塔之间直线连接，按 WIRETYPE 着色（CONDUCTOR/GROUNDWIRE/OPGW） |
| 跨越点 | ✖️ 符号 |
| 经纬度网格 | Canvas 绘制（Canvas-only 模式显示，overlay 模式隐藏） |
| 比例尺 | Canvas 绘制（Canvas-only 模式显示，overlay 模式由 MapLibre ScaleControl 替代） |

### 图层开关

地图图层可见性维护在前端内存（不持久化）：

- 导线 / 地线 / OPGW / 未知线 / 塔位 / 跨越点 / 标签
- 塔位图层可见性控制 hover/click 命中检测
- 标签图层可见性覆盖基于缩放级别的标签显示

---

## 7. 树↔地图联动

| 方向 | 实现 |
|---|---|
| 树 → 地图 | 点击树节点 → `focusTowerByNodePath(path)` → 地图定位 + 高亮 |
| 地图 → 树 | 点击地图塔位 → `selectTreeRow(path)` → 树行选中 + 滚动 |

树节点行带 `data-node-path` 属性，供地图反查。

---

## 8. SQLite 缓存

### 线路工程表（6 张）

| 表 | 用途 |
|---|---|
| `powerline_cbm_node` | 线路 CBM 节点（F1-F4System / TOWER / WIRE / CROSS） |
| `powerline_cbm_child` | 线路 CBM 父子关系 |
| `powerline_cbm_ref` | 线路 CBM 引用（含 `normalized_ref_value` / `file_name_lower`） |
| `powerline_file_stat` | 线路文件统计 |
| `powerline_fam_property` | 线路 FAM 属性缓存 |
| `powerline_dev_property` | 线路 DEV 属性缓存 |

### 缓存校验

线路工程缓存命中条件（`validate_gim_cache`）：

- `line_parser_version` 匹配当前 `LINE_PARSER_VERSION`（当前为 `gim-line-parser-v1`）；旧库中仅有 `parser_version` 时按 v21/v22 兼容迁移
- file_size 匹配
- `line_cbm_node_count > 0` 且 `line_fam_source_count > 0`（`project_type = 'transmission_line'`）

`parser_version` 仍保留为兼容/诊断字段，但不再作为线路缓存的唯一失效依据；变电 `SUBSTATION_PARSER_VERSION` 升级不会使线路图、属性或 semantic pack 失效。

### 首次导入事务

`save_line_project_cache` 是统一事务命令：线路图（6 张表）+ FAM/DEV 属性在同一事务内写入，成功后设置 `line_parser_version = LINE_PARSER_VERSION`（当前为 `gim-line-parser-v1`），同时写入旧 `parser_version` 供兼容诊断。线路 domain 版本独立于变电 `SUBSTATION_PARSER_VERSION`，版本变更只失效对应工程域。

### 诊断键空间

`powerline_cbm_ref.refs` 是裸文件名（如 `x.fam`），`line_fam/dev_property.normalized_path` 是完整路径（如 `Cbm/x.fam`）。诊断使用 `file_name_lower` 作为统一键空间，避免 false-positive missing 报告。

---

## 9. 属性面板

线路节点属性面板使用“概览 / 参数 / 关系 / 来源”四页签展示：

- **概览**：实体类型、可读名称、分类、子节点/关键业务字段
- **WIRE 悬链线参数**：`KVALUE` / `SPLIT` / `POINT0.BLHA` / `POINT1.BLHA` / `POINT0.MATRIX0` / `POINT1.MATRIX0`
- **参数**：按“当前对象/杆塔实例/基础/导线串”及属性组展示 FAM/DEV，四类线路 MOD 解析结果；HNum 显示骨架统计，Bolt 明细采用单张表格
- **关系**：塔位按“杆塔/基础/导线/导线挂点”分组，导线节点显示端点关联状态；不在关系页铺文件引用
- **来源**：CBM/DEV/FAM/PHM/MOD/STL/WIRE/IFC 的可读按钮统一集中于此页；GUID 文件名和完整路径不直接显示
- BLHA/POINT*.BLHA 坐标按纬度、经度、高程、方位角逐行展示；来源按钮通过线路业务树定位，不要求用户阅读 GUID 文件名。
- 左侧线路工作区仅保留“模型”（地图）入口；选中杆塔后，切换属性面板“来源”页签可查看 HNum 杆塔形状预览。

---

## 10. 当前实现边界

| 边界 | 当前行为 |
|---|---|
| 底图不可用 | MapLibre/OSM 或天地图不可用时自动回退 Canvas-only；Canvas-only 绘制经纬度网格，不依赖在线瓦片。 |
| 投影 | MapLibre overlay 使用 MapLibre 当前相机投影；Canvas-only 使用 Web Mercator 兼容投影。BLHA 按样本约定作为 WGS-84 坐标，不做 GCJ-02 强转。 |
| 塔型表达 | 地图以圆形/菱形业务符号表示塔位；选中杆塔后，在属性面板“来源”页显示等比例 HNum 局部骨架预览，明确不等同完整 3D 塔型。 |
| 悬链线 | 地图可显示实验性 2D 弧垂示意；它不代表经过工程验收的张力/弧垂计算。same-point 内部连接不绘制为跨塔悬链线，交互采样与可见曲线共享。 |
| 线路 MOD/STL | 四类线路 MOD 文本格式由属性面板按需解析；来源页提供可读的 CBM/DEV/FAM/PHM/MOD/STL 定位按钮。线路不创建独立 3D Viewer。 |
| IFC | 线路工程不加载 IFC；CBM 语义、地图实体和来源关系由线路 graph/属性缓存提供。 |

---

## 11. WIRE 拓扑分类与悬链线候选字段

> 本节归纳 M4-B3 / B3A / B3B / B3C 审计 + demo-line 全量静态分析的**已证实**结论。
>
> 待决策的暂缓项见 [dev-log.md](dev-log.md) "悬链线待决策项"。
>
> 研究方法论、审计流程与决策路径见 [14-line-catenary-study.md](schema/14-line-catenary-study.md)。
>
> demo-line 全量静态分析证据（5460 WIRE / 327 TOWER）见 [schema/15-wire-catenary-evidence.md](schema/15-wire-catenary-evidence.md)。

### 11.1 WIRE 节点字段清单（已证实存在）

实际线路样本（`wireCount=5460`、`towerCount=327`、`spanGroupCount=651`）确认以下字段在 WIRE 节点的 `rawProps` 中**覆盖率 100%**：

| 字段 | 已证实事实 | 语义状态 |
|---|---|---|
| `POINT0.BLHA` | 导线起点坐标，格式 `纬度,经度,高程,方位角` | ✅ 已确认（与塔位 BLHA 格式一致） |
| `POINT1.BLHA` | 导线终点坐标，格式同上 | ✅ 已确认 |
| `KVALUE` | 数值类型，覆盖率 100%，零值占 55%，非零值 0.00025-1.34 | ✅ 已确认为参数字段；⏳ 具体公式仍待决策 |
| `SPLIT` | 取值 `1` / `4`，正整数 | ⏳ 候选（疑似分裂数，已用于样式加粗） |
| `POINT0.MATRIX0` | 16 元素 4x4 矩阵（逗号分隔），平移在 `[12][13][14]` | ✅ z=挂点高度（24-81m）、x=横担偏移（±16m）、单位米已确认；⏳ y 分量与坐标系局部性仍待核验 |
| `POINT1.MATRIX0` | 同上 | 同上 |
| `WIRETYPE` | `CONDUCTOR` / `GROUNDWIRE` / `OPGW` | ✅ 已确认（用于着色与样式） |
| `ISJUMPER` | 跳线标识 | ✅ 已确认（用于虚线样式） |
| `BACKSTRING` / `FRONTSTRING` | 端点兜底引用（塔名） | ✅ 已确认 |

### 11.2 WIRE 拓扑分类（M4-B3C 已证实）

实际样本中存在大量 `POINT0.BLHA == POINT1.BLHA` 的 WIRE 节点，证明**同一档距内存在"同点内部连接"**。M4-B3C 将档距组分为三类：

| 分类 | 判定规则 | 已证实事实 |
|---|---|---|
| `same-point` | POINT0.BLHA 归一化后等于 POINT1.BLHA | 同点内部连接候选（跳线 / 同塔内部连接），**不应直接进入悬链线渲染** |
| `inter-point` | 两端 BLHA 不同 | 真实跨点档距候选，**未来悬链线候选** |
| `missing-endpoint` | 任一端 BLHA 缺失 | 端点缺失 |

归一化规则：按逗号分割后逐段 trim 再 join（`'1, 2, 3'` → `'1,2,3'`）。

### 11.3 档距聚合结构（M4-B3B 已证实）

- 每组 WIRE 数：`min=5 / max=31 / avg≈8.39`（不固定，因转角塔/分支塔/跳线档差异）
- 多条 WIRE 共用相同 BLHA → 必须先做档距聚合才能理解"一档多线"
- spanKey 规则：`min(POINT0.BLHA, POINT1.BLHA) -> max(...)`，去方向

### 11.4 MATRIX0 格式与语义（demo-line 全量静态分析已证实）

- **格式确认**：16 元素，逗号分隔，为 4x4 矩阵（5460/5460 = 100%）
- **平移分量位置确认**：`values[12]`(x) / `values[13]`(y) / `values[14]`(z)
- **z 分量**：范围 24-81m，与塔位 FAM TOWERHEIGHT 量级吻合 → ✅ 已确认为挂点高度，单位米
- **x 分量**：范围 ±16m，符合典型横担长度 → ✅ 已确认为横担偏移，单位米
- **y 分量**：范围 ±0.3m，值很小 → ⏳ 语义未确认（疑似旋转残留或顺线方向微偏移，可忽略）
- **坐标系**：基于 BLHA=塔位中心推论，疑似为相对塔位的局部坐标系 → ⏳ 未做交叉验证
- **挂点坐标公式**：`hangPoint = towerBlha.latLng + (MATRIX0.x, MATRIX0.y)` + `towerBlha.elev + MATRIX0.z`

> 详细证据见 [schema/15-wire-catenary-evidence.md](schema/15-wire-catenary-evidence.md) §3。

### 11.5 BLHA 含义（demo-line 全量静态分析已证实）

- **已确认**：BLHA 为塔位中心坐标（非挂点坐标）
  - interPoint 档距的 652 个端点（326 档距 × 2）全部命中 TOWER BLHA（100%）
  - samePoint 档距的 325 个 BLHA 全部命中 TOWER BLHA（100%）
- **挂点偏移由 MATRIX0 平移分量提供**（见 §11.4）
- **同塔不同挂点 BLHA 相同**：samePoint group 中 `POINT0.BLHA == POINT1.BLHA`（325 组）

> 详细证据见 [schema/15-wire-catenary-evidence.md](schema/15-wire-catenary-evidence.md) §4。

### 11.6 审计工具

| 快捷键 | 用途 | 输出 |
|---|---|---|
| `Ctrl+Shift+C` | 悬链线参数审计导出 | JSON（`report` + `spanGroupingReport`）+ Markdown 摘要（§1-§11） |
| `Ctrl+Shift+D` | 数据库诊断 | JSON（工程类型 / 缓存状态 / 底图状态） |

### 11.7 决策与当前实现

- **M4 历史决策**是不实现悬链线；此后范围已经调整
- **当前地图默认绘制实验性 2D 曲线**，但它不等同于工程语义悬链线
- **same-point 与 inter-point 已分离**，后续若做悬链线需基于 inter-point
- **M5/专项决策仍未完成**：KVALUE 公式、MATRIX0 y、WIRETYPE 来源及示意/工程模式边界仍待确认

---

## 12. 当前实现摘要

### 12.1 解析、导航与属性

- 线路 CBM 按“线路 → 区段 → 耐张段 → 杆塔/档距 → 导线与跨越物”的业务顺序构建树；原始引用文件名和技术数值不占用导航节点。
- 四类线路 MOD 文本格式由 `lineModParser.ts` 分发，按需供属性面板消费；HNum 预览只表达局部骨架，来源页提供统一可读的文件定位按钮。
- 属性面板按“概览 / 参数 / 关系 / 来源”组织；坐标逐行展示，杆塔、基础、导线和导线挂点在关系页分组，文件链接集中在来源页。

### 12.2 地图与交互

- “模型”是线路唯一工作区。MapLibre overlay 与 Canvas-only 使用同一套塔位、导线、跨越物语义；OSM/天地图不可用时自动回退 Canvas-only。
- MapLibre 相机变化维护 camera revision。交互态每个 RAF 用当前相机快速绘制塔位、简化导线和跨越点，停止移动后再运行完整渐进绘制；旧 revision 的投影结果不会写入当前 Canvas。
- 地图、导航树和属性面板共享选择状态；塔位、导线和跨越物的 hover/click 使用可见几何的同一采样结果。

### 12.3 缓存、诊断与范围

- 线路 graph、FAM/DEV 属性和 semantic pack 使用独立的 `LINE_PARSER_VERSION`；缓存命中不重新解压，路径比较大小写不敏感。
- 性能诊断通过 `Ctrl+Shift+D` 输出；线路语义解析可在 Worker 中执行，结果提交受 `ProjectLoadSession` 保护。
- 线路不加载 IFC、不创建独立 3D Viewer，也不把变电 XML primitive 当作线路格式。未完成事项和下一步统一见 [dev-log.md](dev-log.md)。
