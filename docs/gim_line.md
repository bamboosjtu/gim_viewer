# 线路 GIM 文件格式与可视化

> 输电线路工程（GIMPKGT）的文件结构、解析流程、地图渲染与树↔图联动。

---

## 1. GIM 文件容器

| 头部魔数 | 工程类型 |
|---|---|
| `GIMPKGT` | 输电线路（Transmission Line） |

与变电工程共享相同的容器格式：

- GIMPKG* 头部（变长，含项目编号和名称，零填充）
- 1MB 窗口内搜索 7z（`37 7A BC AF 27 1C`）或 ZIP（`50 4B 03 04`）签名
- libarchive.js（WebAssembly）解压

### 目录命名差异

| 工程 | 目录命名 |
|---|---|
| 变电（GIMPKGS） | 小写：`CBM/` `DEV/` `PHM/` `MOD/` |
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

`src/gim/lineRefKind.ts` 定义 10 种引用类型：

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

`src/gim/lineMapData.ts` 的 `extractLineMapData(graph, attrs)` 将 GIM 图转为扁平地图数据：

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
| `line_cbm_node` | 线路 CBM 节点（F1-F4System / TOWER / WIRE / CROSS） |
| `line_cbm_child` | 线路 CBM 父子关系 |
| `line_cbm_ref` | 线路 CBM 引用（含 `normalized_ref_value` / `file_name_lower`） |
| `line_file_stat` | 线路文件统计 |
| `line_fam_property` | 线路 FAM 属性缓存 |
| `line_dev_property` | 线路 DEV 属性缓存 |

### 缓存校验

线路工程缓存命中条件（`validate_gim_cache`）：

- parser_version 匹配
- file_size 匹配
- `line_cbm_node_count > 0` 且 `line_fam_source_count > 0`（`project_type = 'transmission_line'`）

### 首次导入事务

`save_line_project_cache` 是统一事务命令：线路图（6 张表）+ FAM/DEV 属性在同一事务内写入，成功后设置 `parser_version = 'gim-parser-v5'`。

### 诊断键空间

`line_cbm_ref.refs` 是裸文件名（如 `x.fam`），`line_fam/dev_property.normalized_path` 是完整路径（如 `Cbm/x.fam`）。诊断使用 `file_name_lower` 作为统一键空间，避免 false-positive missing 报告。

---

## 9. 属性面板

线路节点属性面板展示：

- **基本信息**：路径、文件名、实体类型、分类名称、子节点数
- **WIRE 悬链线参数**：`KVALUE` / `SPLIT` / `POINT0.BLHA` / `POINT1.BLHA` / `POINT0.MATRIX0` / `POINT1.MATRIX0`
- **原始属性**：rawProps（排除已突出显示字段）
- **变换矩阵**：TRANSFORMMATRIX（非单位矩阵时显示）
- **引用清单**：CBM/DEV/FAM/PHM/MOD/STL/WIRE/IFC 引用 + 挂点/原始引用

---

## 10. MVP 阶段限制

| 限制 | 说明 |
|---|---|
| 无真实底图（Canvas-only 时） | Canvas 2D 绘制经纬度网格，无卫星图/地形图 |
| 简化投影 | Canvas 等距投影，高纬度有畸变（overlay 模式用 MapLibre 投影） |
| 无坐标偏移修正 | 直接使用 BLHA 原始坐标，未做 GCJ-02/WGS-84 转换 |
| 非真实塔型 | 圆形/菱形符号，非 3D 模型 |
| 折线渲染 | 两塔之间直线连接，非悬链线弧垂 |
| 无 MOD 解析 | 未解析 .mod 几何文件 |
| 无 3D 线路 | 不创建 Viewer，不做 3D 渲染 |
| 无 IFC | 线路工程不加载 IFC 文件 |
