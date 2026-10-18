# 未决事项

本文件只维护**代码缺陷、实现风险和待决策的技术项**。
样本与格式的进一步研究、设备验收、外部业务候选不在本文件维护。
只维护未关闭项，不保存开发流水或历史版本。实现与格式正文说明当前行为，本文件维护行动、依赖和完成条件。关闭后删除条目，并更新相应正文。

优先级：
P0 为正确性或核心流程阻断，P1 为主要效率、可维护性或拟交付核心需求，P2 为增强或需要场景确认的候选。状态分为待核验、待开发、待决策；列入不代表已排期。同一问题只使用一个 ID，新增证据原地更新，不追加阶段叙事。

## 桌面实现问题

| ID | 优先级/状态 | 当前问题 | 行动与完成条件 |
|---|---|---|---|
| D-01 | P1 / 待核验 | 变电原始冷路径完整加载及连续响应没有达标证据，DEV 编译仍有长尾风险 | 固定四包空缓存，分别测 IFC conversion、core.load、模板编译、placement/scene commit；完整模型 ≤600s，interactive 后最长 heartbeat 间隔 ≤2s、输入延迟 ≤1s；同时通过正确性门禁 |
| D-02 | P1 / 待开发 | DEV 级诊断未把 IR 的细粒度来源原因贯通到诊断存储 | `geometryDiagnostics` 已定义 empty-device-xml、assembly-node-without-own-geometry、phm-no-solidmodel、dev-no-solidmodel、parser-unsupported、missing-dependency、source-invalid、parse-failed、unknown，IR 侧 `NoneReason` 也区分这些情况；但 DEV 级 `reason` 目前只设置 missing-dependency、parse-failed、parser-unsupported、source-invalid。XML 烘焙已按可见根上报 `failedVisibleRoots`（含 MOD 路径、根 id 与逐依赖原因，每 DEV 上限 64 条）与 `simplifiedBooleans`，可作为映射来源。把 IR 原因映射进 DEV 诊断，使冷/暖/raw 三路径一致可检索，不能伪造几何 |
| D-03 | P1 / 待决策 | 完整 Fragments 缓存不可达，且同一原因使 Preview 相关分支整段成为死代码 | `ifcEntryLoader` 在 `bim-lod` 下提前返回并加载浏览 LOD，`canUseCache` 又要求 `openingPolicy === 'full'`，而 `readIfcOpeningPolicy()` 固定返回 `bim-lod`，调试键开启也已无效；`previewFirstDeferredFine` 因此恒为 false，Preview Provider 挂载块、`allIfcPreviewsReady` 分支与 `conservative-fast-lane` 选择均不可达。先决定完整路径与浏览 LOD 的关系：保留则去掉硬编码并按策略分派，放弃则删除对应死分支及其测试，再谈四包 OFF/build/HIT 的数量、GUID、坐标、选择等价与缺失/截断/版本不匹配回退 |
| D-04 | P1 / 待核验 | 杆塔 HNum/MOD 按需预览有延迟风险 | 拆分 read/parse/render，记录延迟和输入规模；必要时有界缓存或任务隔离；树、地图与快速切换不受阻 |
| D-05 | P2 / 待核验 | 线路 warm 内存驻留归因不完整 | 独立进程分别测 JS heap、WebView/Worker/Rust RSS，切换与关闭后观察回收；据证据决定属性 lazy load |
| D-06 | P2 / 待核验 | line03 原生 7z 冷解码需单独评估 | 拆分 decoder、条目写出和调度，不混入 parser 指标；改进须保持配额、路径安全、完整性和源身份 |
| D-08 | P1 / 待开发 | XML primitive 覆盖有缺口，部分仅解析或近似 | 对未渲染类型按样本频次和可达对象排优先级；补齐字段语义与真实参考形状；保留 partial/unsupported，验证缓存及变换。当前未生成几何的类型见 [XML MOD](schema/substation-mod.md) |
| D-11 | P1 / 待决策 | substation02 两个摄像头 DEV 的源 MOD Entity 矩阵含约 10¹⁴ mm 平移，34 个 occurrence 以 source-invalid 确定性缓存并显式拒绝；其他局部实体是否保留未决 | 保持源值及失败来源可追溯；如引入局部保留，必须标记 partial、证明有效子集并复核冷暖与选择，不计为完整恢复 |
| D-12 | P1 / 待核验 | 原生语义发布与 DEV 未完成时正常关闭后的独立暖启动已通过局部验收；WASM 回退及持久化异常的真实桌面闭环未执行 | 在限定预算内核验回退源写入、缺文件、截断索引、写入失败和 A→B；语义 HIT 与部分 DEV 缓存分开，不放宽超时 |
| D-13 | P2 / 待核验 | 变电来源文件 validation 保留逐文件 reparse 检查，首轮 OS/文件打开波动仍可显著增加耗时 | 扩充独立进程与部署环境验证；目录安全检查去重须先证明验证期间变化 fail closed，不以降低安全检查换取提速 |
| D-14 | P2 / 待开发 | 遗留全量 GLB 回退路径仍依赖完整 manifest/version，transient I/O/写盘失败后的整批恢复成本尚未收敛 | 默认设备 LOD 已逐模板原子提交并复用局部缓存；核对遗留回退路径的适用范围及恢复成本，保留 retry，不能把临时失败持久化为 source-invalid |
| D-15 | P1 / 实验待验收 | Remaining Preview 原顺序与 conservative fast-lane 的 02 阶段对照产物已不在 `output/` 中，无法就地复核 | fast-lane 默认关闭；重新取得有效配对证据，补 01/03/04 成本/交互验收，不用 entry count 或单轮总时间替代对象覆盖、Fine 等待与峰值内存 |
| D-16 | P0 / 默认策略待验收 | 02 single-pass early semantic 已通过功能 smoke；Native eligibility 允许 01/02/04，03 因 checkpoint 后仅余 732 bytes 正常 fallback。02 三次完整有效 cold 观察 core 约 31.5–32.2 秒、first 约 34.7–35.3 秒；当前默认关闭 | 01 未在既定 90 秒内完成正式发布观察；早关闭后 v26 receipt 未发布、重开继续 cold，MSIX 两种 root spelling 的独立文件/副本清理证据仍需闭环。不扩大超时，也不用结构有效宣称默认门禁通过 |
| D-17 | P1 / 待开发 | IFC 未缓存近景仍有源打开和几何成本；板件、杆件及紧固件已使用区域依赖子集，较大闭包仍有构建长尾，其他类型及回退路径仍可能重开整源 | 维持自动视域/30m 与已识别小孔策略；扩展前证明单位、放置、外观和保留开洞等价，核对预算、回退及峰值内存；补齐真实树到区域细节高亮与重任务资源竞争，不把源复用当成区域即时完成 |
| D-18 | P1 / 启动待核验 | 当前本机 Portable 启动检查确认了进程和 Tauri 窗口创建，未取得 WebView 页面就绪证据；构建和 ZIP 完整性校验已通过 | 复核普通交互启动、Fixed Runtime 环境和页面就绪；启动方式受控且页面可交互后再判定桌面启动通过，不将检查进程创建等同于软件可用 |
| D-21 | P1 / 待开发 | 设备细节缓存未命中时，磁盘惰性来源仍按文件经主线程原生 RPC 读取，LOD1/2 深层精确 CSG 仍有不可中断长尾；全站基础表示的内存驻留也偏高 | 保留当前两 Worker 并发与输出背压，依据请求来源链评估有界批量读取和模板/元数据驻留；保持按需范围、原生安全校验与旧表示连续显示，单列缓存未命中细节、阶段墙钟和连续响应，不能用减少设备覆盖换取提速 |
| D-22 | P1 / 待定性 | `npm test` 全量并行运行下 `selectionInteraction.test.ts` 出现 5 秒超时与一次相机断言失败（`expected Vector3{0,0,0} to deeply equal Vector3{10,0,0}`），但该文件单独运行连续两次均 25/25 通过，属并发负载下的抖动 | 定位并行度、任务残留与资源竞争；保留选择提交权与相机断言，不移除失败测试、不提高 timeout 掩盖。同批次另有 2 个失败来自 Rust 测试无法创建临时 SQLite 库，属环境因素，不计入本条 |
| D-23 | P1 / 场景待验收 | 大规模设备相机交互仍需固定路线验收；已有分批提交、相机评估复用和状态合并刷新，单次提交不可中断 | 记录 draw calls、帧耗时 p95/p99、长任务与驻留内存，依据测量决定实例化或合批，保留 occurrence 和部件选择身份；局部几何通过不等同整站流畅度通过 |

现行模板共享和 IFC/Spatial Worker 已存在，不作为待开发项重复立项。

IFC Preview Provider 保留为默认关闭的研究原型（见[架构](architecture.md#实验性-ifc-preview-provider桌面变电)），产品不提供 Preview 入口。因为默认策略是 `bim-lod`，而 Preview-First / Deferred-Fine 与 Preview Provider 挂载都要求 `openingPolicy === 'full'`，该原型在当前默认路径下不可达；调试键只对完整路径生效。旧原型的完整工程验收、预览缓存、MappedItem/BRep 预览主体、带孔/曲线轮廓及 MapConversion 仍未完成；默认产品采用独立的 IFC 浏览 LOD，不沿用这些原型的完成结论。

大型 IFC 几何实验未关闭的具体问题：完整 02 原路径在 120 秒窗口内尚未提交钢结构 LOD0；自适应候选虽提交预览，实际鼠标目标板件 ExpressId 66438 被另一 MEMBER 566436 遮挡/命中，未完成整站单对象精化验收。不能据此认定 identity 映射错误，也没有足够证据将原因归结为单一坐标或相机问题。视距候选单轮最慢不可中断轮廓构建约 54.4 ms，超过 2 ms 软预算；降低三角面并未同时降低 draw calls。对象精化首请求仍须读入并 OpenModel 整个源文件，局部实验约 16 秒、WASM heap 容量约 808 MB，不能宣称任意对象均可即时精化。结果保留在 `output/ifc-geometry-breakthrough/`，失败不提高超时重跑。跨表示位置与复杂开洞正确性仍需逐对象证据，不使用拟合 T。

小 IFC 的真实 Tauri/WebView 替换已有局部验收证据：独立验收包封装两个未修改的真实 IFC，目标文件 575,414 bytes、SHA-256 `3cfe2f6927511badc4b5ae112a71e994404b83139102d0ea63c4b2be8f7f927d`；语义冷/暖路径均保持同一 GlobalId/ExpressId，LOD0/LOD1/LOD2 包围盒中心误差约 4.21 微米，Preview 退出场景，精细高亮与属性沿用原 SelectionRequest。此证据只覆盖该对象和输入，不证明全站跨表示等价。

substation02 的 Preview/Fine 协作已有局部桌面证据，DEV 单工作单元仍有不可中断长尾，循环间检查点不能覆盖内部序列化。原生语义持久化已独立于该重任务，暖启动验证不代表完整几何 HIT；缺失或未完成的几何继续按原回退路径处理。连续输入响应观测不覆盖整段预览生成与所有后台工作；进程内存驻留仍较高，完整转换 Worker heap 尚无精确公开测量。 性能指标见 [性能](performance.md)。

## 加载与业务投影待完成项

| ID | 优先级/状态 | 当前问题 | 行动与完成条件 |
|---|---|---|---|
| D-25 | P1 / 待核验 | 原生登记核心未复现长卡；v0.0.8 已取得 substation01 新进程冷/暖配对计时（90.5 s / 4.6 s，见[性能](performance.md)），仍未取得同进程关闭重开与 Mutex poisoned 首次 panic 堆栈。同一当前 Portable 的仓库外完整副本可进入原生页面并连接 CDP，仓库内启动与隔离调试窗口仍有权限/位置环境差异 | 继续取得同进程重开诊断，分列登记、IPC、语义恢复、IFC 实际冷暖来源及 DEV 缓存批读/解析/提交；若仍出现 poisoned，保留首次 panic 证据后定位其他持锁路径，不能通过清除 poison 掩盖未知异常 |
| D-26 | P1 / 场景待验收 | 同名系统前缀、字母数字间隔、自然排序、二次归属及确定设备别名已修正；任意层级分类与装配歧义仍需业务复核 | 核对四样本独立设备及部件覆盖、真实重复模板实例、歧义别名和当前 FAM 证据；业务节点计数与几何实例计数分开，不能以研究报告的 F4 数直接当设备台数，不按空间近邻强配 |
| D-24 | P1 / 待开发 | IFC Spatial 仍逐文件扫描 STEP；源 SHA 跨阶段复用与派生缓存写删路径仍有重复成本，原生整体驻留尚缺配对数据 | 冷路径的真实 Blob 已由 Spatial Worker 读取和解码，磁盘 shim 仍经授权读取；DEV 缓存读取、校验和解析共用 128 MiB 输入预留预算，编译与 GPU 内存另计。后续须从完整解析结果生成等价语义输入，并以可信原生读取凭据复用校验，不能仅凭路径/大小/mtime 跳过 SHA |
