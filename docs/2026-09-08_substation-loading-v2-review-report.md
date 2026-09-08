# Substation Runtime Performance Baseline & Loading Pipeline Review

日期：2026-09-08  
基线：当前 HEAD f888b09  
范围：Substation Runtime 观测、测量和架构评审  
结论类型：AS-IS baseline；本轮不实施 Loading v2

## 结论摘要

当前变电打开流程已经能够把语义、IFC、MOD/STL 和 DEV GLB 分成可观测阶段，但产品上的四个时刻并不等价：

- semanticReady 的主要阻挡是 CBM/FAM/DEV/FileDevRelation 之后的 IFC 空间语义索引。当前 warm 路径没有可用的 semantic pack，仍会从磁盘缓存的 IFC 逐个重建空间索引。
- firstGeometryReady 的主要阻挡是第一个 IFC 的 web-ifc/Fragments 加载。loadAllIfcFiles 当前是严格串行循环。
- interactive 明确等待全部 IFC 完成，然后才做坐标同步、名称索引、树/UI 和相机适配。因此大型变电工程也会在已经有首个模型之后继续等待剩余 IFC，才被标记为可交互。
- fullModelReady 的主要阻挡是 IFC 之后的 DEV→MOD/STL→GLB 和 placement 渲染阶段。cold 的 s02 约 535 秒，s04 约 33 秒；当前 s02 warm 的一个坏 GLB 触发 scoped raw fallback，使 full-model tail 达到约 681–714 秒。这个 tail 不是 GLB 二进制读取本身造成的。

当前没有证据表明坐标对齐或 name index 是主要瓶颈。warm GLB 的批量读取和解析在 clean 样本上通常是秒级或更低；但是每个 CBM placement 仍独立 loadDevGlb，会重复解析/复制并烘焙 geometry。主线程长任务和内存峰值也说明，真正的后续风险在 Fragments 模型转换、DEV 编译、placement/scene commit 和资源保留，而不是单纯磁盘读。

本轮没有修改 Powerline Runtime、Substation Runtime 或 Shared Core 运行时代码；只新增本文档。

## 1. 范围、数据来源与可信度

### 1.1 运行代码边界

复核的当前代码路径为：

1. desktop/src/services/substationRuntime.ts
2. desktop/src/gim/ifcSpatialParser.ts
3. desktop/src/viewer/ifcEntryLoader.ts
4. desktop/src/viewer/ifcLoader.ts
5. desktop/src/services/progressiveGeometryService.ts
6. desktop/src/services/modAutoLoadService.ts
7. desktop/src/viewer/xmlModLoader.ts
8. desktop/src/utils/perfTimings.ts

本轮没有实施以下工作：

- IFC 并发、Worker Pool、Streaming Scheduler
- Fragments 或 web-ifc 的替换
- DEV GLB 格式或解析算法重写
- MOD/STL 策略修改
- Powerline Runtime、线路地图或 Line Parser 修改
- AppState 重构

### 1.2 真实样本覆盖

真实 .gim 文件位于 demo/，尺寸如下：

| 样本 | 输入 .gim 大小 | 本轮可用的完整数据 | 用途 |
|---|---:|---|---|
| substation04 | 11.8 MB | v22 cold n=2、warm n=6 | 小型、当前 v22 主基线 |
| substation02 | 34.2 MB | v22 cold n=1、warm n=3 | 中型/当前完成样本中最慢，主瓶颈样本 |
| substation01 | 14.4 MB | v21 cold n=1、warm n=0 | 历史慢样本，仅用于方向性对照 |
| substation03 | 71.8 MB | 没有完整当前 v22 cold/warm payload | 最大归档样本，当前测量缺口 |

主要数据目录：

- tmp/regression-triage-substation-post/：s02、s04 的完整 v22 记录
- tmp/tauri-substation-semantic-v22-smoke/：s04 的 v22 语义/缓存记录
- tmp/tauri-substation-perf-v6/：v21、Fragments cache 关闭的 clean warm 对照
- tmp/tauri-substation-perf-20260902-v1-final/：v21 的历史方向性基线

v22 真实 payload 在 2026-09-04 采集；当前 HEAD 后续主要完成了 Runtime 架构边界迁移，没有改变这里测量的变电解析算法。由于当前环境没有 cargo/rustc，无法为当前 HEAD 重新编译 Tauri binary，因此必须把这些结果表述为“现有 v22 运行数据对当前代码路径的基线证据”，而不是一轮新的 current-head Tauri smoke certification。这个限制不影响代码路径审查，但降低了对当前二进制端到端时序的最终确认度。

### 1.3 统计方法

- 所有时间均为毫秒换算后的 wall-clock elapsed；下文优先用秒。
- p95 使用 nearest-rank；n=1 时 p50/p95/max 相同，n=2 或 n=3 的 p95 仍然不能代表稳定分布。
- semanticReady、firstGeometryReady、fullModelReady 是现有 product moments。
- 当前 interactive 由“变电工程可交互（IFC 全部就绪）”这个 perf mark 表示，不是 PerfProductMoment 类型中的独立字段。
- RSS 是采集器看到的 process-tree peak，不等于 Rust backend 单进程 RSS；同时报告 JS heap peak。
- Long Task 是浏览器主线程观测，不等于整个 wall time；大量等待仍可能发生在 IPC、文件读取、Fragments 或 native 层。

## 2. AS-IS loading timeline

~~~mermaid
flowchart TD
    A[inspect source / SHA / cache validation] --> B{cache state}
    B -->|cold| C[Native extraction]
    B -->|warm| D[restore cached GIM index]
    C --> E[IFC discovery]
    C --> F[CBM / FAM / DEV / FileDevRelation]
    D --> F
    F --> G[buildSubstationSpatialIndexFromFiles]
    G --> H[semanticReady]
    H --> I{for each IFC, sequential}
    I --> J[source read/decode or Fragments cache read]
    J --> K[web-ifc / Fragments load]
    K --> L[scene.add / fragments.update / RAF validation]
    L --> M[firstGeometryReady after first IFC]
    L --> I
    I -->|all IFC complete| N[coordinate alignment]
    N --> O[IFC name index]
    O --> P[CBM tree / FileDev panel / UI / camera]
    P --> Q[interactive: all IFC ready]
    Q --> R{background geometry}
    R -->|cold| S[unique DEV serialize: MOD/STL -> GLB]
    S --> T[write GLB]
    R -->|warm| U[manifest + batch read unique GLB]
    T --> V[load GLB per CBM placement]
    U --> V
    V --> W[placement transform / bbox / scene add]
    W --> X[fullModelReady]
~~~

现有流程的关键语义是：

1. semanticReady 发生在 IFC spatial index 完成之后。
2. 第一个 IFC 完成后才有 firstGeometryReady。
3. 所有 IFC 都完成后，才有当前定义的 interactive。
4. interactive 后以 microtask 启动 MOD/STL；因此 MOD/STL 不应该阻挡隐藏 IFC loading spinner 的那个时刻，但会在用户已经看到 IFC 后继续产生明显主线程工作。
5. fullModelReady 由 MOD/STL/GLB 阶段结束驱动，并不等于 IFC 已经可交互。

## 3. Product moments baseline

### 3.1 当前 v22 主基线

| 样本 / 路径 | n | semanticReady | firstGeometryReady | interactive | fullModelReady | process-tree RSS peak | JS heap peak |
|---|---:|---:|---:|---:|---:|---:|---:|
| s02 cold | 1 | 57.3 / 57.3 / 57.3 s | 60.1 / 60.1 / 60.1 s | 299.0 / 299.0 / 299.0 s | 834.7 / 834.7 / 834.7 s | 6.55 GB | 1.35 GB |
| s02 warm | 3 | 24.8 / 26.8 / 26.8 s | 25.3 / 27.3 / 27.3 s | 31.1 / 33.4 / 33.4 s | 743.8 / 744.9 / 744.9 s | 6.30–6.57 GB | 2.24 GB |
| s04 cold | 2 | 13.0 / 28.0 / 28.0 s | 17.5 / 32.9 / 32.9 s | 35.3 / 51.0 / 51.0 s | 68.2 / 83.7 / 83.7 s | 2.27–2.96 GB | 0.325–0.402 GB |
| s04 warm | 6 | 5.25 / 5.84 / 5.84 s | 5.83 / 6.54 / 6.54 s | 9.03 / 10.34 / 10.34 s | 10.34 / 12.02 / 12.02 s | 2.40–3.09 GB | 0.623–0.649 GB |

表中每个 moment 的三项依次为 p50 / p95 / max。s02 warm 的 full-model p95 不是常态的“GLB warm 读取时间”，而是当前样本中一个 GLB parse failure 进入 scoped raw fallback 后的结果，详见第 6 节。

### 3.2 历史慢样本对照

历史 s01 v21 cold：

- semanticReady：349.8 s
- firstGeometryReady：351.0 s
- interactive：369.5 s
- fullModelReady：2,867.6 s，约 47.8 min
- process-tree RSS peak：4.20 GB
- JS heap peak：1.27 GB

这个结果说明旧版本在 DEV/MOD/STL 路径上曾有数量级更长的 tail，但它不是当前 v22 的可封板统计样本，也没有对应 warm 记录，不能用来推断当前实现的 p95。

## 4. 阶段分解与 critical path

### 4.1 cold 关键阶段

| 阶段 | s02 cold | s04 cold | 解释 |
|---|---:|---:|---|
| Native extraction | 31.0 s | 约 7.0 s | 解压、decode、写盘和 entry 处理；s02 解压后约 578.7 MB |
| CBM/FAM/DEV/FileDevRelation | 2.0 s | 0.28 s；另有一次 7.39 s outlier | 形成工程语义和设备引用集合 |
| IFC spatial index | 17.9 s | 4.0–4.1 s | 逐 IFC 读取、STEP 扫描、placement/detail、空间实体、属性和关系 |
| IFC source read/decode 合计 | 6.44 s | 1.46 s | 这部分本身不是 IFC wall time 的主因 |
| spatial semantic profile 合计 | 11.25 s | 2.47–2.62 s | 统计 profile 内部 parser 子阶段 |
| web-ifc / Fragments load 合计 | 241.4 s | 21.2–21.6 s | 串行累计；s02 最大 IFC 单项约 207.3 s |
| coordinate + name index | <1 ms | <1 ms | 当前样本不是瓶颈 |
| MOD/STL/DEV GLB aggregate | 535.5 s | 32.6–32.9 s | interactive 后开始；包含编译、落盘、placement load、transform、scene add |

s02 cold 的 critical path 是：

31.0 s extraction → 17.9 s spatial semantic → 241.4 s serial IFC/Fragments → 535.5 s background DEV geometry

其中语义和 IFC 阶段先后阻挡 semanticReady、firstGeometryReady、interactive；DEV geometry 是 fullModelReady 的主要 tail。

s04 cold 的 critical path 更短，但形态相同：

约 7.0 s extraction → 4.0 s spatial semantic → 21.2 s serial IFC/Fragments → 32.6 s DEV geometry

### 4.2 warm 关键阶段

当前 v22 warm 的 Fragments cache 已命中，但 semantic warm 不是 semantic pack restore：

| 阶段 | s02 warm | s04 warm | 解释 |
|---|---:|---:|---|
| CBM/FAM/DEV/FileDevRelation | 0.95–1.23 s | 约 0.25–0.29 s | SQLite / 缓存索引恢复 |
| spatial index rebuild | 约 19.2 s | 4.14–4.29 s | 仍逐个读取磁盘 IFC；当前 payload 的 semanticPackEntries=0 |
| Fragments cache read | 0.55–0.72 s | 0.16–0.23 s | 实际缓存字节读取 |
| Fragments cache load/deserialize | 5.30–5.46 s | 3.40–4.18 s | warm IFC 几何恢复主成本 |
| outer IFC/Fragments stage | 约 6.05–6.31 s | 4.41–4.58 s | 包含模型事件/验证等外层开销 |
| clean GLB batch read | 1.97–2.35 s | 0.55–0.62 s | 按 unique DEV 批量读 |
| GLB parse | 约 0.12–0.13 s；profile 受失败 fallback 影响 | 0.14–0.20 s | clean s02 对照见下节 |
| MOD/GLB placement stage | 680.6–713.7 s | 1.18–1.37 s | s02 被一个坏 GLB 的 raw fallback 拉长 |

为区分 Fragments cache 和 GLB cache，使用了 tmp/tauri-substation-perf-v6/ 中 parser v21、Fragments cache 关闭、无 raw fallback 的 clean warm 对照：

- s02：Fragments load p50 288.1 s，fullModelReady p50 350.4 s；GLB batch read p50 2.36 s，GLB parse p50 0.97 s，MOD stage p50 6.96 s。
- s04：Fragments load p50 17.9 s，fullModelReady p50 28.0 s；GLB batch read p50 0.73 s，GLB parse p50 0.175 s，MOD stage p50 1.51 s。

这说明 Fragments cache 对 warm IFC 路径有决定性影响；在 clean GLB 路径中，GLB IO/parse 通常是秒级或更低，残余的 placement 和场景提交仍有不可忽略的成本。

## 5. 各阶段复核结果

### 5.1 Shared Core / extraction

冷启动的 Shared Core 仍然是首段 critical path，但通常不是最大段：

- s02：输入 archive 34.2 MB，解压后约 578.7 MB，Native extraction 31.0 s；最大 decode 单项约 10.45 s，出现在一个 CBM IFC。
- s04：输入 archive 11.8 MB，解压后约 134.6 MB，Native extraction 约 7.0 s。
- s02 cold 中 extraction 比完整 IFC/geometry tail 小，但它会在任何语义工作开始前阻挡整个 Runtime。
- warm 路径没有重复 cold extraction；它的主要语义成本来自从磁盘缓存 IFC 重建 spatial index。

没有发现本轮需要修改 extraction primitive 的 correctness 证据。解压安全配额、session cleanup 和缓存失效机制属于 Shared Core 既有能力，不在本轮改动。

### 5.2 CBM / FAM / DEV / FileDevRelation

当前代码在 onGimExtracted 和 warm restore 中先形成工程骨架、FAM/DEV 索引和文件设备关系，再建立 IFC spatial index：

- s02 诊断计数：CBM 6,316，FAM 4,628，DEV 7,440，FileDevRelation 3,326；spatial profile 中 cbmLinks 6,256。
- s04 诊断计数：CBM 1,069，FAM 5,988，DEV 1,687，FileDevRelation 0。
- s02 cold 这一段约 1.98 s，warm 约 0.95–1.23 s。
- s04 正常 cold 约 0.28 s，warm 约 0.25–0.29 s；一次 cold 记录出现约 7.39 s outlier，应继续保留为观测项，但样本不足以把它定义为稳定瓶颈。

这些索引是后续树、属性和 DEV placement 的输入。当前没有证据表明它们阻挡了 s02/s04 的主要用户可见时间。

### 5.3 IFC spatial semantic

buildSubstationSpatialIndexFromFiles 在 desktop/src/gim/ifcSpatialParser.ts:755 开始，当前行为是：

1. 按 entry 顺序从文件映射中取 IFC；
2. 逐个读取 arrayBuffer 并 TextDecoder；
3. 进行 STEP scan；
4. 收集 placement/detail 和空间实体；
5. 解析属性、关系并 finalize；
6. 将结果交给 Substation Runtime。

当前没有可用 semantic pack：v22 payload 的 extraction metadata 为 semanticPackEntries=0、semanticPackBytes=0。因此 warm 的 semanticReady 仍然包含 spatial semantic rebuild：

- s02 warm 约 19.2 s；
- s04 warm 约 4.2 s。

这不是 correctness 问题，但它是 warm 首段最明确的架构性浪费。后续如果实现 semantic pack，必须绑定 source SHA、substation parser version、normalized path 和关系/属性 schema 版本，并保留从 IFC 重建的 fallback。

### 5.4 IFC source read 与 web-ifc / Fragments conversion

loadAllIfcFiles 在 desktop/src/services/substationRuntime.ts:403 使用严格顺序循环。每个 entry 调用 loadIfcEntry，并在单个 entry 完成后继续下一个：

- s02 cold source read/decode 合计 6.44 s，Fragments load 合计 241.4 s；source read 约占这两类 span 合计的 2.7%。
- s04 cold source read/decode 合计 1.46 s，Fragments load 合计 21.2 s；source read 约占两类 span 合计的 6.9%。
- s02 最大单个 IFC CBM/0302-钢结构.ifc 约 372.6 MiB，source read/decode 约 4.24 s，Fragments load 约 207.3 s。
- s04 最大单项 DEV/设备支架-版本1.ifc 约 92.5 MiB，source read/decode 约 0.95 s，Fragments load 约 7.49 s。

因此“读 IFC 很慢”不是当前主要解释；主要成本是 web-ifc/Fragments 转换、模型建立以及随后的 scene/update 相关工作。现有埋点还没有把转换、onItemSet、scene.add、fragments.core.update 和 RAF validation 完全拆开，所以不能把整个 Fragments span 100% 归因于 web-ifc conversion。

### 5.5 每个 IFC 的加载时序

代表性单 IFC 数据：

| 样本 / IFC | 文件大小 | read + decode | semantic profile | Fragments load | 结论 |
|---|---:|---:|---:|---:|---|
| s02 CBM/0302-钢结构.ifc | 372.6 MiB | 4.24 s | 7.29 s | 207.3 s | 单项支配 s02 IFC critical path |
| s02 CBM/0303-檩条系统.ifc | 97.1 MiB | 1.06 s | 2.09 s | 12.18 s | 次大项，但远小于第一项 |
| s02 CBM/04-建筑配电楼.ifc | 14.8 MiB | 0.21 s | 0.41 s | 4.28 s | 小文件也有固定 Fragments 开销 |
| s04 DEV/设备支架-版本1.ifc | 92.5 MiB | 0.95 s | 1.71 s | 7.49 s | s04 最大项 |
| s04 DEV/1-版本1.ifc | 13.7 MiB | 0.16 s | 0.32 s | 3.42 s | 小项固定开销明显 |

当前的序列化意味着：

IFC_1 read → convert → scene/update → IFC_2 read → convert → ...

而不是所有 IFC 读完后再统一转换。即使把 source read 视为可等待操作，单一大 IFC 也会直接阻挡后续 IFC 和当前“全部 IFC ready”交互门槛。

### 5.6 coordinate alignment / name index

当前记录中：

- coordinate alignment：s02 约 0.4 ms，s04 低于 1 ms；
- IFC name index：s02 约 0.1 ms，s04 低于 1 ms；
- 历史 s01 v21 name index 约 325 ms，但没有在当前主样本中重复出现。

这两个步骤发生在全部 IFC 完成之后，语义上属于 interactive barrier 的末端，但在 s02/s04 当前数据中不是时间主因。后续可以继续保留阶段埋点，不应先从这里做优化。

### 5.7 DEV GLB cold compile

runProgressiveDevGlbPipeline 在 desktop/src/services/progressiveGeometryService.ts:171 收集 CBM instances，按 normalized DEV path 建立 unique DEV 顺序，并在 :341 开始逐个处理。每个 unique DEV 的路径大致包括：

1. DEV → PHM → MOD/STL discovery；
2. MOD/STL 解析和顶点烘焙；
3. GLTFExporter/GLB serialization；
4. GLB 落盘；
5. 对每个 CBM placement 载入并应用 placement；
6. bbox、scene add、状态提交；
7. unique DEV 之间 yield 到主线程。

当前数据只能可靠给出 aggregate：

| 样本 | CBM instances | unique DEV | GLB DEV | 空 DEV | rendered instances | MOD/STL aggregate |
|---|---:|---:|---:|---:|---:|---:|
| s02 cold | 4,675 | 1,174 | 627 | 547 | 3,710 | 535.5 s |
| s04 cold | 532 | 207 | 207 | 0 | 532 | 32.6–32.9 s |
| s01 v21 cold | 未作为当前 v22 主基线 | 285 | 285 | 未知 | 285 | 2,498.1 s |

已有 write_glb_file_binary invoke 埋点只能说明落盘本身不是全部 tail：

- s02：627 次，累计 47.6 s；单次 p50 50.4 ms、p95 210.4 ms、max 776.8 ms。
- s04：207 次，累计 12.3 s；单次 p50 37.9 ms、p95 88.7 ms、max 791.2 ms。

当前没有每个 DEV 的 serializeDevToGlb phase span，因此不能给出 cold 编译的真实 per-DEV p50/p95/max，也不能把 s02 的 535.5 s 精确拆成 MOD parse、顶点烘焙、GLTF export、write、placement transform 和 scene add。这是本轮最重要的测量缺口之一。

### 5.8 warm GLB read / parse / duplicate placement

modAutoLoadService.ts:556 的注释和现有 profile 明确表达了当前语义：

- 同一 unique DEV 的 GLB bytes 只读取一次；
- 每个 CBM placement 仍单独调用 loadDevGlb；
- placement 会修改 BufferGeometry，因此暂不共享 Three geometry。

实测：

- s04 warm：532 个 CBM instance、207 个 unique DEV、GLB batch read 约 0.55–0.62 s，parse 约 0.14–0.20 s，MOD stage 约 1.18–1.37 s，无 raw fallback。
- s02 clean warm 对照：4,675 个 CBM instance、1,174 个 unique DEV，batch read 约 2.36 s，parse 约 0.97 s，MOD stage 约 6.96 s，无 raw fallback。
- s02 当前 v22 warm：batch read 约 2 s，GLB parse 仅约 0.12–0.13 s，但一个 GLB parse failure 触发 scoped raw fallback，整个 MOD stage 变成约 681–714 s。

结论是：

1. clean warm 下，GLB read/parse 不是主要 full-model 瓶颈；
2. “unique DEV 只读一次”已经成立；
3. “placement 只复用 geometry”没有成立，parse/load/geometry transform 仍按 placement 重复；
4. 某个 DEV 的 fallback 会把 warm tail 从秒级放大到分钟级，且应当被视为产品 UX 风险。

### 5.9 placement transform / scene commit / Fragments update

applyPlacementTransformToSceneUnits 在 desktop/src/viewer/xmlModLoader.ts:193 对 group 下的 mesh geometry 做矩阵和 mm→m 顶点烘焙。ifcLoader.ts:33 的 safeFragmentsUpdate 会调用 ctx.fragments.core.update(force)；model item set 时还会进行 scene add、状态写入、回调和 update。

当前没有这三个子阶段各自的 span，因此只能做 residual 估计，不能下精确 attribution：

- s04 clean warm：MOD stage 约 1.18–1.37 s，GLB batch read 约 0.55–0.62 s，parse 约 0.14–0.20 s，剩余约 0.4–0.6 s，包含 placement、bbox、scene add、progress 和 GC 等。
- s02 clean warm 对照：MOD stage 约 6.96 s，batch read 约 2.36 s，parse 约 0.97 s，剩余约 3.6 s，规模更大且 placement 数更多。

因此“placement/scene tail 可能明显”成立，但“具体是顶点烘焙还是 Fragments update 最大”目前证据不足。下一轮应该先补 phase telemetry，再决定是否需要 immutable geometry/instance 方案。

### 5.10 用户看到首批模型后的主线程阻塞

Long Task 结果：

| 样本 | Long Task count | total blocking | max single task |
|---|---:|---:|---:|
| s02 cold | 3,220 | 76.8 s | 7.61 s |
| s02 warm | 约 3,585；p95 约 3,613 | p50 100.9 s；p95 105.4 s | p50 7.74 s；p95 8.26 s |
| s04 cold | 22–30 | 3.87–4.97 s | 1.78–1.89 s |
| s04 warm | 9–10 | 2.80–2.93 s | 1.84–1.90 s |

这证明在用户已经看到 IFC 之后，后台 geometry pipeline 仍然会产生可观测主线程阻塞；但不应把所有 wall time 都解释成主线程阻塞。s02 当前 warm 的 12 分钟主要是 fallback/raw geometry 的异步和解析工作，Long Task 总 blocking 约 101 秒，二者不是同一个量。

### 5.11 RSS / JS heap

当前峰值相对于工程规模明显偏高：

- s02 cold process-tree RSS 约 6.55 GB，JS heap 约 1.35 GB；
- s02 warm process-tree RSS 约 6.30–6.57 GB，JS heap peak 约 2.24 GB；
- s04 cold process-tree RSS 约 2.27–2.96 GB，JS heap 约 0.325–0.402 GB；
- s04 warm process-tree RSS 约 2.40–3.09 GB，JS heap 约 0.623–0.649 GB；
- Rust backend 单进程 RSS 最大只在约 34–55 MB 级别。

这说明内存压力主要出现在 WebView/JS、Fragments/Three/native allocations 或其子进程组合，而不是 Rust SQLite/extraction backend 单独占满内存。当前没有 GPU memory 或 WebAssembly/native allocator 的独立数值，因此不能进一步归因。

## 6. A–F 假设逐项判断

| 假设 | 判断 | 证据 |
|---|---|---|
| A. loadAllIfcFiles 等待全部 IFC 才形成 interactive barrier | 成立 | substationRuntime.ts:403 是严格串行 for ... await loadIfcEntry；:605 在全部 entry 后才 mark 变电工程可交互（IFC 全部就绪）；s02 cold IFC aggregate 约 241 s |
| B. 单个 IFC 加载时间与全部 IFC 串行累计时间都重要 | 成立 | s02 最大 IFC Fragments load 约 207.3 s、全部约 241.4 s；s04 最大约 7.49 s、全部约 21.2 s |
| C. IFC read 相比 web-ifc/Fragments conversion 不是主要瓶颈 | 成立，但 Fragments span 仍含未拆开的 scene/update 成本 | s02 read/decode 6.44 s 对 Fragments 241.4 s；s04 1.46 s 对 21.2 s；现有 instrumentation 无法把 Fragments 内部完全细分 |
| D. warm DEV GLB read/parse 已不是主要瓶颈 | 部分成立 | clean s04 和 v21 clean s02 中 read/parse 为秒级或更低；当前 s02 warm 的主要 tail 是一个 GLB parse failure 后的 raw fallback，所以不能对所有 warm 输入一概而论 |
| E. 同一 unique DEV 的多个 CBM placement 仍重复 loadDevGlb/geometry 操作 | 成立 | modAutoLoadService.ts:556 明确说明 bytes 只读一次、placement 独立 load；测试输出也覆盖“同一 DEV 只读一次但各 placement 独立 parse/load” |
| F. placement transform、scene/Fragments update 或 cold DEV compile 构成明显 tail | 部分成立；精确归因证据不足 | cold aggregate、clean warm residual 和 Long Task 都显示该路径有显著成本；但缺少 per-DEV serialize/export、placement transform、scene commit、Fragments update 独立 spans |

## 7. 问题分类

### P0 Correctness

在本轮已有样本和测试中没有发现新的已复现 P0。

已有 regression tests 覆盖：

- session/token 失效时旧 IFC model 不进入新工程；
- 旧 CBM/relation/spatial/STD 结果不提交到工程 B；
- cache version、SHA、truncation、missing、deserialize failure 走 fallback；
- stale cleanup 不删除新会话缓存；
- progressive GLB 失败时不会写出“完成”版本标记。

但当前真实 Tauri smoke 没有在当前 HEAD 新 binary 上重跑，且没有对“坏 GLB scoped raw fallback 与原始几何业务等价”做完整 golden comparison。因此“没有观察到 P0”不等于所有设备几何等价性已经证明。

### P1 Product correctness / important UX

1. **全部 IFC 才 interactive**：s02 cold 约 299 s，cache-off warm 对照约 343 s。用户已经可以看到或等待第一个 IFC，但产品门槛仍被最大 IFC 和其余 IFC 推迟。
2. **坏 GLB 导致 warm full-model 长尾**：s02 当前 warm 的 semantic/IFC 约几十秒内完成，但 full-model 约 12 分钟。fallback 保护了继续加载，但重复发生会显著损害“缓存命中秒开”的产品承诺。
3. **最大样本 s03 缺少当前 v22 完整测量**：这是发布前的证据缺口，而非已证明的运行时 bug。

### P2 Performance

1. warm spatial semantic rebuild 没有 semantic pack fast path。
2. IFC conversion/load 严格串行，且 interactive 直接绑定 all-IFC barrier。
3. cold unique DEV compile 和逐 placement geometry 操作串行。
4. 每 placement 仍独立 GLB parse/load/顶点 transform，不能共享 immutable geometry。
5. Fragments update、scene add、placement transform 和 GC 没有独立 phase telemetry。
6. s02/s04 的 process-tree RSS 和 JS heap 峰值偏高，当前没有 retention/预算控制证据。

### Research Unknown

- s03 在当前 v22、当前 HEAD binary 上的 cold/warm 全量数据；
- 每个 DEV 的 MOD/STL parse、vertex bake、GLTF export、write、placement、scene add 的 p50/p95/max；
- web-ifc conversion、Fragments deserialize、fragments.core.update 和 GPU/native allocation 的精确拆分；
- immutable GLB template + per-instance transform 是否能保持选中、属性、source tracing、材质和 bbox 语义；
- web-ifc multi-thread availability 在目标发布环境是否稳定；当前 payload 中 webIfcMt.available=false。

## 8. Loading v2 建议（本轮不实施）

以下按收益/风险排序。排序针对后续设计，不代表当前批准立即修改。

| 优先级 | 建议 | 预期收益 | 主要风险 / 前置条件 |
|---|---|---|---|
| 1 | 重新定义产品 moments：保留 semanticReady，新增 firstUsableGeometryReady，将当前 all-IFC mark 命名为 allIfcReady；interactive 只在首批可用 IFC、树、搜索和相机可用时成立；fullModelReady 继续表示全部 geometry 完成 | 直接解除“首个模型已经出现但 UI 仍等待所有 IFC”的体验误导 | 需要 UI 状态、计数和 session guard 的回归；不改变解析结果 |
| 2 | 建立 keyed semantic pack：source SHA + substation parser version + normalized paths + semantic schema/version；warm 先 restore，失败再从 IFC rebuild | 直接削减 s02 warm 约 19 s、s04 warm 约 4 s 的 spatial rebuild，并降低 warm 磁盘扫描 | 关系闭包、property/source tracing、FileDevRelation 和旧 cache 失效必须严格验证 |
| 3 | 在基线 telemetry 完成后再设计 bounded IFC scheduler；优先级先加载首个可用 IFC，限制并发和内存，提交顺序保持确定性 | 减少串行 IFC conversion 对 firstGeometryReady 和 allIfcReady 的阻挡 | 内存峰值、Fragments API 是否可并行、scene/update 线程安全、session cancellation；本轮明确不实施 |
| 4 | 先补齐 geometry phase telemetry，再评估 immutable GLB template / instance transform | 可能消除同一 unique DEV 多 placement 的 parse/geometry duplication | selection、property/source tracing、material、bbox 和 transform 语义容易被破坏；高风险，不应凭测量缺口直接重构 |
| 5 | 对 GLB parse failure 做 scoped invalidation/rebuild：记录失败 DEV、清理对应失效标记、后台重编译；下一次 warm 不要重复同一 raw fallback | 避免单个坏 DEV 每次打开都产生分钟级长尾，同时保持当前 raw fallback 安全性 | 需要确认失败是 cache corruption、source change 还是 parser bug；必须绑定 source SHA 和 session |
| 6 | 将 fragments.core.update、model item set、scene add、placement transform、bbox、GC 相关观察分成独立 spans | 让下一次选择优化位置有证据，而不是把 residual 误判成 parse 或 IO | 埋点本身要保持低开销，不改执行顺序 |
| 7 | 建立内存基线和 retention budget：分别采集 JS heap、process tree、GPU/native/WASM（如平台可得），并定义 first-model 后的回收点 | 防止 s02 级别工程在交互后继续攀升到不可用内存 | 需要目标机器矩阵和 WebView/Fragments 版本固定；不是简单调 GC |

不建议在没有完成第 1、2、6 项前直接实施 IFC 并发、Worker Pool 或 geometry sharing。那些方案可能缩短 wall time，但会同时改变 session cancellation、scene commit、property tracing 和内存行为，难以从当前数据判断收益是否来自正确阶段。

## 9. 建议的 Substation Loading v2 目标状态

这是方案草图，不是本轮实现结果：

1. inspect source → source identity/SHA → cache validation 保持 Shared Core 责任。
2. cold/warm 都先产生同一份可验证的 semantic snapshot；warm 优先 restore，cold 从 CBM/FAM/DEV/FileDevRelation 和 IFC 构建。
3. semanticReady 只表示 semantic snapshot 可用于树、搜索、属性和 source tracing。
4. IFC loader 采用有上限的调度策略：首个可用 IFC 优先，其他 IFC 后台；所有异步结果仍经过 ProjectLoadSession 和 source identity 检查。
5. firstUsableGeometryReady 表示首个可定位、可选中、可查询的模型完成；allIfcReady 单独记录全部 IFC。
6. coordinate alignment、name index、tree/search/source tracing 不依赖 full model geometry。
7. DEV geometry 保持 unique source cache；先记录每个阶段，再决定 template/instance 或 placement-specific clone 的实现。
8. fullModelReady 必须只在所有已声明的 geometry tasks 成功、fallback 状态已收敛、session 仍有效时产生；坏 cache 不得恢复 partial “完成”标记。

## 10. 验证与回归执行结果

本轮/当前 HEAD 可复核的自动化结果：

- cd desktop; npm test -- --run：60 个 test files，676 个 tests，全通过，约 26.86 s。
- cd desktop; npm run test:sample：6 个 sample test files，34 个 tests，全通过；依赖 demo 解压目录，使用已有样本回归。
- TypeScript no-emit check：通过。
- Vite production build：通过；只有既有 dynamic import 和 large chunk warning。
- cargo check / current-head Tauri smoke：未执行。环境没有 cargo 和 rustc；现有 desktop/src-tauri/target/debug/gim-viewer.exe 的时间早于当前架构 HEAD，不作为本轮证据。

现有单元/服务测试中与本复核直接相关的行为：

- modAutoLoadFastPath.test.ts：同一 DEV bytes 只读取一次，但各 placement 独立 parse/load。
- progressiveGeometryService.test.ts：同 DEV 只序列化一次，逐 instance 渲染；覆盖 session/token race 和完成标记门控。
- ifcFragmentsCache.test.ts：cache hit、版本/SHA/truncation/missing/deserialize failure fallback，以及迟到 session 不删除新 cache。
- ifcSessionRace.test.ts：stale model 被拒绝。
- projectStateCommitRace.test.ts：stale CBM/relation/spatial/STD 结果不提交。
- projectCleanup.test.ts：异步 cleanup 前先递增 token。

这些测试证明了竞态和缓存失败路径的设计意图；由于没有当前 HEAD 的 Tauri smoke，它们不能替代真实 WebView/Fragments/RSS 验证。

## 11. 证据到结论的代码路径

| 证据 | 代码路径 | 结论 |
|---|---|---|
| 顺序 IFC loading | desktop/src/services/substationRuntime.ts:403 | loadAllIfcFiles 的 await loop 形成串行链 |
| coordinate/name/UI/interactive | desktop/src/services/substationRuntime.ts:573-605 | 全部 IFC 后才做末端工作并 mark interactive |
| first geometry 与后台 geometry | desktop/src/services/substationRuntime.ts:519、:660-871 | 首个 IFC 后记录 first moment，MOD/STL 在之后后台启动 |
| warm/cold dispatch | desktop/src/services/substationRuntime.ts:898-1112 | warm cache restore 与 cold extraction 后都进入同一 Substation 生命周期 |
| spatial index rebuild | desktop/src/gim/ifcSpatialParser.ts:755-832 | 逐 IFC read/decode/parse，没有 semantic pack fast path |
| IFC cache hit / source read | desktop/src/viewer/ifcEntryLoader.ts:96-212 | Fragments cache hit 可跳过 IFC source buffer，但仍有 cache load/validation |
| model add/update | desktop/src/viewer/ifcLoader.ts:33-140 | scene.add 和 fragments.core.update 在 model event 路径中发生 |
| cold DEV pipeline | desktop/src/services/progressiveGeometryService.ts:171-489 | unique DEV 顺序编译、写盘、placement 渲染、yield |
| warm unique DEV batching | desktop/src/services/modAutoLoadService.ts:556-1060 | bytes 按 unique DEV 批量读取，placement 独立 load |
| placement vertex bake | desktop/src/viewer/xmlModLoader.ts:193-240 | placement matrix 应用到 mesh geometry |
| telemetry / memory / Long Task | desktop/src/utils/perfTimings.ts | product moments、stage spans、invoke、cache、Long Task、memory |
| 竞态和 cache fallback | desktop/src/services/__tests__/、desktop/src/viewer/__tests__/ | stale result、失效 cache 和完成标记的回归保障 |

## 12. 最终判断

当前 Substation Runtime 的 AS-IS baseline 已经足够回答下一轮 Loading v2 应该优化哪里：

1. 首先分离产品可交互时刻与 all-IFC 完成时刻；
2. 其次补 semantic pack，消除 warm spatial rebuild；
3. 再用 phase-level telemetry 决定 IFC 调度和 geometry instance 方案；
4. 对坏 GLB cache 做一次性失效/重编译，避免当前 s02 warm 的重复分钟级 fallback。

本轮没有实施上述改造，也没有修改 Powerline Runtime。后续进入 Substation Loading v2 前，必须补齐 substation03 当前 v22 cold/warm，以及 per-DEV/per-placement/Fragments update 的独立测量。
