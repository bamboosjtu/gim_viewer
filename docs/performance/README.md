# 性能经验与门禁

本目录把项目历史会话中仍成立的性能做法整理成当前开发约束。先读[性能门禁](gates.md)，再按改动方向选文档。运行时事实仍以[架构](../architecture.md)和源码为准，测量方法见[性能测试指南](../performance-guide.md)，CLI 见 [Benchmark](../benchmark.md)。

## 方向索引

| 方向 | 文档 | 主要防止什么回退 |
|---|---|---|
| 原生解压与存储 | [native-extraction.md](native-extraction.md) | 回到低吞吐解压、海量小文件/逐条 IPC、重复解包 |
| 来源读取与索引 | [source-io.md](source-io.md) | 重扫全包、重复读/解析、串行准备阻塞无关根 |
| 首屏与生命周期 | [startup-first-frame.md](startup-first-frame.md) | 几何等待完整语义/校核/落盘，白屏却报交互完成 |
| 实体与视图投影 | [engineering-and-projections.md](engineering-and-projections.md) | 重分类重编几何、展开树重建工程、复制属性 |
| DEV 几何与 LOD | [geometry-and-lod.md](geometry-and-lod.md) | 丢设备换速度、默认 L2、分治后不等价 |
| IFC 与空间语义 | [ifc-and-spatial.md](ifc-and-spatial.md) | 重开整源、全量资源当产品、无界顶点复制 |
| Worker 与内存 | [workers-and-memory.md](workers-and-memory.md) | 盲目加线程、结果积压、空闲池/回调保留大对象 |
| 序列化与传输 | [serialization-and-transfer.md](serialization-and-transfer.md) | 大字符串、多份缓冲、错误零复制、同步主线程编码 |
| 缓存与持久化 | [cache-and-persistence.md](cache-and-persistence.md) | 暖开回到冷计算、整批失效、先写盘后显示 |
| 绘制与交互 | [rendering-and-interaction.md](rendering-and-interaction.md) | 静态重绘、矩阵重算、全 Mesh 拾取、不安全捷径 |
| 校验成本 | [validation-cost.md](validation-cost.md) | 无理由 hash、反向核对源 STL、重复扫描 |
| 测量与验收 | [measurement-and-acceptance.md](measurement-and-acceptance.md) | 口径变更伪收益、缺采样当零、自动批准基线 |
| 线路与移动端 | [line-and-mobile.md](line-and-mobile.md) | 拉入桌面重依赖、逐节点入库、伪暖恢复、重复地图工作 |

## 历史材料的使用边界

2026-11-15 筛查了应用可访问的 25 个相关或项目工作区会话，其中 17 个归档；全部可访问分页已结束。会话和游标覆盖审计保存在本地 `output/log/performance-history-review.private.json`，不作为 CI 输入或随仓库分发的运行数据。

会话用于发现经验和反例，不能单独证明现在实现了什么。本文档与当前源码、契约测试交叉核对；研究 Demo、SDK 设计和外部引擎跑分不写成 Viewer 的现有能力。撤回的优化只保留教训，不恢复实验分支。当前只预留 SDK/Validator 边界，不因本目录抽取 SDK 或实现校核器。

每个方向区分结构/计数证据和本地性能证据。减少调用次数、解除等待、字节等价或单测通过，都不能独自证明整站提速；真实收益以开发者本地冻结构建的同条件报告为准。历史固定秒数、内存总量及增长比例目标不构成现行门禁。

## 单一权威

- 性能是否接受、复测范围、认可基线：开发者决定。
- 无样本契约与依赖方向：现有 CI 和[验证](../validation.md)。
- 性能原则和比较字段：[performance-policy.mjs](../../desktop/scripts/benchmarks/performance-policy.mjs)，契约固定 v1。
- 缓存域、失效范围及实现预算：[缓存域](../architecture/caches.md)；预算不等于进程峰值或验收目标。
- 当前未关闭缺陷：[问题与限制](../open-issues.md)。本目录不把未验收项改写为通过。
