# GIM Viewer v0.2.1 代码与架构复核

> 复核基线：`9d0a391` + 本次清理（2026-11-08）
> 复核范围：桌面端、测量核心、本地 Benchmark、文档与 CI
> 结论：**P0 未发现；P1 未发现。** 当前保留 **P2 1 项**（v0.2.1 产品改动的原生验收缺口）。文档协议版本采用人工核对；`recover-batch` 的所有权边界已整改，待 CI 验证。

---

## 1. 本次清理

### 删除的死代码

- `desktop/src/viewer/highlight.ts`：删除 `HIGHLIGHT_STYLE` 及仅它使用的 `@thatopen/fragments` 导入；实际高亮走 `HIGHLIGHT_MOD_COLOR` 和 selection outline。
- `desktop/src/services/engineeringCacheCodec.ts`：删除无人引用的 `EngineeringEntityArtifact`。
- `packages/measurement-core/src/types.ts`：删除无人引用的 `MeasurementCapabilities`；`Availability` 仍由 memory 类型使用。

均通过全仓库引用检查和 `tsc --noUnusedLocals --noUnusedParameters` 复核；不是导出 API 的猜测性删除。

### 删除的低价值测试

- `desktop/src/config/__tests__/tianditu.test.ts`：删除只断言 `TIANDITU_SUBDOMAINS` 常量数组的测试；保留 Key 修剪、URL 编码、可用性等行为测试。常量仍由 `lineMapStyle` 实际使用。

### 无效分支审计

- 未发现 `if (false/true)`、不可达 return、遗留 TODO/FIXME 或空的兼容分支。
- `tsc` 的 unused locals/params、ESLint 和仓库搜索均无新增问题；未为了“清理数量”删除动态导入、Worker 入口或公开类型。

### 文档清理

- `docs/architecture/measurement.md`：协议从错误的 `gim-measurement-v2` 修正为代码中的 `gim-measurement-v1`。
- 删除 `README.md` 和 `docs/architecture/measurement.md` 中重复的 Benchmark CLI 链接。
- 全局 Markdown 机械检查已退役；文档由人工复核，不作为构建门禁。

---

## 2. 代码与架构评审

### 2.1 分层和边界

- `check:engineering-boundaries` 通过：306 modules、414 type edges、211 dynamic edges。
- `packages/measurement-core` 仍无 DOM/Tauri/Three 依赖；桌面端只通过 `desktop/src/measurement/core.ts` 使用核心源码。
- `services/` 负责调度和宿主适配，`gim/` 负责来源解析，`viewer/` 负责渲染；本次清理未改变依赖方向。
- 未发现新的跨层反向依赖或样本名称/路径驱动的 correctness 分支。

### 2.2 测量与报告

- 协议为 `gim-measurement-v1`；`task-phase-timeline-v2` 是明细传输策略，不是协议版本，文档已区分。
- `aggregateComplete`/`detailComplete`/`lifecycleComplete`/`memoryEvidenceComplete` 分层清晰：
  - 纯明细容量截断可以 aggregate-only，不改变产品 PASS/PARTIAL；
  - 内存证据缺口不把产品打开判为 INCONCLUSIVE，但正式内存比较和基线批准要求完整；
  - slow-tasks/slow-phases/slow-templates 是诊断数据，不作为完整时间线或基线必需证据。
- `slow-templates` 新增最慢 20 个等待者/占用者；原始 DEV 路径写入 `tmp/gim-bench` 私有文件，可分享报告只保留 `sourceId`。实现与 `docs/benchmark.md` 一致。
- `checkedWebviewProfile` 已要求 cold 的 SQLite 根和 paired WebView profile 为空，warm 的 profile 存在且非空；缺失时是 INCONCLUSIVE，不伪造 warm。
- `recover-batch` 增加 controller PID/ownership 检查、`recovery` 标记、`recovery` 运行拒绝进入 gate/approve。恢复报告不生成耗时或缓存成功。

### 2.3 产品改动

本版本新增/调整：

- 工程构建待办、tree 终态、无 Spatial 模型时的部分树发布；
- 60 秒无进展的 `product-stalled`；
- 单个超大 MOD 的 visible-root rootSlice 分部编译；
- DEV 模板调度诊断、场景提交队列和 DEV 缓存写入分段；
- 原生小文本批量物化提前到类型判断前。

这些改动都落在既有服务/Worker/缓存层；`tsc`、单元测试、边界检查未发现架构破坏。它们的行为验证仍不完整，见 P2。

---

## 3. 当前问题

### P2：v0.2.1 产品改动的原生验收缺口

**现状**：

- `output/substation-survey-826d876`（6 PASS/2 PARTIAL）和 `output/line-survey-826d876`（12/12 PASS）都早于本版本的 DEV 调度、slow-templates、rootSlice、tree 终态和 product-stalled 改动；
- 本版本没有新的原生 L0/L1 冷/暖结果；
- `docs/open-issues.md` O-17 仍要求单个超大 MOD 的 rootSlice 做原生几何、失败子码和输出预算复核；
- `product-stalled` 的 60 秒阈值、tree 终态、DEV 写入分段尚无真实大工程证据。

**影响**：单元测试通过不能证明大工程、真实 WebView2、缓存和 Worker 调度闭环；不能据此宣布 v0.2.1 性能或产品验收完成。

**建议**：同构建、同 SHA 至少重跑 L1 变电/线路冷暖，再抽 L0 500/35kV；核对 rootSlice 完整几何、tree 终态、60 秒阈值和 slow-templates 的匿名输出。该缺口属于验收，不是已确认代码缺陷。

**严重度**：P2。

### 已接受约定：测量协议文档不进入测试

本次发现 `docs/architecture/measurement.md` 曾写成 `gim-measurement-v2`，而代码是 `gim-measurement-v1`；现已人工核对一致。项目决定 Markdown 文档不作为 CI 测试输入。

**维护方式**：变更协议常量时同步更新文档，代码行为由协议单元测试验证；不增加 Markdown 字符串断言或文档门禁。

**状态**：按项目约定接受，不作为未关闭产品缺陷。

### P3 整改待验收：recover-batch 控制器所有权

控制器私有记录现包含随机 nonce、输出目录映射与进程启动时间。恢复时共同核对这些凭据；原 PID 被其他进程复用不会误拒绝。旧批次缺记录或进程身份无法确认时需显式 `--force`；仍存活的原控制器拒绝恢复。恢复结果保留 `recovery` 标记，不能进入 gate/基线。

**剩余**：本轮未复跑测试或原生批次，需由后续 CI 和本地中断恢复场景验证。

**状态**：代码已整改，待验收。

---

## 4. 已关闭的复查项

- CI 的 `hostWorker` queued 终止断言：已改为 `cancelled`/`cancelledBeforeStart`，完整测试通过。
- cold/warm paired profile：cold 双空、warm 存在且非空；测试覆盖。
- slow-phases interval/aggregate：测试固定；`core.test.ts` 15/15。
- aggregate-only 和慢榜边界：文档、测试和实现一致。
- L1 catalog 豁免申诉：成立。catalog 按唯一 DEV 来源核对，选择性持久化的几何 LOD1 模板 miss 不进入 catalog 分母；不保留“样本 L1 豁免”的错误判断。
- recovery 标记/基线拒绝：测试覆盖；恢复批次不能进入 approve/gate。

---

## 5. 验证

| 命令 | 结果 |
|---|---|
| `npm test` | 179 files / 1480 passed / 3 skipped，exit 0 |
| `npm run test:measurement-tools` | 59/59 |
| `npm run test:acceptance-tools` | 4/4 |
| `npm run lint` | 通过 |
| `npx tsc --noEmit` | 通过 |
| `npm run check:engineering-boundaries` | 通过（306/414/211） |
| Markdown 机械检查 | 已移除，不作为 CI 或本地测试门禁 |
| 缓存文档字符串检查 | 已从 CI 和 npm 脚本移除；Markdown 不作为测试输入 |
| `npm run check:version` | 0.2.1，清单一致 |

上表为此前本地检查记录，不代表本轮复跑。CI 运行 `42480679628` 的测量工具检查为 58/59，失败用例缺少原生报告必需的生命周期字段；本轮已修正 fixture，待新 CI 验证。本次没有运行原生 L0/L1 或性能矩阵；P2 的结论是验收缺口，不是已确认的产品失败。

---

## 6. 建议顺序

1. 先提交本次死代码/文档清理，确认 CI 全绿；
2. 用同一构建重跑 L1 变电/线路冷暖，验证 s03/tree/rootSlice/慢模板；
3. 完成 L0 500/35kV 的剩余样本，处理 B1-4 renderer crash 和 B1-3 aggregate-only 复测；
4. 执行探针 overhead A/B、十轮 lifecycle；
5. 生成并显式批准 v2 基线后，再进入 SDK 阶段。
