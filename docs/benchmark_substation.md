# 变电性能 Benchmark

> 本文记录变电 Runtime 的可复核性能证据、Fragments Cache 门禁和下一步计划，不记录按日期
> 排列的运行日志。当前实现见 [gim_substation.md](gim_substation.md)，样本事实见
> [schema/README.md](schema/README.md)。

## 1. 测量契约

本轮验证 Substation Fragments Cache Default-On Final Gate。没有修改线路、Spatial
Semantic Core、DEV Geometry、IFC parser 或 IFC scheduling；`tryWriteFragmentsCache` 的
调用位置保持不变。

| 项目 | 口径 |
|---|---|
| A | Fragments OFF warm ×3 |
| B | Fragments HIT warm ×3；每轮新建 portable process 并重新使用 native file picker |
| 样本 | `substation01`、`substation02`、`substation03`、`substation04` |
| 构建 | production release portable |
| 平台/runtime | Windows；固定 WebView2 `151.0.4129.107` |
| 采集 | Playwright CDP + Windows UIAutomation/Win32 native file picker |
| 稳定窗口 | 20 s；导出 `Ctrl+Shift+D` 诊断 JSON 与 `Ctrl+Shift+B` benchmark JSON |
| commit | `a41f2fe76cb70c3c59159572388ba308233d0b44` |

每个 raw benchmark 都保存 `commit`、`buildMode`、`platform`、`webview2Runtime`、`sample`、
`coldWarm`、`sourceSha256` 和完整 `fragmentsCacheProfile`。profile 包含
`enabled/attempts/hits/misses/fallbacks`，以及 validate/read/load/serialize/write/upsert
的 count、bytes、total/p50/p95/max、failures。summary 保留完整 `raw` 对象和逐 IFC
`fragmentTimingDiagnostics.byIfc`，不是只保留汇总数字。

样本 source SHA：

| 样本 | sourceSha256 |
|---|---|
| substation01 | `711259814db95999f5282af1871da9cb50db4548b71626637b33038b062fc390` |
| substation02 | `a1c0990162e769f678f2fe5eeb275b1266fb8640776399289197d1998d372f29` |
| substation03 | `3197c03ef2c6c423cbb85447f71491a4112db0f9a8cea0c9f72f0b410b8175ab` |
| substation04 | `00b7746d5ea6ab3b92c215c1e42ffc7eec5a9f0517c1c555fa27a596d4d800dc` |

substation01/04 的六轮 A/B 和 substation02/03 的 HIT 轮次使用当前带诊断埋点的 release；
substation02/03 的 OFF 三轮沿用同 commit、production、runtime、source SHA 的既有 A/B
基线，summary 对每条记录标注 measurement provenance。

## 2. A/B 结果

以下为每组 `n=3` 的 p50。`firstUsableGeometryReady` 在这些运行中与 `interactive`
一致；内存格式为 peak/idle MiB，`hit/miss/fallback` 为该模式每轮 profile 的计数。

| 样本 | 模式 | interactive (s) | allIfcReady (s) | fullModelReady (s) | interactive→allIfc (s) | post TBT (s) | post max Long Task (s) | JS heap peak/idle (MiB) | tree RSS peak/idle (MiB) | hit/miss/fallback | DEV (s) | geometry |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| substation01 | OFF | 2.194 | 14.662 | 19.957 | 12.467 | 10.230 | 1.943 | 523.097/523.097 | 2515.289/2515.289 | 0/0/0 | 3.054 | complete |
| substation01 | HIT | 1.869 | 4.612 | 9.972 | 2.788 | 2.683 | 1.959 | 541.855/539.837 | 2535.430/2535.430 | 12/0/0 | 3.007 | complete |
| substation02 | OFF | 1.657 | 271.870 | 274.563 | 270.170 | 256.116 | 221.715 | 329.757/329.757 | 1945.406/1931.668 | 0/0/0 | 2.523 | complete |
| substation02 | HIT | 1.405 | 6.493 | 8.445 | 5.065 | 0.644 | 0.464 | 284.125/284.125 | 1773.074/1773.074 | 17/0/0 | 1.835 | complete |
| substation03 | OFF | 13.094 | 128.214 | 136.542 | 113.186 | 78.491 | 21.155 | 418.247/413.479 | 1546.383/1496.914 | 0/0/0 | 8.161 | complete |
| substation03 | HIT | 1.486 | 5.024 | 7.244 | 3.496 | 0.390 | 0.387 | 402.926/382.555 | 1532.887/1531.141 | 8/0/0 | 2.178 | complete |
| substation04 | OFF | 2.149 | 17.411 | 18.149 | 15.263 | 8.108 | 4.033 | 141.327/124.549 | 1329.875/1329.875 | 0/0/0 | 0.675 | complete |
| substation04 | HIT | 1.233 | 4.094 | 4.859 | 2.863 | 0.159 | 0.131 | 169.384/150.136 | 1251.727/1251.727 | 19/0/0 | 0.692 | complete |

HIT 相对 OFF 的关键变化：

- allIfcReady p50 分别下降约 68.5%、97.6%、96.1%、76.5%；post-interactive TBT
  分别下降约 73.8%、99.7%、99.5%、98.0%；
- 四个样本 HIT 的 post-interactive 最大 Long Task 都小于 30 s，最大值为 substation01
  的 1.959 s；
- substation02/03 的 fullModelReady 不再出现旧 MOD 长尾；substation01/04 也保持
  `fullModelReady - allIfcReady` 小于 6 s；
- HIT fallback 全部为 0，DEV geometry 均 complete，`worstDevPaths` 和 phase 仍在 raw
  profile 中保留。

## 3. correctness parity

四个样本的 OFF/HIT 结构 fingerprint 全部一致，代表性交互 smoke 也全部通过。对照项
包括 IFC model count、MOD/DEV instance count、CBM/IFC link、GUID selection、空间/导航、
IFC/MOD 坐标锚点、visibility/highlight、Fragments model count 和 DEV unresolved/fallback。

| 样本 | IFC / MOD instances | CBM nodes | spatial nodes / objects / links | geometry/fallback |
|---|---:|---:|---:|---|
| substation01 | 12 / 285 | 12594 | 70 / 4714 / 12433 | complete / 0 |
| substation02 | 17 / 2532 | 6316 | 62 / 62176 / 6256 | complete / 0 |
| substation03 | 8 / 162 | 646 | 32 / 9572 / 610 | complete / 0 |
| substation04 | 19 / 532 | 1069 | 91 / 7720 / 1052 | complete / 0 |

## 4. MISS/build path

对 substation02/03 清除目标工程的 `substation_fragment_cache` 记录和对应
`fragments/{project_id}` 目录后，以 `ENABLE_FRAGMENTS_CACHE=true`、fresh process 测量
完整 miss → IFC → serialize/write/upsert。该路径的 `coldWarm` 仍标为 `warm`，因为语义和
DEV/GLB 缓存是 warm；`harness.fragmentCacheScenario` 明确标为 `miss-build`。

| 样本 | interactive (s) | allIfcReady (s) | fullModelReady (s) | post TBT (s) | post max Long Task (s) | miss/fallback | serialize total (s) | write total (s) | upsert total (s) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| substation02 | 1.714 | 239.188 | 241.556 | 216.071 | 187.076 | 17/0 | 6.287 | 0.717 | 0.057 |
| substation03 | 7.703 | 69.755 | 74.890 | 38.314 | 9.540 | 8/0 | 10.709 | 1.337 | 0.089 |

每个 IFC 的 `validate`、`web-ifc conversion`、`fragments.serialize`、`fragments.write`、
`fragments.upsert` 已按 entry 写入 raw 的 `fragmentTimingDiagnostics.byIfc`。聚合 profile
为 substation02 写入 19,859,457 bytes，substation03 写入 46,537,535 bytes；主要耗时为：

| 样本 | 最大 web-ifc conversion | 最大 serialize | 解释 |
|---|---:|---:|---|
| substation02 | `0302-钢结构.ifc` 198.794 s | 同一 IFC 3.348 s | 与约 187.076 s Long Task 同源，raw IFC conversion 是主导 |
| substation03 | `设备接线.ifc` 19.799 s | 同一 IFC 5.227 s | conversion 主导；没有出现 >30 s 的单 Long Task |

`tryWriteFragmentsCache` 的测量结论：substation02 首个 IFC 的 serialize/write/upsert 约
50 ms，interactive 在 1.714 s；它不是 198.8 s 长任务的来源。substation03 首个 IFC 的
serialize/write/upsert 约 885 ms，interactive 在 7.703 s，说明 persistence 确实位于首个
entry 的 sequential critical path，但当前证据只显示约 0.9 s 的首屏影响；其余 IFC 的
累计 persistence 约 12.1 s，会增加 remaining IFC wall time，却没有形成新的不可接受
Long Task。本轮不移动 persistence。

## 5. HIT composite 拆分

本轮只增加诊断 span，没有等待或重排现有运行行为。每轮 HIT 的 `core.load`、
`model-added callback` 和 `core.update(true)` 按 IFC entry 记录；下表是各阶段在每轮的
总时长 p50，`models/update` 验证是否每个模型都触发一次 update。

| 样本 | IFC/Fragments size | core.load total p50 (ms) | model-added total p50 (ms) | update(true) total p50 (ms) | models/update per run |
|---|---:|---:|---:|---:|---:|
| substation01 | 12 / 5.4 MB | 2469.9 | 3.6 | 1005.9 | 12 / 12 |
| substation02 | 17 / 19.9 MB | 3830.8 | 5.0 | 1172.5 | 17 / 17 |
| substation03 | 8 / 46.5 MB | 3344.5 | 2.5 | 979.5 | 8 / 8 |
| substation04 | 19 / 3.9 MB | 2857.9 | 5.1 | 1980.7 | 19 / 19 |

substation02 与 substation03 的当前 fresh-cache HIT p50 为 `allIfcReady=6.493 s` 和
`5.024 s`，不是此前观察到的 `21.5 s` 与 `4.9 s` 组合。拆分结果说明：

- `model-added callback` 只有毫秒级；
- substation02 的 17 次 `update(true)` 有累计成本，但总计约 1.17 s；`core.load` 总计
  约 3.83 s，二者与 validate/read 一起构成 HIT wall time，未显示重复 rebuild 造成的
  数十秒长尾；
- substation03 虽然总 fragment bytes 更大，但只有 8 个 model，`core.load` 总计约
  3.34 s、update 总计约 0.98 s。当前差异更接近 model 数量、fragment 内容和单 entry
  反序列化形状的组合，不能用文件总 MB 单独解释；需要继续保留逐 IFC span 才能定位。

因此本轮不改 `core.load`、`core.update`、IFC 顺序或任何并发模型。若后续 HIT 出现超过
30 s 的单 Long Task，再继续拆 read/core.load/update，而不是进入 DEV Geometry Compiler。

## 6. 最终决策

| 样本 | allIfc/TBT | fallback | correctness/geometry | memory | 结论 |
|---|---|---|---|---|---|
| substation01 | pass | 0 | pass | pass（JS heap peak +3.6%） | pass |
| substation02 | pass | 0 | pass | pass（JS heap/RSS 下降） | pass |
| substation03 | pass | 0 | pass | pass（JS heap/RSS 不超过 1.10×） | pass |
| substation04 | pass | 0 | pass | **fail：JS heap peak +19.9%、idle +20.5%** | hold |

最终保持：

```text
ENABLE_FRAGMENTS_CACHE_BASE = false
default-on candidate = false
status = hold
blocking sample = substation04 / hitMemoryNoSignificantRegression
```

substation04 的 process-tree RSS HIT p50 反而比 OFF 低约 5.9%，但 JS heap peak/idle 的
稳定增量超过 10% 门槛，因此不能以 RSS 下降抵消 heap gate。当前证据足以证明 HIT 的
性能收益、正确性和 fallback 行为，但不足以证明四样本均可默认开启。

## 7. 下一步计划

1. 只对 substation04 做 JS heap 驻留、GC 后 idle 和 fragment model 生命周期归因；不做
   内存架构改造，不引入 Compact Runtime Cache。
2. 若该门槛通过，再复核四样本 release gate，并单独提交把
   `ENABLE_FRAGMENTS_CACHE_BASE` 改为 `true` 的变更。
3. 若 MISS persistence 成为唯一不可接受回归，再下一轮评估将 serialize/write 移出 IFC
   sequential critical path；本轮不移动 persistence。
4. substation01 cold 的约 770 s DEV 长尾只保留现有 `devGeometryProfile.worstDevPaths`
   和 phase，另立 Cold DEV Compiler Characterization；不与本轮 Fragments gate 混合。

完整证据：

- [final-gate summary JSON](../.tmp/benchmarks/fragments-default-on-final-gate-summary.json)：保留所有 raw benchmark、profile、诊断和 correctness smoke；
- [final-gate summary Markdown](../.tmp/benchmarks/fragments-default-on-final-gate-summary.md)：机器聚合的 p50、门禁和阶段拆分；
- `../.tmp/benchmarks/fragments-default-on-final-gate/`：逐轮 raw、diagnostic、app-export、correctness 和日志。
