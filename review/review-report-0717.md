# GIM Viewer 评审报告（2026-07-17）

评审基线：`master @ 1fd58fc`。复核对象为 `review/review-report-0712.md`，并对 07-12 之后新增的 STD/SLD、线路悬链线、StretchedBody、离线打包相关代码进行了增量审查。本文只保留截至 07-17 仍然存在的问题；已解决项不再列出。

## 一、结论

当前代码可以构建，现有自动化测试全部通过，但**不建议将其作为可安全打开外部来源 GIM 文件的正式版本发布**。主要阻断项是 SLD 内容未经真正的 SVG/CSS 安全化即进入 Tauri WebView；此外，默认开启的悬链线存在明确的业务语义偏差，变电 MOD 仍会稳定丢失一部分图元。

若用途限定为“只打开可信内部样本的研发演示”，当前版本可继续使用，但下列 P0/P1 问题仍应在正式发布前处理。

| 级别 | 数量 | 摘要 |
|---|---:|---|
| P0 | 1 | 不可信 SLD SVG/CSS 可直接进入主 WebView |
| P1 | 4 | 悬链线语义与交互错误、MOD 图元缺失、单轴线路被误判无坐标、核心管线缺少回归保护 |
| P2 | 6 | 主编排与 Rust DB 结构债务、字符串错误、长持锁、脆弱迁移、真实容器 fixture 缺失 |
| P3 | 2 | 长期几何性能路线、矩阵统计跨样本验证 |

## 二、验证结果

| 命令 | 结果 |
|---|---|
| `npm run build` | 通过；Vite 对多个大 chunk 给出超过 500 kB 的警告 |
| `npm test` | 19 个测试文件、409 个用例全部通过 |
| `npm run test:coverage` | 通过；Statements/Lines 21.21%，Branches 82.59%，Functions 65.26% |
| `cargo test` | 4 个用例全部通过；全部集中在 `query_reachable_geometry` |

本轮未执行 `npm run tauri:build` 后的安装包/portable 交互式烟测，因此本报告不对最终分发物的启动、WebView2 运行时和真实大文件加载作通过结论。

## 三、P0 问题

### 3.1 SLD 的“安全 SVG”没有执行安全化，且输入 CSS 作用域覆盖整个应用

[sldParser.ts](../src/gim/sldParser.ts#L145) 只删除了 `defs` 的直接子节点中、类型恰为 `text/css` 或 `application/ecmascript` 的 `script`，随后在 [sldParser.ts](../src/gim/sldParser.ts#L188) 将整个 `svg.outerHTML` 命名为 `safeSvgOuterHTML`。它没有过滤：

- 其他位置或其他类型的 `script`；
- `onload`/`onclick` 等事件属性；
- `foreignObject`、外部 `href`/`xlink:href`、外部资源元素；
- 可影响应用其他节点的选择器和 CSS URL。

[sldView.ts](../src/ui/sldView.ts#L151) 又把输入文件中的 CSS 原样放进主文档的 `<style>`，并在 [sldView.ts](../src/ui/sldView.ts#L158) 重新解析、直接 append 整个 SVG。该 `<style>` 不在 Shadow DOM 中，也没有选择器作用域限制，因此即使 CSP 阻止了部分脚本执行，恶意或意外的 `body`、`*`、应用元素 ID 选择器仍可修改、遮挡或伪造整个应用 UI。

风险被 [lib.rs](../src-tauri/src/lib.rs#L81) 所描述的信任边界放大：主 WebView 中的前端可调用接受任意绝对路径的文件读取命令。当前 CSP 是重要缓解措施，但不能代替对内联 SVG/CSS 的显式白名单清洗。

**建议**：将 SLD 视为不可信文档。优先使用 SVG 元素/属性 allowlist 重新构造 DOM，禁止脚本、事件属性、`foreignObject` 和非本地引用；CSS 应做规则白名单并限定到独立 ShadowRoot。更强隔离方案是使用无 `allow-same-origin`/无脚本权限的 sandbox iframe，并通过最小消息协议传递 `gridId`。

## 四、P1 问题

### 4.1 悬链线默认启用，但当前实现既不表达物理高程，命中检测也与绘制曲线不一致

[features.ts](../src/config/features.ts#L102) 将 `ENABLE_CATENARY` 默认设为 `true`。样本研究已经确认 BLHA 是塔位中心，MATRIX0 的 x/z 可用于横担偏移和挂点高度；但 [15-wire-catenary-evidence.md](../docs/schema/15-wire-catenary-evidence.md) 仍明确记录 KVALUE 的物理含义、单位和公式、MATRIX0 y 分量以及 WIRETYPE 来源未确认。当前待决策的是实验曲线的产品定位及是否升级为工程语义悬链线，而不是“是否存在曲线代码”。

当前 [lineMapView.ts](../src/ui/lineMapView.ts#L593) 的实现存在三处具体偏差：

1. `sagMeters = KVALUE * L²`，再使用 `4t(1-t)` 作为归一化曲线；如果采用文档候选公式 `k*x*(L-x)`，中点弧垂应为 `k*L²/4`，当前值在限幅前放大了 4 倍。
2. [lineMapView.ts](../src/ui/lineMapView.ts#L621) 把“下垂”固定加到屏幕 Y 方向，完全没有使用已经保存在 `WireSegment.startElev/endElev` 中的端点高程。这会在二维地图上把导线向屏幕下方/地理南侧弯曲，而不是表达垂直高程。
3. [lineMapView.ts](../src/ui/lineMapView.ts#L912) 的 hover/click 命中仍计算鼠标到端点直线弦的距离。曲线弧垂较大时，用户点在实际可见曲线上会无法选中。

**影响**：功能开关默认开启后，用户看到的是可能误导的线路形状，且曲线显示与交互区域分离。该路径没有测试覆盖。

**建议**：在物理语义和呈现维度确认前先默认关闭；将曲线采样提取为纯函数，对公式、端点高差、限幅和 hit-test 共用同一批采样点。二维平面图若无法表达高程，应保持直线或明确标注为非地理的示意剖面。

### 4.2 7 类 MOD 图元被直接丢弃，现有样本约 4.28% 的 Entity 不生成几何

[xmlModGeometry.ts](../src/viewer/xmlModGeometry.ts#L111) 对 `PorcelainBushing`、`TerminalBlock`、`ChannelSteel`、`Table` 以及 3 类弱 schema 图元直接返回 `null`，调用方在 [xmlModGeometry.ts](../src/viewer/xmlModGeometry.ts#L404) 静默跳过这些 Entity。

按项目自己的样本统计 [08-mod-static-survey.md](../docs/schema/08-mod-static-survey.md#L479)，上述 7 类合计 1,979 / 46,250 个 Entity（约 4.28%）：

- PorcelainBushing 1,506；
- TerminalBlock 201；
- ChannelSteel 129；
- Table 109；
- RectangularFixedPlate 18；
- OffsetRectangularTable 15；
- RectangularRing 1。

这不是未知输入的理论风险，而是当前 demo 语料中可量化的模型缺件。测试目前把“返回空几何”锁成了预期行为。文档现已与代码对齐，但缺件本身仍未解决。

**建议**：至少恢复文档中已定义的 P0 简化几何；若业务选择继续不渲染，应在加载结果和 UI 中明确报告丢弃数量/类型，不能只在每种类型首次出现时写一条 console warning。

### 4.3 纯南北或纯东西线路会被误判为“未提取到可定位塔位”

[lineMapData.ts](../src/gim/lineMapData.ts#L462) 要求 `maxLat > minLat` 且 `maxLng > minLng` 才认为地图数据有效；[lineMapView.ts](../src/ui/lineMapView.ts#L1300) 又重复了同一判断。因此，只要所有塔位纬度相同或经度相同，即使有多个合法塔位和导线，也会进入 [lineProjectView.ts](../src/ui/lineProjectView.ts#L741) 的“未提取到可定位塔位”分支。

**建议**：有效性只判断是否有有限坐标点；对单轴零跨度使用最小 padding。`focusBboxByNodePaths` 已使用 `span || 0.002` 处理退化范围，可复用同一策略，并补充南北直线、东西直线和单塔三个测试。

### 4.4 核心打开/缓存/线路/UI 管线仍几乎没有自动化回归保护

覆盖率虽然从旧报告的 222 个用例增长到 409 个，但新增覆盖主要集中在纯解析器。当前总行覆盖率仍只有 21.21%，以下关键模块为 0%：

| 模块 | 行数 | 覆盖率 | 风险 |
|---|---:|---:|---|
| `services/openGimService.ts` | 1030 | 0% | Tauri/浏览器入口、缓存命中与完整解压回退 |
| `desktop/database.ts` | 855 | 0% | 全部 Tauri DB/缓存 IPC 包装 |
| `app/bootstrap.ts` | 175 | 0% | 顶层装配与快捷键 |
| `gim/lineCbmParser.ts` | 301 | 0% | 线路图构建入口 |
| `gim/lineMapData.ts` | 679 | 0% | 塔/线/跨越点与悬链线输入数据 |
| `ui/lineMapView.ts` | 1372 | 0% | 线路绘制、命中与交互 |
| `ui/lineProjectView.ts` | 1241 | 0% | 线路页面编排与底图切换 |
| `ui/sldView.ts` | 323 | 0% | 不可信 SVG 的实际挂载与 gridId 联动 |

`modAutoLoadService.ts` 只有 21.93%，`nodeInteractionService.ts` 只有 3.09%。Rust 侧仍只有 4 个测试，全部验证 `query_reachable_geometry`，迁移、缓存校验、路径工具和绝大多数 command 没有测试。

**建议**：优先补 4 组可隔离的集成测试：缓存命中/失败回退、线路 `GimGraph → LineMapData`、SLD 安全化与挂载、Tauri SQLite 临时库的 migration/validate/delete。不要以继续增加纯类型契约测试替代主流程覆盖。

## 五、P2 问题

### 5.1 `openGimService.ts` 仍是高耦合编排热点

[openGimService.ts](../src/services/openGimService.ts) 当前 1,030 行，包含 43 处动态 import。`openGimWithDialog` 位于 816-1030 行，共 215 行，仍同时处理 Tauri 对话框、文件信息、缓存校验、线路/变电两类恢复、STD/SLD 恢复、GLB 清理、完整解压回退和浏览器 input 流程。

动态 import 本身用于懒加载是合理的，问题在于分支状态和错误回退都集中在同一模块且覆盖率为 0%。建议把“缓存恢复结果”建模为明确的 discriminated union，并分离 `restoreLineProject`、`restoreSubstationProject`、`openFromSource` 与浏览器文件选择生命周期。

浏览器路径还有一个具体的生命周期缺口：[openGimService.ts](../src/services/openGimService.ts#L1007) 返回的 Promise 只在 `change` handler 中 resolve，也只在 `change` 时移除 handler；文件选择器触发 `cancel` 时没有清理。取消一次后再次打开并选择文件，旧 handler 可能与新 handler 一起执行，造成同一文件并发解析。应同时处理 `cancel`，并保证每次调用只有一个可终止的监听器。

### 5.2 `db.rs` 仍是 3,528 行单文件，重复查询模板和职责边界没有收敛

[db.rs](../src-tauri/src/db.rs) 当前仍为 3,528 行，包含 7 个 `row_to_*` 映射器、33 处 `prepare` 调用，并同时承担 schema 初始化、迁移、项目索引、线路缓存、GLB/fragment 文件、诊断、删除和几何遍历。

建议至少按 `schema/migrations`、`project_index`、`line_cache`、`geometry_cache`、`diagnostics`、`pathutil` 分模块；是否使用泛型 helper 次于先建立清晰职责边界。

### 5.3 Rust command 仍统一返回字符串错误

`db.rs` 有 39 处、连同 [lib.rs](../src-tauri/src/lib.rs) 共 41 处 `Result<_, String>`。前端只能展示或记录文本，不能稳定区分缓存损坏、文件不存在、路径非法、SQLite 锁/磁盘错误等类型，也无法基于错误类别决定“回退完整解压”还是“立即停止”。

建议引入可序列化的错误码结构（可用 `thiserror` 组织内部来源），IPC 返回 `{ code, message, context }`；用户提示保留中文 message，流程判断只依赖稳定 code。

### 5.4 `get_reachable_geometry` 持有全局 SQLite Mutex 完成查询和内存遍历

[db.rs](../src-tauri/src/db.rs#L2938) 获取唯一 `Mutex<Connection>` 后，在锁内调用 [query_reachable_geometry](../src-tauri/src/db.rs#L2958)。后者读取多张表、构建 HashMap、累计 CBM 变换并递归 DEV/PHM 引用，直到结果全部生成后才释放锁。

**影响**：大型工程查询期间，缓存管理、诊断、读取索引等其他 DB command 全部排队。当前桌面单用户场景未必立即成为故障，但它仍是后端并发扩展和交互响应的主要瓶颈。

### 5.5 6 处 `ALTER TABLE` 仍通过吞掉所有错误模拟 migration

[db.rs](../src-tauri/src/db.rs#L225) 到 374 行有 6 处 `let _ = conn.execute("ALTER TABLE ...")`。这不仅忽略“列已存在”，也会忽略数据库损坏、只读、磁盘 I/O 等真实失败，使应用在不完整 schema 上继续启动，随后在无关 command 中才报错。

建议先引入最小 `PRAGMA user_version` 顺序迁移和事务，不一定必须立刻增加第三方 migration 框架；每一步只容忍可识别的幂等状态，其他错误必须终止初始化。

### 5.6 没有仓库内真实 `.gim` 容器 fixture，头部/签名/解压链仍依赖人工样本

现有 `gimExtractor.test.ts` 主要验证手工构造 buffer；`demo/` 中的大型 `.gim` 被 gitignore，19 个测试文件都没有引用真实容器。历史上 `GIMPKGT`/`GIMPKGS` 头部差异和归档偏移搜索就是实际故障点，因此纯函数测试不足以保护 `GIMPKG* → archive offset → libarchive → 文件 Map → project type` 的完整入口。

建议制作一个经过脱敏、体积受控、可提交的最小 GIM fixture，至少各含一个 7z/ZIP 载荷变体；CI 验证头部、解压文件清单和工程类型。大型 demo 可继续只用于本地烟测。

## 六、长期与研究项（P3，非当前发布阻断）

### 6.1 SQLite 几何表、Worker 化解析和 InstancedMesh 装配尚未实施

[17-batch-load-schema.md](../docs/schema/17-batch-load-schema.md) 中规划的 SQLite `geometry_cache` 表、`xmlModParser.worker`/Worker 池和 InstancedMesh 装配在当前源码中均不存在，仍是有效的长期性能路线。

需要同时明确已经完成的部分，避免重复记账：mergeGeometries 静态合并已经把 draw call 从约 77k 降到几十；DEV 粒度 GLB 缓存也已实现。因此“draw call → 6”和“二次打开跳过逐 MOD 解析”是两条不同路线，前者尚未实施，后者已有实现但仍缺真实运行时验收。

这些工作对超大模型、核显和长期可扩展性有价值，但在没有新的性能基线证明现方案不达标前，不应列为当前发布阻断项。

### 6.2 变换矩阵统计仍只有单个变电样本

[09-transform-chain-analysis.md](../docs/schema/09-transform-chain-analysis.md) 中 `CBM TRANSFORMMATRIX` 覆盖率 53.4%、非单位占比 6.1%，以及 DEV `SUBDEVICES` 矩阵 87.8% 非单位等统计都来自当前唯一的 `demo-substation`。两个线路样本没有等价的变电 SUBDEVICES 结构，不能形成独立复核。

这些数值可以继续作为当前样本的优化和测试基线，但不能写成 GIM 通用规则。获得新的变电工程样本后，应至少复核矩阵字段覆盖率、非单位占比、旋转/缩放分布、SUBDEVICE 嵌套深度和多实例 MOD 比例。

SCH/STD/SLD 不属于“尚未解析”的剩余问题：当前已有 SCH/STD/SLD parser、三向 gridId 索引、首次打开与缓存恢复、SLD 视图及双向联动。现有三个样本中只有 `demo-substation` 各含 1 份、两个线路样本均为 0，因此“仅变电存在”仍应表述为样本事实；其真正的发布问题是本报告 3.1 的不可信 SVG/CSS 安全化不足。
