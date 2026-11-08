# 测量框架与项目架构复核

> 本轮复核状态（2026-11-08）：P1 的慢阶段测试已改为真实 interval，并断言 aggregate 阶段不进入单次慢榜；P2 的 cold WebView profile 非空校验已补，profile 路径仅记录在工作区私有报告；aggregate-only 的基线和慢榜边界已写明。P3 的 active 尾批此前已有受控取消/意外终止测试，本轮源码复核确认计数与 lifecycle 分开。下文 826d876 运行结果仍是历史测量；本轮新产品/框架修改尚未执行样本或性能复测，不能据此宣称 L0 闭环。

> 复核提交：`826d876`（2026-11-08）
> 复核日期：2026-11-08
> 结论：**P0 未发现**；当前 **P1 1 项、P2 2 项、P3 1 项**。P1 是 CI 红灯：`core.test.ts` 用聚合 `probe.record` 断言 `slowestPhases`，而 Collector 只收录 interval 阶段，测试与契约冲突。其余为冷/暖 WebView profile 的冷态校验、aggregate-only 证据边界和活跃任务尾批诊断。

---

## 1. CI 红灯（P1）

### 证据

CI 与本地均可复现：

```
FAIL src/measurement/__tests__/core.test.ts
> keeps a bounded slow phase list even after detail capacity is reached
AssertionError: expected [] to have a length of 10 but got +0
  at core.test.ts:103
```

- `npm run test:measurement-tools`：50/50 通过；
- 完整 `npm test`：1 个失败（就是这一项），其余通过；
- 失败测试使用 `probe.record(context,'dev.compile',ms)`（`Probe.record` 产生 `timing:'aggregate'`），见 `desktop/src/measurement/__tests__/core.test.ts:100-106`；
- `Collector.accept` 的 slow-phase 逻辑要求 `event.timing !== 'aggregate'`，见 `packages/measurement-core/src/collector.ts:109-113`；
- 文档 `docs/benchmark.md` 将 `slow-phases.csv` 定义为“单次阶段”，并明确聚合直方图不充作单次阶段。

### 判定

这是**测试契约错误**，不是产品/Collector 缺陷：`probe.record` 是聚合 duration，不能作为单次 phase；slowestPhases 为空是正确行为。CI 红灯会阻塞合并，必须修测试或重新定义契约。

**建议修复**：测试改用 `probe.phase` 生成 20 个 interval 阶段，并在任务计时前重置 tick：

```ts
for (let ms=1; ms<=20; ms++) { const p=probe.phase(context,'dev.compile'); tick(ms); p.end(); }
tick(0);
probe.event(context,{kind:'task',name:'started'}); tick(33);
probe.event(context,{kind:'task',name:'ended',status:'completed'});
```

若确实希望把聚合阶段纳入 slowestPhases，则需修改契约、文档和 `Collector`，不能让测试与实现各自解释“慢阶段”。

---

## 2. P2：冷/暖 WebView profile 的冷态未完整校验

`desktop/scripts/benchmarks/cache-roots.mjs` 让冷/暖共用 `paired-webview-profile-v1`：

```ts
pairedWebviewProfile = dataRoot => join(dirname(dataRoot), 'webview-profile')
```

`native-run.mjs:56-60` 对 cold 只检查 `dataRoot` 目录为空，没有检查紧邻的 `webview-profile`。IFC LOD 缓存在 WebView2 IndexedDB 中；如果手工复用了一个空的 `dataRoot`（或旧运行留下的空目录），其 sibling profile 仍有 IndexedDB 数据，cold 实际会读暖缓存，违反 cold 语义。批处理默认每次生成新 out 时不会触发，但 `runNative` API、重试/恢复和手工 `dataRoot` 可以触发。

**建议**：cold 同时要求 paired profile 不存在/为空，或显式分配新的 profile 目录；报告记录 profile 路径/策略；增加 cold-with-existing-profile 的测试。warm 继续复用同一 profile。

**严重度**：P2（冷态测量语义）。

---

## 3. P2：aggregate-only 允许通过，但详细时间线/慢阶段证据变为可选

`native-run.mjs` 现在用 `measurement.aggregateComplete` 作为 `measurementComplete` 的必要条件；纯明细容量截断时：

- `measurementDetailStatus='aggregate-only'`；
- `detailComplete=false`，`aggregateComplete=true`；
- `runReadiness` 不再因为 `measurementDetailDropped` 判 INCONCLUSIVE；
- `slowestPhases`/`slowestTasks` 只保留截断前的前十项。

`docs/architecture/measurement.md` 已说明“纯容量截断可降为 aggregate-only，不改变产品 PASS/PARTIAL”。这是合理的产品/诊断分层，但需要明确：

- aggregate-only 的 PASS/PARTIAL 不能声称有完整阶段时间线；
- 基线审批不要求 `measurementDetailStatus=complete`，只要求 aggregate/lifecycle/内容证据；
- slow-phases/slow-tasks 是**诊断视图**，不是基线必要证据。

当前文档已给出边界，但 CI 测试违反了这一边界（见 P1）。建议把“聚合阶段不能进入 slowestPhases”固化为测试，而不是仅在文档中说明。

**严重度**：P2（证据能力边界，不是代码错误）。

---

## 4. 已复核：826d876 的 L1 原生结果

`output/substation-survey-826d876` 为 6 PASS/2 PARTIAL，s03 冷/暖均通过；`output/line-survey-826d876` 为 12/12 PASS。上一轮 s03 的 late spatial task 未再出现，说明 `finalEvidenceIssue`/尾部等待/进度快照路径在当前批次有效。该验证缺口关闭；正式基线仍缺三次重复，见 `research/plan-status.md`。

---

## 5. P3：活跃任务终止尾批目前只是计数器

`hostWorker.ts:143-151` 对 active task 的未确认尾批改为：

```ts
if (active) run.probe.event(context,{kind:'counter',
  name: run.collector.intentionalTermination(workerId)
    ? 'worker.cancelled-unconfirmed-tail'
    : 'worker.active-tail-unconfirmed'});
else run.probe.event(context,{kind:'loss',name:'worker-terminal-tail-unconfirmed'});
```

这比之前“直接跳过”好，能留下诊断；但 active 尾批仍**不计入 `loss.detailEvents`**，而是 counter。受控取消可以正常结算，普通异常由 `interruptedTasks` 使生命周期不完整；有意终止时尾批丢失不一定使测量失败。当前没有 active task + terminate 的测试。

**建议**：区分“有意取消且尾批未确认”和“异常 active 尾批”，至少让报告/review 能解释后者；增加测试。

**严重度**：P3（诊断/边界）。

---

## 6. 项目架构评估

### 分层与边界

- `check:engineering-boundaries` 通过（306 modules、414 type edges、210 dynamic edges）；
- `packages/measurement-core` 仍为纯测量核心，无 DOM/Tauri/Three 依赖；
- `desktop/src/measurement` 负责 Worker/CDP/证据适配；
- 826d876 的产品修改都在既有层内：`gim/engineering/sourceGraph` 增加进度回调、`services/engineeringWorker*` 增加进度/超时续期、`devLodArtifactWriter` 写槽从 4 提到 8、`gim_extract_command` 裸 7z 通用 pack、`substationRuntime` 的语义/DEV 解耦；没有看到跨层反向依赖。

### 测量架构

- 事件/任务/Clock/Collector 的层次完整；新增 `slowestPhases`/`slowestTasks` 是有界前十诊断；
- `aggregateComplete` 与 `detailComplete` 分离，允许纯明细容量截断保留产品判定；
- Worker 批次有连续 ID/ack/flushed；最终 evidence 有类型化失败原因；比上一轮更可诊断；
- `paired-webview-profile-v1` 把 WebView IndexedDB 纳入 cold/warm 身份，v1→v2 迁移文档已写入 `docs/benchmark.md`；
- `review-partial` 增加了独立复核记录、受控原因、候选摘要绑定、首次/上一基线约束，解决了上一轮“任意布尔自报”的主要问题；但复核身份仍是字符串，不是密码学身份，属于流程边界。

### 产品修复

- B1-3 裸 7z 现在使用通用 source pack，不再依赖线路 pack 语义；
- DEV 写槽 8 个、进度/超时续期、B1-4 语义未发布导致 DEV 卡死的修复都在对应服务层，架构方向合理；
- 但这些是产品行为修复，本轮没有完整 L0 原生矩阵，不能仅凭单元测试宣称性能/正确性闭环。

### 架构结论

整体分层和测量核心仍健康。当前主要风险不是边界破坏，而是**契约测试与实现口径不一致（CI）**和**cold profile 冷态校验缺口**；L1 已有 826d876 原生结果，L0 矩阵仍不完整。

---

## 7. 验证

| 命令 | 结果 |
|---|---|
| `npm run test:measurement-tools` | 50/50 通过 |
| `npx vitest run src/measurement/__tests__/core.test.ts` | **1 failed / 13 passed** |
| `npm test`（CI 同口径） | **1 failed / 1476 passed / 3 skipped** |
| `npx tsc --noEmit` | 通过 |
| `npm run check:engineering-boundaries` | 通过 |
| `output/substation-survey-826d876` | 6 PASS / 2 PARTIAL，s03 通过 |
| `output/line-survey-826d876` | 12/12 PASS |

L0 仍未形成完整矩阵（`l0-500-survey-505b10c` 为 5 PASS/2 PARTIAL/1 INCONCLUSIVE/1 FAIL/1 SKIPPED，`35kV-survey-826d876` 仍 RUNNING）；aggregate-only 和 L0 的真实表现仍待开发者本地复跑。

---

## 8. 相关位置

- `desktop/src/measurement/__tests__/core.test.ts:100-106`：CI 失败测试。
- `packages/measurement-core/src/collector.ts:109-113`：slow phase 只收 interval。
- `desktop/scripts/benchmarks/cache-roots.mjs`、`native-run.mjs:56-60`：paired profile 与 cold 校验。
- `desktop/scripts/benchmarks/completion.mjs`、`native-run.mjs:230-270`：final evidence/late task。
- `desktop/src/measurement/hostWorker.ts:143-151`：active 尾批诊断。
- `docs/benchmark.md`、`docs/architecture/measurement.md`：v2/aggregate-only 契约。
