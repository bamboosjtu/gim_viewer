# 技术架构

> 当前 GIM Viewer 的模块边界、运行时生命周期和持久化结构。样本格式事实归档在
> [schema/README.md](schema/README.md)，共用缓存与诊断契约见 [gim_common.md](gim_common.md)。

## 1. 运行时组成

GIM Viewer 是 Tauri 2 + Vite/TypeScript 桌面应用。Rust 负责文件、解压、SQLite 和
高吞吐批量 IO；前端负责解析编排、DOM、Three.js/OBC 渲染和 MapLibre/Canvas 地图。

| 组件 | 当前责任 |
|---|---|
| `desktop/src/app` | 启动、全局 `AppState`、工程切换身份 |
| `desktop/src/services` | Shared Core、线路/变电 Runtime、缓存编排、后台任务和资源清理 |
| `desktop/src/gim` | 纯 GIM 容器、文本、几何 IR、线路图和变电空间语义解析 |
| `desktop/src/viewer` | OBC Fragments、IFC 加载、选择、高亮、相机和 XML/MOD/STL 渲染 |
| `desktop/src/ui` | DOM 视图、属性抽屉、CBM 树、线路地图和缓存管理界面 |
| `desktop/src/shared` | HTML/CSV/显示名、基础解析门面和诊断摘要 |
| `desktop/bridge` | Tauri invoke、文件选择、文件读取、数据库 payload 映射 |
| `desktop/src-tauri/src` | Rust 命令、原生解压、SQLite schema/迁移/缓存校验 |

应用只拥有两个业务 Runtime：

```text
Shared Core
  ├─ GIMPKGT → Powerline Runtime → graph / attributes / map / tree
  └─ GIMPKGS → Substation Runtime → CBM / IFC / Fragments / DEV geometry / 3D
```

## 2. 分层边界

- `gim/` 不依赖 `services/`、`viewer/`、`ui/` 或 Tauri bridge；解析器消费文本/文件抽象，
  输出稳定的 domain DTO。
- `viewer/` 只拥有 3D 引擎和场景资源，不编排 SQLite 或业务 Runtime。
- `ui/` 只负责 DOM 投影和交互，不直接调用数据库；来源按钮通过事件委托交给 Runtime。
- `services/gimOpenCore.ts` 只提供 source、extraction、loading、session/perf 等共性设施，
  不持有线路或变电模型。
- `powerlineRuntime.ts` 与 `substationRuntime.ts` 各自拥有自己的缓存校验、恢复和就绪
  语义；它们不互相调用。
- `desktop/bridge` 只映射前端参数和后端命令，缓存有效性、版本和路径安全由 Rust 负责。

重依赖按需 dynamic import：应用启动不创建 3D Viewer；只有变电需要 IFC/几何时才加载
OBC、Fragments、web-ifc 和 Three.js 相关运行时，线路打开不创建独立 3D Viewer。

## 3. 打开生命周期

```text
main → bootstrap
  → inspect source (header / SHA / size / magic)
  → cleanup + activate ProjectLoadSession
  → validate domain cache
      ├─ hit: restore SQLite/derived entries
      └─ miss: native extract → parse → background persist
  → dispatch one domain Runtime
  → UI/地图/3D projection
```

`ProjectLoadSession` 和 `geometryLoadToken` 是异步所有权边界。每个后台结果在写入
`AppState`、scene、SQLite manifest 或 UI 前都检查 session；工程切换先 dispose 旧资源，
再清理状态，避免旧 Worker、IFC callback 或几何 placement 迟到。

变电 Runtime 将 `interactive`、`allIfcReady`、`fullModelReady` 分成不同依赖门；线路
Runtime 以 semantic graph、属性和地图投影完成作为主要域内阶段。详细产品行为见两个
Runtime 文档。

## 4. 数据与缓存结构

SQLite 以 `gim_project` 保存共享工程身份，以 domain 前缀隔离业务表：

| 域 | 主要表/派生缓存 | 内容 |
|---|---|---|
| 共用 | `gim_project`、条目 manifest | path、SHA、size、域版本、解压条目 |
| 变电 | `substation_cbm_node`、`substation_ifc_model`、`substation_file_dev_entry`、属性和几何引用链 | CBM/IFC/设备关系、FAM/DEV、DEV→PHM→MOD/STL |
| 线路 | `powerline_cbm_node`、`powerline_cbm_child`、`powerline_cbm_ref`、文件统计和属性 | 线路 graph、引用、FAM/DEV |
| 运行时派生 | `substation_fragment_cache`、空间 semantic snapshot、DEV GLB manifest | 可验证的 IFC/空间/几何派生结果 |

当前版本边界：线路 `gim-line-parser-v1`，变电 `gim-substation-parser-v23`，几何
`geometry-cache-v6-geometry-status`，Fragments `fragments-cache-v6`。缓存只在 project
identity、source SHA、尺寸、域版本和派生文件完整性都通过时命中。

## 5. 功能开关与构建

`desktop/src/config/features.ts` 当前开关：

| 开关 | 默认 | 作用 |
|---|---|---|
| Fragments Cache base flag | `false` | IFC Fragments 派生缓存，当前仅灰度/调试开启 |
| `ENABLE_MAPLIBRE_EXPERIMENT` | `true` | 线路 MapLibre overlay |
| `ENABLE_PMTILES_EXPERIMENT` | `false` | PMTiles 离线底图预研 |
| `LINE_BASEMAP_MODE` | `osm-online` | 线路默认在线底图，失败回退 Canvas-only |

```bash
cd desktop
npm run dev
npm run tauri:dev
npm run build
npm run tauri:build
npm test
npm run test:sample
cargo check --manifest-path src-tauri/Cargo.toml
```

构建前复制 `web-ifc.wasm`/`web-ifc-mt.wasm`；release portable 额外准备固定版本
WebView2 Runtime，并由 `scripts/package-portable.mjs` 组装 ZIP。系统 WebView2 只用于
开发模式，不能把裸 release exe 视为 portable 产物。

## 6. 下一步架构计划

- 完成线路/变电文档和缓存文档的单一职责拆分，避免同一缓存规则在多个文档漂移。
- 保持解析层和 Runtime 的单向依赖，优先清理未使用 re-export、重复基础解析器和过期
  测试夹具，不扩大 domain 合并。
- 以真实 release portable benchmark 为发布证据；性能优化先拆解 composite span，再
  决定是否需要 Runtime 级调整。
- 变电 Fragments Cache 先完成剩余样本验证；未达到证据门槛前保持产品默认关闭。
- 暂不引入 IFC Semantic Worker、新 Spatial Cache、shared geometry/InstancedMesh，
  也不把线路地图升级为独立 3D Runtime。
