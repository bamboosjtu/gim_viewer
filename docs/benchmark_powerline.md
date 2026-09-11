# 线路性能 Benchmark

> 本文描述线路 Runtime 的性能模型、现有证据和下一步测量计划，不把样本格式结论或
> 单次运行日志混入产品文档。当前实现见 [gim_powerline.md](gim_powerline.md)，样本事实见
> [schema/README.md](schema/README.md)。

## 1. 性能模型

线路不加载 IFC，主要路径是：

```text
source inspect / cache validation
  → semantic pack 或 SQLite restore
  → cold input read/decode
  → graph parse + FAM/DEV parse
  → navigation/map projection
  → DOM、Canvas overlay、可选 MapLibre overlay
```

冷路径由 `lineParserInput.ts` 控制输入规模：文本语义文件通过 semantic pack 或批量
cache read 进入 Worker，大 MOD/STL 只保留类型元数据；`LineParserTextCache` 让 graph
和属性解析共享一次文本/解析结果。Worker 与主线程 fallback 采用同一个纯核心，因此
比较性能时要把 worker、decode、graph、attributes 分开。

warm 路径的目标不是重复读取 GIM，而是恢复已经提交的 graph、FAM/DEV 属性和文件统计。
缓存不完整或 semantic pack integrity 失败时整体回到 cold rebuild，不能以 partial graph
换取一个更短的数字。

## 2. 已有证据

当前六套真实线路样本的结构化回归已确认：主线程/Worker graph stats 和 FAM/DEV payload
一致，地图塔位、导线端点和 source path 关联有效；这部分是性能测量的 correctness 前提，
样本边界见 [schema/README.md](schema/README.md)。

已知性能形状：

| 项目 | 当前证据 | 解释 |
|---|---|---|
| line03 cold archive | 7z decode 约 13 s，总解压约 15 s | decoder/entry 落盘是冷路径主要候选，Worker parser 不是主导 |
| warm process-tree RSS | 约 0.9–1.3 GB 的历史独立观测 | 不是 JS heap；需要拆分 WebView、Worker、Tauri 后端和回收后的基线 |
| HNum/MOD lazy preview | 少数真实选择可能延迟几十秒 | 只影响来源页反馈，不应阻塞线路树、地图和属性切换 |
| 地图 overlay | Canvas-only 与 MapLibre 共用业务投影 | 在线瓦片失败只改变底图，不应重复计算地图实体 |

这些数字是问题规模和方向性证据，不是当前 release portable 的 n=3 认证结果。线路没有
沿用变电 Fragments benchmark 的指标或结论。

## 3. 测量契约

正式线路 benchmark 应在 release portable、真实进程重启和固定 WebView2 runtime 下进行，
每次保存：

- commit、buildMode、platform、WebView2 runtime、sample、coldWarm、sourceSha256；
- cache validation、semantic pack/SQLite restore、input `batches/semanticPackReads`；
- parser `decodeMs/graphMs/attributesMs/totalMs/fileCount/bytes/cacheEntries/worker`；
- map data、navigation index、DOM/render 阶段，以及 JS heap、process-tree RSS、Long Task；
- unmatched references、finite coordinate、map validity 和 source tracing 结果。

比较时至少报告 p50/p95/max，并分别给出：

1. source-to-semantic-ready；
2. semantic-ready-to-map-ready；
3. parser total 与 UI projection total；
4. peak/idle memory 和工程切换后的 retained resource。

不能把 archive decode、Worker 等待、MapLibre tile 网络等待和 Canvas 绘制相加后称为单一
CPU parse 时间；每段都要保留原始 span。

## 4. 下一步计划

1. 对 line01–line06 采集 release portable cold/warm 各 `n=3`，先建立统一身份字段和
   cache/semantic pack profile，不修改线路图、地图或 catenary 算法。
2. 对 line03 拆出 7z decode、entry write、semantic pack read、Worker decode/graph/attributes，
   验证总 wall time 的归因；保留现有解压配额和 source identity 校验。
3. 对 HNum/MOD 预览增加 read、parse、SVG/Canvas render 三段计时和取消边界，评估有界
   preview cache；预览失败不能污染当前工程或阻塞主界面。
4. 在独立进程中验证线路工程切换后的 Worker、地图句柄、MOD 来源 cache 和 JS/WebView
   资源是否回收；若 RSS 仍偏高，再决定是否做属性 lazy load。
5. 继续保持悬链线为实验性 2D 示意，待 `KVALUE`、`MATRIX0` 和斜档距语义完成样本/工程
   资料核验后再改默认策略。
