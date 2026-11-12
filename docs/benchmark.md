# 本地批量 Benchmark

本页说明本地批量 Benchmark 的命令、输入注册、报告文件、状态判定和基线流程。覆盖 `npm run bench -- ...` 的批量与单样本命令、L0/L1/L2 输入登记、报告与匿名化规则；测量指标定义见[测量与 Benchmark](architecture/measurement.md)，手工步骤见[性能测试指南](performance-guide.md)。权威结果以 CLI 打印的 `privateResults` 和 `tmp/gim-bench/` 私有报告为准；`output/` 是派生视图，可按配置展示样本别名或文件名。

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
- [详细 Trace 与 Profile](#详细-trace-与-profile)
- [相关文档](#相关文档)

## 范围与证据边界

- 实际工程、性能与内存测试只在开发者本地运行；远程 CI 不运行真实或合成工程样本。
- 性能结论必须同时记录构建（源码指纹/EXE/运行时）、样本 SHA 和运行环境；缺任一项不能作为复核依据，也不把不同条件的结果合并。
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

Windows 也可在 `desktop/` 手动执行 `powershell -ExecutionPolicy Bypass -File .\run-bench-survey.ps1`：构建一次后依次运行变电、线路和通用设计批次，分别保存输出。已完成批次中的 FAIL、PARTIAL、INPUT_ERROR 或 INCONCLUSIVE 保留在报告中，不中断后续批次；构建失败、未正常完成或缺少完成凭据才报执行异常。全部执行后输出总体状态数量，以及按工程类型、变电电压等级和冷暖状态分组的时间最短/最长值。包装脚本退出 0 表示执行及汇总完成，不表示全部样本通过；直接调用 `bench batch` 的退出码契约保持下表定义。此脚本不进入远程 CI。脚本使用带 BOM 的 UTF-8，兼容 Windows PowerShell 5.1 的中文目录解析，修改时须保留该编码。

该脚本三组批次显式使用 `--anonymize false`，公开通用设计标准方案号/文件名及已匿名的 `substation01–04`、`line01–06` 验证样本名，便于跨轮识别基准；工程 `.gim` 文件不随仓库发布。非匿名派生报告只保留文件名，源 SHA、源路径、原始 Profile 与批准记录仍留在私有目录。直接调用 CLI 的默认报告继续匿名。一次批次导出的 Profile、JSON 和 CSV 共用一组临时别名，阶段标签、Worker 堆采样状态和数值统计按受控契约保留，未知原因用省略代码表示，不能把公开派生结果用于 gate 或批准。

每批次的 `exportId` 只用于把公开输出映射回本地私有结果，不是样本身份或授权凭据。复用同一输出路径时优先查当前 controller；完成后的重复恢复按 exportId 查询该批次，历史结果不覆盖当前结果。PARTIAL 的原因类别和计数单独导出，缺陷集合签名继续用别名保留分组差异；不能仅凭相同计数合并覆盖不同的样本。

末尾时间范围分别使用首次响应 `firstResponseMs`、首次几何 `firstGeometryMs`、基础几何齐备 `allGeometryReadyMs` 和完全结算 `settledMs`，单位为秒。终端输出使用定宽文本表格，按中文显示宽度补齐、数字右对齐；变电和线路分表，表头统一注明“最短 - 最长”。只统计 PASS/PARTIAL 项已有的有限非负观测；失败、跳过和缺失值不填零，缺失项显示 `-`。变电电压优先使用报告中的 `voltageKv`，否则识别文件名电压前缀，无法识别的单列“未标注”。该范围只是本轮样本描述，不作为自动性能回退判断。

已有报告无需重跑工程，可在 `desktop/` 执行 `node scripts/with-workspace-temp.mjs scripts/benchmarks/survey-summary.mjs --substation <变电results.json> --line <线路results.json> --substation <通用设计results.json>` 生成同样的终端汇总；各报告须为同一构建已完成的批次。

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
| `run` | 对单个已登记样本执行原生测量 | `--build <清单>`、`--sample <id>`；可选 `--mode`（`off`、`summary`、`benchmark`、`diagnostic`）、`--diagnostics <配置>`；兼容 `--capture`（`cpu`、`allocations`、`heap`）与 `--worker-family dev` |
| `matrix` | 按冻结 Profile 运行重复矩阵并产出候选 | `--build <清单>`、`--profile <json>`；可选 `--repetitions <n>`、`--mode <模式>` |
| `overhead` | 测量探针自身开销，样本须属于冻结 Profile 或候选 | `--build <清单>`、`--sample <id>`，以及 `--profile <json>` 或 `--candidate <批次json>`；矩阵候选须同时提供匹配的 `--profile`；批次样本可加 `--registry <json>` / `--directory <目录>` |
| `lifecycle` | 十轮开闭与资源回落自检 | `--build <清单>`、`--sample <id>`；可选 `--second-sample <id>`、`--registry <json>` / `--directory <目录>` |
| `compare` | 比较基线与候选 | `--baseline <json>`、`--candidate <json>`；可选 `--retest-baseline <json>`、`--retest-candidate <json>`、`--output <tmp/output 下的 JSON>`、`--geometry-review <批准记录>` |
| `gate` | 门禁比较，要求基线带有效批准摘要 | 同 `compare` |
| `analyze` | 从私有运行报告生成覆盖、Span、等待和阻塞分析 | `--input <tmp 下的 report.json>` |
| `export-trace` | 导出私有 Perfetto 兼容 Chrome JSON | `--input <tmp 下的 report.json>` |
| `report` | 从已有结果 JSON 重新生成 HTML 报告 | `--input <json>` |
| `review-partial` | 独立复核 PARTIAL 来源证据并生成候选摘要绑定的私有记录 | `--candidate <json> --reviewer <复核者> --reason <受控代码>` |
| `accept-measurement` | 校验测量验收报告，输出携带验收凭据的新候选文件 | `--candidate <json> --doctor <report.json> --overhead <overhead.json> --lifecycle <report.json>` |
| `approve-baseline` | 显式批准候选为基线 | `--candidate <json> --approver <批准者>`；PARTIAL 还需 `--accept-partial --partial-review <复核记录>`，首次加 `--first-partial`，后续提供 `--previous-baseline <已批准基线>` |
| `approve-geometry-change` | 导入独立网格验证结果，生成几何内容变更批准记录 | `--baseline <已批准基线> --candidate <json> --verification <验证结果> --approver <批准者>` |
| `batch` | 按目录或注册表批量执行冷开、暖开与重复轮次 | `--build <清单>`；`--directory <目录>` 或 `--registry <json>`；可选 `--output <目录>`、`--anonymize`（`true`/`false`）、`--preset`（`survey`/`baseline`）、`-repeat`/`--repeat <n>`、`--timeout-seconds <n>` |
| `recover-batch` | 控制器被外部结束后，结算遗留 RUNNING/PENDING 行 | `--output <已停止的批次目录>`；旧批次缺所有权凭据时需显式 `--force`；只从工作区私有进度快照恢复状态，不补造耗时 |

## 命令与退出码

退出码按命令类别读取，不能用同一套映射套所有命令。报告中的状态不会被退出码改写。

| 类别 | 命令 | 退出码 |
|---|---|---|
| 批量 | `batch` | `PASS`/`PARTIAL`→0；`FAIL`→1；其他→2；`CANCELLED`→130 |
| 比较与门禁 | `compare`、`gate` | `PASS`/`PARTIAL`→0；`FAIL`→1；其他（含 `INCONCLUSIVE`）→2 |
| 矩阵与开销 | `matrix`、`overhead` | `PASS`/`PARTIAL`→0；其他→2；`FAIL` 也是 2 |
| 单样本 | `run` | `PASS`/`PARTIAL`→0；`FAIL`→1；其他→2 |
| 自检 | `doctor`、`lifecycle` | 只有 `PASS`→0；其他→2 |
| 辅助命令 | `init`、`samples`、`inventory`、`select`、`freeze-profile`、`build`、`report`、`recover-batch`、`review-partial`、`accept-measurement`、`approve-baseline`、`approve-geometry-change` | 成功→0；参数或执行异常→1 |

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
- **写出。** 运行中更新私有 `results.json` 检查点，公开侧更新 `status.json` 和 `report.html`。HTML 保持完整报告布局，展示已完成结果、四个里程碑、未完成状态、覆盖汇总和筛选；只投影报告头和结果行，不遍历全量诊断表。状态计数及检查点时间不代表控制器仍存活。完整 CSV、诊断表和结果 JSON 在结束或恢复后统一生成；运行中不显示尚未生成的下载链接。`status.json.reportReady=true` 表示本次完整导出已完成；该文件是公开派生视图，不能进入 gate 或批准链。公开冻结 `profile.json` 的 `exportId` 绑定私有权威结果，运行页与最终报告复用本次导出的别名，历史批次不能抢占当前输出。
- **构建校验。** `bench build` 会核对 Benchmark 前端探针已进入原生 EXE；旧版、普通前端或源码指纹与当前工作区不一致的构建清单会在批量打开样本前被拒绝。修改桌面源码或测量契约后重新构建，不复用旧清单。构建失败不会发布可测量的清单。
- **打开前重试。** 批量批次中，仅当样本尚未进入 `open`，且原因为 CDP、原生启动、WebView2 GPU 或 Benchmark API 基础设施故障时重试；每个计划轮次最多尝试 3 次（首次加两次重启）。
- **重试隔离。** 每次重试拥有新的原生进程、WebView profile 和调试端口；冷开还拥有新的空缓存。已进入 `open`、解析失败、缓存失败及产品正确性失败不重试。
- **重试记录与耗尽。** 重试次数和启动失败原因写入结果及私有运行日志；耗尽后保持 `INCONCLUSIVE`，暖开跳过时保留冷开的基础设施原因。
- **端口竞争。** 调试端口由运行器分配，启动前存在释放端口的竞争窗口；重试只降低瞬时故障影响，不能据此断言某次故障的根因是端口占用。
- **去重。** 相同 SHA 与相同动作路线只执行一次，其余输入标为 `DUPLICATE` 并关联首个输入；不同动作路线仍分别执行。不会根据文件大小、历史耗时或失败记录跳过某个唯一来源。目录符号链接不跟随，报告会列出拒绝访问项。
- **队列。** 批次的所有计划行在执行前写入结果。单次失败、超时、输入缺失或 SHA 不符都记录后继续；只有用户取消或报告无法安全写入才停止队列。冷开未准备好有效缓存时，对应暖开标为 `SKIPPED`，下一来源继续执行。除上述打开前基础设施故障外，失败项不自动重试；性能回退的正式独立复测由比较流程处理。
- **取消。** 运行中可按 Ctrl+C，或在该报告目录新建空的 `stop.request`。控制器取消当前任务、回收本次拥有的应用进程树，余项标为 `CANCELLED`。结果随每次状态变化落盘，浏览器刷新 HTML 即可看到进度；不覆盖已有批次目录。强制结束控制器或机器断电可能留下 `RUNNING`/`PENDING`，它们不属于成功结果。
- **外部中止恢复。** 确认原控制器与应用进程均已停止后，运行 `npm run bench -- recover-batch --output ../output/<批次>`。控制器的私有输出映射与运行记录共用随机 nonce，并记录 PID 与进程启动时间；相同进程仍存活时拒绝恢复，PID 被复用不会误认为原控制器。旧批次缺少凭据、或系统不能确认进程身份时，核实进程已停止后显式加 `--force`。恢复将遗留行标为 `CANCELLED`，从私有 `progress.private.json` 带回最后观测的写入待办和缓存状态；旧批次若没有 runId，只在私有清单能唯一匹配样本时关联快照。缺失的 `settledMs` 保持空值，最小私有报告带 `recovery` 标记且 `measurementComplete=false`；带中断恢复标记的批次不得进入基线批准或 gate。恢复先写回私有权威报告，再生成 output 派生；`exportId` 只用于复用输出路径时的批次绑定，完成后的重复恢复按 exportId 查询该批次，历史结果不覆盖当前结果。公开派生报告不能直接作为恢复输入。
- **异常与导出修复。** 可捕获的控制器异常先保存并导出已知结果，再传播失败；异步致命异常通过 `uncaughtExceptionMonitor` 写入私有 `controller-error.private.json`，不改变 Node 的退出语义。`run-bench-survey.ps1` 将构建及批次输出保存到 `tmp/gim-bench/surveys/`；子控制器异常退出且导出未完成时，自动尝试有归属校验的恢复，不自动使用 `--force`，随后仍以失败结束并停止后续批次。脚本本身被强杀或断电时仍须手动恢复。若私有批次已经完成但公开文件缺失，`recover-batch` 可补导出，保持私有权威结果不变；存活的最终写出进程仍受保护。

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
| `summary.csv` | 按输入和冷暖状态汇总中位数、P95、观测数/缺失数与状态计数 |
| `stages.csv` | 每个运行的阶段次数、wall time、最大值、可追踪字节工作量、ms/MiB 和 p50/p95/p99 区间 |
| `slow-tasks.csv`、`slow-phases.csv` | 每个运行耗时最长的十个 Worker 任务和单次阶段，使用匿名来源 ID；聚合直方图不充作单次阶段 |
| `slow-templates.csv` | 每轮最慢 20 个 DEV 模板槽位等待及最久 20 个槽位占用者；含优先级、缓存读取、Worker 请求/排队、输入预算、输出字节及内存压力，公开列只用匿名来源 ID |
| `workers.csv` | 每个 Worker 的类型、堆采样可用性、成功/失败次数、观测峰值、最大采样延迟和间隔 |
| `results.json` | output 下默认是匿名派生视图；显式非匿名 survey 可含允许的样本文件名；CLI 打印的 tmp/privateResults 才保留比较与批准所需权威证据 |
| `profile.json` | 权威冻结版本在 tmp 私有批次目录；output 仅有派生信息 |

- CSV 使用 UTF-8 BOM、标准引号转义；时间字段后缀 `Ms`、内存字段后缀 `Bytes`。HTML 显示秒与 GiB。不可用字段留空，不填零。
- 字段名以本次构建生成的 `results.json` 与 `results.csv` 表头为准；本页只维护文件用途与判读边界，不逐列冻结字段名。
- 汇总分别计数 `PASS` 与 `PARTIAL`；同组轮次的 PARTIAL 签名不同时中位数留空，`coverageGroups` 与 `partialSignatures` 给出分组证据。
- 公开投影保留受控阶段名、状态、原因码、PARTIAL 计数和本次 `exportId`；无法识别的自由文本替换为 `unverified-reason-omitted`，不把路径或业务名称带入派生视图。
- `summary.csv` 的每个时间指标同时给出 Median、P95、Count 和 Missing；P95 是该组重复轮次的经验最近秩，必须结合观测数量和覆盖状态判读。
- 单次运行的 `report` 生成流水线概览、内存曲线与覆盖/阻塞证据；具体视图取决于输入是否包含 Trace 事件。批次 `report.html` 提供“测量结果 / 样本覆盖”两个 tab。
- 覆盖汇总同时给出有效轮次和计划轮次，以及基础设施重试次数。少于计划轮次的中位数可供诊断，但不能冒充完整基线。
- `measurementDetailStatus=aggregate-only` 表示详细时间线因容量截断，但阶段聚合与任务闭环仍完整；内存采样另见 `memoryEvidenceComplete`。截断条数保留，产品 PASS/PARTIAL 不因此变成 INCONCLUSIVE。未确认的 Worker 尾批、序号缺口或聚合丢失仍使测量不完整。Worker 批次有连续 ID、确认和任务结束标记。
- `aggregate-only` 的 PASS/PARTIAL **没有完整事件时间线**。基线审批要求 `aggregateComplete`、生命周期、必要内存和内容证据，不要求 `detailComplete`；`slow-tasks.csv`、`slow-phases.csv` 仅供诊断，不作为基线必需证据。聚合阶段不进入单次慢阶段榜。
- `measurementLifecycleComplete` 与 `measurementComplete` 分开：意外 Worker 终止的在途任务、超时、无理由取消和异常迟到事件使生命周期不完整；有受控原因的项目切换/关闭或 AbortError 取消可以正常结算。DEV 精细请求主动终止 Worker 时按任务身份登记取消，不豁免池内其他任务。外来 run 和重复序号使事件传输不完整，不能被静默忽略。
- `pendingCount`、`pendingSourceCount`、`pendingDigest` 单列；语义摘要已包括待归对象的身份、原因、来源、类别和 disposition。冷暖逐项比较 pending 证据。
- `geometryStructuralFingerprint` 是结构指纹，不是顶点/索引内容校验。`devContentDigest` 聚合 DEV L0 GLB 的字节 SHA，`devContentCovered` 与 `devContentComplete` 标注实际覆盖；IFC/L2 内容不在该证据范围。
- `automaticLoadMs` 是工程语义、导航、全部 IFC 与自动基础几何均已就绪的最晚产品事件时刻；缓存写入与几何编译并行，写入若在该时刻前完成，`writeDrainMs` 为零，但不意味着写入没有占用主线程。`settledMs` 是任务、缓存、后台及静默窗口全部完成时刻。样本覆盖 tab 同时列出自动表示、缓存发布和完全结算的中位数。
- `modelTreeReadyMs` 是工程组成投影首次可用（线路/设备取导航可用时刻）；`firstGeometryMs` 是首个几何可见；`allGeometryReadyMs` 是自动基础 DEV/IFC 表示均齐备的时刻。三者与 `cachePublishMs`、`settledMs` 分列；几何齐备是 wall time，可能含来源读取、调度和缓存写入背压，不冒充纯三角化耗时。不同样本的 `automaticLoadMs` 与写入重叠程度可不同，跨样本比较应同时阅读几何与缓存两条时间线。
- 冷暖配对复用 SQLite 数据根和 WebView2 用户数据目录；IFC LOD 的 IndexedDB 缓存位于后者。cold 要求两者为空，warm 要求配对 profile 已存在且非空；缺失时报 `warm-webview-profile-unavailable` / INCONCLUSIVE，不启动伪暖开。旧的独立 WebView profile 运行条件不可与新口径比较。运行中的 `progress.private.json` 每 30 秒保留一次匿名状态快照，只存工作区私有目录。工程提取按实际来源进展续期；活动工程任务 60 秒没有进展时以 `product-stalled` 终结，且保存最后观测阶段。无活动工程任务而语义仍未就绪时，120 秒后标为 `engineering-progress-stalled` / INCONCLUSIVE。
- 从未执行任务的 Worker 标为 `not-applicable / never-executed`；没有独立 JS isolate 的宿主或外部进程也标为 `not-applicable`。短命 Worker 标为 `short-lived / ended-before-heap-sample`；不填零。实际执行任务的 Worker 若仍缺堆证据则列出 `unavailable` 或 `missing`。一次成功采样不掩盖后续失败；失败次数、最大采样间隔或延迟超过两个周期时，该 Worker 的内存证据不完整。进程树采样失败会重试，并单列根进程 Private Bytes 作为下界，不冒充完整进程树峰值。`memoryIncompleteItems` 指明缺口；产品 PASS/PARTIAL 保留，正式内存比较和基线认可返回 INCONCLUSIVE。
- `cacheWriteBytes` 是 DEV 产物实际提交尝试的元数据与 GLB 字节之和，`cacheWriteMsPerMiB` 是服务端到端 wall time 除以该字节量，包含打包、IPC 等待和原生写入，不是磁盘吞吐。`cachePack`、`cacheInvokeWall`、`cacheNativeResolve`、`cacheNativeWrite` 的阶段均记录字节量，嵌套阶段不能相加。缓存写入与模型树、几何阶段重叠，比较时间线时须看各自就绪事件。
- `templateQueue` 是等待模板处理槽位的 wall time；`templateSlotOccupancy` 是获槽到释放的 wall time。两者可并行重叠，不把各任务累计值当成应用启动耗时。`slow-templates.csv` 的 `workerAwaitMs` 含 Worker 排队、读取及执行；`workerQueueWaitTotalMs` 是该模板直接或分部 Worker 派发等待的累计值，分部任务并行时也不可直接当作端到端时间。原始 DEV 路径仅留在 `tmp/gim-bench/runs/<runId>/template-diagnostics.private.json`，可分享 CSV/JSON 只保存 `sourceId`。
- 批量测量在工作区 `tmp/` 运行固定控制器 CPU 与写入/暖读校准，批次报告记录机器 CPU、内存、工作区可用空间；比较结果给出 `calibrationRatio`。该校准不能等价代表 WebView Worker、源盘或显卡速度，所以产品 wall time 不乘系数归一化。跨轮默认同机、同运行时、同 SHA 与同工作量；CPU 校准偏差超过 15% 或工作区 I/O 校准偏差超过 30% 时，正式比较返回 INCONCLUSIVE。电源模式无法可靠读取时明确记 `unavailable`。不同批次缺少相同 L0/L1/L2 登记输入时属于覆盖缺口，报告不会凭样本名自动补齐，也不改变单样本判定。
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

暖开 DEV catalog 校验按本次运行的唯一来源集合核对：命中数与未命中来源数必须覆盖全部 DEV；未命中只能对应有原始引用/范围证据的 `source-invalid` 或 `missing-dependency` 来源。这里的 catalog 是来源范围缓存，与几何 LOD1 模板不同；**几何 LOD1** 按热点策略不持久化，其 `devLodMisses[1]` 不参与 catalog 命中要求。样本集合的 `L1` 仅表示开发回归资料，不改变缓存规则。冷暖还必须保持同一匿名失败来源摘要；不在注册表登记样本专属缺陷白名单。
该规则以 `cacheProofPolicy=source-failure-catalog-v1` 冻结进运行条件；旧口径结果不能与其直接比较。

## 匿名化与私有产物

- `output/` 中的报告默认使用本次导出别名，不导出源 SHA、路径或稳定私有摘要。显式 `--anonymize false` 的 survey 可在派生视图中保留通用设计标准方案号或已匿名 `substation01–04`、`line01–06` 的 `.gim` 文件名，仍不导出源 SHA、源路径、原始 Profile 或批准记录。
- `results.json`、`profile.json` 在 `output/` 下标注 `artifactRole=public-derived`；`gate`、`compare`、`accept-measurement` 和基线批准只接受 `tmp/` 私有权威文件，公开派生视图不能作为权威输入。
- `--anonymize false` 同时影响 tmp 报告和 output 派生视图；tmp 始终保留权威私有内容，output 仍只生成白名单视图。直接调用 CLI 默认匿名。
- 只有工作区根 `output/` 被分类为公开派生目录；其他位置不按公开视图处理。该开关只影响报告展示，不改变 Profile、动作或测量口径。
- 源路径映射、原始错误堆栈、授权 nonce、日志与 WebView profile 保存在 `tmp/gim-bench/`，不混入可分享的 `output/` 报告。
- 公开投影保留受控阶段名、状态、原因码和 PARTIAL 计数；无法识别的自由文本替换为 `unverified-reason-omitted`，未知路径或业务名称不进入派生视图。
- 非匿名 survey 也不能作为 gate 或批准输入；分享前仍应检查样本名是否属于允许公开的标准方案或已匿名验证样本。
- 堆采样与 Private Bytes 不是同一口径；阶段 wall time 不等于 CPU time。

## 比较与基线

```powershell
npm run bench -- compare --baseline <私有基线JSON> --candidate <CLI打印的privateResults>
npm run bench -- gate --baseline ../tmp/gim-bench/<已批准基线>.approved.json --candidate <CLI打印的privateResults>
```

- 比较按来源、场景、冷暖状态及测量模式分别分组，不把多工程的指标混成一个中位数。
- 矩阵候选先检查整体结果、必需 Worker 家族、计划运行数和逐来源冷暖配对；缺口为 `INCONCLUSIVE`，不能只凭已有逐轮数据通过 `compare` 或 `gate`。
- 每组至少一次独立进程；基线与候选须有相同重复次数、机器、运行时、Profile、动作、工作量和视口。
- 比较身份还包含 `measurementVersion`、`detailPolicy=task-phase-timeline-v2`、`lifecyclePolicy=worker-terminal-v2`、`contentPolicy=dev-l0-glb-sha256-v1`、`cacheProofPolicy=source-failure-catalog-v1` 和 `webviewProfilePolicy=paired-webview-profile-v1`；缺任一条件按不可比处理，不自动换算。
- `PARTIAL` 只与同 SHA、同来源缺口摘要的 `PARTIAL` 比较；`PARTIAL` 与 `PASS` 的覆盖不同，结果为 `INCONCLUSIVE`。
- 普通 `compare` 可读取结构指纹和已有内容证据，但不把缺少内容证明作为普通测量失败。正式 `approve-baseline` 和 `gate` 要求 DEV L0 内容摘要覆盖所有已显示根；字节摘要变化默认 INCONCLUSIVE，只有下述独立网格验证与显式审批流程可以接受这项变化。放置指纹或覆盖变化保持 INCONCLUSIVE，不能仅凭相同包围盒自动通过。无 DEV 表示的输入标为不适用，不伪造内容 SHA。
- 超过 10% 要求独立复测，仍超限为 `FAIL`。性能优化须明确提示开发者复核；消缺和新功能的 10% 回退提交门槛由开发者人工控制，不要求每轮完整测量，不接入远程 CI。
- 摸底批次的 `PASS`/`PARTIAL` 仅表示该次计划执行结果。`baseline` 批次要求冷暖等价、来源缺口摘要及工作量一致；正式认可仍需探针开销、十轮生命周期与测量能力等验收。
- 完整正确性基线只接受 `PASS`。`PARTIAL` 是显式接受的覆盖基线：来源复核者先运行 `review-partial`，其记录绑定候选摘要、复核身份、时间和受控原因；另一位批准者再引用该记录，不能仅在批准命令中自报已复核。原因只接受与候选证据相符的 `source-geometry`、`engineering-coverage`、`combined-source` 或 `mixed-source`。首次须显式 `--first-partial`；本地已有同来源批准记录时 CLI 拒绝再次声明首次，后续须提供上一份已批准基线，相同来源从 PASS 退到 PARTIAL 或缺口签名变化会被拒绝。复核和批准文件以候选摘要及时间命名，保存在工作区私有 `tmp/`，不覆盖上一份记录，也不存自由文本工程名或路径。工具核对记录与身份不同，仍无法替代实际人工审阅。
- SDK 迁移不在本轮 Benchmark 范围内。完整指标口径见[测量架构](architecture/measurement.md)。

### 测量验收与正式批准

`matrix` 的 `candidate.json` 和 `batch --preset baseline` 的 `results.json` 都是未批准候选。正式原生候选须先绑定同构建、同机器、同固定运行时和同测量协议的验收报告。能力报告须通过 Worker/CDP 自检；开销报告须属于候选的 Profile、来源、场景与工作量，包含至少三组交替运行的独立 off/benchmark 进程；生命周期报告须覆盖候选中的来源，并通过十轮开闭、取消与资源归零检查。生命周期 PASS 表示上述检查通过，不会把来源 PARTIAL 升级成产品 PASS：来源几何或工程覆盖缺口须有充分证据、与候选一致且十轮保持相同的缺口摘要；新增产品失败、缺口变化或证据缺失仍拒绝。新报告保留初始正确性参考与每轮正确性结果，PARTIAL 验收必须携带这些记录。开销和生命周期的 10% 判断会从明细重新计算，不能仅填一个 `outcome: PASS`。

```powershell
# 先执行 matrix 或 batch，保留其候选 JSON 和本轮构建清单。
npm run bench -- doctor --build <本轮构建清单>
# batch 的样本可以直接引用同一份注册表，不需要重新运行 samples/inventory。
npm run bench -- overhead --build <本轮构建清单> --candidate <候选JSON> --sample <匿名样本ID> --registry <本轮注册表>
npm run bench -- lifecycle --build <本轮构建清单> --sample <匿名样本ID> --registry <本轮注册表>
npm run bench -- accept-measurement --candidate <候选JSON> --doctor <能力report.json> --overhead <overhead.json> --lifecycle <生命周期report.json>
# 上一步输出新的 accepted-candidate 文件；原候选保持不变。
npm run bench -- approve-baseline --candidate <accepted-candidate文件> --approver <批准者>
npm run bench -- gate --baseline <approved基线文件> --candidate <下一版候选JSON> --output ../tmp/gim-bench/new-comparison.json
```

冻结矩阵使用 `overhead --profile <冻结Profile>`，也可同时指定 `--candidate <矩阵候选JSON>`，此时必须匹配 Profile 摘要。矩阵的场景、精化动作和超时均从冻结 case 读取，不使用样本注册表推断动作；单独使用 `--candidate` 只支持批次候选。省略 `--registry` / `--directory` 时，`overhead` 与 `lifecycle` 使用 `samples` 登记的私有语料。开销复测保留第二组完整运行记录。验收绑定不覆盖候选、不批准基线，也不自动运行工程样本；记录只保存验收所需字段，绑定候选摘要，候选修改后须重新绑定。PARTIAL 的 `review-partial` 须针对绑定后的新候选执行。`approve-baseline` 和后续 `gate` 都复核验收记录，不能用另一构建的能力报告替代。

`--output` 可以指定新文件及尚未创建的子目录，但只能位于工作区 `tmp/` 或 `output/`。逐层拒绝目录链接、文件链接和目录型文件目标；输入文件仍须已存在。

### 几何内容变更审批

几何编译器使 GLB 字节发生变化时，开发者先用独立网格验证器比较对应构建、来源和场景中的全部变更 occurrence，再由另一位批准者导入验证结果。Benchmark CLI 提供验证结果导入和审批，不实现网格等价算法，也不从包围盒、计数或提速推断等价。没有独立验证报告时保持 INCONCLUSIVE。

验证器输出 `gim-geometry-equivalence-v1` JSON：`outcome: PASS`、`method: independent-mesh-equivalence-v1`、`verifier`、`baselineDigest`、`candidateDigest` 和 `checks`。两个摘要使用 [evidence.mjs](../desktop/scripts/benchmarks/evidence.mjs) 的 `digest` 对完整输入 JSON 计算。每组变更场景的检查包含：

- `transitionDigest`：对 [geometry-review.mjs](../desktop/scripts/benchmarks/geometry-review.mjs) 的 `geometryTransition(基线run, 候选run)` 计算摘要，绑定双方构建、内容 SHA、来源、场景、冷暖状态、Profile、工作量与放置指纹。
- `coveredOccurrences`：必须等于报告中全部已显示 occurrence 数；`evidenceSha256` 指向验证器明细证据的 SHA，明细由开发者私有保存并人工核验。
- `positions`、`topology`、`normals`、`materials`、`transforms`、`sourceBindings`：每项均须通过。单纯相同包围盒不满足此契约。

```powershell
npm run bench -- approve-geometry-change --baseline <approved基线文件> --candidate <新候选JSON> --verification <独立网格验证报告> --approver <批准者>
npm run bench -- gate --baseline <approved基线文件> --candidate <新候选JSON> --geometry-review <上一步批准记录>
```

批准记录只允许对应 GLB 内容 SHA 的变化；缺失内容证据、覆盖或放置变化、运行条件、内存证据与 10% 回退检查仍按原规则判断。复测仍需相同的双方构建和已验证内容。候选或基线改变后，审批记录失效；该记录不会批准或替换性能基线，也不改变 PARTIAL 的独立来源复核要求。

### 时间线策略 v1 到 v2 的基线迁移

`task-phase-timeline-v1` 报告只作历史参考。v2 增加 Worker 批次确认、最终证据核对和生命周期口径；冷暖还需共用 WebView2 profile（`paired-webview-profile-v1`）。比较工具对旧条件返回 `incomparable:detailPolicy` 或缺少 profile 条件，不自动换算指标，也不复制旧批准元数据。

测量协议本身统一使用共享常量 `MEASUREMENT_VERSION`（当前为 `gim-measurement-v1`），不按时间线策略另设协议版本。旧报告若在 `conditions.measurementVersion` 写入其他值，只作历史参考，不能通过相互一致绕过版本检查；工具不自动改写报告或批准记录。

开发者在同一机器、固定运行时和构建方式下重新构建 Benchmark，按冻结注册表执行 L1 变电/线路至少三组独立冷暖配对，并完成 L0 关键样本、探针开销及十轮资源回落检查。核对工作量、语义/几何摘要与缓存域后，显式批准新候选。未完成的 L0 项或冷暖异常保持 INCONCLUSIVE，旧 v1 基线仅供定位变化，不参加 v2 门禁。真实样本与性能矩阵只在开发者本地运行。

```powershell
cd desktop
npm run bench -- build
npm run bench -- batch --build ../tmp/gim-bench/builds/<构建>/acceptance-build.json --registry ../benchmarks/l1/substation01-04.json --preset baseline -repeat 3 --output ../output/l1-substation-v2
npm run bench -- batch --build ../tmp/gim-bench/builds/<构建>/acceptance-build.json --registry ../benchmarks/l1/line01-06.json --preset baseline -repeat 3 --output ../output/l1-line-v2
npm run bench -- batch --build ../tmp/gim-bench/builds/<构建>/acceptance-build.json --registry ../benchmarks/l0/common-design-500kv.json --preset baseline -repeat 3 --output ../output/l0-500-v2
```

实际注册表的文件须由开发者在工作区提供并核对 SHA；命令只说明本地验收路径，不构成已执行结果。

## 详细 Trace 与 Profile

基线批次的原始事件保存在私有 `tmp/gim-bench/runs/<runId>/events.jsonl`，不复制到公开 `output/`。批次的 `runs.private.json` 提供 runId 与私有目录映射。普通 `benchmark` 只有任务/阶段区间，不能离线补造 diagnostic 的完整 Operation/Span、CPU、Heap 或 GPU 记录。

终态采证会在同会话内有界重新等待并采集，漂移对及字段差异保存在 `final-evidence.private.json`。批次 JSON/CSV 的 `finalEvidenceAttempts`、`finalEvidenceDrifts` 展示尝试数与漂移次数；重新采证后通过的 run 仍保留这些计数。会话变化、持续漂移及缺少完整证据继续按失败/不可判定处理，不能使用旧报告绕过新构建验收。

每次原生运行写出 `artifacts.private.json`，逐项说明文件名、字节数与 available / not-requested / unavailable / unsupported 状态。`--mode diagnostic` 即使省略配置也采详细 Trace，并自动生成 `analysis.private.json`、`trace.private.json`；CPU/Heap/Allocation 仍须显式配置。GPU 请求另外写入有界的 `gpu.private.json`，保存实际 Query 样本和省略数；线路 MapLibre 没有接入 GPU Pass Query 时明确标 unsupported，不将帧间隔冒充 GPU 耗时。

以下配置分别在独立诊断运行中使用，不混入普通基线或同时争用同一 HeapProfiler：

| 配置 | 产物/用途 |
|---|---|
| `benchmarks/diagnostics/cpu-main.json` | 主线程 CPU `.cpuprofile` |
| `benchmarks/diagnostics/allocations-main.json` | 主线程分配采样 `.heapprofile` |
| `benchmarks/diagnostics/heap-main.json` | 延迟 500 ms 请求主线程 `.heapsnapshot`；记录实际采集窗口，短运行可能尚未触发 |
| `benchmarks/diagnostics/trace-gpu.json` | 详细 Trace 与支持时的 GPU Timer Query，不请求系统提权采集 |

在 `desktop/` 中，先为修改后的源码执行 `npm run bench -- build`，再用 `npm run bench -- run --build <新构建清单> --sample <匿名样本ID> --mode diagnostic --diagnostics ../benchmarks/diagnostics/<配置>.json`。文件截断、目标退出或未触发均读取产物清单中的实际状态；历史未采集的 Profile 无法回补。

当前系统录制入口直接返回 `authenticated-system-helper-required`，不读取可写计划、不触发提权或 WPR 录制；WPR/PMC 录制待受保护认证 helper 接入后恢复，已采集 ETL 的离线 WPA 摘要仍可用。CPU Profile 自身窗口与热点分析可用；未经真实时钟域验收的跨域映射标不可用，请求/响应括号仅保留为私有候选，不能用它归因精确 Span CPU。slow-span 使用独立有界活动索引；上下文历史超过 32k 不再阻止新活动 Span 触发。

诊断中的 `project.open` 保持根 operation；重叠动作使用同根子 Span 和独立能力 scope。默认主线程上下文始终属于根操作，异步动作须显式传递入口捕获的子上下文，不能用“最后活动的动作”推断归属。Worker 新 Probe 使用独立 producer epoch；超过保留范围的旧 run 重建探针时显式记录 retention loss，不复用已消费的序号。活动索引溢出与历史关联截断分别报告，采集取得 Profile 不代表触发搜索、上下文关联或整个操作覆盖完整。

私有 `events.jsonl` 是按批次写入的 NDJSON。每行的 `contexts` 保存本批次上下文去重表，`events` 中的 `contextIndex` 指向该行的上下文；索引仅在本行有效，不是 Run、Task 或 Span 身份。事件仍使用 `gim-measurement-v1` Envelope，保留 producer、sequence、clock 与原始时间；这是存储编码，不是新的事件协议版本。离线读取器同时支持该批次编码与携带完整 `context` 的旧记录，分析前展开上下文，再按原始 Event Ref 去重和归并。

以下命令在 desktop 执行，输入输出均位于工作区：

```powershell
npm run bench -- run --build <本轮构建清单> --sample <匿名样本ID> --mode diagnostic --diagnostics ../benchmarks/diagnostics/cpu-main.json
npm run bench -- analyze --input ../tmp/gim-bench/runs/<本轮runId>/report.json
npm run bench -- export-trace --input ../tmp/gim-bench/runs/<本轮runId>/report.json
npm run bench -- report --input ../tmp/gim-bench/runs/<本轮runId>/report.json
```

诊断配置的 captures 支持 kind=cpu/allocations/heap、target=main/worker、family/executorId/taskId/spanId/operationTraceId、受控 stage 阶段名、trigger=operation-start/external/slow-span。external 由控制器按 delayMs 触发；slow-span 必须提供 thresholdMs。单次诊断最多 8 个 capture，默认 CPU 窗口 5 秒、上限 30 秒，单产物容量上限 256 MiB；不能捕获已结束 Span 的历史栈。可使用 captures=[] 仅采详细 Trace，gpu=true 请求可用的 GPU Query。示例见 [`benchmarks/diagnostics/`](../benchmarks/diagnostics/)：`cpu-main.json`、`cpu-worker-slow.json`、`trace-gpu-system.json`。

`analyze` 将摘要写入输入报告同目录的 `analysis.private.json`，原始事件留在 `events.jsonl`，终端只打印覆盖摘要；逐任务阻塞链只分析 duration 最大的前 16 个依赖终点，省略数量见 `taskPathSelection`。Pipeline 是可重叠 span duration 之和，不等于墙钟。内部 HTML 只内嵌有界概览；`export-trace` 写入同目录的 `trace.private.json`（Chrome Trace Event JSON，Perfetto 可读）。生命周期归并、冲突、阻塞链和未归因区间的判定见[测量架构](architecture/measurement.md#operation-trace-与定点诊断)。

system 配置仍校验 durationMs 与 bufferMiB，但当前录制入口关闭，返回 `authenticated-system-helper-required`，不启动提权或 WPR；WPR/PMC 待受保护认证 helper 接入后恢复。已采集 ETL 的离线 WPA 摘要仍可用：需 exporter（可省略并从 PATH 查找）、wpaProfile、profileSha256 以及 tables 列/单位契约。表契约 columns 指定 pid/created/start/end/value，可选 tid，并单独指定时间列的 timeUnit（ns/us/ms/s）和数值列的 unit；创建时间必须与独立采样器的 windows-filetime-100ns 身份一致，没有匹配的 owned process 实例时返回 `owned-process-instance-not-matched` 并标 unavailable，不能用进程名称或 PID 猜配。缺少 WPA Profile 时保留原始 ETL，摘要标 unavailable。

诊断运行不能参与普通性能基线。原始 .cpuprofile、.heapprofile、.heapsnapshot、.etl、analysis.private.json 和 trace.private.json 留 tmp；可分享报告由白名单生成，缺口不补零。P95 是给定重复轮次的经验最近秩，结合 Count/Missing 和覆盖状态判读，不宣称少量重复证明尾部性能。

## 相关文档

- [性能测试指南](performance-guide.md)：SLO、冷/暖步骤与手工测试路线。
- [测量与 Benchmark](architecture/measurement.md)：采集面、完整性口径、Trace/Profile 与 SDK 前置门禁。
- [性能样本登记](../benchmarks/README.md)：L0/L1/L2 目录、SHA 与运行示例。
- [本地功能测试](../desktop/local-tests/README.md)：`test:local` 基础功能样本。
- [开发指南](development.md)：环境、命令、工作区与临时目录。
- [验证](validation.md)：证据分层、自动门禁与真实复核。
