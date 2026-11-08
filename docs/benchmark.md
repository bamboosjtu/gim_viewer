# 本地批量 Benchmark

本页说明本地批量 Benchmark 的命令、输入注册、报告文件、状态判定和基线流程。覆盖 `npm run bench -- ...` 的批量与单样本命令、L0/L1/L2 输入登记、报告与匿名化规则；不覆盖测量指标定义、当前实测结果和手工测试步骤，这些分别见[测量与 Benchmark](architecture/measurement.md)、[性能基线](performance.md)和[性能测试指南](performance-guide.md)。

Benchmark 使用固定 WebView2 的原生 Release 应用，每次运行启动独立进程，顺序执行注册的工程；不以 Node 微基准代替产品加载。目录或 JSON 注册表可以直接作为输入，不需要逐个手动调用。

## 目录

- [范围与证据边界](#范围与证据边界)
- [命令行](#命令行)
- [子命令一览](#子命令一览)
- [命令与退出码](#命令与退出码)
- [运行行为](#运行行为)
- [JSON 注册表](#json-注册表)
- [在册登记与本地默认发现](#在册登记与本地默认发现)
- [报告文件与判读边界](#报告文件与判读边界)
- [状态与判定](#状态与判定)
- [匿名化与私有产物](#匿名化与私有产物)
- [比较与基线](#比较与基线)
- [相关文档](#相关文档)

## 范围与证据边界

- 实际工程、性能与内存测试只在开发者本地运行；远程 CI 不运行真实或合成工程样本。
- 开发者基础功能集合由 [`test:local`](../desktop/local-tests/README.md) 验证：仓库跟踪 [mini-samples.example.json](../desktop/local-tests/mini-samples.example.json)，开发者可直接修改为自己的变电、线路、设备 GIM 路径及 SHA。缺失样本显式跳过，已有来源的 SHA 或运行时工程类型不符则失败；跳过不构成通过。
- `test:local` 不是 L0/L1/L2 性能样本登记；性能样本沿用[性能样本登记](../benchmarks/README.md)的独立登记。
- 所有输入必须位于工作区内；产物只能写入工作区根目录的 `tmp/`、`output/`。样本目录仅被读取，系统 TEMP/TMP 不作为测试目录。

## 命令行

在 `desktop/` 执行。`--directory` 与 `--registry` 只能选一个；`--build` 必须指向 `bench build` 生成的清单。

```powershell
# 构建一次。后续命令显式传入它输出的 acceptance-build.json。
npm run bench -- build

# 一轮批量摸底：递归发现目录内全部 .gim（扩展名不区分大小写）。
npm run bench -- batch --build ../tmp/gim-bench/builds/<构建>/acceptance-build.json --directory ../demo --output ../output/benchmark-survey

# 或按 JSON 注册表执行；不要求事先完成全包清单分析。
npm run bench -- batch --build ../tmp/gim-bench/builds/<构建>/acceptance-build.json --registry ../tmp/benchmark-inputs.json --output ../output/benchmark-registered

# 基线候选：每个唯一来源一轮冷开和一轮暖开。
npm run bench -- batch --build ../tmp/gim-bench/builds/<构建>/acceptance-build.json --registry ../tmp/benchmark-inputs.json --preset baseline --output ../output/benchmark-baseline

# 需要三组重复时显式增加 -repeat 3，并使用新的输出目录。
# 测量能力自检只需要构建清单，不需要工程样本。
npm run bench -- doctor --build ../tmp/gim-bench/builds/<构建>/acceptance-build.json
```

L0/L1 的逐文件 SHA 注册表与 L2 目录清单见[性能样本登记](../benchmarks/README.md)。

## 子命令一览

CLI 支持以下子命令。参数只列关键项；完整格式以 `npm run bench` 的用法输出为准。

| 子命令 | 用途 | 关键参数 |
|---|---|---|
| `init` | 在工作区私有目录创建默认配置，已存在时不覆盖 | — |
| `samples` | 按本地默认发现扫描样本，输出路径数、唯一来源、重复数和分组提示 | — |
| `inventory` | 为已登记样本收集原生文件清单统计 | — |
| `select` | 按来源覆盖特征生成候选选择，不按耗时排序 | — |
| `freeze-profile` | 将候选选择冻结为不可变 Profile | `[--name <名称>]`，默认 `commit-gate` |
| `build` | 构建带 Benchmark 探针的原生 Release，输出 `acceptance-build.json` | — |
| `doctor` | 测量能力自检；不需要工程样本，源文件授权请求会被拒绝 | `--build <清单>` |
| `run` | 对单个已登记样本执行原生测量 | `--build <清单>`、`--sample <id>`；可选 `--mode`（`off`、`summary`、`benchmark`、`diagnostic`）、`--capture`（`cpu`、`allocations`、`heap`）与 `--worker-family dev` |
| `matrix` | 按冻结 Profile 运行重复矩阵并产出候选 | `--build <清单>`、`--profile <json>`；可选 `--repetitions <n>`、`--mode <模式>` |
| `overhead` | 测量探针自身开销，样本必须属于冻结 Profile | `--build <清单>`、`--profile <json>`、`--sample <id>` |
| `lifecycle` | 十轮开闭与资源回落自检 | `--build <清单>`、`--sample <id>`；可选 `--second-sample <id>` |
| `compare` | 比较基线与候选 | `--baseline <json>`、`--candidate <json>`；可选 `--retest-baseline <json>`、`--retest-candidate <json>` |
| `gate` | 门禁比较，要求基线带有效批准摘要 | 同 `compare` |
| `report` | 从已有结果 JSON 重新生成 HTML 报告 | `--input <json>` |
| `review-partial` | 独立复核 PARTIAL 来源证据并生成候选摘要绑定的私有记录 | `--candidate <json> --reviewer <复核者> --reason <受控代码>` |
| `approve-baseline` | 显式批准候选为基线 | `--candidate <json> --approver <批准者>`；PARTIAL 还需 `--accept-partial --partial-review <复核记录>`，首次加 `--first-partial`，后续提供 `--previous-baseline <已批准基线>` |
| `batch` | 按目录或注册表批量执行冷开、暖开与重复轮次 | `--build <清单>`；`--directory <目录>` 或 `--registry <json>`；可选 `--output <目录>`、`--anonymize`（`true`/`false`）、`--preset`（`survey`/`baseline`）、`-repeat`/`--repeat <n>`、`--timeout-seconds <n>` |

## 命令与退出码

退出码按命令类别读取，不能用同一套映射套所有命令。报告中的状态不会被退出码改写。

| 类别 | 命令 | 退出码 |
|---|---|---|
| 批量 | `batch` | `PASS`/`PARTIAL`→0；`FAIL`→1；其他→2；`CANCELLED`→130 |
| 比较与门禁 | `compare`、`gate` | `PASS`/`PARTIAL`→0；`FAIL`→1；其他（含 `INCONCLUSIVE`）→2 |
| 矩阵与开销 | `matrix`、`overhead` | `PASS`/`PARTIAL`→0；其他→2；`FAIL` 也是 2 |
| 单样本 | `run` | `PASS`/`PARTIAL`→0；`FAIL`→1；其他→2 |
| 自检 | `doctor`、`lifecycle` | 只有 `PASS`→0；其他→2 |
| 辅助命令 | `init`、`samples`、`inventory`、`select`、`freeze-profile`、`build`、`report`、`review-partial`、`approve-baseline` | 成功→0；参数或执行异常→1 |

- 缺少必需参数、未知命令或未捕获异常走统一异常路径，返回 1；上表描述的是命令完成后的结果映射。
- `batch` 是唯一安装 Ctrl+C / SIGTERM 取消控制并返回 130 的命令；取消还写入 `CANCELLED`。
- `matrix` 与 `overhead` 不把 `FAIL` 映射为 1；`approve-baseline` 不按 `PASS`/`PARTIAL`/`FAIL` 映射，成功写入返回 0，缺参数或拒绝候选时抛错返回 1。
- `doctor` 读取能力自检结论，`lifecycle` 读取开闭自检结论；两者都只有 `PASS` 返回 0。
- 报告始终保留原状态；退出码只供脚本消费。

## 运行行为

| 选项 | 默认 | 行为 |
|---|---|---|
| `--preset survey` | 是 | 每个唯一输入执行一轮冷开 |
| `--preset baseline` | — | 每个唯一输入执行一冷一暖 |
| `-repeat N` / `--repeat N` | 1 | `survey` 重复 N 组冷开；`baseline` 重复 N 组冷暖配对；重复次数冻结进 Profile，比较时须一致 |
| `--timeout-seconds N` | 3600 | 单次打开的等待上限；不是整条命令的总时间上限，动作和进程清理另有有限超时 |

- **并发。** 不要并行运行多个性能批次，也不要在采样时编译或执行其他负载。
- **构建校验。** `bench build` 会核对 Benchmark 前端探针已进入原生 EXE；旧版、普通前端或源码指纹与当前工作区不一致的构建清单会在批量打开样本前被拒绝。修改桌面源码或测量契约后重新构建，不复用旧清单。构建失败不会发布可测量的清单。
- **打开前重试。** 批量批次中，仅当样本尚未进入 `open`，且原因为 CDP、原生启动、WebView2 GPU 或 Benchmark API 基础设施故障时重试；每个计划轮次最多尝试 3 次（首次加两次重启）。
- **重试隔离。** 每次重试拥有新的原生进程、WebView profile 和调试端口；冷开还拥有新的空缓存。已进入 `open`、解析失败、缓存失败及产品正确性失败不重试。
- **重试记录与耗尽。** 重试次数和启动失败原因写入结果及私有运行日志；耗尽后保持 `INCONCLUSIVE`，暖开跳过时保留冷开的基础设施原因。
- **端口竞争。** 调试端口由运行器分配，启动前存在释放端口的竞争窗口；重试只降低瞬时故障影响，不能据此断言某次故障的根因是端口占用。
- **去重。** 相同 SHA 与相同动作路线只执行一次，其余输入标为 `DUPLICATE` 并关联首个输入；不同动作路线仍分别执行。不会根据文件大小、历史耗时或失败记录跳过某个唯一来源。目录符号链接不跟随，报告会列出拒绝访问项。
- **队列。** 批次的所有计划行在执行前写入结果。单次失败、超时、输入缺失或 SHA 不符都记录后继续；只有用户取消或报告无法安全写入才停止队列。冷开未准备好有效缓存时，对应暖开标为 `SKIPPED`，下一来源继续执行。除上述打开前基础设施故障外，失败项不自动重试；性能回退的正式独立复测由比较流程处理。
- **取消。** 运行中可按 Ctrl+C，或在该报告目录新建空的 `stop.request`。控制器取消当前任务、回收本次拥有的应用进程树，余项标为 `CANCELLED`。结果随每次状态变化落盘，浏览器刷新 HTML 即可看到进度；不覆盖已有批次目录。强制结束控制器或机器断电可能留下 `RUNNING`/`PENDING`，它们不属于成功结果。

## JSON 注册表

按文件路径的注册表默认相对 **JSON 文件所在目录**解析，也接受工作区内绝对路径。最小形式是字符串数组；推荐使用对象以绑定 SHA、分组来源与可选动作：

```json
{
  "version": "gim-batch-input-v1",
  "samples": [
    {
      "path": "../demo/substations/substation01.gim",
      "sourceSha256": "711259814db95999f5282af1871da9cb50db4548b71626637b33038b062fc390",
      "sampleTier": "L1"
    },
    {
      "path": "../demo/变电站通用设计模型/500-A3-1 三维设计.gim",
      "sourceSha256": "ea53999fec01bd7440392a21b59baa42547e842bc781cf7d32cff5994212be0b",
      "sampleTier": "L0"
    }
  ]
}
```

- `gim-batch-input-v1` 的 L0/L1 条目必须有完整 `sourceSha256`；填写后与实际不符会报错，不自动更新。
- `sampleTier` 是资料形成目的，允许未登记，不能从模型粒度推断。
- 现有 `gim-samples-v1` 私有注册表可直接输入；它的 `paths` 沿用相对工作区的语义，每个路径都列入结果。去掉路径后的匿名注册表不能用来打开源文件。
- 注册表中列出的样本路径必须位于工作区内；样本文件缺失、SHA 不符或路径越界会记录为输入错误，其余输入继续执行。

L2 可使用 `gim-batch-directories-v1`：`sampleTier` 固定为 `L2`，`directories` 列出工作区内的目录和通用组名。CLI 递归发现 GIM、计算本次 SHA 并冻结到 Profile；目录缺失、为空、链接、不可读或位于工作区外会作为输入错误报告。目录内容变化会改变 Profile，不能与原基线直接比较。参见[目录示例](../benchmarks/l2/directories.example.json)。

默认场景为打开工程并等待自动请求的表示与缓存任务结束，不自动请求全部 L2。需要精化的条目可在按路径注册表的对应样本对象上显式加入 `actions`：

```json
"actions": [
  {"kind": "dev-fine", "selector": "canonical-first-base-v1"},
  {"kind": "ifc-near", "selector": "smallest-source-canonical-small-object-v1"},
  {"kind": "ifc-fine", "selector": "smallest-source-canonical-small-object-v1"}
]
```

| `kind` | 可用 `selector` |
|---|---|
| `dev-fine` | `canonical-first-base-v1`、`canonical-first-boolean-base-v1` |
| `ifc-near` | `smallest-source-canonical-small-object-v1` |
| `ifc-fine` | `smallest-source-canonical-small-object-v1` |

找不到要求的目标会记录不完整，不能默默删去动作。近景动作完成后恢复原相机，避免引入未声明的后续精化。

## 在册登记与本地默认发现

仓库登记是精确路径集合，L2 使用目录示例。`npm run bench -- samples` 扫描开发者本地 `demo/` 的约定目录，包括 `substations/` 与 `lines/` 下全部 GIM，并报告实际发现数；它不内置期望数量。两套来源的数量可以不同。

登记项的 `workloadProfile` 仅选择冻结的场景和动作，例如全包索引回归；不修改 `PASS`/`PARTIAL`/`FAIL` 的统一判定规则。
- 批次样本只由 `--directory` 或 `--registry` 取。在册登记只选择输入，不提供判定例外；`PASS`/`PARTIAL`/`FAIL` 由统一运行证据规则判定。

## 报告文件与判读边界

| 文件 | 用途 |
|---|---|
| `report.html` | “测量结果 / 样本覆盖”两个 tab，含结果表、覆盖汇总、筛选、排序与 CSV 链接 |
| `results.csv` | 每个输入、轮次和冷暖状态的明细结果；失败和跳过行保留 |
| `errors.csv` | 需要关注的 `PARTIAL`、失败、不完整、跳过及取消行；重复别名仍保留在全量结果中 |
| `summary.csv` | 按输入和冷暖状态汇总中位数与状态计数 |
| `stages.csv` | 每个运行的阶段次数、wall time、最大值和 p50/p95/p99 区间 |
| `slow-tasks.csv`、`slow-phases.csv` | 每个运行耗时最长的十个 Worker 任务和单次阶段，使用匿名来源 ID；聚合直方图不充作单次阶段 |
| `workers.csv` | 每个 Worker 的类型、堆采样可用性、样本数、观测峰值和延迟 |
| `results.json` | 机器读取的结果、运行条件、正确性检查、工作量、比较所需指标与冷暖一致性结果 |
| `profile.json` | 本批次冻结的来源 SHA、动作、模式、轮数、超时与摘要 |

- CSV 使用 UTF-8 BOM、标准引号转义；时间字段后缀 `Ms`、内存字段后缀 `Bytes`。HTML 显示秒与 GiB。不可用字段留空，不填零。
- 字段名以本次构建生成的 `results.json` 与 `results.csv` 表头为准；本页只维护文件用途与判读边界，不逐列冻结字段名。
- 汇总分别计数 `PASS` 与 `PARTIAL`；同组轮次的 PARTIAL 签名不同时中位数留空，`coverageGroups` 与 `partialSignatures` 给出分组证据。
- 覆盖汇总同时给出有效轮次和计划轮次，以及基础设施重试次数。少于计划轮次的中位数可供诊断，但不能冒充完整基线。
- `measurementDetailStatus=aggregate-only` 表示详细时间线因容量截断，但阶段聚合、任务闭环和必要采样仍完整；截断条数保留，产品 PASS/PARTIAL 不因此变成 INCONCLUSIVE。未确认的 Worker 尾批、序号缺口或聚合丢失仍使测量不完整。Worker 批次有连续 ID、确认和任务结束标记。
- `measurementLifecycleComplete` 与 `measurementComplete` 分开：意外 Worker 终止的在途任务、超时、无理由取消和异常迟到事件使生命周期不完整；有受控原因的项目切换/关闭或 AbortError 取消可以正常结算。DEV 精细请求主动终止 Worker 时按任务身份登记取消，不豁免池内其他任务。外来 run 和重复序号使事件传输不完整，不能被静默忽略。
- `pendingCount`、`pendingSourceCount`、`pendingDigest` 单列；语义摘要已包括待归对象的身份、原因、来源、类别和 disposition。冷暖逐项比较 pending 证据。
- `geometryStructuralFingerprint` 是结构指纹，不是顶点/索引内容校验。`devContentDigest` 聚合 DEV L0 GLB 的字节 SHA，`devContentCovered` 与 `devContentComplete` 标注实际覆盖；IFC/L2 内容不在该证据范围。
- `automaticLoadMs` 是自动表示终态；`settledMs` 是任务、缓存、后台及静默窗口全部完成时刻。`writeDrainMs` 只量最后一笔 DEV 产物写晚于自动表示的部分，不代表全部写入时间。样本覆盖 tab 同时列出自动表示、缓存发布和完全结算的中位数。
- 冷暖配对复用 SQLite 数据根和 WebView2 用户数据目录；IFC LOD 的 IndexedDB 缓存位于后者。旧的独立 WebView profile 运行条件不可与新口径比较。运行中的 `progress.private.json` 每 30 秒保留一次匿名状态快照，只存工作区私有目录。变电语义无进展时，无活动工程任务 120 秒、有活动工程任务 300 秒后以 `engineering-progress-stalled` 结束为 INCONCLUSIVE；明确工程语义失败立即报 FAIL。
- 关联的 Worker 若在两个堆采样周期内终止且只有一次任务，堆值标为 `short-lived / ended-before-heap-sample`；不填零。其余 Worker 区分 `unavailable`（收到失败原因）与 `missing`（从未收到记录），两者均使测量不完整。
- 原始端点错误、调试端口、应用 PID/退出状态、进程采样尾部和 WebView2 日志尾部只写入私有运行目录（如 `tmp/gim-bench/runs/<runId>/startup.private.json`），不进入可分享报告。

| 对象 | 判读 |
|---|---|
| 线路行缓存与 pack | 显示缓存发布状态和 pack 评估；`uncommitted` 表示 SQLite 工程类型尚未提交，不能误读为 pack 文件缺失。 |
| 失败几何 | 按原因计数，不包含私有 DEV 路径。 |
| 线路时间语义 | 首次响应与自动表示完成时刻不等待线路 SQLite 写入；缓存就绪时刻必须等到 `finish` 提交。 |
| 冷开变电证据 | 必须等到 `cachePersistenceReady` 成功或失败终态后再取得数据库证据；工程 Worker 的来源派生缓存状态不代替 SQLite 核心发布。 |
| 变电缓存发布耗时 | 只在实际发布时有值；完整暖开复用既有缓存时留空。 |
| 变电结束条件 | 另含后台 Spatial 终态，避免最后一次快照碰到刚启动的 Worker。 |

## 状态与判定

| 状态 | 含义 |
|---|---|
| `PENDING` / `RUNNING` | 已计划或正在执行 |
| `PASS` | 正确性检查、测量完整性和缓存证据通过，且没有来源缺口 |
| `PARTIAL` | 有运行证据支持的来源几何异常、工程来源覆盖不完整，或者合法裸归档已打开但缓存未能持久化；不等同完整 `PASS` |
| `FAIL` | 产品检查、IFC/解析、缓存读写或未归因的进程崩溃等失败 |
| `INCONCLUSIVE` | 来源证据缺失、测量条件不完整或明确的环境挂起，无法作产品判定 |
| `INPUT_ERROR` | 输入缺失、SHA 不符、路径越界或解码器明确报告 CRC/Data/Header 错误 |
| `ERROR` | 执行环境错误或未预期异常 |
| `SKIPPED` | 暖开因冷开未就绪、缓存不可复用或输入损坏而跳过 |
| `DUPLICATE` | 相同 SHA 与动作路线的重复输入，关联首个输入 |
| `CANCELLED` | 用户取消或队列停止 |

来源证据缺失为 `INCONCLUSIVE`，IFC/解析/缓存读写或其他产品检查失败为 `FAIL`。7z 解码器有明确 CRC/Data/Header 错误时标 `INPUT_CORRUPT`，不把所有提前 EOF 或工具失败猜成损坏；不为测量单独先解压一遍。锁屏与挂起日志同时存在、且控制器观察有长间隙时标 `INFRA_SUSPEND` / INCONCLUSIVE，解锁后由开发者重跑，普通渲染崩溃仍为 FAIL。裸归档以 `INPUT_VARIANT` 单独标注；若仍无可复用缓存则标注 `CACHE_NOT_PERSISTABLE`，对应暖开为 `WARM_UNSUPPORTED`，不能成为完整冷暖基线。

### 来源几何 PARTIAL

来源几何要成为有证据的 `PARTIAL`，必须同时满足：

- 唯一失败的产品检查是 `no-failed-geometry-occurrences`，没有其他检查失败。
- 失败可见根为 0，失败原因只允许带原始范围证据的 `source-invalid` 或带原始引用证据的 `missing-dependency`，原因计数之和等于失败源数；容量/预算与解析失败仍为产品 FAIL。
- 失败源数不小于 1，失败 occurrence 不小于 1。
- `sourceEvidenceComplete` 为真，失败源集合摘要为完整 SHA256。

其他产品检查失败或出现可见根、其他失败原因时为 `FAIL`；证据不完整时为 `INCONCLUSIVE`。报告按失败几何原因、几何状态和来源引用状态分列；空 PHM 原因不计入失败。

### 工程来源 PARTIAL

工程来源覆盖判定只适用于变电工程；线路和独立设备没有这一覆盖判定。不完整原因必须非空，且只能来自 `source-graph-incomplete`、`source-reference-unresolved`、`ifc-manifest-incomplete`；出现其他原因时为 `FAIL`。

除原因限制外，还要满足以下计数与摘要前提，否则为 `INCONCLUSIVE`：

- `semanticDigest` 和 `sourceSha256` 为完整 SHA256；`placementDigest` 为 `null` 或完整 SHA256。
- `sourceCount` 不小于 1；`graphDiagnostics`、`sourceCount`、`entityCount`、`pendingEntityCount`、IFC 源数、`missing`、`ambiguous` 均为非负整数。DEV 的 `partialOccurrences` 属几何域，不参与工程来源覆盖摘要。
- 来源引用状态只含 `resolved`、`missing`、`ambiguous`，其计数为非负整数。
- 来源缺口计数至少一项为正：`missing + ambiguous + graphDiagnostics`，若含 IFC 不完整再加 `missing + extra + duplicate`，结果不小于 1。

当不完整原因包含 `ifc-manifest-incomplete` 时，还必须满足 IFC manifest 条件：

- `archiveSources`、`spatialModels`、`missing`、`extra`、`duplicate`、`parseErrors` 均为非负整数。
- `archiveSources` 不小于 1，`spatialModels` 不小于 1。
- `archiveSources − missing + extra = spatialModels − duplicate`。
- `missing + extra + duplicate` 不小于 1。
- 以上计数条件不满足时为 `INCONCLUSIVE`（IFC manifest 证据不完整）。

计数条件通过后，运行时证据还须全部成立，否则为 `FAIL`（IFC 运行时证据不完整）：

- `parseErrors = 0`。
- 运行时 IFC 源数 = 已加载 IFC 源数 = 缓存 IFC 数 = IFC 条目数。
- `missingIfc = 0`。
- `parserMatches = true`。
- `semanticValid = true`。

通过后按语义摘要、放置摘要、来源与实体计数、排序后的不完整原因、引用状态和图诊断计算覆盖摘要；含 IFC 时摘要还绑定 manifest。来源几何与工程覆盖同时成立时合并为 `combined` `PARTIAL`，保留两个缺口摘要。

SQLite 核心缓存发布单独验证；冷开缓存已发布、产品正确性为 `passed`/`partial` 时继续暖开。若冷开仅因测量证据不完整而 INCONCLUSIVE，暖开仍执行，整批门禁保持 INCONCLUSIVE；暖开以及后续基线比较必须保持同一缺口摘要、语义/几何结果和工作量。

## 匿名化与私有产物

- `--anonymize true`（默认）以完整文件 SHA256 展示样本，不显示源文件名和路径。
- `--anonymize false` 显示文件名与工作区相对路径，同时保留完整 SHA256。
- 该开关只影响报告展示，不改变 Profile、动作或测量口径。
- 源路径映射、原始错误堆栈、授权 nonce、日志与 WebView profile 保存在 `tmp/gim-bench/`，不混入可分享的 `output/` 报告。
- 分享包含真实工程名的实名报告前，应切换匿名模式或仅分享匿名产物。
- 堆采样与 Private Bytes 不是同一口径；阶段 wall time 不等于 CPU time。

## 比较与基线

```powershell
npm run bench -- compare --baseline ../output/benchmark-base/results.json --candidate ../output/benchmark-next/results.json
npm run bench -- gate --baseline ../tmp/gim-bench/<已批准基线>.approved.json --candidate ../output/benchmark-next/results.json
```

- 比较按来源、场景、冷暖状态及测量模式分别分组，不把多工程的指标混成一个中位数。
- 每组至少一次独立进程；基线与候选须有相同重复次数、机器、运行时、Profile、动作、工作量和视口。
- `PARTIAL` 只与同 SHA、同来源缺口摘要的 `PARTIAL` 比较；`PARTIAL` 与 `PASS` 的覆盖不同，结果为 `INCONCLUSIVE`。
- 普通 `compare` 可读取结构指纹和已有内容证据，但不把缺少内容证明作为普通测量失败。正式 `approve-baseline` 和 `gate` 要求 DEV L0 内容摘要覆盖所有已显示根；字节摘要或放置指纹变化为 INCONCLUSIVE，不能仅凭相同包围盒自动通过。无 DEV 表示的输入标为不适用，不伪造内容 SHA。
- 超过 10% 要求独立复测，仍超限为 `FAIL`。
- 摸底批次的 `PASS`/`PARTIAL` 仅表示该次计划执行结果。`baseline` 批次要求冷暖等价、来源缺口摘要及工作量一致；正式认可仍需探针开销、十轮生命周期与测量能力等验收。
- 完整正确性基线只接受 `PASS`。`PARTIAL` 是显式接受的覆盖基线：来源复核者先运行 `review-partial`，其记录绑定候选摘要、复核身份、时间和受控原因；另一位批准者再引用该记录，不能仅在批准命令中自报已复核。原因只接受与候选证据相符的 `source-geometry`、`engineering-coverage`、`combined-source` 或 `mixed-source`。首次须显式 `--first-partial`；本地已有同来源批准记录时 CLI 拒绝再次声明首次，后续须提供上一份已批准基线，相同来源从 PASS 退到 PARTIAL 或缺口签名变化会被拒绝。复核和批准文件以候选摘要及时间命名，保存在工作区私有 `tmp/`，不覆盖上一份记录，也不存自由文本工程名或路径。工具核对记录与身份不同，仍无法替代实际人工审阅。
- SDK 迁移不在本轮 Benchmark 范围内。完整指标口径见[测量架构](architecture/measurement.md)。

### v1 到 v2 的基线迁移

`task-phase-timeline-v1` 报告只作历史参考。v2 增加 Worker 批次确认、最终证据核对和生命周期口径；冷暖还需共用 WebView2 profile（`paired-webview-profile-v1`）。比较工具对旧条件返回 `incomparable:detailPolicy` 或缺少 profile 条件，不自动换算指标，也不复制旧批准元数据。

开发者在同一机器、固定运行时和构建方式下重新构建 Benchmark，按冻结注册表执行 L1 变电/线路至少三组独立冷暖配对，并完成 L0 关键样本、探针开销及十轮资源回落检查。核对工作量、语义/几何摘要与缓存域后，显式批准新候选。未完成的 L0 项或冷暖异常保持 INCONCLUSIVE，旧 v1 基线仅供定位变化，不参加 v2 门禁。真实样本与性能矩阵只在开发者本地运行。

```powershell
cd desktop
npm run bench -- build
npm run bench -- batch --build ../tmp/gim-bench/builds/<构建>/acceptance-build.json --registry ../benchmarks/l1/substation01-04.json --preset baseline -repeat 3 --output ../output/l1-substation-v2
npm run bench -- batch --build ../tmp/gim-bench/builds/<构建>/acceptance-build.json --registry ../benchmarks/l1/line01-06.json --preset baseline -repeat 3 --output ../output/l1-line-v2
npm run bench -- batch --build ../tmp/gim-bench/builds/<构建>/acceptance-build.json --registry ../benchmarks/l0/common-design-500kv.json --preset baseline -repeat 3 --output ../output/l0-500-v2
```

实际注册表的文件须由开发者在工作区提供并核对 SHA；命令只说明本地验收路径，不构成已执行结果。

## 相关文档

- [性能测试指南](performance-guide.md)：SLO、冷/暖步骤与手工测试路线。
- [测量与 Benchmark](architecture/measurement.md)：采集面、完整性口径与 SDK 前置门禁。
- [性能基线](performance.md)：最近一次快照的结论与验收边界。
- [性能样本登记](../benchmarks/README.md)：L0/L1/L2 目录、SHA 与运行示例。
- [本地功能测试](../desktop/local-tests/README.md)：`test:local` 基础功能样本。
- [开发指南](development.md)：环境、命令、工作区与临时目录。
- [验证](validation.md)：证据分层、自动门禁与真实复核。
