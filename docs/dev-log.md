# 开发者日志

> 已知问题、技术债务、关键决策、日志与诊断工具。

---

## 1. 已知限制

### 地图渲染

| 限制 | 说明 |
|---|---|
| Canvas 简化投影 | 等距投影（Equirectangular），高纬度地区有畸变（overlay 模式由 MapLibre 投影替代） |
| 无坐标偏移修正 | 直接使用 BLHA 原始坐标，未做 GCJ-02/WGS-84 转换 |
| OSM 依赖网络 | MVP 主底图为 OpenStreetMap 在线瓦片，离线时自动回退 Canvas-only |

### 塔位

| 限制 | 说明 |
|---|---|
| 非真实模型 | 圆形/菱形符号，非真实塔型 3D 模型 |
| 无 MOD 解析 | 未解析 .mod 几何文件 |
| 塔型分类有限 | 仅区分直线塔（圆形）和耐张塔（菱形） |

### 导线

| 限制 | 说明 |
|---|---|
| 折线渲染 | 两塔之间直线连接，非真实弧垂 |
| 无悬链线 | 未使用 KVALUE/SPLIT 参数计算导线弧垂曲线（决策见 §8.4） |
| 档距为近似值 | M4-B2 档距由经纬度 Haversine 反算，未考虑高程差，与真实档距存在偏差 |
| KVALUE 公式未确认 | KVALUE 已确认为参数字段（见 [schema/15-wire-catenary-evidence.md](schema/15-wire-catenary-evidence.md) §2），但具体物理含义与公式仍待决策（见 §8.1） |

### 跨越点

| 限制 | 说明 |
|---|---|
| 部分无坐标 | 部分 CROSS 节点无 BLHA 坐标，无法在地图定位 |
| 无跨越物类型 | 未区分跨越对象（电力线/通信线/道路/河流等） |

### IFC（变电工程）

| 限制 | 说明 |
|---|---|
| 无 Fragments 缓存 | 每次重新解析 IFC，加载较慢（`ENABLE_FRAGMENTS_CACHE=false`） |
| 模型可能不完整 | web-ifc 解析部分 IFC 可能丢失构件（OBC 已知限制） |
| Fragments 异常 | "Malformed tile" 被 catch 不阻断，但该 IFC 可能显示不全 |

### 缓存

| 限制 | 说明 |
|---|---|
| 版本变化失效 | PARSER_VERSION 变更时所有旧缓存自动失效 |
| 首次导入较慢 | 大型线路工程 FAM/DEV 属性解析 + 入库可能耗时数秒 |

### 其他

| 限制 | 说明 |
|---|---|
| 单工程模式 | 同时只能打开一个 GIM 工程 |
| 无搜索功能 | 不支持按塔位编号/设备名称搜索定位 |
| 无导出功能 | 不支持导出地图截图/属性表格 |

---

## 2. 技术债务

### Fragments 缓存（休眠）

`ENABLE_FRAGMENTS_CACHE=false`，以下代码路径休眠但保留：

- `src/desktop/database.ts`：`writeFragmentCacheFile` / `readFragmentCacheFile` / `upsertFragmentCacheRecord` / `getFragmentCacheRecord` / `validateFragmentCache`
- `src/viewer/ifcEntryLoader.ts`：`tryLoadFromFragmentsCache` / `tryWriteFragmentsCache`

### PMTiles 离线瓦片（休眠）

`ENABLE_PMTILES_EXPERIMENT=false`，以下代码路径休眠但保留：

- `src/ui/lineMapStyle.ts`：`createPmtilesLineMapStyle()`
- `src/ui/lineMapPmtiles.ts`：`setupPmtilesProtocol()`
- `src/config/features.ts`：`PMTILES_DEMO_URL = '/tiles/demo.pmtiles'`

### 未使用的导出

M4-B3C 收口后已无未使用的导出。此前列出的 6 个符号（`findArchiveOffset` / `flattenExtractedFiles` / `isDebugOverrideEnabled` / `getWebIfcWasmBaseUrl` / `getWebIfcWasmUrl` / `buildLineGraphTopoIndex`）经核查**本就不是 `export`**，属于文档误判，已修正。

M4-B3C 清理：
- 删除 `lineGeometryAuditService.ts` 中未使用的 M4-B1 `buildLineGeometryAuditReport` + 5 接口 + 10 内部辅助 + 4 常量（完全死代码，被 M4-B3 `buildLineCatenaryParamAuditReport` 取代）
- `lineSpanGroupingAuditService.ts` 中 `parseMatrixTranslation` 降级为模块私有（去除 `export`）

---

## 3. 关键决策

### MVP 地图路线

- **主底图**：OpenStreetMap online（`LINE_BASEMAP_MODE = 'osm-online'`）
- **失败兜底**：Canvas-only（3 次 tile error → `onBasemapUnavailable` → 回退）
- **暂不做**：离线瓦片、天地图、高德、思极、GCJ-02、悬链线、MOD 解析、真实 3D 线路

### 工程类型检测

通过 `.ifc` 文件存在性 + 线路专属字段（`ENTITYNAME`/`GROUPTYPE`/`DEVICETYPE` **键值级匹配**，非子串检查）区分变电与线路工程。

### 线路目录命名

线路工程使用 PascalCase（`Cbm/`/`Dev/`/`Mod/`/`Phm/`），解析器通过 `lowerFileName()` 兼容大小写。

### 诊断键空间

`line_cbm_ref.refs` 是裸文件名（`x.fam`），`line_fam/dev_property.normalized_path` 是完整路径（`Cbm/x.fam`）。诊断使用 `file_name_lower` 作为统一键空间，避免 false-positive missing 报告。

### MapLibre attributionControl

MapLibre 的 `attributionControl` 类型为 `false | AttributionControlOptions`，不接受 `true`。OSM 模式传 `{ compact: false }` 始终展开 attribution。

### OSM error listener 生命周期

OSM 模式下 `onLoad` 不移除 error listener（需持续监听 load 后的 tile error），`destroy()` 时显式 `map.off`。

---

## 4. 日志系统

### 日志分类

`src/config/debug.ts` 定义 5 个分类：`runtime` / `ifc` / `gim-cache` / `line-map` / `fragments`。

### 默认行为

| 模式 | debug 日志 | console.error | 关键 warning |
|---|---|---|---|
| 开发（`npm run dev` / `tauri:dev`） | ✅ 全部开启 | ✅ 始终输出 | ✅ 始终输出 |
| 生产（`npm run build` / `tauri:build`） | ❌ 全部关闭 | ✅ 始终输出 | ✅ 始终输出 |

**始终输出的 warning**（不受 debug 开关控制）：IFC 缓存字节为空、IFC 文件头非 ISO- 前缀、Fragments 缓存校验失败、payload 过大、缓存恢复失败回退完整解压。

### localStorage override（生产排障）

```js
// 开启指定分类
localStorage.setItem('GIM_DEBUG', '1')
localStorage.setItem('GIM_DEBUG_CATEGORIES', 'ifc,fragments')
location.reload()

// 关闭
localStorage.removeItem('GIM_DEBUG')
localStorage.removeItem('GIM_DEBUG_CATEGORIES')
location.reload()
```

### logger API

```ts
import { debugLog, debugWarn, debugError } from '../utils/logger.js';
import { DEBUG_IFC_LOAD, DEBUG_FRAGMENTS } from '../config/debug.js';

debugLog(DEBUG_IFC_LOAD, '[IFC Engine] init start', { href });
debugWarn(DEBUG_FRAGMENTS, '[Fragments] update failed', err);
debugError(DEBUG_FRAGMENTS, '[Fragments] full stack trace', err);
```

| 场景 | 使用 |
|---|---|
| 正常调试信息 | `debugLog(DEBUG_*, ...)` |
| 可恢复异常详情 | `debugWarn(DEBUG_*, ...)` |
| 需要完整堆栈的 debug 级错误 | `debugError(DEBUG_*, ...)` |
| 致命错误 | `console.error(...)` |
| 缓存损坏 | `console.warn(...)` |

---

## 5. 诊断工具

### 快捷键

| 快捷键 | 用途 | 触发条件 |
|---|---|---|
| `Ctrl+Shift+D` | 数据库诊断 JSON（工程类型 / 缓存状态 / 底图状态） | 任意工程 |
| `Ctrl+Shift+C` | 线路悬链线参数审计 JSON + Markdown 摘要 | 仅线路工程成功渲染后；变电 / 清空场景提示无数据 |

两个快捷键独立工作，互不影响。Ctrl+Shift+C 若与系统冲突可改为 Ctrl+Alt+C（需同步更新 `src/app/bootstrap.ts` 与本文档）。

### 诊断 JSON 结构（Ctrl+Shift+D）

```json
{
  "dbPath": "/path/to/gim_viewer.db",
  "diagnostic": {
    "project_type": "transmission_line",
    "parser_version": "gim-parser-v13",
    "line_cbm_node_count": 1234,
    "ifc_models_count": 0
  },
  "debug": { "dev": false, "gimDebug": "1", "categories": ["ifc", "fragments"], ... },
  "basemap": {
    "status": "osm-online",
    "mode": "osm-online",
    "maplibreEnabled": true,
    "tileErrorCount": 0,
    "updatedAt": "2026-06-27T08:00:00.000Z"
  }
}
```

### `basemap.status` 枚举

由 `src/services/basemapStatusService.ts` 维护：

| `status` 值 | 触发场景 |
|---|---|
| `canvas-only` | 初始 / 未启用 MapLibre / MapLibre 初始化失败 |
| `osm-online` | MapLibre + OSM 在线 raster 加载成功 |
| `osm-unavailable-fallback` | OSM 累计 3 次 tile error 触发回退 |
| `empty` | `LINE_BASEMAP_MODE='empty'`（保留枚举，MVP 不使用） |
| `pmtiles` | `LINE_BASEMAP_MODE='pmtiles'（保留枚举，MVP 不使用） |

`fallbackReason` 仅在 `osm-unavailable-fallback` 状态下有值。

### Ctrl+Shift+C 审计 payload

包含 `generatedAt` + `parserVersion` + `projectSummary` + `LineCatenaryParamAuditReport`（覆盖率 + 4 类样本）+ `spanGroupingReport`（档距聚合 + 拓扑分类）。

- 详细字段说明见 [schema/14-line-catenary-study.md](schema/14-line-catenary-study.md) §4 审计服务 API + §5 用户核验流程
- 静态分析全量基线对照见 [schema/15-wire-catenary-evidence.md](schema/15-wire-catenary-evidence.md) §1.2
- OSM fallback 兼容：fallback 后仍可调用，payload 在 `renderLineProjectPanels` 阶段已构建，与底图模式无关
- 向后兼容：`spanGroupingReport` 为可选字段，旧 payload 无此字段时调用方需判空

### 生产排障流程

1. 按 `Ctrl+Shift+D`，检查 `debug` + `basemap` 字段确认日志开关与底图状态
2. 如需详细日志，在 DevTools Console 执行 localStorage 设置 + reload
3. 复现问题，收集 Console 日志 + 诊断 JSON
4. 排障完成后关闭 debug

---

## 6. OSM MVP 边界约束

> M4-A2 OSM MVP Finalization 已验收通过（OSM 可用主路径 + OSM 不可用 fallback 路径），以下为固化边界。
>
> OSM 渲染流程详见 [gim_line.md](gim_line.md) §5 地图渲染。

- **不新增底图能力**：不做 PMTiles / MBTiles / 本地 tile server / 离线瓦片 / 天地图 / 高德 / 思极 / GCJ-02
- **不修改变电 IFC**：本阶段仅触及线路地图层，变电工程路径完全不受影响
- **不修改 SQLite schema**：basemap status 为内存状态，不持久化
- **不开启 Fragments 缓存**：`ENABLE_FRAGMENTS_CACHE=false` 保持不变
- **OSM 仅在线**：不做瓦片下载 / 缓存 / 预取
- **错误阈值**：3 次 tile error 才触发回退，单次错误不回退（网络抖动容忍）
- **error listener 持续监听**：OSM 模式下 `onLoad` 不移除 listener，确保 load 后的 tile error 仍计数

---

## 7. 缓存管理

### Tauri commands

| command | 说明 |
|---|---|
| `list_cached_projects` | 返回项目列表（按 last_opened_at DESC） |
| `delete_project_cache` | 事务删除 13 张表 + 磁盘目录 |
| `get_project_diagnostic` | 返回单个项目完整诊断 |

### 删除策略

- DB：事务删除 13 张索引表 + gim_project 记录
- 磁盘：best-effort 删除 `app_data_dir/extracted/{id}/` 和 `fragments/{id}/`
- 按 project_id 精确删除，不影响其他项目
- 删除当前查看工程时视图不立即关闭，重新打开该 GIM 会重新解压重建

---

## 8. M4 悬链线暂缓项

> M4-B3 / B3A / B3B / B3C 审计 + demo-line 全量静态分析已完成，大部分字段语义已确认。
>
> - **已确认结论**（KVALUE 为参数字段、MATRIX0 z=挂点高度/x=横担偏移/单位米、BLHA=塔位中心、挂点坐标公式）见 [schema/15-wire-catenary-evidence.md](schema/15-wire-catenary-evidence.md) §8 汇总
> - **已证实事实**见 [gim_line.md](gim_line.md) §11 WIRE 拓扑分类与悬链线候选字段
> - **研究方法论与审计服务 API** 见 [schema/14-line-catenary-study.md](schema/14-line-catenary-study.md)
>
> 以下为仍待决策的真正未决项。

### 8.1 KVALUE 物理含义与公式（待决策）

- **已确认**：数值类型参数字段，覆盖率 100%，零值占 55%，非零值 0.00025-1.34
- **仍待决策**：
  - 具体物理含义：弧垂系数 / 张力系数 / 应力参数（候选范围）
  - 单位与公式：抛物线近似 `f(x)=k*x*(L-x)` 还是悬链线 `cosh` 形式
  - KVALUE=0 的精确语义：未启用 / 跳线 / 直线塔（需按 ISJUMPER + 塔型交叉核验）
- **阻塞原因**：GIM 标准文档无明确字段定义
- **核验路径**：对照样本工程导线型号表 + 标准弧垂表反推
- **影响**：未确认前不进入"工程语义悬链线"实现（"示意悬链线"可基于经验参数绕过此项）

### 8.2 MATRIX0 y 分量与坐标系局部性（待核验）

- **已确认**：100% 为 4x4 矩阵，z=挂点高度（24-81m）、x=横担偏移（±16m）、单位米
- **仍待核验**：
  - y 分量语义：值很小（±0.3m），疑似旋转残留或顺线方向微偏移，未完全确认
  - 坐标系局部性：基于 BLHA=塔位中心的推论疑似局部坐标系，但未做"同塔不同档距的 x/y 方向一致性"交叉验证
- **核验路径**：
  - 收集同塔多挂点样本，验证 x 分量符号对称性（左挂点 x<0，右挂点 x>0）
  - 对比同塔不同 wireType（CONDUCTOR vs OPGW）的 z 分量分层
- **影响**：y 分量值很小，对挂点坐标计算影响可忽略；坐标系局部性影响多塔坐标拼接

### 8.3 WIRETYPE 字段缺失（待核验）

- **现状**：demo-line 中 5460 个 WIRE 节点的 WIRETYPE 全部为 UNKNOWN
- **根因**：CBM 文件中 WIRE 节点可能不包含 WIRETYPE 字段，或字段名不同
- **影响**：无法按 CONDUCTOR / GROUNDWIRE / OPGW 分组分析 KVALUE / MATRIX0 分层差异
- **核验路径**：检查 DEV/FAM 文件中的导线类型字段，或对照 demo-line1 样本

### 8.4 悬链线实现决策（后置到 M5）

- **决策**：M4 不实现悬链线，地图保持直线段显示
- **数据可行性已确认**（见 [schema/15-wire-catenary-evidence.md](schema/15-wire-catenary-evidence.md) §6.1）：
  - BLHA=塔位中心 ✅
  - MATRIX0=挂点偏移 ✅
  - 挂点坐标可计算 ✅
  - interPoint 档距可识别 ✅
  - KVALUE 为非零小参数（符合弧垂系数特征）✅
- **仍待决策**：
  - 是否实现悬链线（业务需求驱动）
  - 使用何种公式（依赖 §8.1 KVALUE 公式确认）
- **后续路线**（详见 [schema/14-line-catenary-study.md](schema/14-line-catenary-study.md) §6.5 后续可能路线）：
  - M5-A：真实跨点档距识别（基于 inter-point）— 前置已解除
  - M5-B：MATRIX0 挂点坐标确认 — 部分已确认（z/x/单位已确认，y/坐标系待核验）
  - M5-C：KVALUE 物理含义确认 — 仍阻塞
  - M5-D：示意悬链线 feature flag — 可基于经验参数绕过 M5-C
  - M5-E：工程语义悬链线 — 需 M5-A/B/C 全部完成

### 8.5 审计代码保留

以下审计服务代码保留（纯内存、不影响渲染），作为后续研究工具：

| 文件 | 用途 |
|---|---|
| `src/services/lineGeometryAuditService.ts` | M4-B3 悬链线参数覆盖率 + 4 类样本 |
| `src/services/lineSpanGroupingAuditService.ts` | M4-B3B/B3C 档距聚合 + 拓扑分类 |
| `src/services/lineCatenaryAuditExportService.ts` | M4-B3A Ctrl+Shift+C 导出 payload + Markdown |
| `src/services/lineWireSemanticService.ts` | M4-B2 导线语义信息（档距计算等） |
