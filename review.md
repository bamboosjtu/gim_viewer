# 测量框架整改复核

> 本轮代码复核（2026-11-08）：下文保留对 `505b10c` 原生批次的历史判断。当前源码已将最终取证失败拆为 `active-tasks`、`progress-drift`、`session-mismatch` 等原因；尾部活动任务可继续有界等待，冷路径重复 spatial 启动已在前轮修复。PARTIAL 首次认可改为候选摘要绑定的独立来源复核记录，批准者身份必须不同；后续认可要求上一份已批准基线，原因使用受控代码。受控取消的 Worker 未确认尾批单独计数。v1→v2 迁移步骤已写入 `docs/benchmark.md`。真实 L1 三次冷暖与 L0 矩阵尚待开发者本地重跑，不能据此宣布原生 P1 验收完成。本轮未运行样本或性能测试。

> 复核提交：`505b10c`（2026-11-08）
> 复核日期：2026-11-08
> 结论：上轮 P1/P2/P3 的代码修复已复核；**P0 未发现**。当前保留 **1 个 P1、2 个 P2、1 个 P3**。其中 P1 是新跑出的原生闭环问题：L1 变电 s03 冷开在最终取证时仍有活跃 spatial 任务，被归为 `final-evidence-drift` 并 INCONCLUSIVE，暖开被跳过。

---

## 1. 复核范围与证据

已执行：

| 命令/证据 | 结果 |
|---|---|
| `npm run test:measurement-tools` | 49/49 通过 |
| `npx vitest run src/measurement` | 24/24 通过 |
| `npm test` | 179 个文件、1473 通过、3 跳过 |
| `npm run test:acceptance-tools` | 4/4 通过 |
| `npx tsc --noEmit` | 通过 |
| `npm run check:engineering-boundaries` | 通过 |
| `output/line-survey-505b10c` | 6 个线路样本冷暖全部 PASS |
| `output/substation-survey-505b10c` | s01/s04 冷暖 PASS；s02 冷暖 PARTIAL；**s03 冷开 INCONCLUSIVE、暖开 SKIPPED** |
| `output/l0-500-survey` | A3-1 冷暖 PARTIAL；其余 L0 项未形成完整矩阵 |

上轮 P1/P2/P3 的实现项（覆盖域隔离、最终 evidence 重取、Worker 批次 id/ack/flushed、matrix 暖开资格、PARTIAL 批准元数据、summary PARTIAL 分组、`run` 退出码、Worker 堆分类、`workloadProfile`、`expectedRole`、裸 ZIP 识别、默认发现）已复核通过；本轮不再复述历史细节。

---

## 2. P0：样本依赖

仍为**未发现 P0**：

- `correctness.mjs` 只读取 evidence 的 checks、geometryDefects、engineeringCoverage、digest/count，不按样本 ID/SHA/名称分支；
- expected-defect/expected-coverage 注册表及 CLI 选项不存在；`correctness.test.mjs` 使用合成 evidence；
- `samples.mjs` 默认发现只按目录扫描，`workloadProfile` 只选择场景/动作；
- 样本选择、路径/SHA 登记和 workload 配置属于输入身份/工作负载，不是判定例外。

---

## 3. 当前问题

### P1-1 L1 变电 s03 冷开被 late spatial task 判为 `final-evidence-drift`

**证据**

`output/substation-survey-505b10c/errors.csv`：

- s03 冷开：`status=INCONCLUSIVE`，`error=final-evidence-drift;measurement-incomplete;measurement-lifecycle-incomplete`；
- `measurementLifecycleComplete=false`，`measurementLifecycleIssues=active-tasks`，`pendingTasks=1`；
- 最终 `activeTasks` 是 `family=spatial` 的任务；该任务在约 `135,847 ms` 才入队，evidence 在 `136,000 ms` 取，最终 snapshot 在 `136,042 ms`；
- `settledMs≈131,300 ms`，即任务在“完全结算/静默窗口”之后才出现；
- s03 暖开因 cold 非 PASS/PARTIAL 被 SKIPPED。

**判定**

- `finalEvidenceAligned` 要求最终 activeTasks 为空；这里实际上是因为**尾部新 spatial 任务**失败，不是 evidence progress 与 snapshot 的字段漂移。
- `native-run.mjs:223` 把 `finalEvidenceAligned` 的所有失败统一写成 `final-evidence-drift`，错误码掩盖了真实原因。
- 这是一次**原生闭环失败**：正常 s03 冷开无法作为有效轮次，暖开也丢失。不能仅因为 `final-evidence-drift` 看起来像“证据对齐”就忽略活跃任务。

**建议**

1. `finalEvidenceAligned` 返回类型化原因：`active-tasks` / `progress-drift` / `session-mismatch`；`native-run` 分别映射 `post-settle-task-incomplete`、`final-evidence-drift` 等。
2. 完成条件在静默窗口后检测到新任务时，重置/延长等待（有界），或明确标 `late-background-task`；不能只等一次 30 秒。
3. 定位该 spatial 任务为何在 `settledMs` 之后才入队：如果产品确实会晚调度，应把它纳入 `backgroundSettled` 的定义；如果是测量/队列残留，应取消并结算。
4. 增加一个“settle 后新任务”的原生回归；当前只有 synthetic `finalEvidenceAligned` 单测。

**严重度**：P1（正常样本闭环失败）。

---

### P2-1 首次 PARTIAL 基线仍依赖不可验证的人工声明

**位置**：`desktop/scripts/benchmarks/compare.mjs:115-151`。

`approveBaseline` 已要求 `sourceReviewed`、`partialReason`，并可选 `previousBaseline` 阻止签名倒退；但：

- `sourceReviewed` 只是布尔 flag，`partialReason` 只是自由文本，程序无法证明认可者真的核对了来源；
- `previousBaseline` 是可选参数，首次 PARTIAL 仍可由单次命令批准；
- 批准元数据会写入 `tmp/gim-bench/baseline.approved.json`，自由文本可能包含私有工程名/路径。

**建议**：首次 PARTIAL 要求可审计的双人/独立复核记录；后续 PARTIAL 强制提供上一份已批准基线；将原因限制为受控枚举或只存私有批准文件。完整正确性基线仍只接受 PASS。

**严重度**：P2（流程性风险，不是样本依赖）。

---

### P2-2 v2 协议的原生矩阵与旧基线迁移仍未闭合

**证据**：

- 线路 `line-survey-505b10c` 全部 PASS，说明 Worker 批次协议在轻量线路上可用；
- 变电 `substation-survey-505b10c` 只有 s03 冷开失败，s01/s04 PASS、s02 PARTIAL；失败点就是 P1-1 的 late spatial task；
- `l0-500-survey` 仅 A3-1 冷暖 PARTIAL，未形成完整 L0 矩阵；
- `task-phase-timeline-v2` 已是身份条件，旧 v1 基线与新候选比较会得到 `incomparable:detailPolicy`，但公开文档没有迁移说明。

**建议**：补齐 L1 变电三次重复和 L0 关键样本；重新生成/认可 v2 基线；在 `docs/benchmark.md` 增加 v1→v2 基线迁移说明，明确旧基线只作历史参考。

**严重度**：P2（集成验证/迁移）。

---

### P3-1 活跃任务终止时，Worker 尾批检查被跳过

**位置**：`desktop/src/measurement/hostWorker.ts:143-145`。

```ts
const active = run.collector.snapshot().activeTasks.some(task => task.workerId === workerId);
if (taskSeen && !active && (receivedBatchId !== flushedBatchId || lastBatchSequence !== flushedSequence))
  // worker-terminal-tail-unconfirmed
```

只有 Worker 空闲时才检查未确认尾批。若终止时还有 active task，尾批检查被跳过；普通异常终止会由 collector 的 `interruptedTasks` 使生命周期不完整，但**受控取消/有意终止**可能正常结算，尾批丢失不会单独记录。当前没有 active task + terminate 的测试。

**建议**：未确认尾批检查不依赖 `active`；若 active 任务被有意取消，单独记录“取消且尾批未确认”，并增加对应测试。

**严重度**：P3（诊断/边界）。

---

## 4. 验证与限制

- 单元/契约测试全部通过；线路原生样本全部通过；变电原生样本暴露 P1-1。
- L0 没有形成完整矩阵（`l0-500-survey` 仅 A3-1 完成冷暖），不能据此评价全部 L0 样本。
- 未运行探针开销、十轮生命周期和完整性能矩阵。
- `finalEvidenceAligned` 的完整 progress 相等比较是保守策略；P1-1 的失败不是 progress 字段漂移，而是 active task，因此错误码需要拆分，不能简单放宽 gate。

---

## 5. 相关位置

- `desktop/scripts/benchmarks/completion.mjs:18-24`：`finalEvidenceAligned`。
- `desktop/scripts/benchmarks/native-run.mjs:206-223`：尾部任务等待与 `final-evidence-drift`。
- `desktop/scripts/benchmarks/compare.mjs:115-151`：PARTIAL 批准与 previous baseline。
- `desktop/src/measurement/hostWorker.ts:143-145`：终止尾批检查。
- `docs/benchmark.md`：v2 基线迁移尚未说明。
