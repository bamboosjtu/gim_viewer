# 测量可信度与性能接受

本页约束如何证明改动有效，复用现有 Benchmark、Trace、Profile。命令见 [Benchmark](../benchmark.md)，细节见[测量架构](../architecture/measurement.md)，不再建立另一套采集体系。

## 时刻与工作量

导航 DOM、可用几何提交、首次有效视口绘制、基础表示收敛、缓存发布和最终结算分别记录。首次几何确认实际模型绘制提交，不等待 GPU 完成。基础 L0 收敛不是全站精确 L2，也不意味着 partial/unsupported/failed 为零。

计时策略从实际前端读取。旧几何提交与新首次可见、包含持久化与排除持久化的自动加载，不能直接计算节省百分比；保留两侧绝对值和不同口径。不能靠提前结算、少加载、暂停生产工作、降低覆盖或隐藏错误制造改善。

最终结算继续包含承诺的缓存终态、后台任务和静默窗口；尾部排空后再取最终证据，防止结算后才启动 Spatial/名称等工作。异步并发阶段总时长和 CPU 样本栈权重都不能直接相加为用户等待时间。

## 门禁

- 比较绑定构建/EXE、样本 SHA、固定运行时、机器/校准、视口/动作、缓存/profile 与测量策略。相同应用版本号不等于相同二进制。
- 每个版本建立自己的有效冷暖；不完整冷开后的重开是部分恢复。不同 PARTIAL 缺陷集合不混算中位数。
- PASS 只代表相应正确性/采集检查，不代表无性能回退、无缺陷或认可基线。失败、取消、缺样本及 INCONCLUSIVE 不补零或计通过。
- Worker 任务、尾批、时钟与采样窗口完整；正常重叠合并不伪记采样失败，真正超时/空窗/意外终止仍单列。短生命周期和不可用不冒充有效零值。
- 清理检查关联被关闭的旧 run，不能 reset 后用新空账本证明释放。采样不触发强制 GC，也不因测量改变业务取消或有效性。
- Private Bytes、JS 堆、WASM 容量、图形账本、GPU 显存分口径；GPU 未采集/不支持显示未知，不从进程内存推算。
- 运行中报告仅更新需要的小表和耐久检查点；不反复遍历/导出大型诊断表干扰测量。完成报告的格式可从原 JSON 重建，不能重新测量或改数值充当排版修复。

## 本地决定

报告绝对耗时、百分比、节省秒数及整批总和，不擅自加权；每个明显变慢的对象和每个峰值成本保留。局部 codec/矩阵/读取收益不能直接扩写成整站成功，较好的后测不能抹去此前高峰值或失败。

优化须有至少一个可测的明显提升，是否有意义和是否接受由开发者判断。功能/正确性成本应具体归因，不自动豁免回退。没有统一的秒数、内存总量或增长比例验收线。轮内保留增长与跨版本峰值分别报告；`optimizationAccepted` 不自动为 true。

采集器/环境改变或证据缺口才补相应 doctor、开销、生命周期或诊断证据；不默认每轮重跑整套矩阵。旧实验中的固定目标、固定重复次数和旧政策版本不恢复为现行门禁。

代码：[政策](../../desktop/scripts/benchmarks/performance-policy.mjs)、[比较](../../desktop/scripts/benchmarks/compare.mjs)、[最终取证](../../desktop/scripts/benchmarks/completion.mjs)、[采样](../../desktop/scripts/benchmarks/cdp.mjs)。检查：[政策](../../desktop/scripts/benchmarks/performance-policy.test.mjs)、[Worker 生命周期](../../desktop/src/measurement/__tests__/hostWorker.test.ts)和 `test:measurement-tools` 对应协议测试；本地实测仍独立。
