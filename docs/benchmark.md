# 本地批量 Benchmark

Benchmark 使用固定 WebView2 的原生 Release 应用，每次运行启动独立进程，顺序执行注册的工程；不以 Node 微基准代替产品加载。目录或 JSON 注册表可以直接作为输入，不需要逐个手动调用。实际工程、性能与内存测试只在开发者本地运行，CI 不运行真实或合成工程样本。

开发者基础功能集合由 [`test:local`](../desktop/local-tests/README.md) 验证：仓库跟踪 [mini-samples.example.json](../desktop/local-tests/mini-samples.example.json)，开发者可直接修改为自己的变电、线路、设备 GIM 路径及 SHA。缺失样本显式跳过，已有来源的 SHA 或运行时工程类型不符则失败。L0/L1/L2 性能样本沿用独立登记。

## 命令行

在 `desktop/` 执行。所有输入必须位于工作区内；产物只能写入工作区根目录的 `tmp/`、`output/`。样本目录仅被读取，系统 TEMP/TMP 不作为测试目录。

```powershell
# 构建一次。后续命令显式传入它输出的 acceptance-build.json。
npm run bench -- build

# 一轮批量摸底，递归发现目录内全部 .gim（扩展名不区分大小写）。
npm run bench -- batch --build ../tmp/gim-bench/builds/<构建>/acceptance-build.json --directory ../demo --output ../output/benchmark-survey

# 或按 JSON 注册表执行；不要求事先完成全包清单分析。
npm run bench -- batch --build ../tmp/gim-bench/builds/<构建>/acceptance-build.json --registry ../tmp/benchmark-inputs.json --output ../output/benchmark-registered

# 基线候选：每个唯一来源一轮冷开和一轮暖开。
npm run bench -- batch --build ../tmp/gim-bench/builds/<构建>/acceptance-build.json --registry ../tmp/benchmark-inputs.json --preset baseline --output ../output/benchmark-baseline
# 需要三轮时显式增加 -repeat 3，并使用新的输出目录。
```

`--preset survey` 是默认值，执行一轮冷开；`--preset baseline` 默认执行一冷一暖。`-repeat 3`（也接受 `--repeat 3`）按相同样本重复三组独立进程冷暖配对。重复次数属于冻结 Profile，比较时须一致。`--timeout-seconds N` 设置单次打开的等待上限，默认 3600 秒；动作和进程清理有各自的有限超时，所以不是整个命令的总时间上限。不要并行运行多个性能批次，也不要在采样时编译或执行其他负载。

`bench build` 会核对 Benchmark 前端探针已进入原生 EXE；旧版、普通前端或源码指纹与当前工作区不一致的构建清单会在批量打开样本前被拒绝。修改桌面源码或测量契约后重新构建，不复用旧清单。构建失败不会发布可测量的清单。

每个计划轮次的冷/暖测量在样本打开前发生 CDP、原生启动、WebView2 GPU 或 Benchmark API 基础设施故障时，最多重新启动两次。每次重试拥有新的原生进程、WebView profile、调试端口；冷开还拥有新的空缓存。已进入 `open`、解析失败、缓存失败及产品正确性失败不重试。重试记录在结果的 `attempts` 与 `startupFailures`、私有运行日志中；耗尽后保持 `INCONCLUSIVE`，暖开跳过时保留冷开的基础设施原因。调试端口由运行器分配，存在启动前释放端口的竞争窗口；重试只降低瞬时故障影响，不据此断言某次故障的根因是端口占用。

相同 SHA 与相同动作路线只执行一次，其余输入明确标为 `DUPLICATE` 并关联首个输入。不同动作路线仍分别执行。不会根据文件大小、历史耗时或失败记录跳过某个唯一来源。目录符号链接不跟随，报告会列出拒绝访问项。

批次的所有计划行在执行前写入结果。单次失败、超时、输入缺失或 SHA 不符都记录后继续；只有用户取消或报告无法安全写入才停止队列。冷开未准备好有效缓存时，对应暖开标为 `SKIPPED`，下一来源继续执行。除上述打开前基础设施故障外，失败项不自动重试；性能回退的正式独立复测由比较流程处理。

运行中可按 Ctrl+C，或在该报告目录新建空的 `stop.request`。控制器取消当前任务、回收本次拥有的应用进程树，余项标为 `CANCELLED`。结果随每次状态变化落盘，浏览器刷新 HTML 即可看到进度；不覆盖已有批次目录。强制结束控制器或机器断电可能留下 `RUNNING/PENDING`，它们不属于成功结果。

L0/L1 的逐文件 SHA 注册表与 L2 目录清单见 [性能样本登记](../benchmarks/README.md)。

## JSON 注册表

普通注册表路径相对 **JSON 文件所在目录**，也接受工作区内绝对路径。最小形式是字符串数组；推荐使用对象以绑定 SHA、集合来源与可选动作：

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

L0/L1 的 `gim-batch-input-v1` 登记必须有完整 SHA；填写后不匹配会报错，不自动更新。`sampleTier` 是资料形成目的，允许未登记，不能从模型粒度推断。现有 `gim-samples-v1` 私有注册表可直接输入，它的 `paths` 沿用相对工作区的语义，每个路径都列入结果。去掉路径后的匿名注册表不能用来打开源文件。

L2 可使用 `gim-batch-directories-v1`：`sampleTier` 固定为 `L2`，`directories` 列出工作区内的目录和通用组名。CLI 递归发现 GIM、计算本次 SHA 并冻结到 Profile；目录缺失、为空、链接或不可读会作为输入错误报告。参见 [目录示例](../benchmarks/l2/directories.example.json)。

默认场景为打开工程并等待自动请求的表示与缓存任务结束，不自动请求全部 L2。需要精化的条目可显式加入：

```json
"actions": [
  {"kind": "dev-fine", "selector": "canonical-first-base-v1"},
  {"kind": "ifc-near", "selector": "smallest-source-canonical-small-object-v1"},
  {"kind": "ifc-fine", "selector": "smallest-source-canonical-small-object-v1"}
]
```

DEV 布尔专项也接受 `canonical-first-boolean-base-v1`。找不到要求的目标会记录不完整，不能默默删去动作。近景动作完成后恢复原相机，避免引入未声明的后续精化。

## 报告与错误

| 文件 | 内容 |
|---|---|
| `report.html` | 按匿名开关展示的结果表、状态计数、搜索、状态筛选、列排序与 CSV 链接 |
| `results.csv` | 每个输入、轮次、冷暖状态的结果、错误码、时间、进程峰值与完整性字段 |
| `errors.csv` | PARTIAL、失败、不完整、跳过及取消的行；重复别名保留在全部结果表 |
| `summary.csv` | 按输入和冷暖状态汇总的中位数，以及成功、失败、不完整和跳过轮数 |
| `stages.csv` | 每个运行的阶段次数、wall time、最大值和 p50/p95/p99 区间 |
| `workers.csv` | 每个 Worker 的类型、堆采样可用性、样本数、观测峰值和延迟 |
| `results.json` | 机器读取的结果、运行条件、正确性检查、工作量、比较所需指标与冷暖一致性结果 |
| `profile.json` | 本批次冻结的来源 SHA、动作、模式、轮数、超时与摘要 |

CSV 使用 UTF-8 BOM、标准引号转义；时间字段后缀 `Ms`、内存字段后缀 `Bytes`。HTML 显示秒与 GiB。不可用字段留空，不填零。`summary.csv` 分别计数 PASS/PARTIAL；只对相同覆盖状态的有效轮次取中位数，不混合完整表示与来源缺陷造成的部分表示。

`summary.csv` 和 HTML 样本覆盖表显示 `validRepetitions / planned` 及基础设施重试次数。少于计划轮次的中位数可供诊断，但不能冒充完整基线。`results.csv` 另列输入变体、缓存发布、工程来源覆盖、partial occurrence、来源引用状态以及测量明细丢失数。Benchmark counter/memory 按事件协议聚合，任务/阶段仍保留明细；`measurementDetailDropped` 是真正截断，不包含有意聚合的事件。原始端点错误、调试端口、应用 PID/退出状态、进程采样尾部和 WebView2 日志尾部只写在 `tmp/gim-bench/runs/<runId>/startup.private.json`，不进入可分享报告。

线路行另显示缓存发布状态和 pack 评估：`uncommitted` 表示 SQLite 工程类型尚未提交，不能误读为 pack 文件缺失。失败几何按原因计数，不包含私有 DEV 路径。首次响应与自动表示完成时刻不等待线路 SQLite 写入；缓存就绪时刻必须等到 `finish` 提交。冷开变电必须等到 `cachePersistenceReady` 成功或失败终态后再取得数据库证据；工程 Worker 的来源派生缓存状态不代替 SQLite 核心发布。变电 `cachePublishMs` 只在实际发布时有值，完整暖开复用既有缓存时留空。变电的原生结束条件另含后台 Spatial 终态，避免最后一次快照碰到刚启动的 Worker。

状态包括 `PENDING`、`RUNNING`、`PASS`、`PARTIAL`、`FAIL`、`INCONCLUSIVE`、`INPUT_ERROR`、`ERROR`、`SKIPPED`、`DUPLICATE`、`CANCELLED`。`PARTIAL` 表示运行证据明确的来源几何异常或工程来源覆盖不完整，或者合法裸归档已打开但缓存未能持久化；不等同完整 PASS。来源证据缺失为 INCONCLUSIVE，IFC/解析/缓存读写或其他产品检查失败为 FAIL。裸归档单列 `INPUT_VARIANT`，若仍无可复用缓存则列 `CACHE_NOT_PERSISTABLE`，对应暖开为 `WARM_UNSUPPORTED`，不能成为完整冷暖基线。`INPUT_ERROR/ERROR` 分别是输入与执行环境错误。退出码：PASS/PARTIAL 为 0，FAIL 为 1，不完整为 2，取消为 130；报告始终保留原状态。

样本只由 `--directory` 或 `--registry` 选取。[L0/L1/L2 注册表](../benchmarks/README.md)不提供判定例外。来源几何 `PARTIAL` 要求全部失败均为带原始范围证据的 `source-invalid`、没有可见根或其他产品失败；工程来源 `PARTIAL` 要求不完整原因仅为来源引用缺失/歧义或来源图缺口，且有相应计数和稳定摘要。完整报告分列 `failedGeometryReasons`、`geometryStatuses` 和来源引用状态，空 PHM 原因不计入失败。SQLite 核心缓存发布单独验证；冷开缓存有效且状态为 PASS/PARTIAL 时继续暖开，暖开以及后续基线比较必须保持同一缺口摘要、语义/几何结果和工作量。

`--anonymize true`（默认）以完整文件 SHA256 展示样本，不显示源文件名和路径；`--anonymize false` 显示文件名与工作区相对路径，同时保留完整 SHA256。该开关只影响报告展示，不改变 Profile、动作或测量口径。源路径映射、原始错误堆栈、授权 nonce、日志与 WebView profile 保存在 `tmp/gim-bench/`，不混入可分享的 `output/` 报告。分享包含真实工程名的实名报告前，应切换匿名模式或仅分享匿名产物。堆采样与 Private Bytes 不是同一口径；阶段 wall time 不等于 CPU time。

## 比较与基线

```powershell
npm run bench -- compare --baseline ../output/benchmark-base/results.json --candidate ../output/benchmark-next/results.json
npm run bench -- gate --baseline ../tmp/gim-bench/baseline.approved.json --candidate ../output/benchmark-next/results.json
```

比较按来源、场景、冷暖状态及测量模式分别分组，不把多工程的指标混成一个中位数。每组至少一次独立进程；基线与候选须有相同重复次数、机器、运行时、Profile、动作、工作量和视口。PARTIAL 只与同 SHA、同来源缺口摘要的 PARTIAL 比较；PARTIAL 与 PASS 的覆盖不同，结果为 INCONCLUSIVE。超过 10% 要求独立复测，仍超限为 FAIL。

摸底批次的 PASS/PARTIAL 仅表示该次计划执行结果。`baseline` 批次要求冷暖等价、来源缺口摘要及工作量一致；正式认可仍需探针开销、十轮生命周期与测量能力等验收。认可 PARTIAL 基线须显式使用 `approve-baseline --accept-partial` 和认可者，不会自动提升为完整 PASS 基线。本轮不迁移 SDK。完整指标口径见 [测量架构](architecture/measurement.md)。
