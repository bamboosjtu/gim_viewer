# 线路 GIM 地图底图（地貌/地形）引入评估

> 文档目的：评估是否在 MVP 阶段之后引入开源地图底图，使线路地图具备真实地理背景（地貌、地形、道路、水系等），提升可读性与真实感。
>
> **当前阶段：仅评估，不集成到主流程。** 现有 Canvas 渲染主流程（`src/ui/lineMapView.ts`）不修改。

---

## 1. 背景与现状

### 1.1 当前 MVP 状态

- 渲染层：`src/ui/lineMapView.ts` 使用纯 Canvas 2D，等距矩形投影（Equirectangular）将 WGS84 经纬度线性映射到屏幕像素。
- 数据来源：`extractLineMapData(graph, attrs)` 从 GimGraph + LineAttributeIndex 提取塔位 / 导线 / 跨越点，BLHA 已解析为 lat/lng。
- 投影基准：`worldX = (lng - centerLng) * cos(centerLatRad)`，`worldY = lat - centerLat`，再 fit 到 canvas 像素（bbox 居中、四周留边距，Canvas Y 轴向下需反转纬度）。
- 范围：单个线路工程通常 10–100 km，跨 0.1°–1° 经纬度。
- 离线能力：Tauri 桌面版默认离线运行，CSP `connect-src 'self' ipc: http://ipc.localhost`，禁止外部网络。

### 1.2 用户痛点（推动评估的原因）

- 抽象线路图缺少地理参考（道路、水系、行政边界），用户难以判断线路与真实地貌的关系。
- 跨越点（CROSS）类型识别需要结合水系/道路信息（例如跨越河流 vs 跨越铁路）。
- 现场定位时希望看到周边地形（高程、坡度）以辅助塔位选址复核。

### 1.3 评估目标

- 选出 1 个推荐方案，明确后续 M4 阶段集成路径。
- 说明为什么当前 MVP 不直接引入。
- 量化包体、性能、离线影响。

---

## 2. 开源方案对比

### 2.1 MapLibre GL JS（推荐优先评估）

| 维度 | 评估 |
|---|---|
| 协议 | BSD-3-Clause，商业友好 |
| 包体 | `maplibre-gl` npm 包 ~1.2 MB（minified），WASM/WebWorker 无 |
| 渲染 | WebGL，矢量瓦片 + 栅格瓦片均支持，性能优秀 |
| 投影 | 默认 Web Mercator (EPSG3857)，需将当前 WGS84 直接传入（API 接受 lat/lng） |
| 离线 | 支持 MBTiles / 本地瓦片源；可拦截网络请求改用本地 PMTiles |
| 集成 | DOM 容器 + JS API，与现有 Canvas overlay 兼容（绝对定位叠加） |
| 缺点 | 引入 WebGL 上下文，与 web-ifc 共享 GPU；样式资源 (style.json) 需本地化 |

### 2.2 Leaflet

| 维度 | 评估 |
|---|---|
| 协议 | BSD-2-Clause |
| 包体 | `leaflet` ~150 KB（minified），无 WASM |
| 渲染 | DOM/SVG/Canvas 2D，性能弱于 MapLibre（>1000 marker 卡顿） |
| 投影 | 默认 EPSG3857，支持 EPSG4326 简单转换 |
| 离线 | 支持本地 tile layer（`file://` 或自定义 URL 模板） |
| 集成 | 简单，但与现有 Canvas 2D 叠加需要 L.Layer 或 L.Renderer 桥接 |
| 缺点 | 偏 2D，无地形可视化；3D 塔高/导线弧垂无法表达 |

### 2.3 Cesium

| 维度 | 评估 |
|---|---|
| 协议 | Apache-2.0 |
| 包体 | `cesium` ~30 MB（含 Assets），打包后仍 ~5 MB |
| 渲染 | WebGL 3D，支持 3D Tiles、地形、影像 |
| 投影 | 多投影支持，WGS84 椭球 |
| 离线 | 支持本地 3D Tiles 和地形切片 |
| 集成 | 重，与 OBC（Three.js）共栈会显著增加 GPU 负担 |
| 缺点 | **不建议 MVP 使用**：包体过大、与现有 Three.js/OBC 共存冲突 |

### 2.4 推荐方案

**MapLibre GL JS + Canvas overlay（方案 A）**

理由：

1. 平衡包体（~1.2 MB）与渲染性能（WebGL 矢量瓦片）。
2. 与现有 Canvas 2D 渲染层职责清晰：MapLibre 负责底图，Canvas overlay 负责线路塔位/导线/跨越点。
3. 离线策略清晰：MBTiles / PMTiles 本地瓦片，Tauri `asset:` 协议可加载。
4. Leaflet 性能不足以支撑密集塔位（典型 500kV 线路 100+ 塔位 + 导线段），Cesium 包体不可接受。

---

## 3. 底图类型评估

### 3.1 矢量瓦片（Vector Tiles）

- 格式：`.mvt` / `.pbf`，按 z/x/y 分块。
- 优势：缩放无锯齿，样式可定制（可隐藏不必要图层降低视觉噪声）。
- 数据源：
  - OpenMapTiles（OSM 衍生，开源 schema）：完整中国覆盖，但需自建瓦片服务或下载 MBTiles。
  - Protomaps：PMTiles 单文件格式，适合 Tauri 内嵌。
- 评估结论：**推荐 M4 主用**，搭配 OpenMapTiles PMTiles。

### 3.2 栅格瓦片（Raster Tiles）

- 格式：PNG/WebP，按 z/x/y 分块。
- 优势：兼容老瓦片服务（如内网天地图、ArcGIS REST）。
- 缺点：缩放有锯齿，文件体积大（中国全境 z0-z14 约 50 GB）。
- 评估结论：作为矢量瓦片的 fallback，例如内网仅有栅格瓦片服务时。

### 3.3 DEM 地形（仅评估）

- 格式：GeoTIFF / Terrarium / Mapzen Terrain JPEG。
- 用途：3D 地形可视化（hillshade、坡度图）。
- 集成：MapLibre 通过 `terrain` 属性 + terrain RGB DEM 实现 3D 地形。
- 评估结论：**M4 第二阶段评估**，不强制；当前 BLHA 已含高程字段 `elev`，可在 tooltip 中展示足够。

---

## 4. 数据来源

| 来源 | 类型 | 离线 | 中国覆盖 | 评估 |
|---|---|---|---|---|
| OpenStreetMap | 矢量/栅格 | 需自建瓦片 | 完整 | 开源友好，但需下载中国区域 MBTiles（约 2-5 GB） |
| OpenMapTiles PMTiles | 矢量 | 单文件离线 | 完整 | **推荐**：单文件易分发，Tauri 可内嵌或按需下载 |
| 内网瓦片服务 | 栅格 | 内网可达 | 取决于服务 | 适合企业部署，但 MVP 不依赖 |
| 天地图 / 高德 | 栅格 | 需 API Key | 完整 | 商业许可问题，不推荐开源版本引入 |

### 4.1 推荐数据策略

- **离线默认**：随应用分发一份精简的中国 PMTiles（z0-z8，约 50 MB），覆盖省级路网与水系骨架。
- **可选增强**：用户首次打开线路工程时按 bbox 引导下载高精度瓦片包（z9-z14，bbox 50km × 50km 约 10-50 MB），存入 `app_data_dir/maps/`。
- **内网可选**：暴露 `MAP_TILE_URL` 环境变量，存在则优先走内网瓦片服务。

---

## 5. 集成方式设计（不实现）

### 5.1 方案 A：Canvas 叠加在 MapLibre 之上（推荐）

```
┌──────────────────────────────┐
│  Tauri Webview                │
│  ┌──────────────────────────┐│
│  │  MapLibre GL (底图层)    ││  ← WebGL 上下文 1
│  │   - 矢量瓦片 (PMTiles)   ││
│  │   - DEM 地形 (可选)      ││
│  └──────────────────────────┘│
│  ┌──────────────────────────┐│
│  │  Canvas Overlay (绝对定位)││  ← Canvas 2D 上下文
│  │   - 塔位 marker          ││
│  │   - 导线折线             ││
│  │   - 跨越点               ││
│  │   - 图层开关 / 图例      ││
│  └──────────────────────────┘│
│  ┌──────────────────────────┐│
│  │  HTML Tooltip (顶层)     ││
│  └──────────────────────────┘│
└──────────────────────────────┘
```

- Canvas overlay 监听 MapLibre 的 `move`/`zoom` 事件，重投影所有要素到当前视口。
- 投影函数：将 lat/lng 通过 MapLibre `project()` 转屏幕像素（无需自己实现 Mercator）。
- 优势：现有 `lineMapView.ts` 渲染逻辑可保留 ~80%，仅替换 `geoToScreen()` 实现。

### 5.2 方案 B：MapLibre 作为背景层 + 线路作为 MapLibre overlay layer

- 将塔位/导线/跨越点作为 GeoJSON Source 添加到 MapLibre，统一在 WebGL 上下文渲染。
- 优势：性能最佳，无 DOM/Canvas 切换。
- 缺点：需要重写 `lineMapView.ts`，工作量较大；自定义 hover/click hit-testing 需用 MapLibre API；图例 / 图层开关需要重新实现。

### 5.3 方案 C：完全迁移到 MapLibre（不建议 MVP）

- 同方案 B，且放弃 Canvas overlay。
- M4 之后可考虑，但 MVP 阶段禁止。

### 5.4 推荐集成路径（M4）

1. 引入 `maplibre-gl` 依赖（~1.2 MB），添加到 `package.json`。
2. 在 `lineMapView.ts` 之外新建 `lineMapBaseLayer.ts`：封装 MapLibre 初始化、PMTiles 加载、`project()` 桥接。
3. `lineMapView.ts` 改造：在 `renderLineMap()` 内部优先尝试创建 MapLibre 底图层；失败（无瓦片、离线无文件）则回退到当前纯 Canvas 模式。
4. `geoToScreen()` 改为 `map.project([lng, lat])`，`screenToWorldGeo()` 改为 `map.unproject({x, y})`。
5. 复用现有图层开关 / 图例 / hover / click 逻辑（在 Canvas overlay 层）。
6. 失败回退路径必须保留：MapLibre 初始化失败时降级到当前 MVP 行为，不抛异常。

---

## 6. 坐标系统

### 6.1 当前状态

- 数据：WGS84 经纬度（lat/lng），来自 BLHA 解析。
- 投影：等距矩形（Equirectangular），线性映射到 canvas。

### 6.2 引入 MapLibre 后

- MapLibre 默认 Web Mercator (EPSG:3857)，但 API 接受 `LngLat` 对象（WGS84），内部自动转换。
- **不需要在数据层做坐标转换**：现有 `TowerMarker.lat/lng` 直接传入 `map.project([lng, lat])`。
- 注意：GeoJSON 顺序为 `[lng, lat]`，BLHA 为 `lat,lng`，**必须显式调换**（项目已遵守此约定，见 `gim/lineMapData.ts` parseBlha）。

### 6.3 中国坐标偏移问题

- 中国境内 OSM 瓦片存在 GCJ-02 偏移（"火星坐标"），约 50-500 m。
- 当前 MVP 不处理，因为离线 Canvas 不依赖底图。
- 引入 MapLibre + OSM 瓦片后需要评估：
  - 选项 1：使用 OSM 原始 WGS84 瓦片（如 Mapbox Satellite、ESRI World Imagery），但开源版本不可商用。
  - 选项 2：在客户端做 WGS84 → GCJ-02 转换（推荐，开源库 `coordtransform`）。
  - 选项 3：忽略偏移（500 kV 线路工程塔位间距 300-500 m，偏移可能影响视觉对齐）。
- 评估结论：M4 集成时采用选项 2，引入 `coordtransform` 库（< 5 KB）。

---

## 7. 性能与包体影响分析

### 7.1 包体增量

| 项 | 增量 | 说明 |
|---|---|---|
| `maplibre-gl` | ~1.2 MB（minified） | 主依赖 |
| PMTiles 离线瓦片（z0-z8 中国） | ~50 MB | 内嵌或首次下载 |
| `coordtransform` | < 5 KB | 坐标偏移转换 |
| `pmtiles` 解析库 | ~30 KB | 单文件读取 |
| **总计** | **~51 MB（含瓦片） / ~1.2 MB（不含瓦片）** | 与 Tauri 主包 ~30 MB 相比可接受 |

### 7.2 运行时性能

- MapLibre WebGL 渲染：60 fps 流畅（参考业界基准）。
- Canvas overlay 重绘：每次 `move`/`zoom` 事件触发，~500 个塔位 + 200 段导线，单帧 < 5 ms。
- 内存：MapLibre 内部瓦片缓存 ~50-100 MB（取决于 zoom range）。
- 与 web-ifc / OBC 共享 GPU：需注意 WebGL 上下文数（浏览器上限通常 16），MapLibre 占 1 个，OBC 占 1 个，仍充足。

### 7.3 离线启动延迟

- 首次启动加载 PMTiles：~50 MB 文件，Tauri `asset:` 协议读取，启动延迟增加 ~200-500 ms。
- 可接受，不影响 MVP 用户体验。

---

## 8. 离线支持策略

### 8.1 MVP 当前状态（不引入 MapLibre）

- 完全离线，Canvas 渲染不依赖任何外部资源。
- 启动延迟最低（无地图引擎加载）。

### 8.2 M4 引入 MapLibre 后的离线策略

| 场景 | 策略 |
|---|---|
| 离线包（默认） | 内嵌 z0-z8 PMTiles（50 MB），覆盖省级路网水系 |
| 首次打开线路工程 | 按 bbox 提示下载高精度瓦片包（z9-z14），存入 `app_data_dir/maps/<project_sha256>.pmtiles` |
| 内网部署 | 检测 `MAP_TILE_URL` 环境变量，存在则走内网瓦片服务 |
| 完全无瓦片 | 回退到当前 MVP 纯 Canvas 模式（必须保留） |

### 8.3 CSP 影响

- 当前 CSP：`script-src 'self' 'wasm-unsafe-eval'; connect-src 'self' ipc: http://ipc.localhost`
- 引入 MapLibre 后需要：
  - 增加 `worker-src 'self' blob:`（MapLibre 使用 Web Worker，需 blob:）
  - 增加 `connect-src` 允许 `asset:` 协议读取本地 PMTiles
  - 若使用在线瓦片，需放开对应域名（不推荐，破坏离线）

### 8.4 Tauri 资源打包

- PMTiles 文件放到 `src-tauri/resources/maps/`，Tauri 构建时打包到 `resources/`。
- 运行时通过 `tauri::path::resource_dir()` 获取路径，前端用 `convertFileSrc` 转换为 `asset://` URL。
- 高精度瓦片按需下载到 `app_data_dir/maps/`，前端通过 `convertFileSrc` 加载。

---

## 9. 当前 MVP 不直接引入的原因

1. **核心功能优先级**：MVP 阶段用户更需要"看到线路走向 + 属性联动"，而非"看到真实地貌"。当前 Canvas 已能展示塔位/导线/跨越点 + 经纬度网格 + 比例尺。
2. **包体控制**：Tauri 主包当前约 30 MB（含 web-ifc WASM + libarchive WASM），引入 MapLibre + 50 MB 瓦片后接近 80 MB，对内网分发的便携性有影响。
3. **离线策略复杂度**：需要设计首次下载、缓存失效、内网回退等多条路径，超出 MVP 范围。
4. **坐标偏移问题**：WGS84 ↔ GCJ-02 转换需要额外验证，否则塔位会与底图错位。
5. **与 Three.js/OBC 共栈风险**：WebGL 上下文数与 GPU 资源共享需要实测，避免影响变电工程 IFC 渲染。
6. **回退路径必须保留**：无论是否引入底图，Canvas 纯渲染模式必须作为兜底，不能删除现有 `lineMapView.ts` 主流程。

---

## 10. 后续 M4 集成步骤（建议）

1. **M4-1**：在 `package.json` 引入 `maplibre-gl`，验证与 Tauri + Vite 集成（CSP 调整、Worker 加载）。
2. **M4-2**：实现 `lineMapBaseLayer.ts`，封装 MapLibre 初始化 + PMTiles 加载。
3. **M4-3**：改造 `lineMapView.ts`，`geoToScreen` 改用 `map.project()`，保留 Canvas overlay。
4. **M4-4**：实现首次打开按 bbox 下载高精度瓦片的引导 UI（`app_data_dir/maps/`）。
5. **M4-5**：引入 `coordtransform`，处理 WGS84 → GCJ-02 偏移。
6. **M4-6**：回归验证：首次/二次打开、线路切变电、清空场景、内网/离线场景、CSP 安全。

每一步必须保留"MapLibre 不可用时回退到 MVP Canvas"的降级路径。

---

## 11. 风险与未决项

| 风险 | 缓解 |
|---|---|
| OSM 瓦片许可（ODbL） | 使用 OpenMapTiles PMTiles 分发，遵守 ODbL；商业版需评估 |
| GCJ-02 偏移导致塔位与底图错位 | 引入 `coordtransform`，客户端转换 |
| WebGL 上下文上限 | 实测变电 + 线路切换场景，必要时延迟初始化 MapLibre |
| 瓦片下载体积 | 提供按 bbox 精简下载，避免全境 z14 |
| 内网无外网 | 保留 `MAP_TILE_URL` 环境变量 + Canvas 回退 |
| Tauri PMTiles 资源路径 | 用 `convertFileSrc` 转 `asset://`，避免直接 `file://` |

---

## 12. 总结

- **推荐方案**：MapLibre GL JS + Canvas overlay（方案 A）+ OpenMapTiles PMTiles（离线）+ `coordtransform`（GCJ-02 偏移）。
- **当前 MVP**：不引入，保留纯 Canvas 渲染，专注线路走向 + 属性联动。
- **M4 路径**：分 6 步引入，每步保留回退到 Canvas 模式的降级。
- **不影响现有功能**：所有改造在新文件 `lineMapBaseLayer.ts` 中进行，`lineMapView.ts` 主流程保留。

---

## 13. M4-A1 技术验证结果

> 阶段：M4 Sprint 1（技术验证，默认关闭，不替换主地图）

### 13.1 已完成

| 项 | 状态 | 说明 |
|---|---|---|
| 引入 `maplibre-gl` 依赖 | ✅ | `package.json` 新增 `maplibre-gl`，~1.2 MB |
| Feature flag | ✅ | `src/config/features.ts` 新增 `ENABLE_MAPLIBRE_EXPERIMENT = false`（默认关闭） |
| Probe 模块 | ✅ | `src/ui/lineMapBaseLayer.ts` 导出 `createMapLibreProbe(container)` |
| 空 style | ✅ | 本地 `EMPTY_STYLE`（仅 background 层，无 source / 瓦片） |
| 动态 import | ✅ | 仅 flag=true 时 `await import('maplibre-gl')`，默认 false 不进主 bundle |
| 创建 / 销毁 | ✅ | `createMapLibreProbe` 初始化 map，`handle.destroy()` 调用 `map.remove()` |
| 集成点 | ✅ | `lineProjectView.ts` 在 Canvas 地图渲染后异步创建 probe，失败仅警告不抛异常 |

### 13.2 默认关闭策略

- `ENABLE_MAPLIBRE_EXPERIMENT = false`（默认）
- flag=false 时：
  - `maplibre-gl` 不被 import，不进 Vite 主 bundle
  - `lineMapBaseLayer.ts` 不被加载
  - 线路地图完全走 `lineMapView.ts` 纯 Canvas 渲染
  - 行为与 M3 MVP 完全一致
- flag=true 时（手动改源码）：
  - Canvas 地图仍正常渲染（`renderLineMap` 不变）
  - 额外异步创建 MapLibre probe（空 style 容器）
  - probe 失败不影响 Canvas 主流程（catch + console.warn）

### 13.3 离线 / 网络策略

- **不加载在线瓦片**：EMPTY_STYLE 无 `sources`，不发起任何瓦片请求
- **不访问外网**：MapLibre 仅初始化 WebGL 上下文 + 渲染 background 层
- **Web Worker**：MapLibre 内部使用 blob worker，CSP `worker-src 'self' blob:` 已允许

### 13.4 CSP 兼容性

当前 CSP（`src-tauri/tauri.conf.json`）：

```
default-src 'self';
img-src 'self' data: blob:;
style-src 'self' 'unsafe-inline';
script-src 'self' 'wasm-unsafe-eval';
worker-src 'self' blob:;
connect-src 'self' ipc: http://ipc.localhost
```

- `worker-src 'self' blob:` → ✅ MapLibre blob worker 允许
- `style-src 'self' 'unsafe-inline'` → ✅ MapLibre 控件内联样式允许
- `script-src 'self' 'wasm-unsafe-eval'` → ✅ 不需要 eval（empty style 无表达式）
- `connect-src 'self' ipc: http://ipc.localhost` → ✅ empty style 无网络请求

**结论：M4-A1 probe 不需要修改 CSP。**

### 13.5 不做的事（留给 M4-A2）

- 不替换 Canvas 主流程
- 不改 `geoToScreen()`
- 不做 Canvas overlay 对接（`map.project()` 桥接）
- 不加载 PMTiles / MBTiles
- 不引入 `coordtransform`
- 不做真实底图

### 13.6 后续步骤（M4-A2）

> **2026-06-26 更新**：M4-A2-lite（阶段 1~5）已完成，见 [第 14 节](#14-m4-a2-lite-底图容器与-canvas-overlay-桥接最小验证)。完整的 M4-A2（含 PMTiles 瓦片）仍未实现。

1. ~~在 probe 基础上加载 PMTiles source（本地 `asset://` 协议）~~ → 仍留给 M4-A2 正式版
2. ~~Canvas overlay 改用 `map.project([lng, lat])` 重投影~~ → M4-A2-lite 已完成
3. ~~监听 `map.on('move')` / `map.on('zoom')` 触发 Canvas 重绘~~ → M4-A2-lite 已完成
4. 保留 Canvas 回退路径（PMTiles 不可用时降级） → M4-A2-lite 已实现降级

每步必须保留"MapLibre 不可用时回退到 MVP Canvas"的降级。

---

## 14. M4-A2-lite：底图容器与 Canvas overlay 桥接最小验证

> 阶段：M4 Sprint 1 Patch + M4-A2-lite
> 时间：2026-06-26
> 前置：M4-A1 技术验证（probe 初始化/销毁）

### 14.1 目标

1. 修复 M4 Sprint 1 评审发现的 MapLibre z-index 遮挡问题
2. 在 feature flag 下实现 MapLibre 底图 + Canvas overlay 桥接
3. 不接入真实瓦片、不引入 PMTiles/MBTiles、不做坐标偏移
4. 默认仍保持 Canvas-only，不影响现有线路/变电流程

### 14.2 z-index 层级修复

M4 Sprint 1 评审发现：MapLibre mount div 使用 `z-index:1`，而 Canvas 未设置层级，可能被遮挡。

修复后的层级方案：

| 层 | z-index | 元素 | 说明 |
|---|---|---|---|
| 底图 | 0 | MapLibre mount div | 最底层，承载 MapLibre 渲染 |
| overlay | 2 | Canvas | 塔位/导线/跨越点/图例/标签 |
| 控件 | 20 | tooltip / fit 按钮 / 图层面板 | 最顶层，可交互 |

容器 `container` 设置 `position: relative` 以建立 z-index 上下文。

### 14.3 投影接口抽象

新增 `src/ui/lineMapProjection.ts`：

```ts
export interface LineMapProjection {
  project(lng: number, lat: number): ScreenPoint;
  unproject?(x: number, y: number): { lng: number; lat: number };
  fitBounds?(bbox: GeoBBox): void;
}

export function createMapLibreProjection(map: MapLibreProjectable): LineMapProjection;
export function createCanvasProjection(params: CanvasProjectionParams): LineMapProjection;
```

- `createMapLibreProjection`：包装 MapLibre 的 `map.project({ lng, lat })` / `map.unproject([x, y])`
- `createCanvasProjection`：包装 lineMapView.ts 内部的等距矩形投影（预留，当前未使用）
- Canvas-only 模式不需要使用此接口，`geoToScreen` 直接用内部逻辑

### 14.4 MapLibre Handle 扩展

`lineMapBaseLayer.ts` 的 `LineMapBaseLayerHandle` 新增：

| 方法 | 说明 |
|---|---|
| `project(lng, lat)` | 调用 `map.project({ lng, lat })`，返回 `{ x, y }` 或 null |
| `onViewChange(callback)` | 监听 `move` / `zoom` / `resize`，返回取消注册函数 |
| `fitBounds(bounds)` | 调用 `map.fitBounds(bounds, { padding: 48 })` |

- `interactive: true`（M4-A2-lite 启用交互，MapLibre 管理 pan/zoom）
- 支持 `initialBounds` 选项（加载后自动 `fitBounds`）

### 14.5 Canvas overlay 模式

`lineMapView.ts` 新增 `RenderLineMapOptions`：

```ts
export interface RenderLineMapOptions {
  projection?: LineMapProjection;
  onRequestRedraw?: (draw: () => void) => void;
}
```

当 `projection` 传入时（overlay 模式）：

- `canvas.style.pointerEvents = 'none'` → MapLibre 接收鼠标事件
- `canvas.style.zIndex = '2'` → 在 MapLibre 之上
- `draw()` 使用 `ctx.clearRect()` 透明背景（让 MapLibre 透出）
- `geoToScreen()` 委托给 `projection.project(lng, lat)`
- `screenToWorldGeo()` 委托给 `projection.unproject(x, y)`
- `fit()` / `focusTowerByNodePath()` / `focusBboxByNodePaths()` 委托给 `projection.fitBounds(bbox)`
- `onRequestRedraw(draw)` 注册 draw 函数，供 MapLibre 视图变化时触发重绘

默认（不传 options）：纯 Canvas 模式，行为完全不变。

### 14.6 集成流程

`lineProjectView.ts` 的 `renderLineProjectPanels`：

1. **Canvas-only 先渲染**：立即调用 `renderLineMap(mapData, container, onTowerClick)`，确保地图可见
2. **flag=true 时异步创建 probe**：
   - 传入 `initialBounds` = `mapData.bbox`
   - 成功后构建 `LineMapProjection`（project/unproject 来自 map，fitBounds 委托 probe）
   - 销毁 Canvas-only handle，用 overlay 模式重新渲染
   - 注册 `onViewChange` → 触发 Canvas overlay 重绘
3. **失败时保持 Canvas-only**：catch 后仅 `debugWarn`，不抛异常
4. **代次守卫**：`maplibreProbeGeneration` 递增取消过期的异步 probe 创建

### 14.7 不做的事（留给 M4-A2 正式版）

- 不加载 PMTiles / MBTiles / 在线瓦片
- 不引入 `coordtransform`（WGS84 ↔ GCJ-02）
- 不做悬链线
- 不做 MOD 解析
- 不做真实 3D 线路
- 不修改 SQLite schema
- 不开启 Fragments 缓存

### 14.8 默认关闭策略

- `ENABLE_MAPLIBRE_EXPERIMENT = false`（`src/config/features.ts`）
- flag=false 时：纯 Canvas 模式，行为完全不变，maplibre-gl 不进入主 bundle
- flag=true 时：Canvas 先渲染 → MapLibre 异步加载 → 切换为 overlay 模式
- MapLibre 失败时自动降级为 Canvas-only
