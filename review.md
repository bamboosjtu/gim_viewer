# 测量框架架构与实现评审

> 整改复核（2026-11-08）：下文是整改前的评审快照。本轮已处理 13 项：P1-1 的覆盖域隔离与 P2-3 的 IFC manifest 文档在本轮前已落实；其余条目已修改代码、契约用例或文档。新 Worker 明细协议为 `task-phase-timeline-v2`，旧基线不可直接比较。TypeScript 检查及脚本语法检查通过；按开发者要求，未运行单元测试、原生样本或性能矩阵。PARTIAL 的首次来源核对仍须由开发者在认可基线时完成，不能由程序自证。

> 评审对象：`gim-measurement-v1` 及本地 Benchmark 工具链
> 代码基线：`28e1a36` + 工作区未提交的测量重构（`correctness.mjs`、input variant、cache publication split 等）
> 评审日期：2026-11-08
> 方法：源码走查、契约测试、类型检查、边界检查、注册表/文档核对；未修改产品与样本
> 结论：**P0 未发现**。框架没有按具体样本 ID/SHA/名称决定正确性、缓存或暖开的路径，也没有 expected-defect/expected-coverage 白名单。发现 5 个 P1、5 个 P2、3 个 P3，主要集中在覆盖证据的域混用、最终证据时序、Worker 明细确认、`matrix` 旧路径和 PARTIAL 自证风险。

---

## 0. 结论摘要

| 级别 | 数量 | 主题 |
|---|---:|---|
| **P0** | **0** | 未发现测量/判断依赖具体样本 |
| P1 | 5 | 覆盖签名混入 DEV partial；最终 evidence 早于尾部排空；Worker 明细无端到端确认；matrix 未接入新缓存/变体策略；PARTIAL 完全自证 |
| P2 | 5 | summary 混合不同 PARTIAL 覆盖；`run` 的 PARTIAL 退出码与文档不一致；文档漏写 IFC manifest partial；Worker 堆 unavailable 与 missing 不分；样本级 workload 配置未显式标注 |
| P3 | 3 | `expectedRole` 残留列；裸 ZIP 变体识别不全；`defaultSources` 的 L1 文件名/期望计数 |

总体判断：**架构方向正确**。纯测量核心、源码内联边界、证据化正确性、缓存发布/覆盖拆分、启动基础设施重试、部分暖开、匿名报告都已落地；当前风险主要不是“框架依赖某个样本”，而是“证据的域不够纯、最终证据时点不够晚、部分旁路没有接入统一判定”。

---

## 1. P0 专项：是否依赖具体样本

### 1.1 审查方法

对测量框架运行时代码、CLI、注册表、文档和测试做了以下检查：

1. 搜索样本 ID/SHA/名称/路径是否进入判定分支：`gim-[0-9a-f]{16}`、`sourceSha256 ===`、`sampleId ===`、具体样本名/SHA 前缀。
2. 搜索 expected 列表/例外：`expected-defect`、`expectedDefects`、`expected-coverage`、`expectedCoverage`、`allowlist`、`whitelist`、`exception`。
3. 搜索样本级阈值/动作：`requiredRegression`、`sampleTier`、`expected:`、按样本大小/名称的特殊分支。
4. 核对 `correctness.mjs`、`profiles.mjs`、`completion.mjs`、`compare.mjs`、`batch.mjs`、`native-run.mjs`、`matrix.mjs` 的判定输入。
5. 核对注册表与文档是否声明“判定例外”；核对测试是否反向锁定“无样本 allowlist”。

### 1.2 结果

| 检查项 | 结果 | 证据 |
|---|---|---|
| 正确性按样本 ID/SHA/名称分支 | **未发现** | `correctness.mjs` 只读 `evidence` 的 checks、geometryDefects、engineeringCoverage、digests、counts；没有 sample 名称/SHA 的相等判断 |
| expected-defect / expected-coverage 列表 | **已移除** | `expected-defects.mjs`、`expected-coverage.mjs`、`benchmarks/l1/expected-defects.json` 均删除；`batch.mjs`/`native-run.mjs`/`cli.mjs` 无对应 import/option |
| Profile 中携带样本级正确性摘要 | **未发现** | `batch.test.mjs:30-36` 明确断言 `profile.json` 不含 `expectedCoverageDigest`/`expectedDefectsDigest` |
| 样本级正确性 allowlist | **未发现** | `correctness.test.mjs` 全部使用合成 evidence；`measurement.test.mjs` 的 geometry profile 测试明确使用任意 `any-dev-source`，不依赖固定样本 |
| 缓存发布/暖开按样本分支 | **未发现** | `profiles.cachePublicationAssessment` 只按 `projectType`、cache state、evidence 计数；`native-run` 的 input variant 按文件 magic，不按样本身份 |
| 注册表是否提供判定例外 | **否** | `docs/benchmark.md:99`、`benchmarks/README.md` 明确“注册表只选输入，不提供判定例外” |
| 样本级阈值 | **未发现** | 判定阈值是全局的：500 m 源范围（产品侧）、10% 回归、3 s 静默、8 buffer 聚合、32,768 明细容量；没有按样本名/SHA 的阈值 |
| 样本 ID/SHA 在框架代码中的出现 | **仅身份/分组** | `sampleId`/`sourceSha256` 用于 manifest 授权、运行条件、比较分组、匿名展示；没有用于通过/失败判定 |

**P0 结论：通过。** 当前框架不依赖某个具体样本决定 PASS/PARTIAL/FAIL、缓存有效性或暖开资格。

### 1.3 非 P0 的样本相关配置

以下确实与样本有关，但不属于“判定依赖具体样本”，应明确区分：

- `benchmarks/l0/*.json`、`benchmarks/l1/*.json` 保存路径与 SHA：这是**输入选择**，不是判定例外；文档已说明。
- `samples.mjs:41-45` 的 `defaultSources` 硬编码 L1 的 `substation01-04`/`line01-06` 文件名和 48/917/10/19/7 期望计数：只用于默认发现/登记；`expected` 没有参与 PASS/PARTIAL/FAIL，`selectSamples` 也不读取它。属于 P3 的默认便利数据。
- `profiles.mjs:7` 的 `sample.requiredRegression==='full-package-index'` 决定场景是 `open` 还是 `open-and-fidelity`，并选择动作：这是**样本级 workload 配置**，不是正确性例外；它被冻结进 Profile，基线与候选必须一致。属于 P2/P3 的可读性问题。
- 产品源码中按具体样本名书写的历史性能注释，不在测量判定路径上。

### 1.4 为什么“没有 expected 列表”不等于没有风险

这次 P0 要求的方向是正确的：**判定不应依赖手写样本名单**。但需要区分两件事：

- **样本身份依赖**（P0）：不允许；
- **样本证据依赖**（正常）：任何测量都必须读取本次样本的工作量、来源、缓存和几何证据。

当前框架做到了前者不依赖，但后者的**证据域**仍有 P1 级问题（见 P1-1），可能让同一份工程覆盖状态因 DEV 场景不同而产生不同签名；这不是“依赖某个具体样本”，但仍是测量语义缺陷。

---

## 2. 架构评估

### 2.1 分层与边界

- `packages/measurement-core` 只含 `Collector`、`Probe`、`MemoryLedger`、`DurationStats`、类型；无 DOM/Tauri/Three/应用状态。`check:engineering-boundaries` 通过（305 modules，413 type edges，210 dynamic edges）。
- 桌面适配器 `desktop/src/measurement` 负责 Worker 包装、CDP 流、证据、场景；`benchmarkHost` 只在显式 benchmark 构建安装。
- CLI 与原生采样器独立，报告匿名；私有路径/日志/nonce 留在 `tmp/gim-bench/`，公开报告只留受控状态。
- 结论：边界清晰，测量核心可独立测试；这是本框架最强的部分。

### 2.2 身份、时钟与任务

- 事件保留 run、sample、source SHA、worker、task、attempt、parent、source ID；缺失身份为 `null`，不推断关联。
- Worker 初始化握手输出 `offsetMs`/`uncertaintyMs`；阶段耗时在同一 `performance.now()` 域内计算；CDP 采样另记延迟。
- Worker ID 不复用池槽位；宿主捕获创建时的 Collector；旧 Worker 迟到事件留在原 run。
- 任务 queued/started/produced/ended 有结算；终止会结算未完成任务；迟到结束不重复结算。
- 结论：设计正确；实现上仍有“最后一批 Worker 事件无确认”的完整性问题（P1-3）。

### 2.3 采集、容量与聚合

- Collector 有界：workers 1024、active tasks 4096、phases 512、counters 512、memory 4096、detail 32768（benchmark）/8192；溢出计入 `loss`/`aggregateGroups`。
- benchmark 模式把 memory/counter 事件聚合，不进入逐事件 CDP；任务/阶段/Worker/clock 仍走带确认的 binding。
- 线路一次转移 >8 个 buffer 时，acquire/transfer/release 各压成一条聚合事件，保留 buffers/referencedBytes。
- `measurementDetailDropped` 与 `measurementAggregatedDetail` 分开，不把“有意聚合”当“截断”。
- 结论：方向正确；Worker→宿主 batch 本身没有确认，最后一批可能丢而不产生 sequence gap（P1-3）。

### 2.4 证据、正确性与 PARTIAL

- `correctness.mjs` 用统一规则：
  - 几何：唯一失败 `no-failed-geometry-occurrences`，全部 `source-invalid`、有 `source-origin-span-v1` 证据、`failedVisibleRoots=0`、source set digest/occurrence 数完整 → PARTIAL；
  - 工程覆盖：`incompleteReasons` 仅限来源图/引用/IFC manifest，且引用状态、计数、IFC runtime/cache 一致 → PARTIAL；
  - 其他产品检查失败 → FAIL；证据缺失 → INCONCLUSIVE；两者同时存在 → combined PARTIAL。
- 规则对所有样本相同，匿名 digest 由本次证据计算；这是替代 expected 列表的关键设计，方向正确。
- 但覆盖 digest 混入了 DEV partial（P1-1），且规则完全由被测运行自证（P1-5）。

### 2.5 完成、缓存与暖开

- `readyForSettle` 要求 automatic/cache/background 三域 settled、无 active task；冷开变电还要求 cachePersistence observed。
- `cachePublicationAssessment` 把 `published` 与 `coverageComplete` 拆开：engineering partial 样本不再使缓存失效；warm 在 coverage partial 时可继续，但要求 dev catalog 命中。
- 输入变体（裸 7z/ZIP）单独标 `INPUT_VARIANT`/`CACHE_NOT_PERSISTABLE`，warm 写 `WARM_UNSUPPORTED`；这是对裸归档样本的正确分类方向。
- 启动基础设施故障最多重试 3 次（2 次重启），只对 `native-cdp-unavailable`/`native-startup-failed`/GPU/benchmark API 生效，且要求 `openAttempted===false`。
- 结论：上述两类样本的分类方向已经正确；`matrix` 没有复用这套策略（P1-4）。

### 2.6 批处理、比较与基线

- 批次先写全部计划行，逐项执行；失败/跳过/重复/取消都保留；冷开未准备 cache 时 warm 跳过。
- 比较按 sample SHA、scenario、cacheState、mode 分组；身份条件（machine/runtime/profile/workload/viewport）必须一致；PARTIAL 只与同 partial signature 的 PARTIAL 比较；回归需独立复测。
- 基线认可显式 `approve-baseline`，PARTIAL 需 `--accept-partial`；非持久化 cache 不能成为基线。
- 结论：比较模型完整；summary 的 PARTIAL 分组仍不够细（P2-1），`matrix` 旁路未接入（P1-4）。

### 2.7 安全与隐私

- 原生 manifest 只允许工作区 `tmp/gim-bench` 下的清单/缓存；boot 时绑定工作区根；源 SHA 重新核对；普通构建拒绝 benchmark 授权。
- 公开报告不含路径/原始错误/日志/nonce；startup 诊断写私有 `startup.private.json`。
- 进程树采样使用受限权限并核对创建时间，避免 PID 重用。
- 结论：安全边界良好；本轮未发现新的隐私问题。

---

## 3. 发现

### P1-1 覆盖签名混入 DEV partial，工程覆盖与几何覆盖不同域

**位置**

- `desktop/src/measurement/modelEvidence.ts:82`：`engineeringCoverage.partialOccurrences = progress.workload.partial`
- `desktop/src/measurement/modelEvidence.ts:29`：`workload.partial = n(dev?.partialOccurrences)`（DEV 几何）
- `desktop/scripts/benchmarks/correctness.mjs:57-59`：`coverageDigest` 纳入 `row.partialOccurrences`

**问题**

`engineeringCoverage` 本应描述“工程来源覆盖不完整”（CBM 引用缺失/歧义、来源图缺口、IFC manifest），但 `partialOccurrences` 来自 DEV LOD 的 partial occurrence。结果是：

- 同一工程覆盖状态，在冷/暖或不同 DEV 视图请求下，`partialOccurrences` 可能不同，`coverageDigest` 随之变化，触发 `mixed-partial-coverage`/`partial-coverage-differs`，把工程覆盖判成不稳定；
- 反过来，工程覆盖的真实变化可能被 DEV partial 的数量变化掩盖；
- 报告字段 `partialOccurrences` 在覆盖上下文中会误导读者以为是工程实体 partial。

**建议**

1. 为工程覆盖增加独立的 `coveragePartialOccurrences`（例如 `engineeringSnapshot` 中 disposition 为 partial 的成员/实体数），不要复用 `workload.partial`。
2. 如果保留 DEV partial，只放在 `geometryDefects`/`workload`，不进入 `coverageDigest`。
3. 给 `correctness.test.mjs` 增加断言：改变 DEV partial 不改变 coverage digest；改变 `referenceStatuses.missing`/`graphDiagnostics` 才改变 digest。

**严重度**：P1（测量语义/签名稳定性）。

---

### P1-2 最终 evidence 早于尾部排空，可能报告旧证据

**位置**

- `desktop/scripts/benchmarks/native-run.mjs:188`：`evidence = await cdp.evaluate('...evidence()')`
- 同文件 `190-199`：排空 ack/transport
- 同文件 `200-215`：等待 active task、再次排空、最终 snapshot

**问题**

`evidence()` 在第一次 settle 后立即获取；之后仍可能有尾任务/明细批次完成。最终 `observation`/`measurement` 会刷新，但 `evidence` 不会。若尾任务改变了 workload、cache 或几何状态，报告会出现：

- `measurementComplete` 来自最终快照，而 `evidence.progress` 来自旧时点；
- `assessCorrectness` 用旧 evidence，可能漏掉尾部新增失败或 coverage 变化；
- `coverageDigest`/`workloadDigest` 与实际最终状态不一致。

**建议**

1. 在最终 drain + active task 归零后重新调用 `evidence()`（或只在最终时点调用一次），并要求 `session-stable`。
2. 记录 `evidenceAt`/`evidenceClock` 和最终 snapshot 的对应关系；如果尾部有事件，重新取证。
3. 增加一个可注入的 CDP 测试：在第一次 evidence 后、最终 drain 前完成一个 task，断言报告使用新 evidence。

**严重度**：P1（证据一致性）。

---

### P1-3 Worker→宿主明细批次缺少端到端确认，最后一批可能静默丢失

**位置**

- `desktop/src/measurement/workerProbe.ts:42-45`：`flush()` 直接 `postMessage`，无 batch id/ack
- `desktop/src/measurement/hostWorker.ts:57-66`：宿主接收 batch，`message.events.slice(0,256)`，多余事件静默截断
- `desktop/src/measurement/hostWorker.ts:113-120`：`terminate` 只发 `terminated`，不确认 worker 最后一批

**问题**

Collector 只能对**已收到**的事件做 sequence gap 检查。若 Worker 在 `terminate` 前最后一批 `postMessage` 未送达，或 batch 超过 256 被截断：

- 丢失的若是最后一批，没有后续 sequence，`detailComplete` 仍可能为 true；
- `measurementDetailDropped` 不会增加，报告看起来完整；
- Worker 的任务/阶段/占用统计可能少最后一截。

`slice(0,256)` 目前通常不会触发（worker flush 阈值 128），但它是静默路径，且没有计入 loss。

**建议**

1. Worker batch 增加单调 `batchId`，宿主逐批 ack；`terminate` 前要求最后 batch 已确认，或由 Worker 发 `flushed(lastSequence)` 终 marker。
2. 宿主记录每个 worker 的期望最后 sequence，缺失计入 `loss.detailEvents`；`detailComplete` 包含该检查。
3. 去掉静默 `slice(0,256)`，超限明确计入 loss 或拒绝批次。

**严重度**：P1（完整性可能被高估）。

---

### P1-4 `matrix` 旁路未接入 input variant/WARM_UNSUPPORTED 与 cachePublished

**位置**

- `desktop/scripts/benchmarks/matrix.mjs:18`：warm 条件只用 `cold.report.reason`、`runReadiness` 的 PASS/PARTIAL、`evidence.progress.cacheSettled`
- 未读取 `cachePublished`/`cacheFailureCode`/`inputVariant`

**问题**

`batch` 已经区分：

- 冷开缓存未发布 → warm 跳过；
- `INPUT_VARIANT + CACHE_NOT_PERSISTABLE` → `WARM_UNSUPPORTED`；
- coverage partial 且 cache published → 允许 warm。

`matrix` 仍只看 `runReadiness` 与 `cacheSettled`。一般 cacheVerified=false 会由 `runReadiness` 拦住，但 input-variant partial 在 `runReadiness` 中明确豁免 cacheVerified；`matrix` 没有读取 `cacheFailureCode`，于是会用空的 cold cache 尝试 warm，得到失败/INCONCLUSIVE，而不是 `WARM_UNSUPPORTED`。`matrix` 又是候选基线路径，可能把无效 warm 结果带入 candidate。

**建议**

1. 把 warm eligibility 抽成共享函数（复用 `cachePublicationAssessment` + `runReadiness` + input variant 判断），`batch`/`matrix` 都调用。
2. `matrix` 的 pair 结果增加 `WARM_UNSUPPORTED`、`cacheFailureCode`、partial signature。
3. 增加 matrix 的 input-variant/coverage-partial 测试。

**严重度**：P1（基线候选路径不一致）。

---

### P1-5 PARTIAL 完全由本次运行证据自证，首次基线可能冻结回归

**位置**

- `desktop/scripts/benchmarks/correctness.mjs:64-80`：只根据本次 evidence 判 partial
- `desktop/scripts/benchmarks/compare.mjs`：`approveBaseline` 接受 PARTIAL（显式 `--accept-partial`），并把 candidate 自身作为基线
- `docs/benchmark.md:112`：说明显式接受，但没有独立于候选运行的期望签名

**问题**

这是“无样本 allowlist”的必然代价：规则不再依赖具体样本，但也不再有独立于被测运行的“已知正确”覆盖签名。若产品回归导致工程来源图看起来不完整（`incompleteReasons`/`source-reference-unresolved` 且计数合理），首次 `--accept-partial` 可以把这次回归后的 coverage 签名批准为基线；之后的候选只要与这次基线一致就会通过。

`compare` 能防“相对已批准基线”的漂移，但不能防“首次基线本身选错”。

**建议**

1. 明确流程：**PASS 才能作为完整正确性基线；PARTIAL 仅作诊断/显式接受的覆盖基线**，且必须在批准记录中写明原因与审核人（已有 `partialAccepted`，补充理由字段）。
2. 对 PARTIAL 基线要求候选与**上一次已知良好**的 PASS/已接受基线对比，而不是仅自我批准；首次接受需人工核对来源证据。
3. 若未来引入 expected 签名，应作为**基线产物**而非框架内置样本名单，避免回到 P0。

**严重度**：P1（门禁风险，不是样本依赖）。

---

### P2-1 summary 中位数仍可能混合不同 PARTIAL 覆盖状态

**位置**

- `desktop/scripts/benchmarks/batch-report.mjs:27-32`：`comparable` 只按 `status==='PASS'||'PARTIAL'`，`mixedCoverage` 只检查 status 集合

**问题**

两个 PARTIAL 轮次可能有不同的 `partialSignature`（coverage digest/source set digest），但 summary 仍会把它们的中位数合并。文档要求“相同覆盖状态”才取中位数；当前只做到 PASS/PARTIAL 不混，未做到 PARTIAL 之间不混。

**建议**

- 按 `partialSignature` 分组；若一个 `(inputId, cacheState)` 内出现多个 signature，`*Median` 置空或分别列出。
- 在 `summary.csv` 增加 `partialSignatures`/`coverageGroups` 计数，便于发现混合。

**严重度**：P2（报告语义）。

---

### P2-2 `run` 的 PARTIAL 退出码与文档/其他命令不一致

**位置**

- `desktop/scripts/benchmarks/cli.mjs:80`：`process.exitCode=(... )==='PASS'?0:2`，PARTIAL 得到 2
- `docs/benchmark.md:97`：声明 PASS/PARTIAL 为 0；`batch`/`matrix`/`overhead`/`compare` 均对 PARTIAL 返回 0

**问题**

单样本 `bench run` 的 PARTIAL 会被脚本当成“不完整”而不是“部分通过”，与其他命令和文档不一致。

**建议**

- 统一为 PASS/PARTIAL 0、FAIL 1、不完整 2；或明确 `run` 是“单次运行”语义并在文档中单独列出。
- 增加一个 CLI 退出码契约测试。

**严重度**：P2。

---

### P2-3 文档未覆盖 `ifc-manifest-incomplete` 的 PARTIAL 规则

**位置**

- `desktop/scripts/benchmarks/correctness.mjs:4` 允许 `ifc-manifest-incomplete`
- 同文件 `36-49` 对 IFC manifest 计数、runtime/cache 一致性做校验
- `docs/benchmark.md:99` 只写“来源引用缺失/歧义或来源图缺口”，未提 IFC manifest
- `correctness.test.mjs` 已覆盖该分支

**问题**

实现允许 IFC manifest 不完整作为 PARTIAL，文档却只描述 CBM/引用缺口；维护者会误以为 IFC manifest 应直接 FAIL，或不知道需要哪些计数。

**建议**

- 在 `docs/benchmark.md` 的 PARTIAL 条件中加入 `ifc-manifest-incomplete`，并列出 `archiveSources/spatialModels/missing/extra/duplicate/parseErrors` 与 runtime/cache 一致性要求。
- 在 `docs/architecture/measurement.md` 同步。

**严重度**：P2。

---

### P2-4 Worker 堆 unavailable 与从未观测被合并为 missing

**位置**

- `desktop/scripts/benchmarks/native-run.mjs:227-229`：`heaps` 只收集 `availability==='available'` 的样本
- 同文件 `measurementComplete` 要求 `!missingWorkers.length`
- `WorkerHeapSampler` 对 unavailable 会发出带 reason 的记录，但 native-run 不把它放进 `heaps`

**问题**

短生命周期 Worker、目标提前结束或 CDP 超时会产生“unavailable with reason”的记录；但 `missingWorkerMemory` 把它当成“从未观测”，只报数量，不报每个 worker 的 reason。结果可能是：

- 所有 Worker 都有 unavailable 记录，但 `measurementComplete=false`，报告无法区分“采样失败”与“没看到 Worker”；
- 用户无法判断是产品 Worker 太短、CDP 不可用，还是采样器漏采样。

**建议**

- 保留每个 worker 的 `availability/reason`；`missingWorkerMemory` 只统计“完全没有记录”的 worker。
- `measurementComplete` 的策略需明确：unavailable 是否允许通过（当前不允许）；若不允许，报告应列出原因，而不是只给 missing 计数。

**严重度**：P2（可观测性/判定口径）。

---

### P2-5 样本级 workload 配置未显式标注，容易被误读为判定例外

**位置**

- `desktop/scripts/benchmarks/profiles.mjs:7`：`sample.requiredRegression==='full-package-index'` 决定 scenario/actions
- `desktop/scripts/benchmarks/samples.mjs:41-45`：默认 L1 文件名和 `expected` 计数
- `benchmarks/l0/*.json`、`benchmarks/l1/*.json`：路径/SHA 选择

**问题**

这些不是 P0 的判定依赖，但字段名 `requiredRegression` 和默认样本清单容易被误读为“这个样本有特殊通过规则”。当前它们只影响 workload 选择和登记，不参与 PASS/PARTIAL/FAIL；需要让代码和文档明确这一点。

**建议**

- 将 `requiredRegression` 改名为 `workloadProfile`/`scenarioHint`，或在文档中明确“只选场景/动作，不改判定”。
- `defaultSources` 的 `expected` 改为显式“仅用于登记提示，不参与门禁”，或移除未使用的 `expected`。
- 保持 P0 测试（profile 不含 expected digest）作为回归锁。

**严重度**：P2（可维护性/P0 边界清晰度）。

---

### P3-1 `expectedRole` 是无来源的残留列

**位置**

- `desktop/scripts/benchmarks/batch-report.mjs:42` 列定义、`:48` HTML 渲染
- 当前 `recordReport` 不再写入 `expectedRole`

**问题**

CSV/HTML 永久显示空列，增加噪声，也让读者以为存在样本级期望角色。

**建议**：移除该列，或由输入注册表显式提供并文档化；不要保留无来源字段。

**严重度**：P3。

---

### P3-2 裸 ZIP 识别只覆盖 `50 4B 03 04`

**位置**

- `desktop/scripts/benchmarks/native-run.mjs:48-49`：只识别 7z 签名和普通 ZIP local header

**问题**

空 ZIP（`50 4B 05 06`）、跨卷 ZIP（`50 4B 07 08`）不会被标为 `bare-zip`；若内容检测能打开，缓存不可持久化时只会落到通用 cache 失败，而不是 `INPUT_VARIANT`。这不是样本依赖，但会让变体分类不完整。

**建议**：用内容探测/容器解析结果判断裸归档，而不是只看一个 magic；至少补充空/跨卷 ZIP 签名。

**严重度**：P3。

---

### P3-3 `defaultSources` 的 L1 文件名和期望计数是硬编码默认值

**位置**

- `desktop/scripts/benchmarks/samples.mjs:41-45`

**问题**

默认 `samples` 命令只发现 `substation01-04`/`line01-06`，并写入 48/917/10/19/7 的期望计数；`expected` 未被校验。换一套工作区样本时，默认发现会漏项，但不会失败；这不是判定依赖，但会让“样本清单完整性”看起来比实际更强。

**建议**：默认发现改为目录通配 + 显式组配置；若保留 `expected`，在 `registerSamples` 中明确比较并报告差异，或删除该字段。

**严重度**：P3。

---

## 4. 验证

| 命令 | 结果 |
|---|---|
| `npm run test:measurement-tools` | 32/32 通过（`measurement.test.mjs`、`batch.test.mjs`、`correctness.test.mjs`） |
| `npx vitest run src/measurement` | 17/17 通过（core/hostWorker/resources/completion） |
| `npm run check:engineering-boundaries` | 通过（305 modules，413 type edges，210 dynamic edges） |
| `npx tsc --noEmit` | 通过，无输出 |
| `npm run test:acceptance-tools` | 4/4 通过 |

测试覆盖到的关键契约：

- `batch.test.mjs:30-36`：profile 不含 expected coverage/defect digest（P0 回归锁）。
- `measurement.test.mjs`：geometry profile 使用注册特征而不是固定样本身份；warm cache proof 按域校验；completion 等待 cache/background。
- `correctness.test.mjs`：source geometry/coverage/combined partial、证据缺失、产品失败、IFC manifest partial。
- `batch.test.mjs`：coverage partial 冷+暖、裸归档 `WARM_UNSUPPORTED`、启动重试、重试耗尽、产品失败不重试。

未运行：真实 L0/L1/L2 性能矩阵与原生样本重跑（按仓库约定只在开发者本地运行）。因此本文的 P1 结论基于源码/契约测试，需在下次真实批次中用报告字段验证。

---

## 5. 建议优先级

1. **P1-1**：拆开工程覆盖与 DEV partial，先修 `coverageDigest`；这会影响覆盖 partial 样本的冷/暖一致性和 PARTIAL 签名。
2. **P1-2**：最终 evidence 在 drain 后重新取证；否则报告可能自相矛盾。
3. **P1-3**：Worker batch ack/最后 sequence 确认；这是测量完整性的底线。
4. **P1-4**：`matrix` 接入共享 warm/cache 判定；否则基线候选路径会绕过新策略。
5. **P1-5**：保留 PARTIAL 显式审批，但补“首次接受需人工核对来源证据/理由”的流程与字段。
6. P2：summary partial 分组、`run` 退出码、文档 IFC manifest、Worker unavailable 口径、样本 workload 命名。
7. P3：清理残留列/默认清单/变体识别。

---

## 6. 限制

- 工作区包含未提交的测量重构；评审对象是当前文件状态，不是已发布提交。
- 未运行真实原生样本；P1-1/P1-2/P1-3 的实际触发频率需在后续批次中观测。
- 未使用操作系统级崩溃转储；本文不评价 WebView2/CDP 启动故障的根因，只评价框架对故障的分类与重试。
- `demo/`、`tmp/`、`output/` 不属于可分发包；本文不记录真实样本路径或地理信息。

---

## 7. 已关闭/不再列为问题

- expected-defect/expected-coverage 注册表与 CLI 选项已移除；`correctness.mjs` 为统一证据规则（P0 通过）。
- 启动基础设施重试已实现，`debugPort`/PID/端点错误/WebView2 日志尾部写入私有 `startup.private.json`。
- 缓存发布与覆盖完整性已拆分；engineering partial 覆盖样本不再自动判缓存失效，coverage partial 可暖开。
- 裸归档 `INPUT_VARIANT`/`CACHE_NOT_PERSISTABLE`/`WARM_UNSUPPORTED` 已实现；裸归档样本不再笼统写成 `cache-state-unverified`。
- detail counter/memory 已聚合，`measurementDetailDropped` 与 `measurementAggregatedDetail` 分开；真正的截断仍会使测量 INCONCLUSIVE。
- 线路 cache persistence、spatial 终态、暖开 IFC 校验已有专门测试；不再作为本轮缺陷列出。
