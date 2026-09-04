# 变电 Fragments Cache-on A/B v1

> 真实 Tauri 诊断记录 18 次；模式为 Cache OFF / BUILD / HIT。每组以 median/P95 汇总，P95 使用 nearest-rank；脚本不补写超时或缺失运行。

## 结论状态

六个 sample×mode 组均达到 n=3；以下判断仅基于真实 Tauri 记录。默认开关仍保持关闭，是否开启需结合语义一致性与交互验收。
本批记录的 `runInfo.bootId` 均为空，采集器只在 HIT 组给出“需重启”的前置提示，未能以进程级 boot 标识证明每次 HIT 都跨 Tauri 重启。因此 HIT 的命中率和耗时可作为本批参考，但不宣称已经完成“重启后命中”的强证据；下一批应先补 bootId/进程 PID 校验再采集。

## 采集边界与证据

- `perfSnapshot.fragmentsCache`：validate/read/load/serialize/write/upsert/delete 的次数、bytes、total/p50/p95/max/failures，以及 hit/miss/fallback。
- `perfSnapshot.productMoments`：semanticReady、firstGeometryReady、fullModelReady；`longTasks`：count/blocking/max；`memory`：JS heap 检查点；采集器独立记录 process-tree RSS。
- Cache OFF 只关闭 `gim-debug-fragments-cache` localStorage 灰度键，未修改编译期默认 `ENABLE_FRAGMENTS_CACHE_BASE=false`。BUILD 每次先通过 Tauri `delete_fragment_cache_record` 删除所有已登记 frag；HIT 点击前检查每个 IFC 均有完整有效记录。
- HIT 需在本组开始前重启 Tauri 应用；若未重启，记录仍可用于功能/耗时参考，但不作为“跨进程命中”结论。
- 当前开发构建已在 `bootstrap` 暴露每次应用启动唯一的 `__GIM_DEV_BOOT_ID__`，后续采集器可将其与进程 PID 一并写入 `runInfo`；本批 18 条记录产生于该埋点接入前。
- 本批原始记录 `runInfo.bootId=null`（见 `tmp/tauri-substation-fragments-ab-v1/manifest.json`），所以无法从数据本身核验上述重启前置条件；这属于采集证据缺口，不是缓存命中逻辑的失败。
- Rust 校验仍严格检查版本、源 GIM SHA、文件存在与实际大小；截断/缺失/版本或 SHA 不匹配均回退 IFC。前端运行时反序列化失败会删除坏记录后回退。

## 产品时刻、内存和 cache 结果

| 样本 | 模式 | n | total median/P95 ms | semanticReady | firstGeometryReady | IFC 全部就绪 | fullModelReady | process-tree RSS median/P95 MB | JS heap median/P95 MB | Long Task count/blocking/max | hit/miss/fallback | read/serialized/written bytes |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| substation02 | build | 3 | 1048426.0/1090139.0 | 50238.9/50904.0 | 50800.5/51511.9 | 304323.1/304974.2 | 1045243.4/1084615.6 | 4967.9/7386.6 | 1341.1/3404.3 | 4629/140958/33376 | 0/51/0 | 0/19859455/19859455 |
| substation02 | hit | 3 | 1111257.0/1236936.0 | 45770.8/50864.6 | 46143.9/51266.8 | 51185.9/56734.9 | 1108086.0/1231300.2 | 5981.1/7342.1 | 2048.3/3372.1 | 10235/204984/29527 | 51/0/0 | 19859457/0/0 |
| substation02 | off | 3 | 958665.0/1066982.0 | 46651.1/47086.5 | 47200.0/47561.4 | 274973.0/276417.2 | 953257.0/1010458.5 | 6313.0/7480.2 | 1312.6/3385.4 | 3534/112478/31162 | 0/0/0 | 0/0/0 |
| substation04 | build | 3 | 34274.0/34419.0 | 7422.3/9358.8 | 9175.4/11097.6 | 27564.7/28972.3 | 29307.2/30736.9 | 2552.2/2621.5 | 707.1/713.3 | 13/5368/3604 | 0/57/0 | 0/3902621/3902621 |
| substation04 | hit | 3 | 20806.0/25782.0 | 9091.9/9989.1 | 9931.7/12385.8 | 15274.4/18683.0 | 17539.3/22376.8 | 2546.5/2570.6 | 894.3/894.6 | 15/6162/3797 | 57/0/0 | 3902627/0/0 |
| substation04 | off | 3 | 29642.0/34228.0 | 7248.6/12086.7 | 8792.1/14070.2 | 25443.1/30746.5 | 26862.9/32431.7 | 2415.4/2520.9 | 724.8/762.7 | 12/5049/3456 | 0/0/0 | 0/0/0 |

## Fragments cache 操作

| 样本 | 模式 | 操作 | n | count median/P95 | bytes median/P95 | total median/P95 ms | max median ms | failures total |
|---|---|---|---:|---:|---:|---:|---:|---:|
| substation02 | build | delete | 3 | 0/0 | 0/0 | 0.0/0.0 | 0.0 | 0 |
| substation02 | build | load | 3 | 0/0 | 0/0 | 0.0/0.0 | 0.0 | 0 |
| substation02 | build | read | 3 | 0/0 | 0/0 | 0.0/0.0 | 0.0 | 0 |
| substation02 | build | serialize | 3 | 17/17 | 19859455/19859457 | 5309.6/5334.3 | 2657.2 | 0 |
| substation02 | build | upsert | 3 | 17/17 | 0/0 | 756.2/817.3 | 456.8 | 0 |
| substation02 | build | validate | 3 | 17/17 | 0/0 | 102.5/116.0 | 11.1 | 0 |
| substation02 | build | write | 3 | 17/17 | 19859455/19859457 | 1359.2/1381.8 | 613.7 | 0 |
| substation02 | hit | delete | 3 | 0/0 | 0/0 | 0.0/0.0 | 0.0 | 0 |
| substation02 | hit | load | 3 | 17/17 | 19859457/19859457 | 4955.9/5901.7 | 1264.9 | 0 |
| substation02 | hit | read | 3 | 17/17 | 19859457/19859457 | 539.6/545.6 | 136.0 | 0 |
| substation02 | hit | serialize | 3 | 0/0 | 0/0 | 0.0/0.0 | 0.0 | 0 |
| substation02 | hit | upsert | 3 | 0/0 | 0/0 | 0.0/0.0 | 0.0 | 0 |
| substation02 | hit | validate | 3 | 17/17 | 0/0 | 129.2/162.4 | 11.4 | 0 |
| substation02 | hit | write | 3 | 0/0 | 0/0 | 0.0/0.0 | 0.0 | 0 |
| substation02 | off | delete | 3 | 0/0 | 0/0 | 0.0/0.0 | 0.0 | 0 |
| substation02 | off | load | 3 | 0/0 | 0/0 | 0.0/0.0 | 0.0 | 0 |
| substation02 | off | read | 3 | 0/0 | 0/0 | 0.0/0.0 | 0.0 | 0 |
| substation02 | off | serialize | 3 | 0/0 | 0/0 | 0.0/0.0 | 0.0 | 0 |
| substation02 | off | upsert | 3 | 0/0 | 0/0 | 0.0/0.0 | 0.0 | 0 |
| substation02 | off | validate | 3 | 0/0 | 0/0 | 0.0/0.0 | 0.0 | 0 |
| substation02 | off | write | 3 | 0/0 | 0/0 | 0.0/0.0 | 0.0 | 0 |
| substation04 | build | delete | 3 | 0/0 | 0/0 | 0.0/0.0 | 0.0 | 0 |
| substation04 | build | load | 3 | 0/0 | 0/0 | 0.0/0.0 | 0.0 | 0 |
| substation04 | build | read | 3 | 0/0 | 0/0 | 0.0/0.0 | 0.0 | 0 |
| substation04 | build | serialize | 3 | 19/19 | 3902621/3902627 | 1245.0/1353.7 | 407.3 | 0 |
| substation04 | build | upsert | 3 | 19/19 | 0/0 | 205.9/207.6 | 71.2 | 0 |
| substation04 | build | validate | 3 | 19/19 | 0/0 | 137.4/152.2 | 11.4 | 0 |
| substation04 | build | write | 3 | 19/19 | 3902621/3902627 | 524.4/559.6 | 100.2 | 0 |
| substation04 | hit | delete | 3 | 0/0 | 0/0 | 0.0/0.0 | 0.0 | 0 |
| substation04 | hit | load | 3 | 19/19 | 3902627/3902627 | 5435.9/6528.0 | 817.7 | 0 |
| substation04 | hit | read | 3 | 19/19 | 3902627/3902627 | 356.2/467.4 | 51.5 | 0 |
| substation04 | hit | serialize | 3 | 0/0 | 0/0 | 0.0/0.0 | 0.0 | 0 |
| substation04 | hit | upsert | 3 | 0/0 | 0/0 | 0.0/0.0 | 0.0 | 0 |
| substation04 | hit | validate | 3 | 19/19 | 0/0 | 251.4/331.7 | 25.9 | 0 |
| substation04 | hit | write | 3 | 0/0 | 0/0 | 0.0/0.0 | 0.0 | 0 |
| substation04 | off | delete | 3 | 0/0 | 0/0 | 0.0/0.0 | 0.0 | 0 |
| substation04 | off | load | 3 | 0/0 | 0/0 | 0.0/0.0 | 0.0 | 0 |
| substation04 | off | read | 3 | 0/0 | 0/0 | 0.0/0.0 | 0.0 | 0 |
| substation04 | off | serialize | 3 | 0/0 | 0/0 | 0.0/0.0 | 0.0 | 0 |
| substation04 | off | upsert | 3 | 0/0 | 0/0 | 0.0/0.0 | 0.0 | 0 |
| substation04 | off | validate | 3 | 0/0 | 0/0 | 0.0/0.0 | 0.0 | 0 |
| substation04 | off | write | 3 | 0/0 | 0/0 | 0.0/0.0 | 0.0 | 0 |

## 结构一致性检查

| 样本 | 模式 | IFC 数 | CBM 节点数 | DOM 模型行 | DOM 树行 | IFC/CBM 与 OFF 一致 | 模型行=IFC 数 | 树行>0 |
|---|---|---:|---:|---:|---:|:---:|:---:|:---:|
| substation02 | build | 17 | 6316 | 17 | 39 | True | True | True |
| substation02 | build | 17 | 6316 | 17 | 39 | True | True | True |
| substation02 | build | 17 | 6316 | 17 | 39 | True | True | True |
| substation02 | hit | 17 | 6316 | 17 | 39 | True | True | True |
| substation02 | hit | 17 | 6316 | 17 | 39 | True | True | True |
| substation02 | hit | 17 | 6316 | 17 | 39 | True | True | True |
| substation02 | off | 17 | 6316 | 17 | 39 | True | True | True |
| substation02 | off | 17 | 6316 | 17 | 39 | True | True | True |
| substation02 | off | 17 | 6316 | 17 | 39 | True | True | True |
| substation04 | build | 19 | 1069 | 19 | 5 | True | True | True |
| substation04 | build | 19 | 1069 | 19 | 5 | True | True | True |
| substation04 | build | 19 | 1069 | 19 | 5 | True | True | True |
| substation04 | hit | 19 | 1069 | 19 | 5 | True | True | True |
| substation04 | hit | 19 | 1069 | 19 | 5 | True | True | True |
| substation04 | hit | 19 | 1069 | 19 | 5 | True | True | True |
| substation04 | off | 19 | 1069 | 19 | 5 | True | True | True |
| substation04 | off | 19 | 1069 | 19 | 5 | True | True | True |
| substation04 | off | 19 | 1069 | 19 | 5 | True | True | True |

> 结构一致性只能证明项目诊断计数与页面基本模型/树行数；GUID↔CBM 关联、选择、高亮、坐标及 IFC/MOD 相对位置需在真实 Tauri 中逐样本点选/截图复核，不能用计数替代。

## 交互验收证据

- substation04 HIT 已完成人工展开空间模型树、选择 IFC 构件、切换“参数/关系/来源”、查看 GUID/位置与 CBM-DEV 关系；截图：[substation04-hit-selection.png](../output/playwright/substation04-hit-selection.png)，原始快照：`tmp/substation04_quality_snapshot.txt`、`tmp/substation04_cbm_snapshot.txt`、`tmp/substation04_cbm_rel_snapshot.txt`。
- substation02 本批保留结构计数与性能诊断，但未单独保存同等粒度的点选/高亮/坐标截图；因此“全量 IFC/MOD 相对位置与 OFF 一致”仍应在下一批按样本逐项复核。

## 损坏缓存回退测试

- Vitest：`src/viewer/__tests__/ifcFragmentsCache.test.ts` 覆盖有效命中不读 IFC、版本不匹配、源 SHA 不匹配、校验前截断、校验后读取截断、空 frag、Fragments 反序列化失败回退，以及旧 session 迟到结果隔离。
- Rust：既有 `fragment_file_size_matches` / 版本校验测试保持通过；真实 Tauri A/B 仅在应用层验证坏缓存自动回退，不修改 Spatial Semantic、MOD/STL、Fragments Cache 默认开关或 IFC Worker。

## 证据链（Evidence → Finding → Path）

### E-001：真实 Tauri A/B 诊断记录

- observed_at: 2026-09-03（Asia/Shanghai）
- source_type: file
- source_ref: `../tmp/tauri-substation-fragments-ab-v1/manifest.json`
- content_hash: SHA-256 `B69AAD9A88FDC451D9FCF20B1C5F24EE2A995085AAEE371B3142903061431E05`
- repro_command: `.\tmp\collect-tauri-substation-fragments-ab.ps1`；`.\tmp\summarize-tauri-substation-fragments-ab.ps1`
- raw_excerpt: substation02/substation04 × off/build/hit，各 3 次；每条含 `timings.fragmentsCache`、产品时刻、Long Task、JS heap、结构计数及进程树 RSS。
- linked_workitem: Fragments Cache-on A/B v1

### E-002：自动化回退和会话隔离测试

- observed_at: 2026-09-03
- source_type: command
- source_ref: `src/viewer/__tests__/ifcFragmentsCache.test.ts`、`src/utils/__tests__/perfTimings.test.ts`
- content_hash: n/a（命令结果以当前工作树和测试输出为准）
- repro_command: `cd desktop; npm test -- --run`
- raw_excerpt: 55 个测试文件、640 项测试通过；覆盖有效命中、截断/空文件/缺失、版本/SHA 不匹配、反序列化失败及旧 session 迟到结果。
- linked_workitem: Fragments Cache-on A/B v1

### E-003：交互抽查

- observed_at: 2026-09-03
- source_type: screenshot | manual
- source_ref: `../output/playwright/substation04-hit-selection.png`
- content_hash: SHA-256 `76F7A90A62B2EB4442265DD1326CC69BFCD7FCEB59BF47C0BC91352739D27E0D`
- repro_command: 在 Tauri HIT 工程展开空间模型树，点选 IFC 构件并切换参数/关系/来源页签。
- raw_excerpt: substation04 HIT 完成模型树、构件选择、GUID/位置及 CBM-DEV 关系抽查；substation02 尚未保存同等粒度截图。
- linked_workitem: Fragments Cache-on A/B v1

### F-001：缓存命中可显著缩短部分样本的 IFC 就绪时间，但不能保证完整模型更快

- severity: info
- category: performance
- status: validated
- evidence_ids: [E-001, E-002]
- location: `src/viewer/ifcEntryLoader.ts`、`docs/substation_fragments_cache_ab_v1.md`
- impact: substation04 HIT 的完整模型中位数较 OFF 快 34.7%；substation02 的 IFC 全部就绪快 81.4%，但 MOD/STL 长尾使完整模型反而慢 16.2%。
- confidence: high
- remediation: 保持默认关闭，下一轮优先 IFC Semantic Core；独立跟踪 substation02 MOD/STL 长尾。

### F-002：跨进程 HIT 证据仍不充分

- severity: low
- category: measurement
- status: accepted_risk
- evidence_ids: [E-001, E-003]
- location: `tmp/tauri-substation-fragments-ab-v1/manifest.json`（`runInfo.bootId=null`）
- impact: 本批不能从记录本身证明每次 HIT 都在应用重启后执行，因此 HIT 结果不作为完整跨进程结论。
- confidence: high
- remediation: 使用当前 `__GIM_DEV_BOOT_ID__` 并补充 PID 证据后重跑 HIT；不改变本轮缓存逻辑。

### P-001：缓存 A/B 调用路径

- path_type: callflow
- start: Tauri 打开变电 GIM
- goal: 记录缓存命中或安全回退，并完成模型加载
- steps:
  1. action: `validate_fragment_cache` 校验版本、源 GIM SHA、记录和文件尺寸 — evidence: E-001 — finding: F-001
  2. action: 校验有效时读取 `.frag` 并调用 `fragments.core.load`；校验失败或运行时加载失败时回退 IFC — evidence: E-001, E-002 — finding: F-001
  3. action: IFC 路径成功后 serialize/write/upsert；所有异步指标按 perf session 提交 — evidence: E-002 — finding: F-002
- residual_risks: substation02 MOD/STL 长尾、RSS/JS heap 偏高、HIT 重启证据待补齐。

## 本批结果判断

- **substation04**：HIT 的 `fullModelReady` median 17.54 s，相对 OFF 26.86 s 缩短 34.7%；IFC 全部就绪从 25.44 s 缩短到 15.27 s。HIT 的 19/19 IFC 均命中，read/load 合计约 5.79 s，说明缓存确实绕过了 web-ifc 转换，但首个几何时刻略慢且 JS heap 约高 23%，需保留内存观察。
- **substation02**：HIT 的 IFC 全部就绪 median 从 274.97 s 降至 51.19 s（降低 81.4%），但 `fullModelReady` 从 953.26 s 升至 1108.09 s（慢 16.2%）；主要长尾在 MOD/STL/后续场景完成阶段，不是 `frag read`（约 0.54 s）或 `fragments.core.load`（约 4.96 s）。HIT 的 JS heap 峰值也高于 OFF，不能据此默认开启。
- **BUILD 写入**：substation02 的 serialize+write+upsert median 约 7.43 s，substation04 约 1.98 s，相对各自完整首开不是主导项；本轮没有把写入移出 ready critical path 的证据。
- **决策**：默认开关继续保持 `ENABLE_FRAGMENTS_CACHE_BASE=false`。本轮不进入默认开启，也不优先拆分 frag read/load；下一阶段优先进入 IFC Semantic Core（同时把 substation02 的 MOD/STL 长尾作为独立性能问题跟踪），待补齐跨进程 HIT 证据和 substation02 交互截图后再做默认开启评估。

## 下一轮决策规则

- 若 HIT 的 `fullModelReady`、`firstGeometryReady` 和 `fragmentsCache.operations.read/load` 相比 OFF 明显下降，且结构/视觉验收 6/6 一致，下一轮进入 IFC Semantic Core。
- 若 BUILD 的 `serialize/write/upsert` 占首开关键路径，下一轮把 Fragments cache 写入移出 ready critical path；不改变当前默认关闭。
- 若 HIT 仍主要耗时，继续拆分 `frag read` 与 `fragments.core.load`（含 p95/max），不先做默认开启。
- 若 RSS/JS heap 在 HIT 仍显著偏高，单独建立内存预算后再考虑其它缓存方案；本轮不做属性 lazy load。

## 复测命令

```powershell
cd D:\vibe-coding\gim_viewer\desktop
npm run tauri:dev
# 另一个 PowerShell，保持 Tauri WebView 的 playwright-cli session 可用
cd D:\vibe-coding\gim_viewer
.\tmp\collect-tauri-substation-fragments-ab.ps1
.\tmp\summarize-tauri-substation-fragments-ab.ps1
```
