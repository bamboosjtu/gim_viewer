# M3 线路 GIM 可视化 MVP 实现说明

> 本文档记录线路 GIM 可视化 MVP 阶段的架构、数据流与设计决策。
> 对应 PARSER_VERSION: `gim-parser-v5`

## 目标

将线路 GIM 工程从"无 IFC 图形 → 无法可视化"转化为"地图化浏览"：
基于塔位坐标（BLHA）和导线路径，在 Canvas 2D 上渲染线路走线图，
支持图层控制、属性查看、树↔地图↔属性联动。

## 已完成功能

| 模块 | 说明 |
|------|------|
| 工程识别 | GIMPKGT 头部检测 + CBM 目录大小写 + 线路信号键识别 |
| GimGraph | 线路 CBM 层级树解析（F1→F2→F3→F4），支持 13 种引用键 |
| SQLite 缓存 | 6 张表：line_cbm_node / line_cbm_child / line_cbm_ref / line_file_stat / line_fam_property / line_dev_property |
| 属性缓存 | FAM/DEV 属性首次导入解析入库，二次打开从缓存恢复 |
| LineMapData | 从 GimGraph + LineAttributeIndex 提取塔位/导线/跨越点扁平数据 |
| Canvas 渲染 | 等距投影 + 塔位符号 + 导线折线 + 跨越点 + 图例 + 缩放/平移 |
| 图层开关 | 7 个图层独立控制（conductor/groundwire/opgw/unknownWire/tower/cross/label） |
| 树↔地图联动 | 点击树节点定位地图；点击地图塔位选中树行 |
| 地图统计 | 塔位/导线/跨越点计数 + FAM/DEV 未解析引用计数 |
| 日志降噪 | debug 开关控制日志输出，生产环境不刷屏 |

## 数据流

### 线路工程

```
首次打开：
  解压 GIMPKG* → detectGimProjectType → buildLineGimGraph
  → parseLineAttributes(FAM/DEV) → save_line_project_cache（统一事务）
  → restoreLineAttributesToState → renderLineProjectPanels
  → extractLineMapData → renderLineMap

二次打开（缓存命中）：
  validateGimCache → getLineGraph → restoreLineGraphToState
  → getLineAttributes → restoreLineAttributesToState
  → renderLineProjectPanels → extractLineMapData → renderLineMap
  （不读取原始 GIM、不解压、不创建 Viewer）
```

### 变电工程

```
首次打开：
  解压 GIMPKG* → detectGimProjectType → onGimExtracted
  → discoverIfcFromCBM → buildCbmTree → parseFileDevRelation
  → cacheIfcEntries → saveGimIndex → openIfcModal
  → 用户选择 IFC → loadSelectedIfcFiles → ensureEngineReady
  → loadIfcEntry → ctx.ifcLoader.load → onItemSet（scene + fragments）

二次打开（缓存命中）：
  validateGimCache → getGimIndex → restoreGimIndexToState
  → buildAndRenderCbmTree → renderFileDevPanel → openIfcModal
  （不读取原始 GIM、不解压；用户选择 IFC 后走 readCachedIfc）
```

## 设计决策

| 决策 | 原因 |
|------|------|
| 线路工程不走 IFC | 线路 GIM 无 IFC 图形文件，仅含坐标和属性 |
| Canvas 2D 为主视图 | 离线运行要求，无地图引擎依赖，MVP 快速实现 |
| FAM/DEV 属性入库 | 二次打开时 currentFiles=null，无法从内存读取属性 |
| 无真实底图 | MVP 不引入 MapLibre/Leaflet/Cesium，避免在线依赖 |
| Fragments 缓存关闭 | 实验功能，默认 ENABLE_FRAGMENTS_CACHE=false |
| IFC 异常隔离 | safeFragmentsUpdate + 逐 IFC try/catch，单 IFC 失败不阻断 |
| 统一清理服务 | cleanupBeforeOpenNewProject 统一处理线路地图销毁 + fragments dispose + UI 清空 |

## 关键文件

### 解析层（gim/）

| 文件 | 职责 |
|------|------|
| `gimExtractor.ts` | GIMPKG* 头部检测 + 7z/ZIP 解压 |
| `projectType.ts` | 工程类型识别（substation/transmission_line/hybrid/unknown） |
| `lineCbmParser.ts` | 线路 CBM 层级树解析 → GimGraph |
| `lineMapData.ts` | GimGraph → LineMapData（塔位/导线/跨越点扁平数据） |
| `lineAttributeTypes.ts` | LineAttributeIndex 类型定义（共享类型） |
| `lineFamParser.ts` | 线路 FAM 三段式扁平属性解析（中文键=ENGLISH_KEY=值） |
| `lineDevParser.ts` | DEV 属性解析 |
| `linePathNormalize.ts` | 路径归一化 + 文件名小写 |

### 渲染层（ui/）

| 文件 | 职责 |
|------|------|
| `lineMapView.ts` | Canvas 2D 地图渲染（投影/绘制/交互/图层/聚焦） |
| `lineProjectView.ts` | 线路工程面板入口（树/统计/属性/地图生命周期） |

### 服务层（services/）

| 文件 | 职责 |
|------|------|
| `openGimService.ts` | GIM 打开流程编排（识别/缓存短路/解压/渲染） |
| `lineAttrPersistenceService.ts` | FAM/DEV 属性解析 + payload 构建 |
| `lineAttrRestoreService.ts` | FAM/DEV 属性从 SQLite 恢复到 AppState |
| `lineGraphPersistenceService.ts` | GimGraph payload 构建 |
| `lineGraphRestoreService.ts` | GimGraph 从 SQLite 恢复 |
| `projectCleanupService.ts` | 统一项目切换清理 |

### 配置（config/）

| 文件 | 职责 |
|------|------|
| `debug.ts` | DEBUG 开关（import.meta.env.DEV 控制） |
| `features.ts` | 功能开关（ENABLE_FRAGMENTS_CACHE） |

## 坐标约定

- BLHA = 纬度,经度,高程,方位角（lat 在前，lng 在后）
- GeoJSON = [经度, 纬度]（lng 在前，lat 在后）
- 转换时必须显式映射，不可直接赋值

## 投影公式

等距投影（Equirectangular）：
```
worldX = (lng - centerLng) * cos(centerLatRad)
worldY = lat - centerLat
```
Y 轴向下（Canvas 坐标系），渲染时需反转 Y。
