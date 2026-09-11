# 遗留技术债务

> 本文件只维护当前仍未完成、需要决策或需要补充证据的事项。
> 不记录按日期排列的过程、单次运行结果或已完成工作的复盘；当前实现以
> [架构](architecture.md)、[共性运行时](gim_common.md)、[变电 GIM](gim_substation.md)、
> [线路 GIM](gim_powerline.md) 和 [Schema](schema/README.md) 为准。每个条目在状态变化时原地更新。

## 使用约定

- `P0` 表示阻断正确性或核心使用流程，`P1` 表示明显影响效率/可维护性，`P2` 表示体验增强或低频场景。
- 只把仍然需要工程行动的事项放在这里；已经完成的功能从本表删除，并在对应实现文档中说明。
- 性能数字仅作为问题规模的当前基线，不作为按日期追加的实验日志；重新测量时更新同一条目的基线和完成条件。

## 变电工程

### P1 · 几何实例化与渲染长尾（Phase 4 结构性改造已完成）

| 字段 | 当前定义 |
|---|---|
| 状态 | Phase 4 已完成结构性改造；warm release corpus 已有证据，cold DEV 长尾仍待专项 |
| 现象 | 正常 warm 运行中 DEV GLB fast path 可以完整命中（包括合法 `empty` DEV）。现在 clean static DEV 在 session 内 template parse once，placement 节点按 bounded slices 提交；剩余 wall-clock 长尾需要真实样本 telemetry 再归因。 |
| 影响 | 变电工程已经显示语义和首批几何后，仍需很长时间才达到完整模型状态。 |
| 下一步 | 保留真实样本的 `templateParseCount`、shared/fallback、placement slice、scene commit、`worstDevPaths` 和 phase；下一轮只做 cold DEV Compiler Characterization，不与 IFC/Fragments 改造绑定。 |
| 完成条件 | 结构性 invariant 已由 unit/regression 覆盖：clean path parse≈unique DEV、placement 共享资源且不改写 geometry、A/B transform 等价、stale slice 不提交、cleanup exactly once。真实 wall-clock/RSS/Long Task 仍需 Tauri 运行证据。 |

### P1 · 几何状态可解释性（第一阶段已实现）

| 字段 | 当前定义 |
|---|---|
| 状态 | 第一阶段已实现；精确来源归因仍待补齐 |
| 现象 | `EMPTY_DEVICE_XML` 或没有自有 `SOLIDMODEL` 的装配节点仍可能没有可渲染几何；其它设备必须继续正常显示。 |
| 影响 | 属性抽屉现在能显示 session 内 DEV 的 `renderable/partial/empty/unsupported/failed` 状态、冷/暖来源和 unsupported primitive 统计，避免把 unsupported 或失败误看成 empty。 |
| 下一步 | 从 DEV/PHM 解析结果进一步填充 `empty-device-xml`、`assembly-node-without-own-geometry` 等精确原因，并让首次打开与缓存命中保持同一原因粒度；不得伪造几何，也不得阻塞其它 DEV。 |
| 完成条件 | `empty-device-xml` 与 `assembly-node-without-own-geometry` 可区分、可检索、可在缓存命中和首次打开中保持一致。 |

### P1 · Fragments 缓存默认策略

| 字段 | 当前定义 |
|---|---|
| 状态 | Final Gate：substation01/02/03 通过，substation04 因 JS heap 回归 hold；默认关闭 |
| 现象 | `ENABLE_FRAGMENTS_CACHE=false`；调试覆盖可用于 cache-off/build/hit 对照，缓存按工程 SHA、IFC 路径、Fragments/web-ifc 版本和文件大小校验。 |
| 影响 | 默认路径每次需要重新走 IFC→Fragments，变电 warm 启动仍承担解析成本。 |
| 下一步 | 只对 substation04 做 JS heap 驻留/回收归因；若通过，再复核四样本并评审 `ENABLE_FRAGMENTS_CACHE_BASE=true`。HIT composite 已拆出 `core.load`、model-added callback、`core.update(true)`；不改 IFC 顺序或 persistence。 |
| 完成条件 | cache hit 的模型数、GUID/CBM 关联、选择高亮、坐标及 IFC/MOD 相对位置与 cache-off 一致；截断、缺失、版本或源 SHA 不匹配都自动回退 IFC。 |

### P1 · Spatial Semantic Cache 运行时证据

| 字段 | 当前定义 |
|---|---|
| 状态 | v1 已实现，等待真实 Tauri corpus 重新测量 |
| 现象 | warm spatial semantic 命中只读取 derived snapshot、校验引用并 hydrate Map；miss/损坏/版本或 source SHA 不匹配才在 all-IFC 后重建。 |
| 影响 | 已移除 warm 重复 IFC STEP spatial scan；重建仍属于 post-interactive heavy task。 |
| 下一步 | 用真实样本比较 cache read/deserialize/hydrate 与 rebuild 的 p50/p95/max、RSS/JS heap，并确认 A→B stale restore/rebuild 不提交。 |
| 完成条件 | 多个真实工程的 models/nodes/objects/links/coverage/root/placement/source tracing 结构等价，坏 snapshot fail-closed，cache hit 不触碰 IFC spatial parser。 |

## 线路工程

### P1 · 杆塔 HNum/MOD lazy preview 长尾

| 字段 | 当前定义 |
|---|---|
| 状态 | 待专项定位 |
| 现象 | 选中杆塔后，来源页按需读取并解析 HNum/MOD；少数真实使用场景会延迟几十秒才显示形状。 |
| 影响 | 塔型核验反馈慢，容易被误判为来源缺失或解析失败。 |
| 下一步 | 增加 preview read、parse、SVG/Canvas render 三段互斥计时；再评估有界预览缓存或独立解析任务。 |
| 完成条件 | 预览延迟可归因且不阻塞线路树、地图和属性切换；预览明确标注为“局部骨架预览”，不把它误报为完整塔型。 |

### P2 · warm 进程树 RSS 偏高

| 字段 | 当前定义 |
|---|---|
| 状态 | 待独立进程基线 |
| 现象 | 线路 warm 浏览的进程树工作集约 0.9–1.3 GB；该指标不是 JS heap。 |
| 影响 | 长时间浏览或频繁切换工程存在内存压力。 |
| 下一步 | 在独立进程中分别测量 WebView、Worker、Tauri 后端的峰值与回收；确认归因后再决定是否引入 property lazy load。 |
| 完成条件 | 报告 JS heap、WebView RSS、Tauri 后端 RSS 的独立口径，并能证明释放工程后旧对象不再增长。 |

### P2 · line03 7z 解码

| 字段 | 当前定义 |
|---|---|
| 状态 | 待 decoder 专项 |
| 现象 | line03 冷启动的 Rust 归档解码约 13 秒，总解压约 15 秒；线路 Worker 解析不是主导阶段。 |
| 影响 | 冷启动交互时间受压缩包解码限制。 |
| 下一步 | 独立测量 7z decode、entry 落盘和调度开销，再评估解码器或归档结构；不与线路语义/地图架构改造绑定。 |
| 完成条件 | 有可重复的解码/落盘分解和安全性回归，且不改变 GIM 条目完整性、路径大小写兼容和缓存身份。 |

### P1 · 悬链线产品语义收口

| 字段 | 当前定义 |
|---|---|
| 状态 | 待产品决策与工程资料核验 |
| 现象 | 地图保留实验性 2D 弧垂示意；`KVALUE`、`MATRIX0` 的完整物理含义和工程公式尚未形成可验收规范。 |
| 影响 | 示意曲线不能当作施工/设计级悬链线，可能造成语义误读。 |
| 下一步 | 基于设计资料核验系数、单位、斜档距和挂点坐标，再决定继续示意、默认关闭或升级工程模式；交互 hit-test 必须与可见曲线共享采样。 |
| 完成条件 | 产品文案、默认开关、公式、异常数据处理和审计输出形成一套可测试的约定。 |

## 暂不排期的边界

以下能力不属于当前产品路径，不作为“进行中”事项；只有需求重新立项时才新增条目：

- 独立线路 3D Viewer；线路当前只有“模型”地图工作区，杆塔形状通过来源页局部骨架预览表达。
- shared Three.js geometry / InstancedMesh；当前 placement 会修改 `BufferGeometry`，先保持实例隔离。
- IFC Semantic Worker、Compact Line Runtime Cache；当前没有扩大这些线程/缓存边界的计划。
- PMTiles 离线底图；代码保留休眠开关，默认仍使用 OSM 在线底图或 Canvas-only 回退。

## 关联文档

- [变电性能 Benchmark](benchmark_substation.md)：Fragments RC v2 的测量契约、A/B 结果和默认策略门槛。
- [线路性能 Benchmark](benchmark_powerline.md)：线路冷/暖路径的测量契约和待补证据。
- [产品路线图](gim_viewer_product_roadmap.md)：按产品阶段维护的后续交付顺序。
