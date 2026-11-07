# 桌面 Benchmark 工具

当前原生测量入口为 `npm run bench -- ...`，包括固定 WebView2 构建、能力检查、目录/JSON 批量运行、冷暖比较、探针开销和生命周期测试。命令、报告口径与匿名化规则见 [Benchmark 使用说明](../../../docs/benchmark.md) 和 [测量架构](../../../docs/architecture/measurement.md)。

来源层级在 [`benchmarks/`](../../../benchmarks/README.md) 登记：L0/L1 的文件绑定 SHA；L2 以本地目录发现文件，运行时计算 SHA。原始 profile、日志和私有路径映射仅写入工作区 `tmp/`，分享报告写入 `output/`。普通 CI 只运行值与协议测试，不运行模型或性能矩阵。

旧的固定样本浏览器与 IFC 单文件探针已退役。原生启动、Worker/CDP 能力使用不需要 GIM 输入的 `bench doctor` 检查；性能或内存结论以注册表批次为准。
