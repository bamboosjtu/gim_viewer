# M4 Sprint 1 总结

> 阶段：M4 Sprint 1（工程化收口 + MapLibre 技术验证）
> 时间：2026-06-26
> 前置：M3 线路 GIM 可视化 MVP + M3-Final 稳定化 + M4-D1 日志与诊断开端

---

## 1. 本轮目标

1. 增加缓存管理能力（M4-D2 最小可用版）
2. 增强诊断信息可读性（M4-D1 延伸）
3. 做 MapLibre 技术验证模块，但默认关闭（M4-A1）
4. 保持现有 Canvas 线路地图为默认主流程
5. 不破坏变电 IFC 流程

**边界**：本轮是 M4 Sprint 1，不是完整 M4。不实现 MapLibre 正式底图、PMTiles、坐标偏移、悬链线、MOD 解析、真实 3D 线路。

---

## 2. 已完成

### 2.1 缓存管理 UI（M4-D2）

**Rust 侧新增 3 个 Tauri command**（`src-tauri/src/db.rs`）：

| command | 说明 |
|---|---|
| `list_cached_projects` | 返回 `Vec<CachedProjectSummary>`（id/name/path/project_type/parser_version/size/modified_ms/updated_at_ms），按 last_opened_at DESC 排序 |
| `delete_project_cache` | 事务删除 13 张索引表 + gim_project 记录；best-effort 删除磁盘 `extracted/{id}/` 和 `fragments/{id}/` 目录 |
| `get_project_diagnostic` | 复用内部 `get_project_cache_diagnostic`，返回单个项目的完整诊断 |

注册在 `src-tauri/src/lib.rs` 的 `invoke_handler`。

**前端新增**：

- `src/desktop/database.ts`：新增 `CachedProjectSummary` 接口 + `listCachedProjects()` / `deleteProjectCache()` / `getProjectDiagnostic()` 包装
- `src/ui/cacheManagerView.ts`：缓存管理 modal（数据库路径 + 项目列表 + 复制诊断 JSON / 复制摘要 / 删除缓存按钮）
- `index.html` + `src/ui/dom.ts`：新增"缓存管理"按钮
- `src/app/bootstrap.ts`：绑定按钮点击 → `openCacheManager()`（Tauri 模式 guard）

**删除策略**：

- DB：事务删除 13 张表（gim_entry, cbm_node, ifc_model, file_dev_entry, fam_property, dev_property, line_cbm_node, line_cbm_child, line_cbm_ref, line_file_stat, line_fam_property, line_dev_property, fragment_cache）+ gim_project 记录
- 磁盘：best-effort 删除 `app_data_dir/extracted/{id}/` 和 `app_data_dir/fragments/{id}/`，失败仅警告不回滚
- 不影响其他项目（按 project_id 精确删除）

### 2.2 诊断信息增强（M4-D1 延伸）

**新增**：

- `src/services/diagnosticSummaryService.ts`：`summarizeDiagnostic(payload)` 将 `ProjectCacheDiagnostic` 转为人类可读的 Markdown 风格文本
  - 线路工程：工程类型 / 缓存状态 / parser_version / 线路节点 / FAM/DEV 源 / 缺失数 / 建议
  - 变电工程：工程类型 / 缓存状态 / parser_version / IFC entries / cached IFC / missing cache / 建议

**Ctrl+Shift+D 增强**（`src/app/bootstrap.ts`）：

- 仍复制完整 JSON 到剪贴板（dbPath + diagnostic + debug）
- 控制台额外输出 `[诊断摘要]` 可读摘要
- loading 提示仍简短

**诊断摘要示例（线路工程）**：

```text
工程类型：transmission_line
缓存状态：valid=true
parser_version：gim-parser-v5 / gim-parser-v5
线路节点：27829
线路子节点：5460
线路引用：21967
FAM 源：21967
DEV 源：4345
FAM 属性：219670
DEV 属性：43450
缺失 FAM：0
缺失 DEV：0
建议：缓存健康
```

**诊断摘要示例（变电工程）**：

```text
工程类型：substation
缓存状态：valid=true
parser_version：gim-parser-v5 / gim-parser-v5
IFC entries：12
cached IFC：12
missing cache：0
建议：缓存健康，可直接选择 IFC 加载
```

### 2.3 MapLibre 技术验证（M4-A1，默认关闭）

**依赖**：

- `npm install maplibre-gl`（~1.2 MB）
- 不引入 PMTiles、MBTiles、coordtransform

**Feature flag**（`src/config/features.ts`）：

```ts
export const ENABLE_MAPLIBRE_EXPERIMENT = false; // 默认必须为 false
```

**Probe 模块**（`src/ui/lineMapBaseLayer.ts`）：

```ts
export interface LineMapBaseLayerHandle {
  destroy(): void;
  getMap(): MapLibreMap | null;
}
export async function createMapLibreProbe(container: HTMLElement): Promise<LineMapBaseLayerHandle>;
```

- 使用本地空 style（`{ version: 8, sources: {}, layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#f8fafc' } }] }`）
- 不加载在线瓦片，不访问外网
- 等待 `load` 事件后 resolve（证明 WebGL 上下文可用）
- `destroy()` 调用 `map.remove()` + 清空挂载 div

**集成**（`src/ui/lineProjectView.ts`）：

- Canvas 地图渲染后，若 `ENABLE_MAPLIBRE_EXPERIMENT=true`，异步创建 probe
- probe 失败仅 `debugWarn`，不抛异常，不影响 Canvas 主流程
- `destroyLineMapView()` 同时销毁 Canvas handle 和 probe handle

**CSP 兼容性**：

当前 CSP 已兼容，无需修改：
- `worker-src 'self' blob:` → MapLibre blob worker 允许
- `style-src 'self' 'unsafe-inline'` → MapLibre 控件内联样式允许
- empty style 无网络请求，`connect-src` 无影响

详见 [地图底图评估 - M4-A1 技术验证结果](map-basemap-evaluation.md#13-m4-a1-技术验证结果)。

### 2.4 文档更新

- `docs/m4-roadmap.md`：M4-D1 标记"已启动/部分完成"，M4-D2 标记"最小可用版已完成"，M4-A1 标记"技术验证中"
- `docs/map-basemap-evaluation.md`：新增第 13 节"M4-A1 技术验证结果"
- `docs/m4-sprint1-summary.md`：本文档

---

## 3. 未完成（明确留给后续）

| 项 | 留给 | 原因 |
|---|---|---|
| MapLibre Canvas overlay 对接（`map.project()` 桥接） | M4-A2 | 本轮仅验证初始化/销毁，不改 Canvas 主流程 |
| PMTiles / MBTiles 离线瓦片 | M4-A2+ | 本轮禁止引入离线瓦片大包 |
| 坐标偏移（WGS84 ↔ GCJ-02） | M4-A2+ | 需要 `coordtransform`，本轮不引入 |
| Fragments 缓存灰度（ENABLE_FRAGMENTS_CACHE=true） | 后续 | 本轮禁止开启 Fragments 缓存 |
| 缓存迁移工具（PARSER_VERSION 变更时自动迁移） | 后续 | 当前策略是版本不匹配即重建，够用 |
| 日志文件持久化（app_data_dir/logs/） | 后续 | 当前 console + localStorage override 够用 |
| 悬链线渲染 | M4-B | 本轮禁止 |
| MOD 解析 | M4-C | 本轮禁止 |
| 真实 3D 线路 | 后续 | 本轮禁止 |

---

## 4. 如何验证

### 4.1 构建

```bash
npm run build
cargo check --manifest-path src-tauri/Cargo.toml
```

### 4.2 线路主流程（demo-line.gim）

1. 打开 demo-line.gim → Canvas 地图正常渲染
2. 图层开关正常
3. 树↔地图联动正常
4. Ctrl+Shift+D → 剪贴板复制 JSON + console 输出可读摘要

### 4.3 变电主流程（demo-substation.gim）

1. 打开 demo-substation.gim → IFC 选择框正常
2. 选择 IFC → 几何显示正常
3. Fragments warning 不红屏（unhandledrejection 仍被 preventDefault）
4. Ctrl+Shift+D → 摘要显示 substation 缓存状态

### 4.4 缓存管理

1. 点击左侧栏"缓存管理"按钮 → modal 打开
2. 能看到 demo-line 和 demo-substation 缓存记录
3. 点击"复制诊断 JSON" → 剪贴板 + console 摘要
4. 点击"复制摘要" → 剪贴板纯文本摘要
5. 点击"删除缓存" → confirm 后删除 → 重新打开该 GIM 会重新解压和重建
6. 不误删其他项目

### 4.5 MapLibre probe

1. 默认 `ENABLE_MAPLIBRE_EXPERIMENT=false` → 打开 demo-line 行为完全不变
2. 手动改为 `true` → 打开 demo-line → Canvas 地图正常 + console 输出 `[MapLibre probe] 技术验证：probe 初始化成功`
3. 不访问外网（empty style 无网络请求）
4. 无 CSP 报错
5. 切换工程 / 清空场景 → probe 正常销毁

---

## 5. 修改文件列表

### Rust 侧

| 文件 | 变更 |
|---|---|
| `src-tauri/src/db.rs` | 新增 `CachedProjectSummary` struct + `list_cached_projects` / `delete_project_cache` / `get_project_diagnostic` 3 个 command |
| `src-tauri/src/lib.rs` | `invoke_handler` 注册 3 个新 command |

### 前端

| 文件 | 变更 |
|---|---|
| `src/config/features.ts` | 新增 `ENABLE_MAPLIBRE_EXPERIMENT = false` |
| `src/desktop/database.ts` | 新增 `CachedProjectSummary` 接口 + 3 个 invoke 包装 |
| `src/services/diagnosticSummaryService.ts` | **新建**：`summarizeDiagnostic(payload)` |
| `src/ui/cacheManagerView.ts` | **新建**：缓存管理 modal |
| `src/ui/lineMapBaseLayer.ts` | **新建**：MapLibre probe 模块 |
| `src/ui/lineProjectView.ts` | 新增 probe handle + 生命周期集成 |
| `src/ui/dom.ts` | 新增 `btnCacheManager` export |
| `src/app/bootstrap.ts` | 绑定缓存管理按钮 + Ctrl+Shift+D 增强摘要输出 |
| `index.html` | 新增"缓存管理"按钮 |

### 文档

| 文件 | 变更 |
|---|---|
| `docs/m4-roadmap.md` | 更新 M4-D1/D2/A1 状态标记 |
| `docs/map-basemap-evaluation.md` | 新增第 13 节 M4-A1 技术验证结果 |
| `docs/m4-sprint1-summary.md` | **新建**：本文档 |

### 依赖

| 包 | 版本 | 说明 |
|---|---|---|
| `maplibre-gl` | latest | MapLibre 技术验证（默认关闭，动态 import） |

---

## 6. 下一步建议

本轮完成后评审，下一步可进入：

1. **M4-D2 缓存管理增强**：Fragments 缓存灰度、缓存迁移工具、缓存大小统计
2. **M4-A2 Canvas overlay 接入**：在 probe 基础上加载 PMTiles source，Canvas overlay 改用 `map.project()`
3. **M4-B1 WIRE 参数预研**：解析 KVALUE / SPLIT / MATRIX0，为悬链线计算做准备

建议优先级：M4-D2 增强 < M4-A2 < M4-B1（视实际需求）。

---

## 7. M4 Sprint 1 Patch + M4-A2-lite（2026-06-26）

### 7.1 修复项

#### 7.1.1 MapLibre z-index 遮挡问题

**问题**：M4 Sprint 1 中 MapLibre mount div 使用 `z-index:1`，而 Canvas 未设置层级，可能被遮挡。

**修复**：

| 层 | z-index | 元素 |
|---|---|---|
| 底图 | 0 | MapLibre mount div |
| overlay | 2 | Canvas |
| 控件 | 20 | tooltip / fit 按钮 / 图层面板 |

详见 [地图底图评估 - 第 14.2 节](map-basemap-evaluation.md#142-z-index-层级修复)。

#### 7.1.2 缓存删除提示优化

`src/ui/cacheManagerView.ts` 删除确认提示新增：

> 注意：如果删除的是当前正在查看的工程，当前视图不会立即关闭；重新打开该 GIM 时会重新解压并重建缓存。

### 7.2 M4-A2-lite：底图容器与 Canvas overlay 桥接

在 feature flag 下实现 MapLibre 底图 + Canvas overlay 最小验证：

| 模块 | 变更 |
|---|---|
| `src/ui/lineMapProjection.ts` | **新建**：`LineMapProjection` 接口 + `createMapLibreProjection` / `createCanvasProjection` |
| `src/ui/lineMapBaseLayer.ts` | Handle 新增 `project()` / `onViewChange()` / `fitBounds()`，`interactive: true`，`initialBounds` 支持 |
| `src/ui/lineMapView.ts` | 新增 `RenderLineMapOptions`（projection + onRequestRedraw），overlay 模式透明背景 + 委托投影 |
| `src/ui/lineProjectView.ts` | flag=true 时异步创建 probe → 构建投影 → Canvas overlay 重渲染 → onViewChange 重绘 |

**关键设计**：

- Canvas 先渲染（确保地图立即可见），MapLibre 异步加载成功后切换为 overlay 模式
- 失败时自动降级为 Canvas-only
- 代次守卫（`maplibreProbeGeneration`）取消过期的异步 probe 创建
- 默认 `ENABLE_MAPLIBRE_EXPERIMENT=false`，maplibre-gl 不进入主 bundle

详见 [地图底图评估 - 第 14 节](map-basemap-evaluation.md#14-m4-a2-lite底图容器与-canvas-overlay-桥接最小验证)。

### 7.3 验收

- `npm run build` ✅（86 modules, 12.96s）
- `cargo check` ✅（1.44s）
- flag=false：Canvas-only 行为完全不变
- flag=true：Canvas 可见，MapLibre 在底层，控件正常，无网络请求

---

## 8. M4-A2 正式版第 1 轮：overlay 交互闭环与控件统一（2026-06-26）

### 8.1 交互桥接

M4-A2-lite 的 overlay 模式下 Canvas `pointer-events:none`，hover/click 不可用。本轮通过事件桥接解决：

- `LineMapViewHandle` 新增 `handlePointerMove` / `handlePointerClick` / `handlePointerLeave`
- `LineMapBaseLayerHandle` 新增 `onPointerMove` / `onPointerClick` / `onPointerLeave`
- MapLibre 接收鼠标事件 → 转发 `{ x, y }` → Canvas handle 处理命中测试 + tooltip + 联动
- 内部逻辑拆分为 `handlePointerMoveAt` / `handlePointerClickAt` / `handlePointerLeaveInternal`，Canvas-only 和 overlay 共用

### 8.2 控件统一

| 控件 | Canvas-only | overlay |
|---|---|---|
| 经纬度网格 | Canvas 绘制 | 隐藏（`showGrid` 默认 false） |
| Canvas 比例尺 | Canvas 绘制 | 隐藏（`showCanvasScaleBar` 默认 false） |
| MapLibre ScaleControl | — | bottom-right（`maxWidth:100, unit:'metric'`） |
| 图层面板 / fit 按钮 / tooltip | Canvas 控件 | Canvas 控件（一致） |

`RenderLineMapOptions` 新增 `showGrid?` / `showCanvasScaleBar?`，默认值根据 overlay 模式自动推导。

### 8.3 fitBounds 优化

所有 `fitBounds` 调用添加 `duration: 0`，消除动画延迟，确保 Canvas overlay 立即同步重绘。

### 8.4 生命周期

`lineProjectView.ts` 新增 `maplibreInteractionCleanup: Array<() => void>`，overlay 成功后注册 3 个取消函数，`destroyLineMapView()` 统一清理。

### 8.5 验收

- `npm run build` ✅（86 modules, 14.24s）
- `cargo check` ✅（1.91s）
- flag=false：Canvas-only 行为完全不变
- flag=true：overlay hover/click/联动正常，MapLibre ScaleControl 显示，无网络请求

详见 [地图底图评估 - 第 15 节](map-basemap-evaluation.md#15-m4-a2-正式版第-1-轮maplibre-overlay-交互闭环与控件统一)。

---

## 9. M4-A2 第 2 轮：cleanup patch + PMTiles 离线瓦片最小预研（2026-06-26）

### 9.1 cleanup patch

- `offView` 加入 `maplibreInteractionCleanup`（原仅 offMove/offClick/offLeave，现 4 个全部纳入）
- 注释统一：`M4-A2-lite` → `M4-A2`（涉及 lineMapView/lineMapBaseLayer/lineMapProjection/lineProjectView）
- destroy 时 listener 清理完整，工程切换无残留

### 9.2 PMTiles 最小预研

引入 PMTiles 离线瓦片能力（默认关闭），验证 MapLibre 可加载本地 PMTiles。

**新依赖**：`pmtiles` npm 包

**新增文件**：

| 文件 | 说明 |
|---|---|
| `src/ui/lineMapStyle.ts` | style 工厂（empty + pmtiles） |
| `src/ui/lineMapPmtiles.ts` | protocol 管理（动态 import + 防重复 + 引用计数 cleanup） |
| `public/tiles/.gitkeep` | 保留瓦片目录结构 |

**修改文件**：

| 文件 | 变更 |
|---|---|
| `src/config/features.ts` | 新增 `ENABLE_PMTILES_EXPERIMENT` / `PMTILES_DEMO_URL` |
| `src/ui/lineMapBaseLayer.ts` | `CreateMapLibreProbeOptions` 新增 `pmtiles` 选项，失败回退 empty style，destroy 清理 protocol |
| `src/ui/lineProjectView.ts` | 传递 pmtiles 选项给 createMapLibreProbe |
| `.gitignore` | `public/tiles/*.pmtiles` 不提交 |

### 9.3 feature flag

```ts
ENABLE_MAPLIBRE_EXPERIMENT = false;
ENABLE_PMTILES_EXPERIMENT = false;
PMTILES_DEMO_URL = '/tiles/demo.pmtiles';
```

两个开关同时开启才生效。PMTiles 失败自动回退 empty style。

### 9.4 验收

- `npm run build` ✅（90 modules, 54.34s）
- `cargo check` ✅（5.25s）
- Canvas-only：pmtiles 包不加载，行为不变
- MapLibre empty：无瓦片，无网络请求
- PMTiles 不存在：自动回退，无崩溃

详见 [地图底图评估 - 第 16 节](map-basemap-evaluation.md#16-m4-a2-第-2-轮cleanup-patch--pmtiles-离线瓦片最小预研)。

---

## 10. M4-A2 第 3 轮：开发环境 OpenStreetMap 在线底图（2026-06-26）

### 10.1 目标

新增开发环境 OSM 在线底图能力，用于调试线路 overlay 与底图对齐。明确底图模式优先级：Canvas-only（默认安全） > OSM online（开发调试） > PMTiles（后续离线） > empty（兜底）。

### 10.2 vibe-Monitor 参考

阶段 1 在 `vibe-Monitor` 仓库搜索地图实现，结论：

- `vibe-Monitor` 仓库在本机不存在
- 兄弟项目（DataCollectorHub / downloader-dcp / dcp_lite_app / dcp_sdk）均无 MapLibre / OpenStreetMap 实现
- 采用 spec 中预设的 OSM raster style 模式实现

### 10.3 feature flag

`src/config/features.ts` 新增：

```ts
export type LineBasemapMode = 'empty' | 'osm-online' | 'pmtiles';
export const LINE_BASEMAP_MODE: LineBasemapMode =
  import.meta.env.DEV ? 'osm-online' : 'empty';
```

- 开发阶段（`import.meta.env.DEV=true`）自动启用 OSM
- 生产阶段默认 `empty`
- 仅在 `ENABLE_MAPLIBRE_EXPERIMENT=true` 时生效

### 10.4 style 工厂扩展

`src/ui/lineMapStyle.ts` 新增 `createOsmOnlineRasterStyle()`：

- 使用 `https://tile.openstreetmap.org/{z}/{x}/{y}.png`（HTTPS，不使用 a/b/c 子域）
- `tileSize: 256`（OSM 标准）
- `attribution: '© OpenStreetMap contributors'`（ODbL 许可要求）
- 保留 `createEmptyLineMapStyle()` / `createPmtilesLineMapStyle()`

### 10.5 BaseLayer 扩展

`src/ui/lineMapBaseLayer.ts` 的 `CreateMapLibreProbeOptions` 新增 `basemapMode?: LineBasemapMode`。

底图选择逻辑（优先级 osm-online > pmtiles > empty）：

| basemapMode | pmtiles.enabled | 选择 style |
|---|---|---|
| 'osm-online' | * | OSM raster |
| 'pmtiles' | true | PMTiles（失败回退 empty） |
| 'pmtiles' | false | empty |
| 'empty' / undefined | * | empty |

**OSM 模式专属**：

- `attributionControl: true`（启用 attribution）
- 瓦片加载错误只 `console.warn`，不 `reject` 主流程
- 使用 `map.on('error', onError)` 持续监听
- PMTiles protocol 不注册

### 10.6 lineProjectView 接入

`src/ui/lineProjectView.ts` 引入 `LINE_BASEMAP_MODE`，传给 `createMapLibreProbe`：

```ts
const probe = await createMapLibreProbe(container, {
  initialBounds,
  basemapMode: LINE_BASEMAP_MODE,
  pmtiles: { enabled: ENABLE_PMTILES_EXPERIMENT, url: PMTILES_DEMO_URL },
});
```

### 10.7 OSM 使用边界

**允许**：开发调试 overlay 对齐 / 显示 attribution / 瓦片失败降级空底图

**禁止**：生产默认 / 批量下载 / 预取 / 离线缓存 / 下载地图功能 / 天地图 / 高德 / 思极 / GCJ-02 / PMTiles source-layer / MBTiles / 本地 tile server

### 10.8 验收

- `npm run build` ✅
- `cargo check` ✅
- Canvas-only：行为完全不变（ENABLE_MAPLIBRE_EXPERIMENT=false）
- MapLibre + OSM（DEV + flag=true）：OSM 瓦片加载，attribution 显示，overlay 交互正常
- OSM 瓦片加载失败：仅 warning，不崩溃，overlay 仍可用

详见 [地图底图评估 - 第 17 节](map-basemap-evaluation.md#17-m4-a2-第-3-轮开发环境-openstreetmap-在线底图)。

---

## 11. M4-A2 第 3 轮 Patch：OSM 不可用时回退 Canvas-only（2026-06-26）

### 11.1 背景

第 10 节将 OSM 限定为"仅开发调试用"，生产默认 `empty`。实际运行中 OSM 瓦片请求失败 `net::ERR_CONNECTION_CLOSED`，旧代码只 warning 不会回退，用户看到空白底图。

### 11.2 MVP 决策调整

- 不再区分开发 / 生产底图
- MVP 阶段全部使用 OpenStreetMap 在线地图
- OSM 不可用时自动降级到 Canvas-only 线路图
- 暂不接入天地图 / 思极 / PMTiles 深化 / 离线能力

### 11.3 实现要点

**阶段 1 — features.ts 收敛**：

- `ENABLE_MAPLIBRE_EXPERIMENT = true`（MVP 默认启用，移除 DEV 分支）
- `LINE_BASEMAP_MODE = 'osm-online'`（移除 `import.meta.env.DEV ? ...` 分支）

**阶段 2 — BaseLayer 失败信号**：

- `CreateMapLibreProbeOptions` 新增 `onBasemapUnavailable?: (reason: unknown) => void`
- OSM 模式下 tile error 计数，阈值 **3 次** 触发回调
- 只触发一次，不 `reject` 主流程，不刷屏

**阶段 3 — lineProjectView Canvas-only 回退**：

- 新增 `fallbackToCanvasOnly(reason)` 函数（闭包内）
- 清理 interaction listeners → 销毁 overlay canvas handle → 销毁 MapLibre probe → 重新渲染 Canvas-only
- 竞态处理：probe 创建期间触发回退后，await 返回检查 `fallbackToCanvasOnlyCalled` 并放弃 overlay 切换
- UI 提示：`OSM 在线底图不可用，已切换为 Canvas 地图模式`

**阶段 4 — 状态日志**：

- 成功：`[MapLibre overlay] enabled: true` / `basemap mode: osm-online` / `using OSM online raster tiles`
- 回退：`[MapLibre overlay] OSM unavailable, fallback to Canvas-only`

### 11.4 回退后行为保证

- 恢复 Canvas 经纬度网格 + 比例尺
- hover/click/tooltip/树联动正常（Canvas handle 自带交互）
- 不继续刷 OSM tile error（probe 已 destroy，map.remove() 已执行）
- 工程切换 / 清空场景不残留（`destroyLineMapView` 统一清理）

### 11.5 保留能力

`empty` / `pmtiles` 代码路径保留，本轮不扩展：

- `createEmptyLineMapStyle()` 仍可用于兜底
- `createPmtilesLineMapStyle(url)` 仍可用于后续离线方案预研
- `ENABLE_PMTILES_EXPERIMENT = false` 保持关闭

### 11.6 验收

- `npm run build` ✅
- `cargo check` ✅
- OSM 可用：MapLibre + OSM raster + overlay 交互正常
- OSM 不可用：3 次 tile error 后自动回退 Canvas-only，UI 提示，交互正常

详见 [地图底图评估 - 第 18 节](map-basemap-evaluation.md#18-m4-a2-第-3-轮-patchosm-不可用时回退-canvas-only)。

