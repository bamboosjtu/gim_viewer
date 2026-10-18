# 性能测量

当前没有可作为本源码构建正式性能承诺的完整数字基线。 测量必须先验证语义、引用、坐标和交互正确，再比较时延与内存。 当前响应与完成时延的核验任务见 [未决事项](open-issues.md)。

## 指标

| 指标 | 起止或口径 | 必须同时说明 |
|---|---|---|
| 打开总时延 | 用户打开输入至指定 ready 状态 | 输入复制是否计入、首次可交互/完整模型 |
| 身份检查 | SHA/源读取和缓存校验 | 源大小、native/browser |
| 解压 | payload 解码、条目写出与调度 | 各阶段拆分、条目数、配额 |
| 核心语义 | graph/FAM/DEV 解析与持久化 | Worker wall time 与主线程工作 |
| IFC conversion | 单文件与总转换 wall time | Worker 并发、输入 copy、文件顺序 |
| Fragments load | `core.load`、回调与更新 | 与转换时延分别列示 |
| DEV | 来源读取/RPC 等待、校验、解析、primitive、Boolean、合并、GLB 导出与 I/O、placement、scene commit | 唯一 DEV 与 occurrence 数、各 LOD 编译与命中数、实际显示与 partial/失败数；Worker elapsed 是墙钟时间 |
| Spatial | read/deserialize/hydrate 或 rebuild | hit 与 miss 分开 |
| 交互 | 输入到最终属性/高亮/相机提交 | 选择 ID、加载阶段、动画 settle |
| 主线程响应 | Long Task、heartbeat 间隔、输入延迟 | 监测窗口、最长值、分位数 |
| 内存 | JS heap、WebView/Worker/Tauri RSS 与峰值 | 单进程和进程树，采样方法、回收时间 |

ready 含义以 [架构](architecture.md#配置与加载状态) 为准。`allIfcReady` 和 `fullModelReady` 都须附加载失败、partial/unsupported 数；达到阶段不能解释为全源模型覆盖。

桌面变电优先报告产品时刻：`coreSemanticReady`（树/基础属性）、`firstUsableGeometryReady`（首个可浏览站模型）、`devCurrentViewReady`（当前视图所需档位完成且无失败）、`devBaseRepresentationsSettled`（全站每个 occurrence 均已显示基础表示、明确 empty/unsupported 或失败终态）、`devAllStationReady`（全部可渲染设备完成 LOD2）、`selectedFineReady`（用户选择的唯一精细关联、高亮和属性提交）。`devGeometryReady` 保留为默认 DEV 基础表示收敛的兼容时刻，路径标记 `device-lod`。同时报告 anchor 到 DEV ready 的等待与执行时间，不用全部 IFC 就绪替代设备可用性。`selectedFineReady` 产品时刻记录首个成功选择；逐请求事件保留 requestId、GlobalId、ExpressId 与 LocalId，过期或歧义选择不产生成功事件。

LOD0 基础表示使用优先且更宽的模板缓存读取通道（当前最多 16 个模板槽、最多两个编译 Worker），LOD1/2 不得占满基础表示槽。原生批读按 16 条一批并在失败时拆批重试；模板槽与编译 Worker 数量分开统计，不能用模板槽数推断并行几何编译数。`catalogHint` 在模板槽内复用目录结果，已验证 empty 源不进入编译或空模板写入。

设备自动 LOD 另外记录 `catalogReady`（空间目录就绪）、`currentViewReady`、`currentViewSettled`、`baseRepresentationsReady`、`baseRepresentationsSettled` 和 `allStationReady`。这些状态不可互相替代：`Settled` 允许失败/empty/unsupported 终态，`Ready` 只统计成功达到所需档位的设备；当前视图不能等待全站目录完成。`allStationReady` 只在所有可渲染设备都达到完整 LOD2 时成立，基础轮廓或 partial 不计为完整几何。状态栏的已准备实例数不等于完整几何数，报告须附部分表示、失败和未知范围数量。

DEV 缓存读取必须按 `hit`、`miss`、`read-error`、`invalid`、`deferred` 分开计数；只有 `miss` 可进入冷编译，其余状态保留原因。批量读取失败须按条目隔离并可拆批重试，不能把整批有效模板当作未命中。逐模板记录 `(source SHA, DEV, LOD)` 的命中、编译、读取错误、校验失败和写入失败；编译成功但未持久化不得计为暖缓存。状态栏分别显示 LOD0/LOD1/LOD2 的缓存命中、冷编译、失败与阻塞原因，进度从 1 开始计数。

暖启动的“检查本地缓存”与“登记工程记录”是分开计时的阶段。缓存结构、parser/domain 版本和索引 receipt 通过后，不逐个打开全部源文件与 GLB；只验证 IFC source，GLB 由 DEV 批读按 entry 校验。完整源扫描只用于结构/版本/receipt 失效的修复路径。诊断报告应分别列出登记、校验、索引恢复、首个 IFC、DEV 基础表示，不能把这些时间合并成一个“核对工程记录”。

单机配对记录（substation01，36,112 个条目，v0.0.9 构建，同一 EXE 冷/暖各一次）：空缓存首开从点击到首个可用 IFC 为 32.7 s（解压 8.6 s：解码 2.2 s、写盘 0.5 s、commit 3 ms；语义 hydration 6.5 s；层级解析 17.0 s；3D/首个 IFC 2.5 s），同机重启后的语义暖开为 4.6 s（首个树节点 2.7 s，源校验 0.04 s，索引恢复 2.5 s）。全站 L0 暖恢复（285 个唯一 DEV、640 个模板缓存）从点击到 285/285 已显示为 12.3 s（其中交互后约 7.8 s），冷编译同一目标为 79 s。首开后的语义索引仍在后台发布，本机约 85–120 s 后才提交；提交前关闭或切换工程会撤销该次发布，下次仍走冷路径。v0.0.8 之前的对照：同一路径缺索引时会重新解压全部条目（142 s），暖校验还要对 3.6 万条源逐条 reparse（`source_scan_path_files` 9.5 s）。冷/暖差异只在本机单样本复现，不是多机 p50/p95 基线，也不代表全站几何命中。

变电几何源在 pack 内是 lazy 的，而 Worker 每次取源都要经主线程往返；几何编译期间主线程繁忙，单次读取实测 30–90 ms，几千次读取会把冷几何阶段拖到数十分钟。冷路径因此在 DEV 调度开始前用少量大批次 IPC 一次取回几何源（DEV/PHM/STL 优先，再 MOD；单文件 8 MiB、总量 128 MiB 上限），暖路径保持按需读取。该预取不改变模板/LOD 判定，只把源读取从“逐条 IPC”换成“批次 + 内存”。

索引未提交就切换工程时，第二次打开改为读取解压清单：源 SHA 匹配就直接复用已解压的 pack/IFC，不再重新解压。实测同一序列（首开未提交 → 打开另一工程 → 再开原工程）从 36 s 降到 24.7 s（解压 8.6 s、hydration 6.0 s、解析 12.7 s）。索引构建在会话切换时会检查取消并中止，避免旧工程属性解析继续占用主线程。读取类命令（`read_cached_entry`、`batch_read_cached_files`、IFC/GLB/manifest 读取）已改为异步命令，避免在主线程繁忙时排队。

IFC 每文件记录 bytes、实际来源（`ifc` 冷转换 / `lod-cache` 远景缓存 / `fragments-cache` 完整缓存）、conversion、`core.load` 与缓存写入耗时；远景缓存命中不等于完整 IFC 几何就绪，区域精化另计。IFC 远景缓存写入不得阻塞 `firstUsableGeometryReady`，写入失败须单独记录且不得形成虚假的暖命中。

Long Task 统计除 count/blocking/max 外保留最多 64 条样本（时间、时长、当时的活动 span），用于把主线程阻塞关联到 `core.load`、GLB 解析、场景提交等阶段；样本上限不代表全量长任务。


默认基础表示覆盖全部物理 occurrence，包括视野外和范围未确定的设备；LOD1/2 按视图或选择请求。比较新旧管线时同时列出实际工作量，不能把旧管线遗漏设备得到的较短时间当作同覆盖度的性能基线。最多两个 DEV Worker 与串行 IFC 转换并行，来源缓存预算由 Worker 平分；显示或选中的模板受保护，128 MiB 是可淘汰模板预算，不能解释为整个工程的硬内存上限。

每个 Preview 记录来源 bytes、WASM 初始化、OpenModel、metadata 检查、LOD0/LOD1 生成与 scene commit。LOD 生成 wall 包含时间片让权及 commit，不能与 commit 时长相加；完整 Preview wall 还包含源读取、Worker 启动/传输等。首个完整 IFC 的顺序不改变，剩余 Preview 保持顺序，不用文件大小代替实测成本排序。

原生冷解压记录 header、archive wall、逐 entry decode/read 累计、sink write/open/data、staging commit、最大 entry decode/write 及路径，前端另记录小文件物化和 CBM/FAM/DEV 解析。archive wall 包含 decode 与 write，不能重复相加；7z solid stream 中单 entry 的读取/解码时长不等于可独立消除的文件成本。阶段解压或延迟 IFC 落盘需要另行评估条目顺序、solid block 和二次解码成本。

原始 IFC 的百分比由当前 Fragments `IfcImporter` 按几何类别、属性、关系和序列化阶段报告，不是已读取字节或已完成构件的比例。某一类别的同步 `StreamMeshes` 返回前可能没有新的百分比；必须结合 Worker CPU、主线程 heartbeat、输入响应和最终文件状态区分计算长尾与界面阻塞。 Worker 隔离同步转换不等于减少几何计算时间，也不保证后续 DEV 编译没有主线程长任务。

设备 LOD0 的 Boolean 使用实体表面组合与相交对求值，LOD1/2 保留精确 CSG。记录 booleanEvaluations、disjointBooleanPairs、simplifiedBooleans 的次数，并与 booleanMs、合并和导出墙钟分别报告；减少求值工作量不能表述为同一次 CSG 的算法加速。状态统计中的已处理 occurrence 包含失败终态，实际显示、部分表示与当前视图成功状态另计。

桌面 MOD 文件加载在已完成的 primitive 烘焙和递归 Boolean 运算之间按时间片让出主线程；同步文本转换接口仍采用相同的运算顺序。单次 CSG 运算、合并和 GLB 序列化仍需分别测量，时间片预算不能解释为这些操作的最大耗时，也不能替代完整加载和持续响应验收。

## 样本与运行条件

变电四包覆盖不同 IFC 布局、嵌套装配和 primitive；线路六包覆盖导出变体。 line02 为六线路中最大文件数与解包体积的样本，可作为线路压力输入。 具体身份与数量只在 [样本台账](schema/sample-corpus.md) 维护。

记录源码提交、依赖安装版本、EXE 与运行时资产哈希、OS/WebView、CPU/RAM、源位置、浏览器或原生、底图网络、监测器和缓存目录。 不同时运行其他基准任务；profiler 测量单独标注，不与未开 profiler 的值直接比较。

## 冷、暖与缓存策略

| 场景 | 初始条件 |
|---|---|
| 全冷 | 独立空缓存与独立进程；没有语义、GLB、snapshot、Fragments |
| 语义暖 | 合法语义缓存；明确列出其他缓存缺失或部分命中 |
| GLB 暖 | 有完整几何 manifest 和逐项命中统计 |
| Spatial 暖 | 合法 snapshot，记录 hydrate 与 rebuild 是否发生 |
| Fragments OFF/build/hit | 明确开关和源/依赖匹配，分别运行 |
| 浏览 LOD 冷/远景 HIT/区域 HIT | 独立派生缓存；远景表示与完整原始几何分列，首次区域 OpenModel 与缓存恢复分列 |
| 设备 LOD 冷/暖 | 独立派生缓存；按 DEV 分别记录 LOD 0/1/2 的编译与命中、128 MiB 模板淘汰、工作闸等待，并单列峰值内存 |

不清除原始 GIM 和解包源。样本缓存准备不能算正式冷运行。 部分 GLB 命中不能标为完全 warm。默认 Fragments OFF 的结果不能外推为 HIT。 IFC 浏览 LOD 使用独立默认缓存；远景 HIT 不等于近景全部 HIT，30m 区域只证明该相机视锥和范围内的恢复。直接网格实验的几何流耗时不包含 Fragments 属性、关系、序列化、索引和场景提交，不能作为产品冷打开耗时。区域源任务串行、单源驻留和空闲释放限制区域并发堆数，仍须独立测量与其他后台管线的峰值内存。设备 LOD 分级只改变表示精度、不改变 occurrence 身份，报告须同时给出各级 LOD 的 occurrence 数与模板命中；模板 LRU 淘汰会触发重新编译，必须与冷编译分开统计，也不能用 LOD 切换生效替代显示正确性验收。

冷转换诊断中的 `ifcColdPipeline` 记录扫描、WASM 初始化、OpenModel、单位读取、importer 与包围盒收集、剩余索引补齐时长。包围盒收集已计入 importer 时长，不能重复相加；源读取、SHA、Worker 启动、派生缓存写入和 Fragments 场景提交由外层 wall time 计入。`parsedModels` 只统计这次转换拥有的模型，不包括后续近景或属性请求。

## 连续测量

从生产入口开始到指定终点，完整记录响应；不通过暂停大 IFC 或中断 DEV 管线降低时间。 超出时间上限是失败，之后完成只作为结束观察，不能改判达标。 取消/切换用例属于生命周期验证，与连续完整加载基准分开。

`Ctrl+Shift+D` 导出包含 timings 的诊断 JSON；`Ctrl+Shift+B` 进入基准相关工具。
埋点入口为 [perfTimings](../desktop/src/utils/perfTimings.ts)，DEV 细分入口为 [devGeometryTelemetry](../desktop/src/services/devGeometryTelemetry.ts)。 报告同时保存 root/alias/instance、IFC 数、缓存命中与选择结果，便于判定速度改善是否改变行为。

## 可采信基线

正式基线需具有相同输入和清晰构建身份，完成规定正确性门禁，报告多次运行的 p50/p95/max、内存峰值及释放后驻留。 只测到 warm、只测首批模型或缺少连续响应窗口时，只能说明对应范围。

当前没有满足上述条件的完整构建基线，正文不沿用不同构建的数字。 Android 真机冷导入和 warm 目标属于待核验要求，完成条件在未决事项维护。

## 移动端测量

移动端“地图设置 → 查看本机运行信息”显示本次会话的打开总时延及导入阶段耗时。 冷导入从 SAF 返回后复制开始，包含复制/SHA、原生校验与解压、Worker 投影、SQLite 提交，终点是树和 Canvas 工程覆盖层可交互；不包含选择器停留或在线瓦片等待。 warm 从点击已有工程开始，终点相同。重复选择原包需要再次复制和 SHA，应单独记录。

Android 模拟器必须标注 API、WebView、native debug/release、ABI、模拟器资源和构建任务竞争。 单次模拟器记录用于定位瓶颈，不能作为 X Fold5 的 ≤10s/≤3s 达标证据。 指定真机需记录完整正确性、连续主线程响应和内存；仅构建优化成功不能认定性能达标。

设备 LOD 相机评估每轮复用一个相机矩阵与视锥上下文。3326 个合成包围盒、每组 40 轮的两次局部 CPU 对照中，旧路径中位数为 3.3/3.0 ms，复用路径为 1.1/1.0 ms，所有可见性、距离与投影尺寸结果一致。此实验只测量候选评估，不能解释为整站帧率、GPU 性能或冷启动提速。诊断增加 uniqueDevSources、sceneCommitCount 与 sceneCommitMaxMs，实例总数、唯一 DEV 来源数和模板数分别解释。

诊断时间线最多保留 8192 条明细，满后按 1024 条淘汰较早记录，长会话的早期明细可能不再可见。DEV ready 统计合并为单趟遍历；模板需求由集合查询，提交队列在入队和选择提优时排序，不随每个提交帧重复排序。GLB 完整 ArrayBuffer 直接交给只读解析器，子视图才复制；新编译结果的 SHA 在 Worker 转移前计算。实际冷暖启动耗时、峰值内存及提速比例须由原生场景取得，不由单元测试推断。

设备模板等待使用可索引堆，避免每个模板槽释放时扫描全部等待者；保护集合未改变时，LRU 不重复扫描全钉住的缓存。编译结果字节阈值为派发反压阈值，已启动任务和暖缓存读入可能使驻留超过该值。测量需同时记录结果队列 bytes、peakBytes 与 count，不把编译结果阈值描述为应用内存预算。原生派生读取的小批次复用项目源校验和父目录规范化，不省略逐文件验证。

区域诊断分别记录源成功读取次数/字节数、源 SHA 校验次数、OpenModel 次数与打开墙钟。连续区域复用与空闲释放后重新打开分别验收；新小孔引发策略变化时的重开也计入 OpenModel，不能用读取复用宣称不再重解析。近景派生预算按共享缓冲区去重估算，不以 JSON 展开顶点数组计量。DEV 输入预留预算与 Worker 结果反压、模板 LRU、GPU 内存分别解释。

完整源回退时，小孔关系的首次修改扫描整份 STEP 并建立字节范围表，后续按新增关系 ID 修改局部范围。测量需区分首次建表、后续范围修改和 OpenModel，不能将范围修改的耗时或缓存区域恢复的耗时写成未缓存近景加载耗时。

区域诊断另列 subsetIndexWallMs、subsetBuilds、subsetBuildWallMs、subsetRecords 和 subsetFallbacks/reason。sourceOpenCount 仅统计整份来源的 OpenModel，不包含子集 CreateModel 或数值桥接探测。连续请求即使没有新增整源打开，仍可能有较大依赖闭包和几何开销；按区域分别记录对象数、依赖记录数与墙钟。空闲释放后仍需重新读入和打开来源。源驻留、子集和 GPU 的内存不能用记录数或子集耗时替代实测。

项目登记原生日志分列路径规范化、两次锁等待、兼容候选数、兼容路径耗时及最终返回墙钟。独立进程中的登记核心探针覆盖已有记录命中和另一个连接持有 WAL 写入保留锁的场景，但不包含 WebView、IPC、语义恢复或几何。该探针不能替代完整桌面暖启动计时。

DEV 暖恢复的缓存批读使用共享消费预留，单次最多 16 条并受调用方字节上限约束；本轮模板槽数最多为每 Worker 两个，实际批大小受并发需求约束。预算内不能接纳的条目延后处理，不按 miss 重编译。cacheReadBatches、cacheReadEntries、cacheReadDeferred 与 templateHits、templateParses、compiled 分开记录。批读减少 IPC 往返，逐模板解析与有时间预算的场景提交仍存在；没有同机配对数据时不宣称整体加载提高某个百分比。

状态冷暖指几何实际来源，不能把“语义工程命中”直接标作全暖。设备节点数、整机装配根数、唯一 DEV 数和 LOD 模板数分别解释。当前视图完成允许显式失败，不等待未请求的全站高精度模板；诊断另列 readinessBlockers、viewPendingOccurrences 和有限 viewPendingSamples，区分相机、目录、模板与提交等待。

完整桌面测试依赖可进入页面的原生入口。同一 Portable 的仓库内启动与仓库外完整副本已有不同结果，仓库外副本可进入页面并接受 loopback CDP；隔离调试 EXE 的窗口创建仍报拒绝访问，尚未确定底层权限失败点。开发服务器不可达或端口占用是另一类错误，不能与 WebView 创建失败混为一谈。浏览器单文件、原生登记核心、Portable 页面就绪和完整工程恢复的证据不能互相替代。手动采集时保留缓存，在卡住和稳定后分别用 Ctrl+Shift+D 复制诊断 JSON；新进程暖启动与同进程关闭重开分开保存，先使用单个 substation01。诊断生成和文件选择器停留不计入打开耗时，不需要为了采集关闭安全软件、修改权限或用管理员运行。
