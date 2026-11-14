# 正确性与验证

本页维护**正确性门禁、证据边界和证据记录规则**：哪些证据能证明什么、哪些不变量必须成立、自动与人工门禁如何选择和记录。环境、命令语法与工作区约定由[开发指南](development.md)维护，本页只保留“门禁命令 → 证明什么”的映射。

实现机制、性能结果和样本统计不在本页维护：

- 当前实现见[系统架构](architecture.md)及各主题文档；
- 工程实体、三视图和目录见[工程实体模型](engineering/README.md)；
- 性能 SLO 见[性能测试指南](performance-guide.md)；权威实测与验收证据在开发者本地 `tmp/gim-bench/`，`output/` 为默认匿名派生视图（显式非匿名 survey 例外）；
- 样本身份与格式统计见[样本台账](schema/sample-corpus.md)；
- 未关闭缺陷与已接受限制见[问题与限制](open-issues.md)。

## 目录

- [证据边界](#证据边界)
- [必须成立的不变量](#必须成立的不变量)
- [自动验证](#自动验证)
- [按改动选择门禁](#按改动选择门禁)
- [真实桌面复核](#真实桌面复核)
- [移动端验证](#移动端验证)
- [证据记录](#证据记录)
- [覆盖率与静态检查](#覆盖率与静态检查)
- [相关文档](#相关文档)

## 证据边界

源包事实、当前源码、自动测试、真实桌面/移动交互属于不同证据层：

| 证据 | 能证明 | 不能证明 |
|---|---|---|
| 源包 SHA/清单/解包 | 输入身份、条目与引用存在 | 场景可达、渲染正确 |
| 单元/集成测试 | 代码契约、边界与竞态 | 真实 WebView、GPU、完整样本 |
| 真实桌面交互 | 当前构建的打开、选择、缓存、坐标 | 其他机器/其他包、长期稳定性 |
| 性能计时 | 指定输入/构件的耗时 | 不同工作量或不同构建的“提速” |
| Trace/Profile 诊断 | 单次运行的等待、阻塞候选、CPU/内存热点与未归因区间 | 产品 SLO 通过、跨构建因果或优化收益 |

同一结论必须注明输入身份、构建、缓存状态与操作路径；不能用不同构建或不同工作量的成功结果互相替代。

测试临时输入、输出、子进程 `TEMP/TMP/TMPDIR` 统一使用工作区根目录 `tmp/`，可分享报告写入 `output/`；Benchmark 的权威私有报告仍在 `tmp/`。禁止访问系统目录作为测试数据或清理目标。Node 测试入口通过工作区临时目录启动器运行，Rust 测试从编译期工作区路径取得临时目录。

测试集和对照基线由开发者自行构建。Benchmark 的权威结果保存在工作区 `tmp/` 私有报告，`output/` 默认只提供匿名派生视图；显式非匿名 survey 仅允许展示标准方案号和已匿名验证样本名，仍不能作为 gate 或批准输入。两者都只描述所记录的构建、样本和运行环境，不能将缺样本跳过或单元测试通过表述为复杂工程验收通过。

## 必须成立的不变量

0.2.3 的识别回归还需分别断言：Inventory 查询零新增 IO、单 FAM 请求不读无关 FAM、属性记录/赋值/原文范围守恒、PARTINDEX 唯一/多/无候选及双重用途、设备类型与用途/类别/边界独立、识别异常保留来源/几何、组成投影异常保留实体/来源视图。标准字段 verified 不扩大到同一行其他字段，requirementContext 不改变实际几何状态。自动测试不替代三类设备真实样本差异审查与本地性能复核。

下表按主题列出当前实现必须成立的检查要求。

| 主题 | 检查要求 |
|---|---|
| 源身份 | magic 决定类型；源改变拒绝继续；源 SHA 与缓存一致 |
| 路径 | 大小写、分隔符兼容；全局 resolver；唯一候选才挂接 |
| FAM | 原文/行号可追溯；重复行不丢；单值视图与原记录分离 |
| PARTINDEX | 按 DEV 身份关联；限制父装配子树；歧义保留；不增加 seed |
| 工程来源 | 从实际文件/CBM/DEV/IFC 建图；不接收旧展示树；缺条目/歧义/循环保留；来源完整性可核对 |
| 工程整体 | 身份不使用 F2/F3/F4、展示名、数组顺序或 Mesh；每份来源唯一主归属；未知/待归保留 |
| 表示绑定 | 按来源 ID 绑定；同名/同模板/邻近不补造；粗表示跨整体时 ambiguous；变量替换不改变选择身份 |
| 三视图 | 清册/组成/来源覆盖整体与对应来源；清册按类别、子类、名称模板分组且不合并同名实例；分组计数按实体去重；来源可追溯整体；空声明组不伪造成员 |
| 点击/拖拽 | 左键单击才选择；移动 >5 px 不选；三维点击不自动定位；相机手势不产生选择请求 |
| 递归装配 | PHM→PHM 可达；逐边矩阵；分支防环；合法重复路径保留 |
| 模板共享 | clean DEV 解析数接近 unique DEV；placement 不修改共享 geometry |
| 变换 | 非单位阵、旋转、缩放、镜像与深层路径保持；单位/轴转换只应用一次 |
| 缓存几何 | 冷/暖/raw fallback 同引用语义；坏 GLB 局部回退；失败不写完整标记 |
| IFC 顺序 | 首个 anchor 一致；模型数量、GUID 与 IFC/MOD 相对位置一致 |
| Spatial | hit 不重扫 STEP；坏 snapshot 拒绝；nodes/objects/links/placement/source 等价 |
| 选择 | 慢 A/快 B 后属性、高亮、相机、树全部属于 B；重复 B 不新增 occurrence |
| 视角历史 | 返回前结算待记录移动；失败保留历史；代次拒绝旧完成；取消后不跳回旧目的地 |
| 静态容器 | 每帧不重算静态子树；动态对象、重挂载与显式锚点更新仍传播世界矩阵 |
| 缓存视图 | 借用视图只在同一次同步解包内；返回缓冲独立、偏移为 0，不引用相邻条目 |
| 工程切换 | A 未完成时切 B：A 的 worker、slice、恢复结果不提交 B |
| 线路图 | 唯一路径节点与引用边分开；共享边界塔不丢；同塔跳线不当跨塔档 |
| 安全 | SLD 禁执行/外部资源；解压配额；异常局部来源隔离 |

## 自动验证

远程 CI 仅运行不依赖工程样本的单元测试、静态检查和构建；真实与合成工程样本、九工程对照和性能矩阵均不纳入 CI。命令语法、环境和工作区约定见[开发指南](development.md)。

| 门禁命令（`desktop/` 下） | 证明什么 |
|---|---|
| `npm test` | 快速单元测试；不启动 Cargo |
| `npm run test:sqlite` | 真实 SQLite 集成；构建一次后直接运行 harness |
| `npm run local-tests:check` | 检查跟踪的 `mini-samples.example.json`；缺样本明确跳过 |
| `npm run test:local -- --build <原生构建清单>` | 运行可用样本；skip 不计通过 |
| `npm run test:engineering:worker` | 真实 Worker/Blob/缓存/取消（headless Edge）；无工程样本功能夹具，不替代原生 IPC、真实渲染或性能验收 |
| `npm run test:measurement-tools` | 测量 CLI、Trace 分析/导出、诊断配置、WPA/系统诊断协议与正确性规则；只验证无样本协议 |
| `npm run build` | TypeScript 检查与生产分包 |
| `cargo check --manifest-path src-tauri/Cargo.toml` | Rust 编译检查 |

本地入口和可编辑的跟踪注册表见[开发者本地验收](../desktop/local-tests/README.md)。

### SQLite 集成门禁

- 独立于单元测试和样本回归；Windows CI 必须单独执行 `test:sqlite`。
- 准备阶段最多 10 分钟，通过 Cargo JSON 产物消息取得本次测试程序。
- 每次 SQLite 执行最多 30 秒，外层测试最多 60 秒。
- 输入、输出和临时 SQLite 文件位于已忽略的 `tmp/sqlite-tests/sqlite/`；每次调用独立目录，进程退出后清理。

## 按改动选择门禁

改动范围较窄时，优先运行对应的专项门禁；完整命令清单见[开发指南](development.md)。

| 改动范围 | 门禁（`desktop/` 下） |
|---|---|
| IFC 加载/转换 | `npm run test:ifc-critical`；连接几何真实指针和固定 WebView2 验证还须执行下述本地门禁，单测不代替 |
| 静态容器矩阵 | `src/viewer/__tests__/staticContainer.test.ts` |
| 视角历史 | `src/viewer/__tests__/viewHistory.test.ts`、`src/ui/__tests__/viewHistoryFeedback.test.ts` |
| 原生批读/GIMR 协议 | `bridge/__tests__/devLodCache.test.ts`、`bridge/__tests__/devLodNativeBatch.test.ts`、`bridge/__tests__/database.test.ts` |
| DEV 几何/缓存/选择 | `devGeometryWorkerClient`、`devLodRuntime`、`devGlbTemplateRuntime`、`xmlModGeometry` 对应测试 |
| 按需绘制/相机取景 | `src/viewer/__tests__/demandRendering.test.ts`、`src/viewer/__tests__/cameraFraming.test.ts` |
| 真实几何门禁 | `GIM_VERIFY_SUBSTATION01=1` 后运行 `devGeometryGate.test.ts --maxWorkers=1 --minWorkers=1` |
| 本地真实工程 | `npm run test:local` 或 `npm run bench -- batch`；缺样本与跳过须单列，不计通过 |
| 测量协议/Trace/诊断 | `npm run test:measurement-tools`；不运行工程样本，不证明真实 Trace 覆盖或系统级诊断可用 |
| 基线批准/几何等价 | `npm run bench -- accept-measurement`、`review-partial`、`approve-baseline`、`approve-geometry-change`；缺同构建证据或人工复核时保持 INCONCLUSIVE |

样本只读检查可使用[样本验证技能](../.agents/skills/gim-sample-verification/SKILL.md)，在工作区 `output/` 保存结果。

研究阶段的九工程归一化记录保存在 `research/data/engineering-wholes/`，不作为当前产品的验收输入或人工真值。当前本地门禁由开发者私有注册表与原生运行报告确定。

## 真实桌面复核

复核时固定提交、源 SHA、EXE/资产哈希、WebView 环境和缓存初始状态；通过生产入口操作，不暂停解析/编译。

### IFC 连接几何本地门禁

`test:ifc-critical` 的连接分块测试使用模拟 API，验证协议、索引边界、分块及堆替换。`npm run test:ifc-connections-local` 用匿名最小 IFC4 和真实 Node web-ifc/WASM 对照完整扫描；追加 `-- --build <当前源码对应的隔离 Benchmark Release 清单>`，在控制器拥有的固定 WebView2 进程中执行同一案例和生产读取器。两者均覆盖六分量、三角形顺序、矩阵、颜色、包围盒、重复/非顺序索引、空对象、归一化、消费等待及真实堆增长。报告保存源、WASM、读取器/案例 SHA、逐部分结果；原生分支另保存浏览器版本、构建和固定运行时指纹。失败退出非零，`nativeWebView2Verified` 仅原生分支通过时为 true，Node 通过保持 false。入口不加入 CI；真实工程连接语义、冷暖及跨机器的完整门禁仍需下列额外证据，不能用一个引擎案例替代：

- 固定本轮构建、`web-ifc` / WASM 哈希、WebView2 版本与源 SHA；选择确有连接构件和多块网格的来源，冷开、暖开各保留完整性与错误证据。
- 在本地诊断中，以同一模型、同一 ExpressId/geometryExpressID 和同一变换，对照完整 `GetIndexArray` / `GetVertexArray` 扫描与分块读取。确认 `GetVertexDataSize()` 为 Float32 元素数、指针偏移以字节为单位；逐块比较索引展开后的 position/normal 六分量、三角形数量、变换矩阵与包围盒。
- 覆盖重复/非顺序索引、多块、空几何、消费等待及 WASM 堆增长；读取前后检查数据指针有效性，记录失败对象，不将缺失对象补零。异常索引、非有限值的拒绝规则仍由无样本单测守护。
- 函数、原始 IFC、ExpressId 对照和诊断数据只存 `tmp/`；公开报告仅保留筛选后的计数、误差、可用性及省略说明。性能收益另需同构建身份可核对的固定冷暖样本对照。

### 变电至少覆盖

- 一个物理根、PARTINDEX、嵌套装配、IFC 关联对象的来源/属性/高亮/相机终态。
- A→B、重复 B、搜索、关闭、同进程重开。
- 工程组成/来源切换、来源→整体、分组选择、待归集合、粗表示歧义。
- 自动定位开/关、树/搜索定位、三维单击不移动相机、拖拽超过 5 px 不选择、Esc 清除/恢复。
- 冷/暖的根数、unique DEV、occurrence、几何状态、IFC 顺序与空间索引。
- 重复 STL 大模板按真实引用路径核对全部三角形、位置/法线、零法线回退、剪切/镜像矩阵和颜色，确认共享缓冲不合并 occurrence；超过 500 m 的单二进制 STL 核对源 SHA、独立扫描范围、三角形数和 Float32 精度。冷暖均核对内容摘要、缓存发布、失败数与完整覆盖，缺少源范围证据的普通模板仍拒绝超限。
- 默认显示不先点树，覆盖已知/未知范围、视野内外、选择/取消、远近切换、失败重试、坏缓存局部修复。

### 线路至少覆盖

- 六包根/F2/F3。
- 共享塔位。
- WIRE/CROSS。
- 塔形预览。
- 搜索。
- 树↔图。
- 缺文件降级。
- 原属性长度与几何长度分列。

### 性能验收

- 必须同时记录 First usable、Current view settled、基础表示完成三个 SLO，不能只报首屏。
- 浏览器开发模式与 Release/WebView2 结果分开报告。
- 性能优化须提示开发者本地复核。性能判定遵循 [Benchmark 决策原则](benchmark.md#性能决策原则)：以相对历史版本不回退为目标，历史正确性修复成本单列依据；内存增长上限 50%，内存换速度的收益同时列百分比、秒数、绝对耗时和整批耗时之和，由人类判断是否同等级别。≤6 GB、冷启动可交互 <10 s、完全结算 <30 s 仅作描述，不豁免相对回退。导航就绪、几何提交与可见实体绘制分别记录，旧提交时点不能与新可见时点直接混比。正确性、来源 PARTIAL 和测量缺口分列，软件建议不是批准。开发者决定复核范围和最终基线批准，远程 CI 仅验证工具协议。
- 正式基线先通过 `accept-measurement` 绑定同构建、同机器和同运行时的能力、开销及十轮生命周期证据，再执行 `approve-baseline`；几何内容变化须提供独立网格等价性验证和人工批准记录。命令与证据契约见 [Benchmark CLI](benchmark.md#比较与基线)。

### 当前已覆盖

- 本地真实工程由开发者注册到 `local-tests/` 或 `benchmarks/`；权威结果写入工作区 `tmp/gim-bench/`，`output/` 为默认匿名派生视图；来源、实体、几何和缓存证据分别判读。
- 九工程入口的研究台账守恒、固定案例与来源扫描对照属于不同验收项；旧输出与当前 parser/规则指纹不一致时不能作为本版通过证据。
- 完整实体/成员/投影金标准尚待建立。
- 生产构建的真实浏览器操作覆盖工程组成/来源、搜索、显隐、精化和工程切换。
- 真实桌面原生操作、完整九工程路线与性能矩阵仍未齐备。
- 旧 0.1.x 九工程冷/暖基线只证明旧构建，不能替代 v0.2 工程实体/三视图链路的原生性能。
- `substation01`–`substation04` 的选择隔离、L2 精化、空间语义与严格 SQLite/几何链。
- 设备样本的源/派生冷开与缓存重开、树/属性/选择、设备→线路→设备切换。
- 线路六包地图、导航、搜索和导出。
- 零 GUID、坏矩阵、异常范围、坏缓存与迟到结果的隔离路径。

### 未覆盖

- v0.2 原生三次真冷/有效暖。
- 完整集合选择与持续交互。
- 设备全库逐个人工显示。
- 大条目设备库性能/内存。
- 自动 L1 与增量连接线的完整组合边界。
- 逐台套人工归属真值。

具体未关闭项见[问题与限制](open-issues.md)。

### 分类与清册

- `npm run test:local`：对开发者登记的一变、一线、一设备运行原生打开与证据检查；缺样本不计通过。
- `npm run check:engineering-catalog -- --python`：检查共享目录与参考工具标签一致，不能证明两者归并策略一致。
- 模板测试：单独检查组成路径变化不影响清册/来源、清册使用自己的搜索索引、同名实例不合并。
- 完整九工程人工实体边界真值仍未建立。

## 移动端验证

- 基础命令：在 `app/` 运行 `npm test`、`npm run build`。
- 样本测试：先准备本地输入，缺包不允许 skip。
- 覆盖范围：唯一对象、共享塔 occurrence、物理档聚合、跳线排除、完整树可达、原始属性与 HNum 预览、JSON 恢复等价。

### 原生存储门禁

```powershell
cargo test --manifest-path crates/gim-native-core/Cargo.toml
cargo test --manifest-path app/src-tauri/Cargo.toml --lib
cargo test --manifest-path app/src-tauri/Cargo.toml six_native_imports -- --ignored --nocapture
```

最后一条必须实际执行并报告零 skip。

### 设备与系统集成

- 在指定 API/WebView/设备上验证 SAF 导入、权限/定位拒绝、折叠屏与沉浸模式。
- 模拟器数据不能替代真机性能承诺。

## 证据记录

每个结果记录：

- 输入身份。
- 构建/提交。
- 命令或操作。
- 通过/失败/跳过数。
- 环境。
- 输出位置和边界。

截图只证明可见状态；结束码、JSON 可解析、缓存命中或阶段完成都不能单独证明语义正确。

不得：

- 把 skip 计入通过。
- 把旧构建的结论用于当前构建。
- 用自动居中/整体偏移掩盖坐标问题。
- 用 draw calls 降低代替对象覆盖/坐标验证。
- 把 Worker 墙钟当 CPU 时间，或把工作量变化当单模板提速。

可重复运行材料独立保存，不追加为正文流水。

## 覆盖率与静态检查

远程 CI 的覆盖率只来自不依赖工程样本的单元测试。`desktop/` 下的 `npm run test:coverage` 执行以下下限：

| 范围 | 行/语句/函数 | 分支 |
|---|---|---|
| `engineering/` | 95% | 90% |
| `gim/` | 90% | 80% |

其余层报告覆盖率，不自动提高或更新阈值；该门禁不代表真实工程或原生性能通过。

### Python 纯逻辑测试

`python -m unittest discover -s tools/<tool>/tests -p test_pure.py` 只检查普通值的矩阵、文本、编码等契约。文件位于：

- `tools/gim_device/tests/test_pure.py`
- `tools/gim_element/tests/test_pure.py`
- `tools/gim_info/tests/test_pure.py`

CI 显式按文件名执行，不能改成不加过滤的 discover：原有 `test_core.py` 与指针/UI 测试含模型目录或归档构造，应由开发者在工作区本地运行。

其他静态检查（`npm run lint`、`npm run check:version`、`npm run check:engineering-boundaries`）的命令语法与用途见[开发指南](development.md)，本页不重复。

页面 CSP、内联样式和 `unsafe-inline` 的约束不属于本页验证规则，见[平台、安全与发布](architecture/platform.md#安全边界)。

## 相关文档

- [开发指南](development.md)：环境、命令语法、工作区与临时目录。
- [系统架构](architecture.md)：当前实现机制与跨主题不变量。
- [工程实体模型](engineering/README.md)：工程实体、三视图与目录。
- [性能测试指南](performance-guide.md)：SLO、冷暖步骤及报告判读边界。
- [样本台账](schema/sample-corpus.md)：样本身份、SHA 与统计。
- [问题与限制](open-issues.md)：未关闭缺陷与已接受限制。
- [平台、安全与发布](architecture/platform.md)：安全边界与页面策略。
- [开发者本地验收](../desktop/local-tests/README.md)：本地入口与跟踪注册表。
