# GIM Viewer 架构评审（复核 v6）

> 复核对象：`17cc477`「UI大文件问题」+ 本轮 R1–R3 修复（工作区）
> 复核日期：2026-11-07
> 本轮范围：R1–R3 修复复核与文档同步
> 结论：**R1–R3 全部关闭，当前无未关闭问题**；剩余条目均为架构约束。

**项目约定（不作为缺陷）**：

- 工程测试集、对照基线和复跑环境由开发者自行构建；远程 CI 只运行不依赖工程样本的单元测试、静态检查和构建。
- `docs/performance.md` 只代表作者在所述机器、构建和私有样本上的结果。
- SQLite 物理 schema 在首次正式发布前固定 v1；结构变更由开发者删库重建。

---

## 1. 复核结论

| 上轮项 | 状态 | 复核证据 |
|---|---|---|
| R1 `bench samples` 的 L1 发现失效（0/10） | **已关闭** | `samples.mjs` 改为从 `demo/substations/` 与 `demo/lines/` 发现；实测 `defaultSources()` 返回 **10/10** |
| R2 L1 注册表缺 line05/06（8/10） | **已关闭** | 新增 `line01-06.json`（6 条），与 `substation01-04.json`（4 条）合计 **10**；逐条 SHA256 与源文件核对 **6/6 一致** |
| R3 注册表清单与示例文档过期 | **已关闭** | `registries/README.md` 更新为 `line01-06.json`、删除单样本注册表说明；`docs/benchmark.md` 示例路径改为 `../demo/substations/substation01.gim`；操作文档与脚本中已无旧文件引用（本文记录除外） |

样本发现实测：

| 组 | 发现 | 期望 |
|---|---:|---:|
| common-design (L0) | 48 | 48 |
| common-model (L0) | 917 | 917 |
| development-regression (L1) | **10** | 10 |
| complex-engineering (L2) | 19 | 19 |
| complex-equipment (L2) | 7 | 7 |

本轮改动（均未提交）：

| 文件 | 变更 |
|---|---|
| `desktop/scripts/benchmarks/samples.mjs` | L1 发现路径改为子目录 |
| `benchmarks/registries/line01-06.json` | 新增，6 条样本 + SHA |
| `benchmarks/registries/line01-04.json` | 删除（被上一项取代） |
| `benchmarks/registries/README.md` | 表项、说明、示例命令同步 |
| `docs/benchmark.md` | 示例注册表路径同步 |
| `desktop/scripts/engineering/web-perf-browser.mjs` | 默认样本路径与用法注释同步 |

校验：`npm run lint` 通过；`check:engineering-boundaries` 通过（305 模块 / 413 类型边 / 210 动态边）。本轮未改 `desktop/src`，沿用上一轮全量结果：**176 文件 / 1460 用例通过 / 3 跳过**，覆盖率 73.55%。

---

## 2. 仍存在的问题

**无。** 前几轮登记的问题均已关闭，关闭证据见附录 A。以下内容不属于缺陷，但会影响下一阶段决策。

---

## 3. 架构约束（不是缺陷）

1. **单 OS 进程内的 Worker 并行**：DEV/PHM/MOD 编译在 `devGeometryWorker` 池，IFC 转换/区域/精细/Spatial 各有 Worker；主线程只做 GLB 恢复、场景提交与 raw fallback。进程隔离仍以复现 OOM/崩溃为启动条件。
2. **Rust 只做 IO/解压/SQLite/语义索引**：Android 无法直接复用桌面几何编译。
3. **测试集本地化**：CI 只验证代码契约；"工程可用"必须由开发者本地样本复跑。
4. **SQLite schema 固定 v1**：结构变更即删库重建。
5. **测量核心源码内联**：`packages/measurement-core` 以源码形式被 `desktop/src/measurement/core.ts` 引用；边界脚本禁止其他入口与核心外导，`exports`/`dist` 不是当前消费契约，SDK 阶段再验证打包。
6. **会话守卫以显式调用为主**：`isCurrentProject` / `isCurrentGeometry` 已统一；`SessionScope` 抽取列入 SDK 阶段。

---

## 4. `research/plan.md` 状态

| 阶段 | 状态 | 说明 |
|---|---|---|
| A 样本与测量设计 | **完成** | L0 48+917、L1 10、L2 19+7 与计划一致；注册表 10 条 L1 全部可核对；测量契约与源码内联边界已明确 |
| B 测量系统实现 | **基本完成** | 核心 + 桌面适配、7 类 Worker 探针、宿主链路、内存账本、采样器、报告；探针开销 A/B 与十轮 lifecycle 的**验收尚未执行** |
| C Benchmark 与基线 | **实现完成，验收未完成** | CLI/报告/比较/门禁已实现并有测试；无本地批次结果、无认可基线（`open-issues` O-15） |
| D–F SDK | **未开始** | 符合顺序；进入前完成 B/C 验收 |
| G/H 优化与隔离 | **未开始** | G 需基线证据；H 未复现 OOM 不触发 |

当前阻塞点已不在实现，而在**本地批次执行与基线认可**。建议顺序：`batch --preset baseline` → `overhead` A/B → `lifecycle` 十轮 → `approve-baseline` → 再启动 D 阶段。

---

## 5. 复核方法与证据

```powershell
cd desktop
npm run lint                                     # 通过
node scripts/check-engineering-boundaries.mjs    # 通过（305 模块 / 413 类型边 / 210 动态边）

# 仓库根：样本发现
node -e "import('./desktop/scripts/benchmarks/samples.mjs').then(m=>console.log(m.defaultSources(process.cwd()).map(x=>[x.group,x.paths.length,x.expected])))"
# → development-regression 10 / 10；L0 48+917；L2 19+7

# 仓库根：注册表 SHA 核对（node 脚本读取 line01-06.json 并逐个哈希）
# → 6/6 OK
```

---

## 附录 A：已关闭项

### 本轮关闭

| 项 | 问题 | 关闭证据 |
|---|---|---|
| R1 | `bench samples` L1 发现 0/10 | 路径改为 `demo/substations`、`demo/lines`；实测 10/10 |
| R2 | L1 注册表 8/10 | `line01-06.json` 补 6 条；SHA 6/6 一致；合计 10 |
| R3 | 清单与示例过期 | README/benchmark.md/web-perf 示例同步；全仓无旧引用 |

### 前几轮关闭（摘要）

- `245dd61`：覆盖率门禁间歇失败（`devLodRuntime` 定时器）关闭；连续 3 次 `test:coverage` exit 0。
- `8c943be`：Python 门禁、UI 值依赖、内联样式/CSP、无用依赖、FAM 语义、覆盖率门禁 6 项关闭。
- `17791da`：13 项关闭；会话守卫转为约束。
- 测量核心包边界（旧 R2）：申诉采纳"源码内联"，边界脚本强制核心不外导、桌面仅走门面、门面内容固定。

---

## 附录 B：对原报告的更正

1. **"没有任何提交点因 token 变化而拒绝"不成立。** `cf6e196` 时 `isGeometryTokenValid` 已存在并被几何路径使用。
2. **Android "必失败"撤回。** 原推断未经运行验证；`normalize_entry_key` 已统一。
3. **性能/内存归因撤回。** 静态代码不能证明 21 s / 7.5 GiB 与单进程拓扑的因果关系。
4. **"验证资产不可复现"撤销。** 测试集自建、CI 不跑样本是项目约定。
