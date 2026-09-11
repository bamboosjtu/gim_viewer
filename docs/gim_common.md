# GIM Viewer 共性实现

> 本文只描述线路与变电共用的容器、打开会话、缓存基础设施、桥接和诊断契约。
> 线路专属行为见 [gim_powerline.md](gim_powerline.md)，变电专属行为见
> [gim_substation.md](gim_substation.md)，样本事实见 [schema/README.md](schema/README.md)。

## 1. 共用输入与打开边界

`.gim` 是带 `GIMPKG*` 头部的自定义容器。解析器在头部后的窗口内搜索 7z 或 ZIP
签名，不把固定 payload offset 当作格式规则。`GIMPKGS` 与 `GIMPKGT` 分别表示变电和
线路；路径查找统一处理 `/`、`\` 和大小写差异，同时保留归档中的实际路径用于展示、
缓存和诊断。

打开流程由 Shared Core 统一编排：

```text
source head / SHA-256
  → source identity + runtime type
  → cleanup + ProjectLoadSession
  → native extraction（失败时 WASM fallback）
  → Powerline Runtime 或 Substation Runtime
```

工程类型由 source magic 优先决定。解压后的内容检测只负责未知 magic 的 fallback、
内容校验和 mismatch 诊断；SQLite 中旧的 `project_type` 不能反向选择 Runtime。打开前后
观察到非空 magic 不一致时，以 `SOURCE_CHANGED_DURING_OPEN` fail closed。

Tauri 生产路径使用 Rust 原生解压器：条目逐个落盘并返回 manifest，前端用同一个
`Map<string, File>` 抽象按需读取。浏览器或原生能力不可用时使用 libarchive.js WASM
并在内存中提供同样的文件集合。

## 2. 会话与状态所有权

`AppState` 是前端唯一的工程状态容器。`ProjectLoadSession` 固定
`generation/projectId/sourceSha256/geometryToken` 四项身份；所有跨 `await` 的解析、
缓存恢复、Worker 结果和几何 slice 在提交前都要调用 `state.isCurrentSession()` 或
等价的 token 检查。

工程切换的顺序是：

1. 立即失效在途 generation 和 geometry token；
2. 停止线路 parser Worker，清理线路 MOD 来源缓存；
3. dispose Fragments、MOD/STL、共享几何和高亮资源；
4. 销毁线路地图和 UI 残留；
5. 由 `resetGimState()` 清空索引、文件、缓存引用和当前工程身份。

这样可以防止旧工程的迟到结果污染新工程，也避免只清空前端索引而把 WebGL 对象留在
场景中。

## 3. 缓存分层

共性缓存基础设施由 Rust SQLite、磁盘条目和前端桥接组成。业务内容按域隔离：

| 层 | 位置/接口 | 责任 |
|---|---|---|
| 项目身份 | `gim_project` | 路径、文件大小、修改时间、源 SHA、工程类型和域版本 |
| 解压条目 | `extracted/{project_id}/` + `*_gim_entry` | 原始 CBM/FAM/DEV/PHM/MOD/STL/IFC 条目，按 entry path 读取 |
| 变电语义 | `substation_*` | CBM、IFC、FileDevRelation、FAM/DEV 与几何引用链 |
| 线路语义 | `powerline_*` | CBM 图、父子关系、引用、文件统计和 FAM/DEV 属性 |
| 派生运行时 | `fragments/`、`glbcache/`、空间 semantic snapshot | 只存可校验的派生结果，不替代源 SHA 和 parser/domain 版本 |

当前域版本为 `gim-line-parser-v1`、`gim-substation-parser-v23`；兼容字段
`gim-parser-v22` 仅用于旧库诊断/迁移。几何缓存使用独立的
`geometry-cache-v6-geometry-status`，Fragments 使用绑定 `@thatopen/fragments` 与
`web-ifc` 版本的 `fragments-cache-v6` 组合键。域版本变化只失效对应域，不触发无关
工程的索引重建。

缓存校验坚持三条原则：源 SHA 和文件尺寸必须匹配；派生文件必须存在且尺寸/版本有效；
任何结构或引用完整性失败都回到对应的 cold path，不能提交 partial semantic state。
Fragments、空间语义和 DEV GLB 的具体回放规则分别写在变电文档中。

缓存管理通过 `list_cached_projects`、`get_project_diagnostic`、`validate_gim_cache`、
`delete_project_cache` 及批量读写命令提供给前端。路径进入 Rust 文件系统前经过组件校验、
canonicalize 和根目录前缀校验，拒绝 `..` 和越界路径。

## 4. 共性显示与诊断契约

`shared/` 提供 HTML 转义、CSV、显示名、GIM 基础解析门面和诊断摘要；`desktop/bridge`
只负责 Tauri invoke、文件选择、文件读取和数据库参数映射，不承载业务规则。

`perfTimings.ts` 记录共用的 session、external span、产品时刻、Long Task、JS heap、
process-tree RSS、Rust invoke 和资源 checkpoint。稳定产品时刻包括：

- `firstUsableGeometryReady` / `interactive`：首次可用几何和最小可操作界面；
- `allIfcReady`：变电全部 IFC 任务完成；
- `fullModelReady`：变电派生几何完成；
- 线路则以 semantic parser、地图数据和 UI 阶段作为域内指标。

桌面版 `Ctrl+Shift+D` 导出诊断 JSON，`Ctrl+Shift+B` 导出 benchmark JSON。导出内容保留
source SHA、commit/build/platform/runtime metadata 以及 domain profile，不用人类可读摘要
替代原始证据。

## 5. 共性 UI 投影契约

线路和变电共享同一套 DOM 外壳：工程栏、工作区轨道、导航树、主视口、对象检查器和
状态栏。业务 Runtime 只提供 ViewModel/事件，不把 CBM 原始节点或数据库连接直接交给
UI。导航树行必须保留稳定 source path、展开/选择/可见性状态和质量徽标；搜索与来源按钮
通过稳定业务 ID 回到原始条目。

对象检查器统一按“概览、参数、关系、来源”组织；长路径、GUID 和原始键是来源定位信息，
不是默认主文案。空数据、加载中、失败和降级状态分别显示，不用空数组掩盖解析失败。树、
地图/3D、属性和高亮共享同一个选择身份，工程切换时由 session 失效旧投影。

线路把语义图投影到地图和树，变电把同一对象图投影到 CBM/空间/功能系统树和 IFC/DEV
视口；底图或派生几何的降级不能改变语义选择和来源追踪。这些规则取代旧设计稿中重复
的组件简报和视觉说明；颜色、尺寸等 token 只作为实现细节维护在 `desktop/index.html`。

## 6. 下一步共性工作

- 继续保持 source identity、domain version 和派生缓存版本的显式绑定，避免新缓存字段
  退回隐式兼容。
- 把缓存校验、删除和批量读写的错误分类收敛为可观察的稳定 contract，便于线路/变电
  共享测试夹具和发布验收。
- 继续压缩 `services` 对具体 UI 的隐式依赖；新共性逻辑优先进入 `shared/` 或纯解析层，
  不把线路/变电 domain model 合并成一个大模块。
- 保持测试以格式不变量、缓存完整性、会话竞态和用户可见正确性为主；一次性复盘脚本
  和重复包装测试不进入长期套件。
