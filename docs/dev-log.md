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
| 无悬链线 | 未使用 KVALUE/SPLIT 参数计算导线弧垂曲线 |

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

以下内部函数被 `export` 但仅在定义文件内使用（可降级为非导出）：

| 函数 | 文件 |
|---|---|
| `findArchiveOffset` | `src/gim/gimExtractor.ts` |
| `flattenExtractedFiles` | `src/gim/gimExtractor.ts` |
| `isDebugOverrideEnabled` | `src/config/debug.ts` |
| `getWebIfcWasmBaseUrl` | `src/viewer/wasmAssets.ts` |
| `getWebIfcWasmUrl` | `src/viewer/wasmAssets.ts` |
| `buildLineGraphTopoIndex` | `src/gim/lineMapData.ts` |

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

`src/config/debug.ts` 定义 5 个分类：

| 分类标识 | 常量 | 覆盖范围 |
|---|---|---|
| `runtime` | `DEBUG_RUNTIME_LOGS` | 工程类型识别、cleanup 统计、线路图构建 |
| `ifc` | `DEBUG_IFC_LOAD` | IFC Engine 初始化、IFC Loader 校验、WASM 路径、高亮、名称索引 |
| `gim-cache` | `DEBUG_GIM_CACHE` | GIM 索引读写、缓存校验/恢复、FAM/DEV 属性持久化 |
| `line-map` | `DEBUG_LINE_MAP` | Canvas 地图渲染、图层开关、focus 定位、MapLibre overlay |
| `fragments` | `DEBUG_FRAGMENTS` | Fragments update 异常详情、unhandledrejection |

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

// 开启全部分类
localStorage.setItem('GIM_DEBUG', '1')
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

### Ctrl+Shift+D

Tauri 桌面模式下按 `Ctrl+Shift+D`，将诊断 JSON 复制到剪贴板，控制台额外输出可读摘要。

### JSON 结构

```json
{
  "dbPath": "/path/to/gim_viewer.db",
  "diagnostic": {
    "project_type": "transmission_line",
    "parser_version": "gim-parser-v5",
    "line_cbm_node_count": 1234,
    "ifc_models_count": 0
  },
  "debug": {
    "dev": false,
    "gimDebug": "1",
    "categories": ["ifc", "fragments"],
    "runtime": false,
    "ifc": true,
    "gimCache": false,
    "lineMap": false,
    "fragments": true
  }
}
```

### 诊断摘要

`src/services/diagnosticSummaryService.ts` 的 `summarizeDiagnostic(payload)` 输出 Markdown 风格文本：

- 线路工程：工程类型 / 缓存状态 / parser_version / 线路节点 / FAM/DEV 源 / 缺失数 / 建议
- 变电工程：工程类型 / 缓存状态 / parser_version / IFC entries / cached IFC / missing cache / 建议

### 生产排障流程

1. 按 `Ctrl+Shift+D`，检查 `debug` 字段确认日志开关状态
2. 如需详细日志，在 DevTools Console 执行 localStorage 设置 + reload
3. 复现问题，收集 Console 日志 + 诊断 JSON
4. 排障完成后关闭 debug

---

## 6. 缓存管理

### 缓存管理 UI

左侧栏"缓存管理"按钮 → modal 展示：

- 数据库路径
- 项目列表（按 last_opened_at DESC 排序）
- 复制诊断 JSON / 复制摘要 / 删除缓存按钮

### 删除策略

- DB：事务删除 13 张索引表 + gim_project 记录
- 磁盘：best-effort 删除 `app_data_dir/extracted/{id}/` 和 `fragments/{id}/`
- 按 project_id 精确删除，不影响其他项目
- 删除当前查看工程时视图不立即关闭，重新打开该 GIM 会重新解压重建

### Tauri commands

| command | 说明 |
|---|---|
| `list_cached_projects` | 返回项目列表（按 last_opened_at DESC） |
| `delete_project_cache` | 事务删除 13 张表 + 磁盘目录 |
| `get_project_diagnostic` | 返回单个项目完整诊断 |
