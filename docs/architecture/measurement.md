# 测量与本地 Benchmark

测量协议统一为 `gim-measurement-v1`，唯一版本常量 `MEASUREMENT_VERSION` 位于 `packages/measurement-core/src/version.mjs`，由 Collector、原生 Benchmark 报告的 `conditions.measurementVersion` 和正向测试 fixture 共用；比较与测量验收拒绝未知版本。测量核心位于 `packages/measurement-core`，不依赖 DOM、Tauri、Three 或应用状态。桌面适配器位于 `desktop/src/measurement`；原有 `perfTimings` 继续提供产品阶段与诊断，其任务阶段和原生进程内存检查点接入同一 Collector。

当前工作区采用**源码内联**：桌面端只通过 `desktop/src/measurement/core.ts` 引用测量核心源码。`check:engineering-boundaries` 禁止其他桌面模块深层引用该包，并禁止核心向桌面、DOM、Tauri、Three 或外部包导入。`package.json` 的 `exports`/`dist` 尚不是产品实际消费的安装契约；SDK 阶段会单独验证打包、声明文件和独立安装后再改为包名消费。

## 目录

- [分层与职责](#分层与职责)
- [身份与时钟](#身份与时钟)
- [采集面](#采集面)
- [模式与完整性](#模式与完整性)
- [CLI 与数据隔离](#cli-与数据隔离)
- [Operation Trace 与定点诊断](#operation-trace-与定点诊断)
- [Windows 系统诊断适配](#windows-系统诊断适配)
- [权威记录和可分享视图](#权威记录和可分享视图)
- [SDK 与进程边界](#sdk-与进程边界)
- [相关文档](#相关文档)

## 分层与职责

| 层 | 位置 | 职责 |
|---|---|---|
| 测量核心 | `packages/measurement-core/` | 事件协议、Collector、Probe、Trace 上下文、内存账本和统计；不依赖 DOM、Tauri、Three 或应用状态 |
| 桌面适配 | `desktop/src/measurement/` | 宿主/Worker 探针、任务与阶段、Trace 归属、Profile 采集、GPU/渲染观测 |
| 本地 CLI 与报告 | `desktop/scripts/benchmarks/` | 构建、批量/矩阵、比较与基线、Trace 分析与导出、系统诊断和报告 |
| 权威产物 | 工作区 `tmp/gim-bench/` | 含来源身份的候选、冻结 Profile、私有 Trace/Profile、批准记录；不随仓库分发 |
| 可分享视图 | 工作区 `output/` | 白名单派生报告，默认匿名；显式非匿名 survey 只额外展示样本文件名。`artifactRole=public-derived`，不能用于 gate、批准或正式比较 |

先行约定：**测量只观察，不决定业务任务是否有效**；产品时刻仍取 `perfTimings`，Trace 不重算原有产品时刻或聚合指标。

## 身份与时钟

事件保留 run、匿名 sample、源 SHA、构建、工程代次、几何批次、请求、Worker 实例、任务、attempt、父任务及来源匿名 ID。来源路径映射单独保存在私有侧；事件不带工程名、设备名、对象名称或文件路径。没有取得的身份是 `null`，不能推断为已经关联。Worker ID 不随池槽位复用；宿主探针捕获创建时的 Collector，旧 Worker 的迟到事件留在原 run。

同一阶段在同一 `performance.now()` 时钟域求差。Worker 初始化握手输出 `offsetMs` 与 `uncertaintyMs`，`hostTime ≈ workerTime + offsetMs`；偏差不用于计算阶段本身的耗时。CDP 采样使用采样器时钟，另记采样延迟。wall time 不是 CPU time。

任务有 queued、started、produced、ended 事件。终止会结算尚未开始和正在运行的任务；迟到结束不重复结算。produced 表示 Worker 计算已产出结果，不能代替主线程消费、场景提交、持久化完成。现有业务 RPC、超时、取消、Transferable 和池调度仍由原有实现管理，测量不决定任务是否有效。

`detailComplete` 描述完整时间线：明细容量截断使它为 false。`aggregateComplete` 保留阶段统计和任务总量，仍要求无序号间隙、非法事件、聚合组溢出、外来 run、重复序号或 Worker 批次丢失；只有纯明细容量截断可以降为 `aggregate-only` 而不改变产品 PASS/PARTIAL。此时慢任务/慢阶段榜仅供诊断，不是完整时间线或基线必需证据。`lifecycleComplete` 单独要求没有活动任务、无授权 Worker 中断、异常终止、超时、无理由取消或异常迟到事件。仅 queued、从未 started 的请求随正常 Worker 终止记为 `cancelled-before-start`，不伪造执行中断；已 started 的任务仍须有受控取消或完整结束。项目关闭/切换会先用受控原因登记取消，再终止对应的在途任务；明确的 AbortError 任务结束也记录 `abort-error`。已取消任务的受控迟到确认可计数但不重复结算。原生 `measurementComplete` 要求聚合与任务生命周期完整；进程树和 Worker 堆采样单独形成 `memoryEvidenceComplete`。产品打开结论不因内存探针缺口降为 INCONCLUSIVE，正式内存比较与基线认可仍要求该证据完整。

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
| Trace | Operation/Span/scope/dependency/wait/resource/message/milestone/health/render；Collector 有界保留，见后文 |
| CPU/Allocation/Heap Profile | 仅 `diagnostic`；主线程或指定 Worker 的有界 CDP 采样，产物留私有目录 |
| GPU/渲染 | Three 异步 Timer Query（每 Pass，最多 8 个在途、5 秒超时）；线路记录 MapLibre render 帧间隔 |
| Windows 系统诊断 | WPR/PMC 录制入口关闭（`authenticated-system-helper-required`）；离线 WPA 摘要与能力探测仍可用 |

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

高频解析与图元阶段在 Worker 内生成可合并的调用直方图，保留调用数、累计时长和分位区间。Benchmark 的 counter/memory 事件先精确进入 Collector 聚合、资源账本和观测峰值，再按 `task-phase-timeline-v2` 策略省略其逐事件 CDP 明细；Worker 批次带连续 ID、宿主确认和任务结束标记，任务、阶段、Worker 和时钟事件再通过带确认的 CDP binding 传输。报告列出按类型聚合的明细数、真正截断数和可用的前十个慢阶段；纯容量截断标记 `aggregate-only`，丢失 Worker 批次或必要聚合仍为 INCONCLUSIVE。`diagnostic` 模式仍传全部可用事件。进程树使用独立原生采样器，即使 WebView 主线程阻塞也继续采样。

DEV 模板额外保留每轮最慢 20 个槽位等待者和最久 20 个槽位占用者，并记录排队优先级、入队/获槽容量与深度、缓存读取、Worker 请求与派发排队、输入预算和 GLB 字节。`templateQueue`、`templateSlotOccupancy`、`sceneCommitQueue` 与 `placementCommit` 分列。DEV 路径只留在工作区私有诊断文件；可分享报告以 `sourceId` 关联，不把并发累计耗时当作端到端时间。

一次线路 Worker 转移可能包含万级 ArrayBuffer。资源账本仍逐 backing buffer 去重并结算；普通 Benchmark 在超过 8 个缓冲时，把该批的 acquire/transfer/release 各压成一条带 `buffers` 和 `referencedBytes` 的聚合事件。任务/阶段明细缓冲为 32,768 条，真正截断仍明确记录。`diagnostic` 模式保留逐缓冲事件，发生丢弃时仍报告不完整。

- **线路持久化。** 首屏后持久化有 `idle/saving/saved/failed` 会话状态；原生 Benchmark 等待 SQLite finish 提交，失败为明确的失败状态。`cachePublishMs` 取线路完成时刻而非首屏后的静默窗口。
- **变电缓存发布。** 冷开变电等待 `cachePersistenceReady` 的成功或失败终态，再读取 SQLite 证据；工程 Worker 的 `cacheSettled` 只表示该域安静，不代表变电核心索引已发布。`cachePublishMs` 使用实际发布时刻，失败时留空。
- **时间字段。** `modelTreeReadyMs`、`firstGeometryMs` 与 `allGeometryReadyMs` 分列工程树、首几何和基础表示齐备；`automaticLoadMs` 是自动表示终态，`settledMs` 单列任务/缓存/后台和三秒静默完成，`writeDrainMs` 只记最后 DEV 产物写晚于自动表示的部分。DEV 写入另分原生路径解析与磁盘原子写阶段，避免把 IPC、文件系统和场景提交混为一项。
- **Worker 堆。** 短于两个采样周期且已关联的 Worker 若首次堆采样前终止，报告堆指标 unavailable 与原因，不填零，也不把整轮误判为产品失败。
- **冷开不完整。** 缓存已发布但冷开仅因测量证据不足而 INCONCLUSIVE 时，暖开仍运行，正式基线继续保持 INCONCLUSIVE。
- **暖开校验。** 依据来源缓存数量、缺失数和 parser 版本；没有请求远景 LOD 的 `open` 场景不要求 `ifcFarHits`。
- **几何失败。** 只汇总受控 reason/status 与数量，不输出 DEV 路径和原始诊断文本。

子命令、参数、注册表、报告文件与退出码见[本地批量 Benchmark](../benchmark.md)。命令在 `desktop/` 执行，全部新产物位于工作区 `tmp/gim-bench/`。原始路径映射、运行授权 nonce、日志与 WebView profile 不属于可分享报告。分享报告默认使用匿名身份、数值与受控状态；显式 `--anonymize false` 的 survey 只允许保留标准方案号或已匿名验证样本的 `.gim` 文件名，不放开源 SHA、路径、原始 Profile 或批准记录。不从日志做简单文件名裁剪后当作脱敏。

可分享派生汇总写入 `output/gim-bench/`；含来源身份的候选、冻结 Profile 和验收记录保存在 `tmp/gim-bench/`。Profile 按内容摘要命名，不覆盖已有冻结版本；样本与动作选择规则一起冻结。近景检查结束返回原相机位置，避免把未声明的持续近景精化混入后续场景。`doctor` 不需要工程样本，并拒绝任何源文件授权；它只检查原生启动、工作区缓存、模块单实例、读取 RPC、Worker 堆及进程树采样。

`run --mode diagnostic --diagnostics <配置>` 支持主线程及指定 Worker 的有界 CPU、Allocation 与 Heap 采集；旧 `--capture` / `--worker-family` 转换为 Worker 配置。诊断模式不参加性能比较或基线认可。原生内存采样仅查询必要的进程信息权限，核对创建时间后才接受父子关系，避免 PID 重用将不相关进程计入。主线程轮询缺口与原生采样缺口分别记录，后者不允许用启动时的一次小数值掩盖。

`bench build` 显式构建并核验 Vite Benchmark 前端，再创建 Cargo `benchmark` feature 的原生产物；发布清单前核验 EXE 确实内嵌探针 chunk。运行器拒绝没有 `frontendProbeVerified` 凭据的旧构建，避免 CDP 已连接普通页面却重复等待 Benchmark API。原生命令只授权私有运行清单指定的匿名样本，并重新核对源 SHA；清单、源、缓存根必须在编译时绑定的工作区，清单/缓存在 `tmp/gim-bench` 下。普通产品构建拒绝 Benchmark 授权，且不导出 Benchmark UI 控制面。

正式原生候选先由 `accept-measurement` 校验并绑定同构建、同机器和同运行时的 doctor、探针开销及十轮生命周期证据，输出新的候选文件；绑定包含候选摘要和可复核的精简证据，不依赖手工编辑 JSON。`approve-baseline` 要求明确的候选文件、认可者和完整冷暖配对；PARTIAL 候选针对绑定后的文件，由另一位复核者通过 `review-partial` 生成候选摘要绑定的私有记录，批准者再以 `--accept-partial --partial-review` 引用，原因使用受控代码。首次须指定 `--first-partial`，后续须提供上一份已批准基线，防止相同来源覆盖倒退；它只成为覆盖基线，不能自动升级成完整 PASS。run/report/compare 不调用批准命令。GLB 字节变化默认 INCONCLUSIVE，仅允许导入独立网格等价性证据后显式批准对应内容变更，放置与覆盖仍须一致；CLI 不实现网格等价算法。命令和证据契约见 [Benchmark CLI](../benchmark.md#比较与基线)。超过 10% 的回退需独立复测，仍超限为 FAIL；运行条件、必要测量或认可基线缺失为 INCONCLUSIVE。10% 提交门槛由开发者本地人工控制，协议/值单元测试进入 CI；样本、性能与内存曲线只在本地执行。

## Operation Trace 与定点诊断

详细采集使用 `diagnostic`，仍共享 `MEASUREMENT_VERSION`。新增 `kind=trace` 携带 `operation`、`span`、`scope`、`dependency`、`wait`、`resource`、`message`、`milestone`、`health`、`render` 记录。Collector 在缓冲前核对 Trace producer/owner、执行器与时钟绑定，并按 producer 独立检查序号高水位；重复、缺口和非法归属同时进入接收损失与 `traceHealth`，使接收完整性不可通过。纯容量丢弃只使详细/Trace 证据不完整，不改变已收聚合值。Collector 最多保留 8192 条 Trace（关键记录优先，普通记录上限 8064 条）、4096 个活动 Span，每批最多 128 条；快照只保留活动数量及最多 64 个 ID，不复制事件。`Probe.phase()` 捕获不可变上下文并返回子上下文；`measure/measureSync` 把子上下文传给回调。原有 phase 区间仍只聚合一次。普通 Benchmark 不启用这些详细记录。

工程打开在 reset 后建立根 Operation；精化/近景等重叠动作使用同根子 Span 和独立能力 scope。默认主线程上下文始终属于根操作，异步动作须显式传递入口捕获的子上下文，不能用“最后活动的动作”推断归属。产品时刻继续取原有 perfTimings，原有指标不因 Trace 分析重算。宿主响应优先核对结果 Envelope 的运行、任务和 attempt；没有 Envelope 时仅接受唯一请求 ID 匹配，不使用 Worker 当前任务推断。归属记录最多保留 4096 项，Collector 档案最多 16 个；超出保留范围的证据不得补配新操作。

主线程和 Worker 提供有效能力窗口；Worker 初始化及每 30 秒输出分段校准，映射有效期 30 秒。新 Probe 使用独立 producer epoch；跨 run 复用时由宿主派发对应模式，首次出现的新 run 不报告保留过期。真正淘汰的旧 run 重建只记录 `worker-probe-retention-expired`，不复用已消费序号；runId 在 reset 后不可改写。任务终态仅保留状态/原因，在该 Collector 的整个 run 生命周期内有效，不按 8192 条插入序驱逐。Worker 终止区分显式项目取消、任务取消和空闲回收；未声明原因的终止计入 unexpected，不能把排队任务自动记为干净取消。同域 duration 不重算，旧的单 offset 只作历史信息，不据此证明新的跨域顺序。缺少窗口关闭、生命周期、校准或尾批时，分析输出部分覆盖。

`analyze` 离线读取最多 100000 条事件，归并生命周期和兼容区间、隔离冲突，并对明确依赖及有实例身份的槽位约束分析指定里程碑；逐任务终点只分析 duration 最大的前 16 项，记录候选总数和省略数，不为每个终点重复扫图。每个里程碑最多保留 64 条最大累计权重的等长候选，不以结束时间晚替代路径权重。父 inclusive 不再计权；没有明确前置的里程碑、未解释时隙或缺少执行边界时输出 Partial Blocking Path。等待入口/解除单列，资源约束不冒充数据依赖。`analysis.private.json` 只存归并摘要、边和 `eventRefs`，原始事件仍在 `events.jsonl`；HTML 只内嵌有界概览，内部报告链接 `trace.private.json`。Pipeline 数值显式标为可重叠 span duration 之和，不是墙钟时长。终端只打印覆盖摘要，该分析是观测解释，不预测优化收益。

`export-trace` 写入报告同目录的私有 `trace.private.json`（Chrome Trace Event JSON，Perfetto 可读），时间戳为微秒，elapsed 跨 await 使用异步轨道。只导出有映射的区间；元数据保留未映射、冲突和未闭合。GPU Query 只有 duration，挂到对应 Pass，不伪造 GPU 绝对时间。

CPU Profile 由控制器启动，单次诊断最多 8 个 capture，默认窗口 5 秒、上限 30 秒、单产物上限 256 MiB；支持预置、控制器定时和活动慢 Span 触发，也可用 `captures=[]` 仅采 Trace。slow-span 使用独立有界活动索引，溢出时标记 `slow-span-index-overflow`；活动索引溢出与历史关联截断分别报告。主线程定时器被阻塞不能回溯采样。每份产物保存请求参数、实际控制器窗口、CDP 原始窗口及观测到的上下文；窗口关联仍可能包含同 isolate 的其他工作，不能作为操作独占 CPU 证据。CDP Profile 与控制器时钟的跨域映射尚未验收，`clockMapping` 保持 unavailable，仅保留私有 `commandBracketCandidate`，不能据此归因精确 Span CPU。采样热点按 timeDeltas 估算，`cpuTimeAvailable=false`。

Three 通过公开 renderer 事件采集提交区间、帧/Pass 计数，不修改 `info.autoReset` 或重置产品计数；原先关闭自动重置时按前后差值记录。公开 `update` 边界的 `finally` 负责在绘制或监听器异常时结算失败阶段。GPU 使用可选异步 Timer Query，最多 8 个在途查询、5 秒超时，按 Pass ID 结束；重叠开始会丢弃并释放旧 query，旧 Pass 的迟到结束不能关闭新 query，无效/停止时释放。线路只通过 MapLibre 公开 render 事件记录帧间隔，不声称取得线路 GPU Pass 边界。内存账本增加登记范围的累计分配、复制、转移和按 retain 请求定义的复用计数；主线程/Worker isolate 采样与进程 Private Bytes 分开。

## Windows 系统诊断适配

WPR/PMC 系统录制入口当前关闭：显式诊断配置在窗口/缓冲校验后返回 `unavailable` / `authenticated-system-helper-required`，不启动提权、不读取计划控制的路径，也不生成 WPRP/ETL。旧的可写计划 helper 不能作为认证通道；恢复需要受保护 helper、可信根和经认证的控制器通道，见[问题与限制](../open-issues.md) L-14。`systemCapabilities` 仍探测本机 WPR、WPAExporter 与 PMC，但 `elevatedCaptureAvailable=false`。

离线 WPA 摘要仍可用于受控流程已采集的 ETL：要求本地 WPAExporter、显式 `.wpaProfile` 与内容 SHA，以及列/单位契约；PID 必须同时匹配进程创建时间。没有匹配的 owned process 实例、PID/创建时间不符或列变化时摘要标 unavailable（如 `owned-process-instance-not-matched`），不输出伪零值。ETL 原件与状态日志保留在 tmp。固定 WebView2、WPRP 与本机 WPA Profile 的实际兼容和开销仍需人工验收。

## 权威记录和可分享视图

批次 CLI 打印 `privateResults`，用于 compare、overhead、accept-measurement 和批准；新矩阵与开销报告也写入 tmp。output 内 JSON 标注 `artifactRole=public-derived`，只保留白名单统计和本次导出别名，或在显式非匿名 survey 中保留允许的 `.gim` 样本文件名，不包含源 SHA、私有摘要、原始 Profile 或批准记录。CLI 和比较入口拒绝将公开派生视图作为权威输入。旧报告仍按原契约读取，不自动改写。内部输出到 tmp 的既有文件名保持兼容。

DEV 分部结果到 Merge 的前置引用由实际 child 任务完成及 Merge 入队事件记录。分析可以独立查看该任务终点的已观测阻塞链；产品里程碑没有明确前置时仅给未归因区间，不用同一操作中耗时最长的任务补配。主线程 task phase 同时输出仅生命周期的 Trace，原有聚合计数不重复累加。预置主线程 CPU 采集等待 Profiler.start 确认后再发起工程打开；请求参数、实际时钟边界及采样方法分别保留。

## SDK 与进程边界

产品迁移顺序保持 Engineering Core → Geometry Source → Geometry Compiler；测量系统和明确认可的原生基线是前置门禁。SDK 通过可选 MetricsSink/TraceContext 接入，默认可使用 NOOP_SINK；不导入桌面采样器、全局 AppState 或日志 UI。

接口设计保留 SourceReader、SessionScope、CompilerBackend、CompilerExecutor 与只读 ModelEvidenceProvider。证据接口只提供来源、对象、属性、关系、几何及可用性，不提供 Validate 规则或占位判定。Rust 继续负责 IO/解压/SQLite；独立编译进程需可复现的编译 OOM/崩溃证据，不能从总体内存峰值直接推导出迁移结论。

## 相关文档

- [Benchmark CLI](../benchmark.md)：命令、报告、Trace/Profile 用法与批准流程。
- [性能测试指南](../performance-guide.md)：SLO、冷暖步骤与手工验收路线。
- [验证](../validation.md)：证据边界、门禁与本地性能复核规则。
- [开发指南](../development.md)：构建、测试与工作区约定。
