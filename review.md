# 测量框架与项目架构复核

> 复核对象：工作区（基于 `93df24f`，含 2026-11-08 的本轮修复）
> 复核日期：2026-11-08
> 结论：**P0 未发现，上一轮 P1/P2/P3 均已关闭，完整测试全绿。** 当前没有已确认的代码缺陷；剩余是 **L0/L1 原生验收和产品改动的实验证据**，不是新的 P1/P2。

---

## 1. 上轮问题复核

### 1.1 CI：已关闭

上轮失败是 `hostWorker.test.ts` 仍期待 queued-never-started 任务在终止时记为 `aborted`。本轮已按新契约改为：

```ts
taskOutcomes: { failed: 1, cancelled: 1 }
loss: { cancelledBeforeStart: 1, interruptedTasks: 0 }
```

本地完整测试：

- `npm test`：179 个文件全部通过，**1480 通过、3 跳过**，exit 0；
- `test:measurement-tools`：57/57；
- `test:acceptance-tools`：4/4；
- `tsc --noEmit`：通过；
- `check:engineering-boundaries`：通过（306 modules、414 type edges、210 dynamic edges）。

### 1.2 L1 catalog 豁免：申诉成立，已撤回

上一轮把**样本集合 L1** 与**几何 LOD1 模板**混为一谈，判断错误，撤回该项。

正确口径已写入 `docs/benchmark.md` 并在测试中固定：

- catalog 按**唯一 DEV 来源**核对，命中与未命中覆盖全部 DEV；
- 选择性持久化的 **几何 LOD1 模板** miss（`devLodMisses[1]`）不进入 catalog 分母；
- 样本集合 `L1` 只是开发回归资料层级，不改变缓存规则。

`warmCatalogCoverage` 继续使用统一的来源集合规则；契约测试补充了 LOD1 misses 不参与 catalog 的用例。该项不是代码缺陷。

### 1.3 warm profile：已关闭

`checkedWebviewProfile` 现在：

- cold：SQLite 根与 WebView2 profile 都必须为空；
- warm：paired profile 必须存在且非空，否则 `warm-webview-profile-unavailable` / INCONCLUSIVE，不启动伪暖开。

测试覆盖 missing/empty profile。`profile.private.json` 只保存在私有运行目录。

### 1.4 recover-batch：已关闭

外部中止恢复现在：

- 写入 controller PID/启动记录；恢复前若 controller 仍存活，拒绝并抛 `batch-controller-still-running`；
- 恢复批次/运行带 `recovery` 标记；
- `runReadiness` 将 recovery 判 INCONCLUSIVE；
- `approveBaseline` 拒绝 recovery，CLI compare/gate 也拒绝；
- 缺失耗时保持空值，最小报告 `measurementComplete=false`。

测试覆盖 PID 存活拒绝、恢复标记和基线拒绝。

---

## 2. P0：样本依赖

仍为**未发现 P0**：

- correctness 只读取本次 evidence 的 checks、geometryDefects、engineeringCoverage、digest/count；
- expected-defect/coverage 注册表不存在；
- 默认样本发现只按目录扫描；
- L1/LOD1 是不同维度，当前 catalog/cache 证明按唯一 DEV 来源和实际模板 miss 分离，没有样本专属豁免。

---

## 3. 当前未关闭的验收项（非代码缺陷）

### P2：产品改动缺少 93df24f 之后的原生证据

本轮产品修复包括：

- 工程构建待办/tree 终态阻止提前结算；
- 无 Spatial 模型时发布部分树；
- `product-stalled` 60 秒无进展终结；
- 单个超大 MOD 按可见根 rootSlice 分部编译；
- 容量错误沿 cause 传递；
- `sourceGraph`/engineering Worker 进度续期。

这些改动有单元测试，但当前 `substation-survey-826d876`/`line-survey-826d876` 都是 **93df24f 之前**的批次。`docs/open-issues.md` O-17 仍明确 rootSlice 需原生复核；`product-stalled` 的 60 秒阈值也可能误伤合法长任务。不能仅凭 `npm test` 宣称产品闭环。

**下一步**：同构建、同 SHA 至少重跑 L1 变电/线路，再抽 L0 500/35kV；核对 rootSlice 几何完整、失败子码、tree 终态和 60 秒阈值。

### P3：L0/L1 测量矩阵仍未完成

- L1 826 批次只有 **1 组冷暖**，正式基线需三次独立重复；
- L0 500 仍有 1 FAIL（B1-4 renderer crash）和 1 INCONCLUSIVE（B1-3 明细截断，后续 aggregate-only 修复需重跑）；
- 35kV 仍 RUNNING；
- 无 v2 认可基线；旧 v1 基线不可直接比较；
- 探针开销 A/B、十轮 lifecycle 尚未执行。

这些属于 `research/plan-status.md` 的 C 阶段验收，不是测量框架新增缺陷。

---

## 4. 项目架构评估

### 分层与边界

- `check:engineering-boundaries` 通过：306 modules、414 type edges、210 dynamic edges。
- `packages/measurement-core` 仍为纯测量核心，无 DOM/Tauri/Three 依赖。
- 产品改动均在既有层内：
  - `sourceGraph`/`engineeringWorker` 负责来源进度；
  - `engineeringService`/`compositionProjectionService` 负责构建待办、tree 终态和部分树发布；
  - `glbCacheService`/`devGeometryWorker*` 负责 MOD 分部和 rootSlice；
  - `geometry_cache.rs`/`devLodCache.ts` 负责原生写入分段；
  - 未发现新的跨层反向依赖。

### 测量架构

- `aggregateComplete` 与 `detailComplete` 分离；纯容量截断进入 aggregate-only，slow 榜仅诊断，文档与测试一致。
- `finalEvidenceIssue` 区分 active-tasks/progress-drift/session-mismatch；late task 有界等待和进度快照。
- `cacheProofPolicy=source-failure-catalog-v1` 和 `paired-webview-profile-v1` 已进入身份；旧基线不可直接比较。
- `recover-batch` 增加了 controller ownership、recovery 标记和 gate 拒绝，状态机比上一轮完整。
- `review-partial` 的双人复核、受控原因、候选摘要绑定和 previous-baseline 约束保持完整；复核者身份仍是字符串，属于流程边界。

### 架构结论

分层、测量核心和报告边界健康；上一轮指出的代码问题均已关闭。当前主要风险是**产品大改动的原生证据**和**L0/L1 矩阵/基线验收**，不是测量框架的新代码缺陷。

---

## 5. 验证

| 命令/证据 | 结果 |
|---|---|
| `npm test` | 179 files / 1480 passed / 3 skipped，exit 0 |
| `npm run test:measurement-tools` | 57/57 |
| `npm run test:acceptance-tools` | 4/4 |
| `npx tsc --noEmit` | 通过 |
| `npm run check:engineering-boundaries` | 通过 |
| `substation-survey-826d876` | 6 PASS/2 PARTIAL，s03 通过（93df24f 之前） |
| `line-survey-826d876` | 12/12 PASS（93df24f 之前） |

---

## 6. 相关位置

- `desktop/src/measurement/__tests__/hostWorker.test.ts`：queued-never-started 断言。
- `desktop/scripts/benchmarks/cache-roots.mjs`：cold/warm paired profile 校验。
- `desktop/scripts/benchmarks/profiles.mjs`、`docs/benchmark.md`：catalog 与 LOD1 维度分离。
- `desktop/scripts/benchmarks/batch.mjs`、`compare.mjs`、`cli.mjs`：recover-batch ownership/recovery gate。
- `docs/open-issues.md` O-17：rootSlice 原生复核。
- `research/plan-status.md`：L0/L1 矩阵与基线验收。
