# 测量与本地 Benchmark

测量协议为 `gim-measurement-v1`。纯 TypeScript 核心位于 `packages/measurement-core`，不依赖 DOM、Tauri、Three 或应用状态。桌面适配器位于 `desktop/src/measurement`；原有 `perfTimings` 继续提供产品阶段与诊断，其任务阶段和原生进程内存检查点接入同一 Collector。

当前工作区采用**源码内联**：桌面端只通过 `desktop/src/measurement/core.ts` 引用测量核心源码。`check:engineering-boundaries` 禁止其他桌面模块深层引用该包，并禁止核心向桌面、DOM、Tauri、Three 或外部包导入。`package.json` 的 `exports`/`dist` 尚不是产品实际消费的安装契约；SDK 阶段会单独验证打包、声明文件和独立安装后再改为包名消费。

## 身份与时钟

事件保留 run、匿名 sample、源 SHA、构建、工程代次、几何批次、请求、Worker 实例、任务、attempt、父任务及来源匿名 ID。来源路径映射单独保存在私有侧；事件不带工程名、设备名、对象名称或文件路径。没有取得的身份是 `null`，不能推断为已经关联。Worker ID 不随池槽位复用；宿主探针捕获创建时的 Collector，旧 Worker 的迟到事件留在原 run。

同一阶段在同一 `performance.now()` 时钟域求差。Worker 初始化握手输出 `offsetMs` 与 `uncertaintyMs`，`hostTime ≈ workerTime + offsetMs`；偏差不用于计算阶段本身的耗时。CDP 采样使用采样器时钟，另记采样延迟。wall time 不是 CPU time。

任务有 queued、started、produced、ended 事件。终止会结算尚未开始和正在运行的任务；迟到结束不重复结算。produced 表示 Worker 计算已产出结果，不能代替主线程消费、场景提交、持久化完成。现有业务 RPC、超时、取消、Transferable 和池调度仍由原有实现管理，测量不决定任务是否有效。

`detailComplete` 只描述事件传输/聚合的完整性：明细丢弃、序号间隙、非法事件、聚合组溢出、外来 run 和重复序号都使它为 false。`lifecycleComplete` 单独要求没有活动任务、无授权 Worker 中断、异常终止、超时、无理由取消或异常迟到事件。项目关闭/切换会先用受控原因登记取消，再终止对应的在途任务；明确的 AbortError 任务结束也记录 `abort-error`。已取消任务的受控迟到确认可计数但不重复结算。原生 `measurementComplete` 同时要求这两层完整，不能用 `activeTasks` 已清空替代任务成功闭环。

## 采集面

| 采集面 | 实现 |
|---|---|
| Worker 生命周期 | DEV 池、IFC 转换/区域/单对象、Spatial、Engineering/组成投影、Line Parser |
| Worker 阶段 | 执行与 Worker 内排队；DEV 来源发现/范围/Part 合并及既有解析、编译、导出阶段；IFC 初始化、模型打开、关系/子集/网格、输出背压；Engineering 读取、解码、提取、归一化、投影、编码；线路解码、图、属性 |
| 宿主阶段 | postMessage 调用、接收计数及原有 DEV/IFC task phase；产品阶段沿用 perfTimings |
| 来源缓冲 | DEV Byte LRU 的唯一底层缓冲容量；线路输入底层缓冲容量 |
| 解析缓存 | Byte LRU 的文本/IR 权重，标为 estimated |
| WASM | 已安装 web-ifc 的 HEAPU8 backing buffer 容量；不可访问时 unavailable |
| Worker 堆 | 专用本地 CLI 通过 target → 应用 Worker ID → isolate ID 关联，再请求 CDP Runtime.getHeapUsage |
| 进程树 | 原生 Private Bytes 检查点/周期采样；不平均分给 Worker |

`MemoryLedger` 提供共享所有权、复制、转移、释放及唯一容量核算；它是可追踪资源账本，不等于 JS 堆或 OS 内存。多个 TypedArray 的同一 backing buffer 只计一次。字符串/IR 权重、预算、WASM 容量、进程 Private Bytes 不相加作为“总 Worker 内存”。图形资源计数也不代表精确 GPU 显存。

阶段统计使用有界对数直方图，p50/p95/p99 返回近似区间；调用数、总时间、最大值分别保留。aggregate 阶段是一次任务内既有阶段累计值，不能把它的分位数误读为每个 primitive 调用的分位数。嵌套/并行阶段不相加为端到端时间。

## 模式与完整性

`off` 关闭可选探针，`summary` 提供汇总，`benchmark` 保留有界详细事件，`diagnostic` 与普通门禁分开。Worker 批量发送事件；Collector 有界保留详细事件、聚合组与任务，溢出/序号间隙明确报告。CLI 每秒采样可用 Worker 堆并排空事件。收到采样失败记录标为 unavailable 并保留原因；从未收到记录标为 missing；短生命周期的已映射 Worker 单列 short-lived，不补零。尾部任务排空后重新取最终 evidence，并与同一会话的最终 snapshot 对照；状态漂移为 INCONCLUSIVE。

工程语义摘要包含实体身份/类别及来源、membership 的类别/含义/disposition、关系，以及待归对象的 ID、原因、来源、类别与 disposition。待归 ID 唯一、来源存在、owner 与 membership 双向一致是独立检查；冷暖比较另核对 pending 数量、来源数和摘要。

普通 Benchmark 的 `geometryStructuralFingerprint` 仅覆盖网格数量、包围盒与变换，不能证明顶点或索引相同。DEV 基础表示已有每模板 GLB 字节 SHA；`contentEvidence` 将其按 occurrence 聚合，并核对 SHA 有效、ID 唯一及已显示根覆盖率。正式基线批准和 `gate` 要求该内容证据完整，同源候选的内容摘要或放置指纹变化返回 INCONCLUSIVE 等待复核；普通批量测量仍不遍历全量顶点重新计算 SHA。此证据仅覆盖 DEV L0 GLB，不宣称已校验 IFC 或 L2 顶点内容。

新增采集当前默认 off；原生探针开销验收完成前，不改变普通产品的采集负担。专用 Benchmark/诊断调用显式选择模式。已有 perfTimings 不受该开关影响。

当前 CLI 的原生场景记录只有在正确性、缓存域、必要指标与任务闭环均证实时才允许门禁通过。未证实的字段保持 unverified/false，输出 INCONCLUSIVE；不能手工把汇总状态改成 PASS 代替缺少的证据。来源几何异常只有在全部失败均有明确 `source-invalid` 原始范围证据或 `missing-dependency` 原始引用证据、没有其他失败时记为 PARTIAL；容量/预算失败仍为产品 FAIL。工程来源覆盖不足只有在不完整原因限于来源图缺口、来源引用缺失/歧义或 IFC manifest 不完整，且对应计数与 IFC runtime/cache 一致性成立、无其他产品失败时记为 PARTIAL。判定细节见[本地批量 Benchmark](../benchmark.md#工程来源-partial)。规则对所有样本相同，匿名缺口摘要由本次证据计算，冷暖及基线比较必须一致。SQLite 核心索引发布与 Engineering Worker 派生来源缓存分开测；来源图 partial 不自动判定 SQLite 缓存失效，也不冒充完整的工程来源缓存命中。`baseline` 默认一冷一暖，`-repeat 3` 可取得三组独立配对；完整迁移门禁还要求固定动作路线、探针开销对照和十轮资源回落验收。

批量 CLI 仅对 `open` 前的基础设施启动故障有限重试，尝试记录与最终测量分开；产品打开、解析、缓存或已开始测量后的故障不自动重试。锁屏和挂起日志同时存在、控制器观察又有长间隙时，渲染进程退出单列 `INFRA_SUSPEND` / INCONCLUSIVE，解锁后由开发者重跑；普通崩溃仍为 FAIL。报告区分计划轮次、有效轮次与实际尝试次数。原生启动诊断留在工作区私有目录，公开报告只含原因码和次数。

CDP 能力以固定运行时实测为准，协议参考 [Runtime](https://chromedevtools.github.io/devtools-protocol/tot/Runtime/) 和 [Target](https://chromedevtools.github.io/devtools-protocol/tot/Target/)。`getHeapUsage` 是 isolate 口径，`performance.memory` 不能替代独立 Worker 堆。重型 CPU profile/heap snapshot 不与普通 Benchmark 数值直接比较。

## CLI 与数据隔离

批量入口、文件夹/JSON 注册表、CSV/HTML 报告与错误处理见 [本地批量 Benchmark](../benchmark.md)。默认先执行完整批次并收集失败，不在每个样本后停下来修改产品；基线模式与一轮摸底分开。

Windows 固定运行时的文件既需要 AppContainer 读取权限，也不能带 Low 完整性标签；沙箱镜像加载策略会拒绝 Low 标签的可执行映像，表现为子进程创建错误 18。构建工具在工作区副本上设置 AppContainer RX 和 Medium 标签，包含宿主与采样器可执行文件；不关闭 GPU 或 Chromium 沙箱。运行时启动标记绑定路径、镜像修改时间和权限策略，替换文件后重新检查。相关系统契约见 [Microsoft 镜像加载策略](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-process_mitigation_image_load_policy)。

模块 Worker 的业务入口保持规范 URL；身份放在独立 bootstrap 中，通过宿主登记关联 CDP target。不能在入口模块 URL 添加身份 fragment/query：分块动态导入可能再次引用不带标记的同一入口，产生第二个模块实例和消息处理器。bootstrap 在导入期间缓冲消息，安装处理器后按顺序交付；创建失败、初始化完成与终止都会回收其 Blob URL。

高频解析与图元阶段在 Worker 内生成可合并的调用直方图，保留调用数、累计时长和分位区间。Benchmark 的 counter/memory 事件先精确进入 Collector 聚合、资源账本和观测峰值，再按 `task-phase-timeline-v2` 策略省略其逐事件 CDP 明细；Worker 批次带连续 ID、宿主确认和任务结束标记，任务、阶段、Worker 和时钟事件再通过带确认的 CDP binding 传输。报告列出按类型聚合的明细数和真正丢弃的明细数；丢弃导致相应测量 INCONCLUSIVE，不把聚合成功冒充明细完整。`diagnostic` 模式仍传全部可用事件。进程树使用独立原生采样器，即使 WebView 主线程阻塞也继续采样。

一次线路 Worker 转移可能包含万级 ArrayBuffer。资源账本仍逐 backing buffer 去重并结算；普通 Benchmark 在超过 8 个缓冲时，把该批的 acquire/transfer/release 各压成一条带 `buffers` 和 `referencedBytes` 的聚合事件。任务/阶段明细缓冲为 32,768 条，真正截断仍明确记录。`diagnostic` 模式保留逐缓冲事件，发生丢弃时仍报告不完整。

- **线路持久化。** 首屏后持久化有 `idle/saving/saved/failed` 会话状态；原生 Benchmark 等待 SQLite finish 提交，失败为明确的失败状态。`cachePublishMs` 取线路完成时刻而非首屏后的静默窗口。
- **变电缓存发布。** 冷开变电等待 `cachePersistenceReady` 的成功或失败终态，再读取 SQLite 证据；工程 Worker 的 `cacheSettled` 只表示该域安静，不代表变电核心索引已发布。`cachePublishMs` 使用实际发布时刻，失败时留空。
- **时间字段。** `automaticLoadMs` 是自动表示终态；`settledMs` 单列任务/缓存/后台和三秒静默完成，`writeDrainMs` 只记最后 DEV 产物写晚于自动表示的部分。
- **Worker 堆。** 短于两个采样周期且已关联的 Worker 若首次堆采样前终止，报告堆指标 unavailable 与原因，不填零，也不把整轮误判为产品失败。
- **冷开不完整。** 缓存已发布但冷开仅因测量证据不足而 INCONCLUSIVE 时，暖开仍运行，正式基线继续保持 INCONCLUSIVE。
- **暖开校验。** 依据来源缓存数量、缺失数和 parser 版本；没有请求远景 LOD 的 `open` 场景不要求 `ifcFarHits`。
- **几何失败。** 只汇总受控 reason/status 与数量，不输出 DEV 路径和原始诊断文本。

子命令、参数、注册表、报告文件与退出码见[本地批量 Benchmark](../benchmark.md)。命令在 `desktop/` 执行，全部新产物位于工作区 `tmp/gim-bench/`。原始路径映射、运行授权 nonce、日志与 WebView profile 不属于可分享报告。分享报告使用匿名身份、数值与受控状态；不从日志做简单文件名裁剪后当作脱敏。

汇总报告写入 `output/gim-bench/`。Profile 按内容摘要命名，不覆盖已有冻结版本；样本与动作选择规则一起冻结。近景检查结束返回原相机位置，避免把未声明的持续近景精化混入后续场景。`doctor` 不需要工程样本，并拒绝任何源文件授权；它只检查原生启动、工作区缓存、模块单实例、读取 RPC、Worker 堆及进程树采样。

`run --mode diagnostic --capture cpu|allocations|heap --worker-family <类型>` 只针对一个 Worker 采集私有诊断产物。诊断模式不参加性能比较或基线认可。原生内存采样仅查询必要的进程信息权限，核对创建时间后才接受父子关系，避免 PID 重用将不相关进程计入。主线程轮询缺口与原生采样缺口分别记录，后者不允许用启动时的一次小数值掩盖。

`bench build` 显式构建并核验 Vite Benchmark 前端，再创建 Cargo `benchmark` feature 的原生产物；发布清单前核验 EXE 确实内嵌探针 chunk。运行器拒绝没有 `frontendProbeVerified` 凭据的旧构建，避免 CDP 已连接普通页面却重复等待 Benchmark API。原生命令只授权私有运行清单指定的匿名样本，并重新核对源 SHA；清单、源、缓存根必须在编译时绑定的工作区，清单/缓存在 `tmp/gim-bench` 下。普通产品构建拒绝 Benchmark 授权，且不导出 Benchmark UI 控制面。

`approve-baseline` 要求明确的候选文件、认可者和完整冷暖配对；PARTIAL 候选还须显式 `--accept-partial --source-reviewed --partial-reason`，只成为覆盖基线，不能自动升级成完整 PASS。可提供上一份已批准基线阻止相同来源的覆盖倒退。run/report/compare 不调用它。超过 10% 的回退需独立复测，仍超限为 FAIL；运行条件、必要测量或认可基线缺失为 INCONCLUSIVE。协议/值单元测试进入 CI；样本、性能与内存曲线只在本地执行。

## SDK 与进程边界

产品迁移顺序保持 Engineering Core → Geometry Source → Geometry Compiler；测量系统和明确认可的原生基线是前置门禁。SDK 通过可选 MetricsSink/TraceContext 接入，默认可使用 NOOP_SINK；不导入桌面采样器、全局 AppState 或日志 UI。

接口设计保留 SourceReader、SessionScope、CompilerBackend、CompilerExecutor 与只读 ModelEvidenceProvider。证据接口只提供来源、对象、属性、关系、几何及可用性，不提供 Validate 规则或占位判定。Rust 继续负责 IO/解压/SQLite；独立编译进程需可复现的编译 OOM/崩溃证据，不能从总体内存峰值直接推导出迁移结论。

## 相关文档

- [Benchmark CLI](../benchmark.md)
- [性能测试指南](../performance-guide.md)
- [性能基线](../performance.md)
- [验证](../validation.md)
- [开发指南](../development.md)
