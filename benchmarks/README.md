# 性能样本登记

样本按**资料来源目的**分为 L0、L1、L2，与工程/设备粒度及 `geometryLod` 无关。GIM 文件不入库，开发者自行取得并置于工作区；所有测量的原始日志、缓存与 profile 位于忽略目录。

| 目录 | 登记方式 | 当前仓库登记 |
|---|---|---:|
| [`l0/`](l0/) | 通用设计三维资料逐文件路径 + 完整 SHA256 | 500/220/110/35 kV，34 个路径 |
| [`l1/`](l1/) | 既有变电、线路开发回归逐文件路径 + 完整 SHA256 | 4 变电 + 6 线路 |
| [`l2/`](l2/) | 复杂工程、真实设备的**目录**，不提交文件清单或名称 | 两类目录示例 |

L0/L1 的 SHA 必须与实际 GIM 相同，缺失或改变时该行失败，不自动替换。

L2 的 [目录清单](l2/directories.example.json)只登记通用组名和本地目录；CLI 递归发现 `.gim`、按 SHA 去重，并把本次计算的完整 SHA 写入冻结 Profile、CSV/HTML/JSON。

目录内容变化会改变 Profile，不能与原基线直接比较。目录缺失、为空或不可读均明确报告，不能冒充空集合通过。

L1/L2 报告默认匿名，`--anonymize false` 需由开发者自行决定是否分享。

从 `desktop/` 执行，先取得当前代码的 `npm run bench -- build` 构建清单：

```powershell
npm run bench -- batch --build ../tmp/gim-bench/builds/<构建>/acceptance-build.json --registry ../benchmarks/l0/common-design-500kv.json --output ../output/l0-500-survey --preset baseline --anonymize false
npm run bench -- batch --build ../tmp/gim-bench/builds/<构建>/acceptance-build.json --registry ../benchmarks/l1/substation01-04.json --output ../output/l1-substation-survey --preset baseline --anonymize false
npm run bench -- batch --build ../tmp/gim-bench/builds/<构建>/acceptance-build.json --registry ../benchmarks/l2/directories.example.json --output ../output/l2-survey --preset baseline --anonymize true
```

默认一轮冷开；正式候选增加 `--preset baseline`。全部结果、错误码和测量完整性见 [Benchmark 使用说明](../docs/benchmark.md)。基础功能测试的可编辑三模型示例在 [`desktop/local-tests/`](../desktop/local-tests/)，它不是 L0/L1/L2 性能样本登记。
