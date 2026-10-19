# 实现决策文档

本目录记录已经落地的关键技术决策：为什么这样设计、机制如何运转、边界在哪里、如何验证。目标是让新人能从这里进入代码，而不是只看到结论。

建议阅读顺序：

1. [GIM 特殊格式处理](gim-special-handling.md)：先理解 `.gim` 不是普通压缩包、路径/引用/XML primitive 的特殊性。
2. [IFC / DEV 分级与加载性能](performance-lod.md)：再理解首屏、LOD、Worker/cache 和远景/近景取舍。
3. [系统架构](../architecture.md)、[性能](../performance.md)：回到当前长期契约与实测基线。

文档边界：

- 本目录解释“为什么/怎么运转/新人从哪里改”；
- 字段级格式、样本统计以 [Schema](../schema/README.md) 为准；
- 性能数字与可比条件以 [性能](../performance.md) 为准；
- 未关闭缺陷与已接受限制只维护在 [问题与限制](../open-issues.md)。
