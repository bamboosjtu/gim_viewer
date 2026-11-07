# 手动测量注册表

注册表固定源路径和完整 SHA256，不包含 GIM 文件。通用设计来自开发者自备的资料，既有开发样本使用匿名文件别名。SHA 不匹配或文件缺失会进入错误报告；不会自动更新注册表或替换样本。

| 注册表 | 集合 | GIM 数 |
|---|---|---:|
| `common-design-500kv.json` | L0，500 kV 通用设计 | 5 |
| `common-design-220kv.json` | L0，220 kV 通用设计 | 15 |
| `common-design-110kv.json` | L0，110 kV 通用设计 | 10 |
| `common-design-35kv.json` | L0，35 kV 通用设计 | 4 |
| `substation01-04.json` | L1，既有变电回归来源 | 4 |
| `line01-06.json` | L1，既有线路回归来源 | 6 |

集合按资料形成目的登记，与几何 LOD 无关。上述文件均采用相对注册表目录的路径，可以随工作区一起移动。需要按单一样本重跑时，临时写一个只含该样本的注册表即可；仓库不再为每个样本维护独立文件。

默认测量路线为完整打开：等待自动请求的表示和缓存任务结束，不自动请求全部 L2，也不运行 Validate。先批量收集所有结果和错误，再按错误集中整改。冻结基线前使用相同 JSON、构建方式、运行时、测量模式和机器；不要并行运行测量或编译。

在 `desktop/` 执行：

```powershell
# 先构建一次，记录输出的 acceptance-build.json 路径。
npm run bench -- build

# 一轮冷开摸底；实名报告显示文件名与工作区相对路径。
npm run bench -- batch --build ../tmp/gim-bench/builds/<构建>/acceptance-build.json --registry ../benchmarks/registries/common-design-500kv.json --anonymize false --output ../output/common-500-survey

# 三轮冷暖基线候选；匿名报告显示完整 SHA256。
npm run bench -- batch --build ../tmp/gim-bench/builds/<构建>/acceptance-build.json --registry ../benchmarks/registries/substation01-04.json --preset baseline --anonymize true --output ../output/substations-baseline

# 线路批量，同样使用原生进程及独立缓存。
npm run bench -- batch --build ../tmp/gim-bench/builds/<构建>/acceptance-build.json --registry ../benchmarks/registries/line01-06.json --anonymize false --output ../output/lines-survey
```

默认 `--anonymize true`。匿名和实名仅改变报告展示，不改变测量 Profile 或执行路线。每次使用新的输出目录；中断可按 Ctrl+C 或在输出目录创建 `stop.request`。结果解释与全部开关见 [Benchmark 使用说明](../../docs/benchmark.md)。运行后提供输出目录即可分析 `results.json`、CSV 和 HTML；不需要上传模型或原始日志。缺少完整测量验收与明确认可时，不把任何摸底结果提升为基线。
