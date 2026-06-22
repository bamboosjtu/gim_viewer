# 加载速度优化方案（Acceleration Plan）

> 目标：缩短「打开 .gim → 可交互」的端到端耗时，覆盖变电（IFC 3D）与线路（地图）两类工程的首开与二开路径。
>
> 本文只做方案分析与排期建议，不含实施代码。每项完成后应回填实测数据。

---

## 1. 加载流程分解与现状基线

### 1.1 变电工程（首次打开）

```
① 文件读取 + sha256（Rust）          ← 通常 < 1s
② GIMPKG* 头部切割                    ← 毫秒级
③ 7z/ZIP 解压（libarchive.js WASM）   ← ⚠️ 大头之一，随包体线性增长
④ CBM 树构建 + FAM/DEV 属性解析        ← 秒级（数万文件）
⑤ SQLite 入库（单事务）+ IFC 缓存落盘  ← 有性能日志（save_line_project_cache 同款）
⑥ ViewerRuntime 创建 + loadAllIfcFiles：
   web-ifc 解析 → OBC Fragments 转换   ← ⚠️ 大头之一，单线程 WASM
⑦ 后台渐进式 DEV GLB 管线：
   XML 解析 + Boolean CSG + GLTFExporter（主线程分批 yield）← ⚠️ 占用主线程
```

二次打开：缓存命中短路（sha256 + parser_version 校验）→ 直接恢复索引渲染；
DEV GLB 走 `tryDevGlbFastPath` 快速路径，已是秒开。

### 1.2 线路工程

| 阶段 | 实测（line02，2.3 万文件） |
|---|---|
| buildLineGimGraph | ~0.7 s |
| parseLineAttributes（FAM/DEV 全量解析） | ~0.6 s |
| saveLineProjectCache 入库 | 未单独实测（Rust 侧有耗时日志），payload 数十 MB 时一次性 invoke 较慢（已有 >50MB 告警） |
| 解压 | 与变电同源，未单独实测 |

结论：前端解析层合计约 1.3 s，不是主要瓶颈；**解压与 SQLite 入库才是剩余大头**。

### 1.3 近期已完成的优化（作为基线的一部分）

| 项 | 效果 |
|---|---|
| 渐进式 DEV GLB 管线 | 首次打开几何可见时间约减半（MOD/STL 单遍解析 + 逐 DEV 渐进显示） |
| GLB 快速路径 | 二次打开 DEV 几何秒出（不再逐实例解析 MOD） |
| 天地图 tiles 子域负载均衡 | t0–t7 全部参与瓦片并行请求（2026-08） |
| 地图数据惰性解析 | 缓存命中时不读原 GIM |

---

## 2. 方案清单

> 优先级定义：P0 = 高收益/低风险，建议立即做；P1 = 高收益但需较大改造或需实测验证；
> P2 = 收益中等或有前置依赖。工作量单位：人日（粗估）。

### P0-1 性能埋点体系（测量先行）✅ 已实现（2026-08，utils/perfTimings.ts + Ctrl+Shift+D timings 字段）

- **现状**：只有零散 debugLog（入库耗时、payload 大小告警），无端到端阶段视图。
- **方案**：用 `performance.mark/measure` 在关键节点打点——解压开始/结束、图构建、属性解析、入库、首个 IFC 就绪、渐进管线完成；Ctrl+Shift+D 诊断 JSON 增加 `timings` 字段。
- **预期收益**：后续所有优化的量化依据；避免凭感觉排期。
- **工作量**：0.5 人日。**风险**：无。
- **验证**：分别打开一个变电 + 一个线路工程，导出诊断 JSON 核对阶段耗时。
- **状态**：✅ 已完成。openGimService 全流程打点（首开/缓存命中两路径），诊断 JSON 含 `timings` 字段。

### P0-2 解压层下沉到 Rust 原生（7z/ZIP）✅ 已实现（2026-08，src-tauri/src/gim_extract.rs + gim_extract_command.rs）

- **现状**：libarchive.js（WASM）在前端单 worker 解压，7z 固体压缩只能整包顺序解。
- **方案**：Rust 侧引入 `sevenz-rust` 或 `compress-tools`（libarchive 系统库绑定），Tauri command 直接输出文件清单 + 字节到缓存目录或内存；前端拿 `Map<path, File>` 改由 Rust 返回的批量字节构建。
- **预期收益**：原生解压通常快 3–5 倍；且省去「WASM 解压 → JS File 对象」的拷贝。对 200MB 级变电包预计节省数秒。
- **工作量**：3–5 人日。**风险**：中——需要处理编码（GBK 文件名）、大包内存峰值；建议保留 libarchive.js 作为浏览器模式回退。
- **验证**：P0-1 埋点对比同一 `.gim` 的解压耗时；样本回归测试（变电 + 线路）全绿。
- **状态**：✅ 已完成。`extract_gim_archive` Tauri 命令返回二进制 payload
  （manifest + blob），前端构建 `Map<path, File>` 与 WASM 路径同构；
  失败自动回退 libarchive.js。
- **实测**：line02.gim（10.8MB，22,640 条目）debug 构建原生解压 3.3s；
  release 构建预计显著更快。ZIP/7z 双路径均有 Rust 单测覆盖，
  另含真实样本集成测试 `extracts_real_line02_sample`。

### P0-3 重评估启用 Fragments 缓存（变电二开）✅ 基础设施已实现（2026-08，灰度开关 + 版本键绑定 + 自愈删除）

- **现状**：`ENABLE_FRAGMENTS_CACHE=false` 休眠。二开时每次都要走 web-ifc → Fragments 转换（⑥ 的主要成本）。休眠原因历史上是正确性问题（Malformed tile / 版本失效）。
- **方案**：
  1. 以 `web-ifc` 版本号 + `PARSER_VERSION` + IFC 文件 sha 作为缓存键，任一变化即失效；
  2. 写入前校验 `.frag` 文件头魔数，读取失败自动删除重建（自愈式降级）；
  3. 先灰度：开关默认 false，仅 debug 配置可开启实测一轮，确认无误后翻默认值。
- **预期收益**：变电二开跳过全部 web-ifc 解析与转换，预计为二开最大单项收益。
- **工作量**：2–4 人日。**风险**：中高——此前正是因此休眠；必须靠自愈机制兜底而非信任缓存。
- **验证**：对 4 个变电样本反复 开→清→开 各 10 次，比对构件数一致；故意损坏一个 `.frag` 验证自愈。
- **状态**：✅ 代码基础设施完成，保持默认关闭待真机灰度：
  - 灰度开关 `isFragmentsCacheEnabled()`：localStorage 设 `gim-debug-fragments-cache=1`
    即可真机开启实测（无需重新构建）
  - 缓存键绑定依赖包版本：`fragments-cache-v5|fragments@x.y.z|web-ifc@a.b.c`，
    任一依赖升级自动失效全部旧缓存
  - 自愈增强：读取失败/空文件/反序列化失败时自动删除坏记录与 .frag 文件
    （新增 delete_fragment_cache_record 命令），避免反复命中坏缓存
  - 待办：真机灰度验证通过后将默认值翻为 true

### P1-1 serializeDevToGlb 移入 Web Worker（变电首开主线程占用）

> **状态**：蓝图就绪，未实施。原因：DOMParser 不可用于 Worker（需替换解析器）、
> CSG 共享缓存正确性回归依赖视觉比对（历史上有天空组件错位教训），
> 均无法 headless 验证。以下为分阶段实施蓝图，供具备交互验证环境时执行。

- **现状**：XML 解析（`DOMParser`）+ GLTFExporter 在主线程分批 yield，首开期间 UI 卡顿。
- **方案与关键障碍**：
  - Worker 内没有 `DOMParser` → 需将 xmlModParser 改写为手写轻量 SAX 式解析（MOD XML 结构简单固定，可行）；或改用 `@xmldom/xmldom`（纯 JS）；
  - GLTFExporter 依赖 Blob/URL → Worker 内可用（Blob 在 Worker 全局存在），需实测 three-bvh-csg 在 Worker 中是否正常（其 ESM 构建无 DOM 依赖）;
  - 主线程与 Worker 之间传递 parsed IR（结构化克隆）而非 THREE 对象。
- **预期收益**：首开期间地图/树操作不卡顿；多 Worker 并行序列化多个 DEV，几何就绪总时长缩短约等于 CPU 核数倍数（受限于 IO）。
- **工作量**：5–8 人日。**风险**：中——CSG 链式求值与共享几何缓存的正确性需重点回归（参考 substation02 天空组件错位的历史教训）。
- **验证**：substationGeometrySeed / modAutoLoadFastPath / progressiveGeometryService 测试全绿 + 变电样本视觉比对。
- **实施蓝图**：
  1. 先用 P0-1 埋点确认瓶颈分布（XML 解析 vs CSG vs GLB 序列化占比），决定拆分粒度
  2. XML 解析去 DOM 化：xmlModParser 改写为手写轻量 SAX 式解析或引入 @xmldom/xmldom；
     以现有 xmlModParser.test 全量用例做双实现输出一致性对比
  3. Worker 模块：接收 IR 输入 → three 场景构建 → CSG → GLTFExporter 序列化 → 返回 GLB 字节
     （结构化克隆传 IR，不传 THREE 对象；GLTFExporter/Blob 在 Worker 可用需实测）
  4. 主线程仅做 GLB 加载与实例矩阵应用；共享几何缓存键策略同步迁移
  5. 回归门槛：全部变电样本渲染结果与主线程版逐 bbox 一致 + 长任务（>50ms）下降 ≥80%

### P1-2 线路入库 payload 分块传输 ✅ 已实现（2026-08，save_line_graph_begin / save_line_attrs_chunk / save_line_project_finish）

- **现状**：graph + FAM/DEV 属性整体 `JSON.stringify` 后一次 invoke，数十 MB 时 Tauri IPC 序列化开销明显。
- **方案**：按 source_path 分块（如每 2000 条记录一批）多次 invoke 写入，Rust 侧同事务包裹；或改用 Tauri 的 binary IPC（ArrayBuffer 载荷）避免 JSON 转义开销。
- **预期收益**：大型线路工程入库阶段耗时降低 30–60%（待 P0-1 实测确认基数）。
- **工作量**：1–2 人日。**风险**：低——事务边界需保证原子性（失败回滚整批）。
- **验证**：line02 入库耗时前后对比；缓存往返测试（gimIndexRoundTrip / stdSldCacheRestore）。
- **状态**：✅ 已完成。三阶段命令 + 每批 4000 条交错传输；原子性语义由
  parser_version 提交点保证（中途失败 → 版本戳未更新 → 缓存判无效重建）。
  入库过程 UI 显示百分比进度。

### P1-3 web-ifc 多线程版本（变电首开）◐ 检测与可观测性已实现（2026-08），启用需真机验证

- **现状**：`public/wasm/web-ifc-mt.wasm` 已就位但未启用；web-ifc 单线程解析是 ⑥ 主要成本。
- **方案**：检测 `crossOriginIsolated`（需 COOP/COEP 响应头，Tauri 下配置自定义协议 header），可用时加载 mt 版本并设置线程数；否则回退单线程。
- **预期收益**：IFC 解析接近线性加速（核数相关），首开 ⑥ 阶段有望减半。
- **工作量**：2–3 人日。**风险**：中——SharedArrayBuffer 要求 COOP/COEP，可能与天地图/OSM 跨域资源加载冲突（需 `credentialsless` COEP 策略验证瓦片仍可加载）。
- **状态**：◐ 部分完成：
  - 已实现 `isWebIfcMultiThreadingAvailable()` 检测（crossOriginIsolated + SAB），
    接入 Ctrl+Shift+D 诊断 JSON 的 `webIfcMt.available` 字段
  - 已确认技术路径：web-ifc Init() 自动检测隔离状态选择 mt 版本（无需改 OBC 调用）；
    web-ifc-mt.wasm 已随 copy-web-ifc-wasm.mjs 分发
  - **未实施**（需真机验证，无法 headless 完成）：
    a) tauri.conf.json security.headers 配置 COOP+COEP:credentialless
    b) emscripten pthread worker 在 Vite 打包下的加载验证
       （mt 版本以主脚本 URL spawn worker，打包器处理方式需实测）
    c) 天地图 DataServer 在 COEP 下的瓦片 CORS 行为核验（不通过则天地图底图失效）
  - 启用步骤：真机完成 a/b/c 后在 tauri.conf.json 加响应头即可，代码零改动

### P2-1 PMTiles 离线瓦片启用（线路地图）

> **状态**：代码路径完备（lineMapPmtiles.ts + 底图切换控件 + 回退逻辑），阻塞项为
> 瓦片数据制备（下载工程覆盖区域 OSM/影像数据并转换为 .pmtiles），属数据工程任务。

- **现状**：`ENABLE_PMTILES_EXPERIMENT=false` 休眠；在线瓦片首屏受网络 RTT 制约（弱网/离线直接回退 Canvas-only）。
- **方案**：制作工程覆盖区域的 `.pmtiles`（栅格或矢量），随安装包分发或首次下载后缓存；底图切换控件已支持 pmtiles 模式。
- **预期收益**：离线可用 + 底图首帧显著提前；对便携版（离线场景）是功能级收益。
- **工作量**：3–5 人日（含制瓦流水线）。**风险**：低——现有回退逻辑完备。

### P2-2 前端分包与预加载微调 ✅ 已实现（2026-08，vite manualChunks 细化）

- **现状**：构建有 >500KB chunk 告警；thatopen/three/web-ifc/libarchive 已 manualChunks 分离，但仍全部随入口加载。
- **方案**：viewer 相关模块（three/thatopen/web-ifc）仅在确认为变电工程后动态 import；线路工程则只需 maplibre。配合 `<link rel="modulepreload">` 提示。
- **预期收益**：线路工程的启动 bundle 显著减小（three/web-ifc 合计数 MB）；变电不受影响。
- **工作量**：1–2 人日。**风险**：低——注意懒加载边界不要引入循环依赖。
- **状态**：✅ 已完成（2026-08 二次修正，含静态依赖可达性切断）：
  - vite manualChunks 细化：maplibre（1.05MB）/ pmtiles / camera-controls
    从 vendor 独立拆分；vendor 1.1MB → 21KB
  - openGimService 对 viewer/ifcLoader、viewer/ifcNameIndex、viewer/camera 的
    静态 import 改为调用点动态 import（评审 #6 指出仅 manualChunks 不够）。
    构建产物验证：入口与 openGimService chunk 的静态依赖图完全不可达
    three/thatopen/web-ifc/camera-controls，重依赖仅在对应分支加载。

### P2-3 变电属性解析与入库并行化 ✅ 已实现（2026-08，gimIndexPersistenceService 分批并行读取）

- **现状**：CBM/FAM/DEV 逐文件 await 解析后统一入库。
- **方案**：解析阶段用有限并发（类似 modAutoLoadService 的 CONCURRENCY=4 模式）批量读取；入库保持单事务。
- **预期收益**：解析层 1.3s 基础上再压缩（IO 密集型任务并发收益明显）。
- **工作量**：1 人日。**风险**：低。
- **状态**：✅ 已完成。DEV/FAM 文本读取按 32 文件/批并行（Promise.all），
  解析保持原顺序确保结果确定性；gimIndexRoundTrip 往返测试覆盖。

---

## 3. 推荐路线图

| 阶段 | 内容 | 出口标准 |
|---|---|---|
| 第 1 步 | P0-1 性能埋点 | 打开变电/线路各一份样本，产出完整阶段耗时报告 |
| 第 2 步 | P0-2 Rust 原生解压 | 解压耗时降至当前 1/3 以内；两类样本回归全绿 |
| 第 3 步 | P1-2 入库分块 | line02 入库耗时下降 ≥30% |
| 第 4 步 | P0-3 Fragments 缓存灰度 | 10 轮开合测试零缺陷后默认启用；二开耗时重新基线 |
| 第 5 步 | P1-1 几何管线 Worker 化 | 首开期间长任务（>50ms task）数量下降 ≥80%；几何结果像素级一致 |
| 第 6 步 | P1-3 / P2-* 视第 1 步实测数据决定 | — |

## 4. 不建议做的方向

- **7z 随机访问/部分解压**：固体压缩不支持，投入无回报；ZIP 包可顺带获得（Rust zip crate 按 entry 解压），但不作为独立目标。
- **替换 SQLite 为其他存储**：当前瓶颈不在查询而在 IPC 序列化与解压，换库收益不确定、迁移成本高。
- **牺牲正确性换速度**（如跳过 sha256 校验）：缓存失效机制的健壮性是二开体验的根基。
