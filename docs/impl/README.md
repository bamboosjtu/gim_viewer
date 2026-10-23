# 实现决策文档

本目录记录已经落地的关键技术决策：为什么这样设计、机制如何运转、边界在哪里、如何验证。目标是让新人能从这里进入代码，而不是只看到结论。

建议阅读顺序：

1. [GIM 特殊格式处理](gim-special-handling.md)：先理解 `.gim` 不是普通压缩包、路径/引用/XML primitive 的特殊性。
2. [IFC / DEV 分级与加载性能](performance-lod.md)：再理解首屏、LOD、Worker/cache 和远景/近景取舍。
3. [系统架构](../architecture.md)、[性能](../performance.md)：回到当前长期契约与实测基线。

P0 的选择查询依据见 [选择查询与大站基线](selection-and-baseline.md)：保留已测得收益的 occurrence 根查询，区分局部收益、选择阶段记录与未通过的大站指标。

后续受控对照见 [导航等待与缓存批读准入](navigation-and-cache-admission.md)：区分模块导入等待、原生文件缓存批读成本与派生缓存缺失时的逐源读取长尾。

DEV 派生缺失恢复的准入、不可变 File 补发、暖路径对照和真实故障隔离见 [受控源工作集](dev-recovery-workset.md)。

选择与显式 L2 的高亮连续性见 [IFC 表示高亮迁移](selection-l2-highlight.md)：只更新被替换对象，保留其他选中来源，并处理取消、失败及旧提交晚到。

未成功技术路线使用 `test-*.md` 独立记录假设、实验边界、结果与回退，不视为已实现能力：

- [扩展选择依赖与高亮合批](test-selection-dependency-batching.md)：缺少有效端到端收益对照，未混入 DEV 恢复交付。
- [gate 失败释放顺序](test-dev-gate-release-order.md)：既有微任务唤醒已保证原顺序安全，未证实竞态，改动已撤回。
- [额外目录探测](test-dev-warm-catalog-probe.md)：完整缓存重复恢复未证明稳定不回退，改为复用正常目录首批。
- [提高 DEV Worker 比例](test-dev-worker-overprovision.md)：历史尝试未获收益，当前大站快照也不支持仅凭空闲 Worker 增加并发。

文档边界：

- 本目录解释“为什么/怎么运转/新人从哪里改”；
- 字段级格式、样本统计以 [Schema](../schema/README.md) 为准；
- 性能数字与可比条件以 [性能](../performance.md) 为准；
- 未关闭缺陷与已接受限制只维护在 [问题与限制](../open-issues.md)。
