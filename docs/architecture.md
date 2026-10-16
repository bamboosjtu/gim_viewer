# 系统架构

当前实现包含 Tauri 2 桌面应用和 Android 线路应用，前端使用 TypeScript/Vite，后端使用 Rust。解析输入、业务编排、视图和持久化有独立职责。变电与线路共享容器与生命周期，使用不同运行时。

## 目录与所有权

| 目录 | 职责 | 依赖边界 |
|---|---|---|
| `desktop/src/app/` | 启动、AppState、工程和选择状态 | 接入业务服务 |
| `desktop/src/gim/` | 容器、纯 parser、索引和地图数据投影 | 不依赖 services/viewer/ui |
| `desktop/src/viewer/` | IFC、Fragments、Three.js、MOD/STL 渲染 | 不依赖 services/ui |
| `desktop/src/ui/` | DOM shell、树、属性、搜索、地图 | 不直接访问数据库 |
| `desktop/src/services/` | 打开、缓存、后台任务、选择编排 | 连接解析、bridge 和视图 |
| `desktop/src/config/` | 功能与调试开关 | 只描述当前配置 |
| `desktop/bridge/` | Tauri IPC DTO 与命令封装 | 隔离 Rust 接口 |
| `desktop/src-tauri/src/` | SQLite、SHA、解压和二进制读取 | 事务、配额、源身份校验 |
| `app/` | Android 线路 UI、Worker、SAF、私有 SQLite | 独立平台 IO；不依赖桌面 Viewer/IFC/Three.js |
| `packages/powerline-core/` | 共享纯线路 parser、graph、路径与领域投影 | 无平台、UI、数据库依赖，桌面使用兼容出口 |
| `packages/plugin-api/` | 中立外部 provider 契约 | AbortSignal/dispose，无地图实例 |
| `crates/gim-native-core/` | 两平台共享有界容器解压 | bytes/path 输入、路径与资源配额 |
| `crates/tauri-plugin-gim-import/` | Android SAF、流式复制与 SHA | ContentResolver，不将整个 GIM 传入 JS |

入口和打开服务按需动态 import 重依赖；不静态引入 Three.js、web-ifc、MapLibre。解析分支依据源 magic 和文件结构能力，不依据导出厂商名称。

## 源身份与打开生命周期

[打开核心](../desktop/src/services/gimOpenCore.ts) 建立源 SHA、大小、magic 和工程会话。源 magic 决定工程类型，缓存记录不能覆盖它。读取期间源发生改变时拒绝继续提交，避免用不同源版本组合索引与几何。

```text
选择源文件 → 身份校验 → 清理前工程 → 校验缓存
                              ├─ 合法：分域恢复
                              └─ 无效：解压 → 语义解析 → 持久化 → 渲染
```

桌面原生提取优先，WASM 用于回退或浏览器开发。条目解析统一路径分隔符、大小写和唯一文件名候选；不能固定 IFC 在某物理目录。解压执行路径与资源配额检查，不能把文件可读取等同于引用完整。

工程会话持有 generation、projectId、sourceSha256 与 geometry token。异步任务在提交状态、场景或派生缓存前验证会话，切换/关闭取消 worker 和后台队列。释放几何、材质、模型、地图和索引的所有权归当前运行时，重复清理不得产生双重释放。

## 选择提交权

SelectionRequest 使用请求 ID 和取消信号，覆盖属性读取、几何准备、高亮及相机动作。只有最新选择可以提交可见状态。A 的慢结果不能覆盖 B 的属性、树选择或定位。同一工程中合法的资源任务可继续复用，不能把一次选择变化当作工程失效。Fragments reset/apply 高亮通过短串行队列提交；后台 fit 不覆盖用户已经建立的选择。

## 变电语义与 IFC

原始 CBM 属性、FAM 物理行和设计文档来源分别保存。[substationEvidence](../desktop/src/gim/substationEvidence.ts) 生成文件能力摘要、IFC 证据、PARTINDEX identity alias 与 GL sidecar 投影。摘要不决定厂商 parser 分支。语义格式与身份规则见 [语义模型](schema/semantic-model.md)。

IFC 文件发现与 IFCGUID 对象挂接独立。全局 entry resolver 解析 CBM 引用及 IFC 清单。转换在 IFC Worker 中执行，主线程仍负责 Fragments `core.load`、模型提交与交互。首个 IFC 的插入顺序是坐标锚点契约；缓存恢复保留持久化顺序，不能按文件名重新排序。

空间语义使用两遍选择性 STEP 扫描，位于独立 Spatial Worker。长期索引保留空间节点、对象、placement 闭包及关联证据；属性集、材料、类型、数量和分类按需获取。推断空间链接与直接链接保留来源和置信度，不填造确定归属。

[Spatial snapshot 服务](../desktop/src/services/substationSpatialSemanticCache.ts) 校验源、域和版本后 hydrate Map。缺失、损坏或不匹配的快照在全部 IFC 尝试完成后重建。它不替代 IFC 几何，也不覆盖变电语义缓存。

### 实验性 IFC Preview Provider（桌面变电）

[`IfcGeometryProvider`](../desktop/src/viewer/ifcGeometryProvider.ts) 定义 `canProvide / loadLOD / release / findByGlobalId`，并提供拾取、属性与高亮接口。对象仍采用现有 `ifc:<logical modelId>:object:<ExpressId>` 身份，保留 GlobalId、ExpressId、IFC 类型和来源 Provider；GlobalId 查询返回候选集合。Provider 不生成新 CBM、空间语义节点或 DEV occurrence，不替代 Fragments Runtime。

原型默认关闭，保留研究代码与调试键；产品顶部不提供 Preview 入口，默认加载采用下文的 IFC 浏览 LOD。该原型在当前默认路径下不可达：Preview-First / Deferred-Fine 与 Provider 挂载都要求 `openingPolicy === 'full'`，而默认策略是 `bim-lod`，调试键只对完整路径生效。原型的完整路径仍由首个完整 IFC 建立生产坐标锚点，后续文件在 metadata Worker 中读取单位、上下文和 LocalPlacement 链，先提交 LOD0，再提交 LOD1，自动完整加载与属性面板的“加载精细几何 LOD2”共用该文件的加载 Promise。

另一个独立、默认关闭的实验开关 `gim-debug-ifc-preview-deferred-fine` 必须与 Preview 开关同时启用。该模式不改变原完整加载模式：首个 IFC 仍完整加载并建立坐标锚点，后续文件默认按原顺序生成 Preview，LOD0/LOD1 均完成后标记 `previewReady`，精细状态为 `fineDeferred`，不自动启动 LOD2。已通过 geometry validation 的 DEV 缓存，在首个完整 IFC 的坐标锚点及 interactive 就绪后即可入队恢复，与剩余 IFC/Preview 顺序循环独立；仍等待 Spatial snapshot 恢复完成分类并使用原有互斥重任务与安全检查点。每个打开会话只入队一次，不在 IFC 尾部完成后重复恢复。未命中、部分或失效缓存的 DEV 编译/修复以及 Spatial 重建仍保留 IFC 尾部门禁；语义索引发布不依赖该门禁。`devGeometryReady` 独立于 `allIfcReady`，后者仍等待每个 IFC 精细加载成功或明确失败，延期中的文件不计为 ready。`fullModelReady` 在完整加载模式等待 IFC 与 DEV 均结束；延期精化模式还要求所有 IFC 为 `fineReady`，不以早到的 DEV 缓存冒充完整模型。

独立的 `gim-debug-ifc-preview-queue=conservative-fast-lane` 只在 Preview-First / Deferred-Fine 模式生效，默认关闭。实际坐标锚点和 interactive 建立前完全保留原顺序，包括首个失败时的 anchor fallback；之后将 remaining 来源稳定分为 <1 MiB、普通/未知、≥64 MiB 三组。阈值依据四样本大小分布提出，只作保守调度提示，不能预测重建成本。保持原 IfcEntry/modelId、单个 Preview Worker 和 Fine 调度；记录 entry-ready、unique ExpressId 可表达对象数与源 bytes，anchor 不计入 remaining 对象覆盖分母。该策略的跨样本产品验收尚未关闭，不默认采用。

属性面板中的精细加载请求按逻辑模型 ID 去重，并排在尚未启动的普通重任务之前。已运行的 DEV 管线在完成单个 DEV 的解析、缓存写入和全部 placement 提交后，调用协调器安全检查点；暖路径还在有界 GLB 批读完成后检查。每个检查点最多执行一个用户精化请求，保留 DEV 的重任务调度权，精化完成或失败后继续下一工作单元，不与其他受协调器管理的重任务并行。定向 raw 回退和单 DEV 缓存修复也记录安全边界；完整 manifest/version 仍在管线原有结束位置提交。单个 DEV 内部序列化和已运行的 Spatial/转换不能中途让权。工程关闭会取消排队请求，并由原 ProjectLoadSession 释放活动 Worker。精细转换失败后可重试。LOD1 完成即终止该文件的 Preview metadata Worker；按需属性查询重新读取单个 IFC，并在一次性 Worker 结束或工程关闭后释放。Preview、属性查询和精细转换以转移方式交接各自的一次性 IFC 输入；延期精化重新读取源文件，不使用已释放的预览缓冲区。metadata 就绪 Promise 只持有完成状态，精细替换后清除显式 metadata 所有者。不同文件的 Preview 与精化、一次性属性读取仍可能短暂并行，不保证全工程只有一个 WASM heap。资源事件和进程内存采样用于观测生命周期，Fragments 转换 WASM heap 的精确值仍不由当前公开 API 暴露。

| 级别 | 当前表示与边界 |
|---|---|
| LOD0 | 显式 IfcBoundingBox 或支持拉伸体的局部包围盒，保留放置方向；开孔等 subtractive feature 不生成正向代理 |
| LOD1 | IfcExtrudedAreaSolid 的矩形/闭合折线轮廓棱柱；IfcBooleanClippingResult 递归取 FirstOperand，明确省略裁剪；凹轮廓采用 earcut 封口；无法提供棱柱的对象仍标 LOD0 |
| LOD2 | 原 web-ifc + Fragments 完整加载，不新增精细渲染 Runtime，不跳过原 IFC |

源坐标使用 IfcProject 长度单位、representation context、递归 LocalPlacement（含 Site 父链）及 solid/profile 放置；矩阵为列主序，先源放置、再单位缩放、再现有工程 source-to-viewer 锚点。metadata-derived 原点仅用于 Float32 精度，根矩阵抵消该平移。禁止使用研究 benchmark 的真值拟合 T；MapConversion、mapped/BRep 主体和其他未覆盖轮廓保留诊断，由 LOD2 处理，不推断空间含义。

LOD0 默认使用共享单位盒的分块 InstancedMesh，实例矩阵保留原始包围盒、局部放置、精度原点和工程坐标锚点；instanceId 映射到原 ExpressId，不产生新语义身份。常规 LOD1 保留分批合并网格和三角面 → ExpressId 映射，高亮使用独立覆盖层。同一 SelectionRequest 沿用至精细表示；属性异步结果和精细高亮提交均检查最新选择/工程会话。精细模型可用后移除预览并释放 metadata Worker；metadata 的释放独立于旧 SelectionRequest 的提交资格。按原 GlobalId 查询精细 LocalId 时，使用 Fragments 公开的 item/GUID 反向查询核对唯一性，避免单值 GUID Map 掩盖重复对象；仅唯一候选可以提升，坐标诊断采用相同约束。无唯一关联时保留原语义选择和未关联/歧义状态，不猜第一个对象。工程切换立即释放 Worker、网格和材质。LOD2 替换诊断对同一 GlobalId 记录首个 IFC 锚点、实际协调矩阵、工程变换、预览世界矩阵、Fragments 世界矩阵/位置/包围盒差值；诊断不拟合或修改矩阵，必须由真实桌面样本验收确认空间等价。预览不持久化，不改变现有缓存域版本。

屏幕空间自动切换与 web-ifc `GetFlatMesh` 单构件精化保留为独立几何原型，生产工程加载不启用这两个选项。局部对象计时和坐标核验不能替代完整工程的实际拾取、后台资源竞争与持续交互验收。正常属性面板的 LOD2 仍调度既有整文件 Fragments 加载。

## DEV 编译、模板与 occurrence

[MOD 编排服务](../desktop/src/services/modAutoLoadService.ts) 从物理根建立独立 occurrence，模板身份使用规范化 DEV 路径；实例身份包括 CBM 物理根与装配/引用路径。PARTINDEX 和 DEV_SUBDEVICE 是语义投影，不生成第二套 seed。

PHM 根据引用扩展名递归，逐边累积矩阵，按当前分支防环。相同模板在不同路径的合法重复出现保留；不能使用全局 visited 集合删除实例。父语义节点的 alias 只在其物理装配子树内查候选，身份优先，歧义保留。

设备模板只包含 Entity、DEV/SUBDEVICE、PHM 逐边变换及毫米到米转换；放置根统一应用 `projectSourceToViewer × CBM累积矩阵（平移转米）`，每项各应用一次。冷编译和暖恢复消费同一物理 occurrence 及放置函数，不通过整体偏移或独立居中校准。首个 IFC 锚点由 [公开坐标读取器](../desktop/src/viewer/ifcCoordinateAnchor.ts) 等待 `model.getCoordinates()` 的实际结果构造，避免 Fragments 在异步查询完成前缓存并返回的占位单位矩阵。合法单位矩阵仍被接受，工程切换后旧查询不能提交。区域 IFC 查询和设备放置保持同一工程基准。

同一 DEV、源 SHA 和 LOD 在会话内共享不可变 geometry/material，每个 occurrence 保留独立节点层级和变换；placement 不烘焙回模板。DEV 生产路径不采用 InstancedMesh，模板校验拒绝带动画、实例化网格或非法几何的 GLB。InstancedMesh 仅用于 IFC 浏览 LOD 的近景紧固件表示。

所有物理设备默认自动生成实际参数描述的基础表示，视野外和小投影使用 LOD0，不以点树作为显示前提。范围未确定的设备也自动编译可支持几何，保留范围诊断，不用虚构包围盒剔除或替代实体。原始来源为空、不支持或失败时明确记录状态，不能伪造设备。

可见设备按包围盒距离和投影像素切换细节：选中对象强制 LOD2；距离 ≤30 m 且投影最长边 ≥120 px 时进入 LOD2，退出使用 >35 m 或 <90 px；LOD1 进入使用 ≥40 px，退出使用 <30 px。相机停稳 200 ms 后更新，选择立即排队。视野外不请求 LOD1/2，取消选中后回到相机决定的档位。新表示完成前保留旧表示，所有档位使用同一身份、属性和高亮。

设备目录通过参数和源装配矩阵构建，不依赖三角化或 GLB；STL 扫描顶点范围，Boolean 使用保守范围，未知类型保留 unknown。目录增量提交，按唯一 DEV 复用。模板以源 SHA、DEV、几何版本和 LOD 为键逐条原子落盘；部分合法缓存可直接恢复，不写旧的全站完整几何标记。128 MiB 模板 LRU 按实际顶点/索引缓冲区计量，正在显示和选中的模板受保护，可使驻留值超过软预算；未使用模板被淘汰并释放。

Viewer 创建后即启动设备编译，编译与 IFC 锚点无关，场景提交等待真实锚点。高核数且非低内存环境最多两个 DEV Worker，其余使用一个；全局最多同时执行一个 IFC WASM 任务和两个 DEV 工作单元。完成的 GLB 占用工作槽直到消费方处理完，避免导出结果无限积累。两个 Worker 的来源字节、解码文本、XML IR、DEV/PHM IR 缓存合计预算分别为 64、32、48、12 MiB，单 Worker 也受同一总预算约束；每份驻留文档复用校验和解析结果，几何临时资源在导出后释放。选择、当前视图缺少的基础表示、可见细节、全站其余基础表示依次调度；轻量范围构建优先于普通几何任务，等待任务逐步提升优先级，防止后台基础表示饥饿。工程会话、请求 ID 和模板键共同拒绝旧结果。

内存中的不可变 File 通过结构化克隆交给 Worker 直接读取，保留共享的 Blob 后备存储，避免逐文件经过主线程。磁盘惰性 File 仍使用受源身份和路径校验保护的 IPC。模板读取/解析也受有界队列限制，正在创建 placement 的模板受 LRU 保护。原生索引提交、缓存校验及设备派生产物 I/O 在后台线程执行，保持原有事务、源校验、路径防护和原子替换条件。

状态栏独立显示已处理几何实例、实际显示与失败数，以及当前视图和后台基础表示阶段，不被并行 IFC 提示覆盖；悬停查看设备范围索引、模板编译、缓存、淘汰、部分表示和活动设备。计数以 occurrence 为单位并按状态去重，模板任务数量另计。currentViewSettled/baseRepresentationsSettled 包含已结束失败，currentViewReady/baseRepresentationsReady 保留成功语义，allStationReady 仍要求完整精细几何；失败结束不能永久显示准备中，也不计作成功。临时失败可通过明确选择重试，确定性 source-invalid 按源证据隔离并缓存，旧档位失败不能污染新请求。阶段耗时包含读取/RPC、解码、校验、解析、primitive、Boolean、合并、导出与提交；Worker elapsed 是墙钟时间。

GLB 恢复校验 manifest、源身份、条目状态和文件完整性。单 DEV 文件失败可局部回退原始几何；manifest 无效使几何域失效，不要求删除有效语义域。完成标记只在所有目标条目形成确定状态后提交，瞬时失败不能写为完整版本。确定性 source-invalid 可与其他确定结果共同发布结构有效的缓存，暖恢复不读取其 GLB 或重试 raw；结构有效不等于所有几何显示，fullModelReady 诊断明确记录拒绝数及 geometryFullyRendered。

source-invalid 的普通选择提示仅解释已跳过渲染、属性与来源仍可查看。完整 diagnostic/detail 保持原样，属性面板提供折叠技术详情和诊断复制，不把原始 Entity 矩阵送到视口消息。相同 SelectionRequest 的属性刷新保留用户当前页签与技术详情展开状态，新对象选择仍重置展示；这属于 UI 展示状态，不改变选择提交权或缓存语义。

DEV 导出前和静态 GLB 模板恢复时检查有限值与包围盒跨度，复用场景既有 500 m 跨度上限，不按设备名称选择规则。异常源矩阵不会被 clamp 或静默删除；导出失败进入现有 failed 路径，不发布正常 GLB 或完整几何版本。运行时仍在应用 occurrence 变换后执行原包围盒守卫。样本验收分别统计候选可恢复、实际提交与异常拒绝 occurrence，不能以文件存在代替显示成功。

XML 烘焙按可见根记录失败明细：每条保留来源 MOD 路径、根 Entity id 及其未解析依赖的 id 与原因，随 DEV 诊断以 `failedVisibleRoots`/`failedVisibleRootCount` 上报，每个 DEV 最多保留 64 条；Boolean 被简化求值的数量记为 `simplifiedBooleans`。这些明细只描述源内求值结果，不改变条目的 partial/unsupported/failed 终态，也不替代 DEV 级来源原因。

| 条目状态 | 含义 |
|---|---|
| `glb` | 可恢复几何 |
| `partial` | 有可渲染部分，同时有未覆盖来源 |
| `empty` | 源内容没有自有可渲染几何，允许零字节标记 |
| `unsupported` | 源存在但当前能力不支持，不能算 empty |
| `source-invalid` | 有类型的确定性源几何异常，零字节且保留来源诊断；禁止渲染，按 SHA/几何版本重新评估 |
| 运行失败 | 读取/编译异常；不是可接受的完整性终态 |

二进制批读 `batch_read_glb_files` 使用 GIMR 协议；当前批量上限为 256 文件或估算 64 MiB。内部 IR 区分 XmlModDocument、primitive、DEV/PHM 模板、引用边、装配路径和场景资源。类型定义以 [powerline-core 的 geometry/ir.ts](../packages/powerline-core/src/geometry/ir.ts) 为准；[desktop 同名文件](../desktop/src/gim/geometry/ir.ts) 只是兼容转发出口，不含定义。格式契约见 [几何模型](schema/geometry-model.md)。

## 线路运行时

[line CBM core](../desktop/src/gim/lineCbmParserCore.ts) 与[line 属性 core](../desktop/src/gim/lineAttrParserCore.ts) 用于 Worker 解析。同一任务共享文本缓存，保留源引用、引用类型、子节点顺序和 FAM/DEV 来源。大型 MOD 使用原生元数据或按需读取，避免把不需要的大文本重复传给 JS。

线路图是可共享节点的有向图。树是它的展示投影，不通过复制节点制造新的塔位。入库使用 begin/chunks/finish，finish 才提交有效 parser 标记；失败或取消的半成品不可作为合法缓存。缓存恢复包不完整时重建，不能用部分 graph 冒充完整工程。

地图数据从有效 BLHA 提取 `[longitude, latitude]` 和高程等源值。导线挂点、跨越与杆塔坐标的角色分别保存，同塔跳线不构造虚假跨塔档。MapLibre、Canvas、树和搜索共用对象选择状态。弧垂为当前视觉近似，工程语义边界见 [线路 MOD](schema/powerline-mod.md)。

## 变电首次解析实验

桌面 `gim-debug-substation-early-semantic=1` 启用默认关闭的 7z 单遍 job；默认路径仍完整解压后解析。job 先处理无 stream 条目和独立的 core-only folder，不改变同一个 solid folder 内的解码顺序，也不重复解码其前缀。core 输入为 CBM/FAM/DEV，含 FileDevRelation.cbm。

early 请求先调用 Native `inspect_substation_early_eligibility`：能力结果包含 archive/folder、core stream/empty 数、core-only folders 和预计 checkpoint 字节/物理位置。只有 GS 7z 且 checkpoint 后仍保留超过总 decoded bytes 1% 的来源才进入 early job；这个保守收益界限不是耗时预测。明确的非 GS 7z、无 core、无 checkpoint 收益返回 capability absence，使用原完整 native extraction。路径/重复条目、配额、CRC/decode、来源 SHA/工程身份、staging/publication 错误仍是错误，不能以字符串匹配降级为能力缺失或转用 WASM。完整 native fallback 同样校验来源绑定，并在 commit 前复核 SHA。未知的 negative capability 也拒绝 fallback。正式 default policy 尚未通过跨样本及关闭门禁，保持关闭；debug override 只请求实验，不决定 eligibility。


`start_substation_extraction → semanticReady → complete / failed / cancelled` 与正式缓存发布分开。早期 File 输入来自同次解码的原字节副本，只能在本次工程会话内使用；其余文件必须等实际 materialize 后读取。首个完整 IFC 的坐标锚点契约保持。准备期间可查看语义与属性，设备定位会明确提示源几何尚在准备。

job 的 staging 只有全部条目通过路径、配额、大小和解码校验、源 SHA 保持、任务未取消后才由现有原子 commit 发布。v26 索引持久化还须等待 source completion。关闭和新 job 会撤销旧任务的发布权；实验读取按最多 64 KiB 的解码单元检查取消。Source completion 后采用既有有界 batch hydration 准备引用文本，避免逐条 job IPC。

独立的 `gim-debug-substation-parse-copy=1` 为完整解压路径生成连续小文件加速副本；原文件仍独立落盘，副本不是权威源、不进入 v26 必需来源。副本校验包括本次提取 receipt 的大小与 SHA、路径/长度/区间及完整覆盖；失败退回 batch hydration。early job 的可选副本失败则等待完整 materialization 后使用原批量路径。`gim-debug-substation-extraction-trace=1` 仅记录完整解压的逐条时序和虚拟 checkpoint，不提前返回 command。

## 当前缓存域

下表是文档中唯一的版本定义表。修改持久化含义时只失效受影响域，实际常量以链接源码为准。

| 域 | 当前契约 | 权威定义 | 校验与失效范围 |
|---|---|---|---|
| 线路语义 | `gim-line-parser-v1` | [db.rs](../desktop/src-tauri/src/db.rs) | 源 SHA、完整事务、graph/属性 |
| 变电语义 | `gim-substation-parser-v26` | [db.rs](../desktop/src-tauri/src/db.rs) | 原始属性、语义引用及索引发布凭据 |
| DEV 几何 | `geometry-cache-v12-mirrored-assembly` | [db.rs](../desktop/src-tauri/src/db.rs)、[DEV 目录](../desktop/src/services/devSpatialCatalog.ts) | occurrence 引用、manifest 和 GLB |
| 设备 LOD 派生 | `geometry-cache-v12-mirrored-assembly` 组合 `dev-spatial-catalog-v2`；有源 SHA 的浏览器上下文使用 IndexedDB `gim-dev-lod-v1` | [DEV 目录](../desktop/src/services/devSpatialCatalog.ts)、[LOD 缓存](../desktop/bridge/devLodCache.ts)、[db.rs](../desktop/src-tauri/src/db.rs) | 源 SHA、DEV 路径、几何版本与 LOD；`templates`/`catalog` 逐条原子提交，局部命中有效，不写整工程完整几何标记；合法语义和 IFC 缓存独立保留 |
| Spatial snapshot | `substation-spatial-semantic-v2` | [快照服务](../desktop/src/services/substationSpatialSemanticCache.ts) | 源、链接和序列化结构 |
| IFC Spatial parser contract | `gim-substation-parser-v23` | [快照服务](../desktop/src/services/substationSpatialSemanticCache.ts) | 独立于变电语义域 |
| Fragments | `fragments-cache-v6` | [db.rs](../desktop/src-tauri/src/db.rs)、[features](../desktop/src/config/features.ts) | 源/IFC 身份及实际安装的 fragments/web-ifc 版本 |
| IFC 浏览 LOD 派生 | `bim-lod-v8` 与安装依赖组合 | [features](../desktop/src/config/features.ts)、[LOD 缓存](../desktop/bridge/ifcLodCache.ts) | 源 SHA、条目、浏览精度、单次解析及源属性策略；独立失效远景、索引、近景和属性 |
| IFC 区域模板几何 | `near-templates-v1`，附加于浏览 LOD 键 | [features](../desktop/src/config/features.ts) | 模板几何 ID 与逐对象放置；仅更新近景产物，不重建有效远景与源属性 |
| Android 线路语义 | `mobile-powerline-v3` | [移动存储](../app/src-tauri/src/storage.rs)、[领域投影](../packages/powerline-core/src/domain.ts) | 私有源 SHA/大小、业务属性范围、唯一对象、自身 FAM 跨越分类和语义表校验 |
| Android HNum 预览 | `hnum-xz-v2` | [领域定义](../packages/powerline-core/src/domain.ts) | 源 SHA、MOD 路径；文件全局唯一点号可跨 Body 连接尾部杆件，重复点号仅在当前 Body 解析 |

SQLite 共享 `gim_project`，变电表使用 `substation_*`、线路表使用 `powerline_*`。 FAM 来源记录使用 `(project_id, source_path, source_line)` 区分物理行，不用归一化键覆盖重复原文。

变电原生解压完成后返回全部已落盘条目的缓存路径。核心语义就绪且完整源文件可读时，独立发布 CBM/FAM/DEV/FileDevRelation 与 DEV/PHM 引用索引，不等待 DEV 编译、IFC Preview、Spatial 或 Fragments。发布过程只准备有界批次的小文本，不再次通过 IPC 读取 IFC 字节；WASM 回退必须先完成源文件写入，并沿用重任务协调器以免与用户精化并行争用大量资源。

`save_gim_index` 清空变电域版本与发布凭据，`save_geometry_refs` 在现有事务中最终提交版本和 `substation_index_receipt_json`。凭据记录源 SHA、语义版本及九张语义/引用表行数；恢复时校验凭据、IFC 清单、必需缓存路径、文件大小与可读性。源改变、未完成写入、删行或缺源均不能作为合法语义 HIT。空 FAM 的零字节文件有效。凭据用于完整发布与截断检测，不是逐行内容签名，也不代表 GLB、Spatial 或 Fragments 完成；变电语义旧版本独立失效，不清除其他域。

变电来源文件 validation 使用单次调用内的 `CacheValidationContext`：只规范化可信工程 root 一次，同时接受其 lexical 与 MSIX redirected canonical 两种精确路径形式；不规范化数据库 candidate 来证明归属。Windows root handle 在该调用内禁止 delete sharing，逐 entry 仍检查相对路径、工程身份、两种 root 和所有目录/文件组件的 symlink/reparse 状态，不缓存目录安全结论。路径检查通过后实际打开文件，在同一 handle 上检查 regular-file 和准确大小；Windows 最终文件以 OPEN_REPARSE_POINT 打开，拒绝检查后替换的文件链接。上下文不会跨调用或工程复用，不改变 receipt、版本或缓存发布契约。

### IFC 浏览 LOD

桌面变电 GIM 和独立 IFC 默认使用 `bim-lod`，首次加载直接转换远景 Fragments：在 Worker 拥有的输入中留空 `IFCRELVOIDSELEMENT` 记录，按 IFC 类型排除 `IFCMECHANICALFASTENER` / `IFCFASTENER`。实体 ID、字节位置、原始磁盘输入和语义身份保留；字符串与注释不参与识别。已有轮廓内洞、BRep 内洞及其他 BooleanClipping 保持原有求值。策略依据结构与类型，不依据厂商或文件名。

冷转换只初始化一个 web-ifc API，并打开一次派生模型。STEP 扫描在省略开洞关系时保留宿主与开洞的引用，单位从派生模型读取。Fragments 的几何和属性处理在同一转换 Worker 内借用这个模型，完成或异常退出后恢复 API 方法并由所有者释放。复用适配器依赖当前安装库的 API 状态布局；升级依赖时须复核初始化、坐标、模型 ID 和释放契约。

区域索引在 importer 的几何流中收集包围盒，读取共享几何模板一次；随后只补充尚未观察到的对象，包括远景排除的紧固件。web-ifc 若启用原点归一化，索引先用实际协调矩阵的逆变换还原绝对 Y-up 米坐标，再应用工程锚点，避免重复平移。

远景 Fragments 保留有几何对象的身份、名称及直接属性，并保留空间层级与包含关系。属性集、类型、材料等不在冷加载时整批序列化；远景及近景选择都通过源 IFC 按需读取并缓存这些内容。属性读取期间先显示已就绪的基础属性，读取失败明确提示，不把未加载内容当作源属性缺失。空间语义图仍由原始 IFC 构建。

顶部“IFC细节”在“自动（近景30m）”与“远景”之间即时切换，默认自动。自动模式查询当前相机视锥及 30m 范围相交的构件包围盒，包含跨区域的长构件及范围内的紧固件。只对这些宿主分析开洞；可识别的孔截面最大尺寸 ≤50mm 时省略关系，较大或无法识别的开洞保留，然后逐对象 `GetFlatMesh`。几何生成仍需首次读入并 OpenModel 整个源文件，不等于 IFC 可以按区域直接解析。

区域对象按原 GlobalId/ExpressId 拾取和读取源属性；只有唯一 GlobalId 对应的远景对象才隐藏，歧义不猜测。离开区域或切到远景时释放局部网格、恢复远景可见性。区域工作在各 IFC 间串行，最多驻留一个源 Worker；连续请求复用源模型，切换源、工程释放或空闲 30 秒后销毁；工程会话及相机请求版本拒绝过期提交。此队列仅约束区域任务，不保证与 DEV、Spatial 或远景转换全局互斥。

近景紧固件在同一次源模型会话中共享几何模板，回复按模板复制和转移一次缓冲区，避免多个对象重复复制顶点。渲染按模板和颜色合并为 InstancedMesh（仅此 IFC 浏览 LOD 近景路径使用，DEV 生产路径不采用），每个实例槽保存原 ExpressId。拾取和高亮仍对应单个源对象；选中时创建独立高亮覆盖层，不改动其他实例。镜像放置保留普通网格路径。离开区域释放未使用的 GPU 模板、材料和实例，逐对象缓存仍保留独立身份与放置。

包围盒使用 web-ifc 的绝对 Y-up 米坐标，归一化几何流的索引先逆变换恢复绝对坐标，再在查询和提交时应用首个 IFC 的真实工程协调矩阵。该矩阵通过公开坐标读取器等待完成并在会话内固定；缓存 HIT 沿用同一方法，占位单位矩阵不得覆盖真实基准。不重复轴转换或拟合研究矩阵。IFC 远景转换、区域求值和源属性读取共享一个 WASM 工作槽，DEV 模板编译可在独立 Worker 内并行。

远景 Fragments/区域索引、逐对象近景网格与属性使用独立 IndexedDB 派生缓存，键绑定源 SHA、条目路径、LOD 策略及实际安装依赖版本。远景 HIT 跳过源读取及转换；近景 HIT 跳过源模型和对象求值。原完整 Fragments 缓存域不与近似表示混用。缓存不可用回退读取源；损坏远景产物删除后重建，源 SHA 改变拒绝近景求值。该路径明确标为近似浏览表示，不能用 `allIfcReady` 证明完整开洞几何。

## 配置与加载状态

下表描述桌面配置与加载阶段。移动端默认天地图影像，Canvas 工程覆盖层先就绪，底图加载独立进行；移动生命周期与存储见 [移动端规格](mobile-spec.md)。

| 配置/状态 | 当前行为 |
|---|---|
| MapLibre | 启用；在线底图不可用时 Canvas 回退 |
| 默认底图 | OSM online；天地图为可配置能力 |
| PMTiles | 关闭 |
| 线路弧垂 | 启用视觉示意 |
| 完整 Fragments 缓存 | 默认关闭；且当前默认策略下不可达——`ifcEntryLoader` 在 `bim-lod` 下提前返回，`canUseCache` 又要求 `openingPolicy === 'full'`，而 `readIfcOpeningPolicy()` 固定返回 `bim-lod`，因此 `gim-debug-fragments-cache=1` 当前不改变实际路径（见未决事项 D-03） |
| IFC 浏览 LOD 派生缓存 | 默认使用；键绑定源、LOD 策略及安装依赖版本 |

完整 Fragments 缓存关闭时不读写该域的 `.frag`，不影响浏览 LOD 的独立派生缓存。该域只在完整路径被显式选中时才会使用；在默认 `bim-lod` 路径下开关不改变行为，不能与默认路径合并比较。

| 就绪状态 | 定义 |
|---|---|
| coreSemanticReady | 核心语义可供 UI 使用 |
| firstUsable / interactive | 首个可用 IFC 与基本交互，不代表全模型 |
| devGeometryReady | DEV 渲染管线完成，主要设备可定位；拒绝、partial、unsupported 单独记录 |
| catalogReady | 设备空间目录就绪；按 DEV 增量提交，不等待全部源解析完成 |
| currentViewReady | 锚点与目录就绪，且当前视锥内 occurrence 均已提交所需档位或已有明确终态 |
| baseRepresentationsReady | 锚点与目录就绪，且全部 occurrence 已提交表示或为 empty/unsupported 终态；基础与 partial 表示不计作完整几何 |
| allStationReady | 在基础表示就绪之上，全部 occurrence 为 empty 终态或已达到 LOD2 完整几何 |
| currentViewSettled | 相机已停稳且锚点、目录就绪，当前视锥内 occurrence 均已提交所需档位或已确定失败 |
| baseRepresentationsSettled | 锚点与目录就绪，全部 occurrence 已提交表示、为 empty/unsupported 或已确定失败 |
| selectedFineReady | 当前有效选择已唯一关联 LOD2，精细高亮及属性完成提交；另记录每次选择事件 |
| allIfcReady | 全部 IFC 加载尝试结束，失败数另列 |
| fullModelReady | DEV 管线结束，unsupported/partial 仍单独记录 |

## 安全与发布

SLD 使用白名单净化与 img 沙箱；删除脚本、事件、foreignObject 和外部资源引用，图形选择数据与原 SVG 执行环境分离。支持标签、样式和局部引用的实际规则以[sldParser](../desktop/src/gim/sldParser.ts) 为准。

解压限制路径与资源消耗；parser 数量和几何实例有上限，循环引用按分支截断并保留诊断。

桌面 npm 命令在 `desktop/` 执行，移动命令在 `app/` 执行。
`npm run build` 完成各端 TypeScript 和 Vite 构建；
`npm run tauri:build` 运行 Tauri 构建并通过 post 脚本生成 portable ZIP。
固定 WebView2 与 WASM 资产由构建脚本准备，产物类型以 Tauri 配置和脚本为准。`desktop/public/worker-bundle.js`、`libarchive.wasm`、`wasm/web-ifc*.wasm` 是随项目维护的运行时资产。 验证命令见 [验证](validation.md)，性能方法见 [性能](performance.md)。

### 设备场景提交与地图会话

DEV/PHM 累积矩阵烘焙到模板顶点时，负行列式同时修正三角形绕序。保留为 Object3D 矩阵的 occurrence 放置继续交给渲染器处理，避免重复反转。XML 材质按来源保留，不通过全局双面渲染掩盖方向错误。

设备模板缓存局部保守包围盒，实例使用放置矩阵变换包围盒；相机单轮评估复用视锥与投影临时对象。相机更新独立防抖 200 ms，目录与提交重新评估采用合并调度，不因持续提交而重置计时。场景提交按 16 ms 间隔调度，单批使用 4 ms 软预算，单个任务不能中断。相机交互期间暂缓普通提交，选中设备优先；旧表示保持到替换完成。同一 occurrence 同档请求合并，会话释放会拒绝等待中的提交。状态统计最多每 100 ms 合并刷新，仍遍历目录，尚未改为增量计数。

线路地图创建接收 AbortSignal，覆盖动态依赖加载、挂载前检查和等待 load 阶段。工程清理与底图切换取消初始化中的地图，失败或取消释放地图 DOM 和 WebGL 对象。过期创建结果不进入新工程。

项目登记在阻塞任务中执行，兼容旧路径的规范化在数据库锁外处理，重新加锁后复核记录。日志分列源路径规范化、锁等待、兼容候选数及兼容路径处理耗时。IFC 转换的补充范围收集只流式处理未观察到的紧固件，不重放全部几何。区域查询按固定工程矩阵缓存包围盒树，区域缓存按批次事务读写。DEV 来源统一经过 File.text 解码入口，Worker 保留有界解析缓存及 16 MiB primitive 缓存；计算结果移交后释放 Worker，运行时最多并行处理两倍 Worker 数量的模板任务。

默认变电导航采用功能系统投影，分类不参与物理 occurrence 收集与几何剔除。功能系统树根据任意物理层级上的 SYSTEMNAME 建立系统、电压区域与间隔分组，不将 F3 或 F4 当作业务边界。缺少中间层时直接展示下层对象；独立设备名称不提升为额外系统。装配子树中的组成部分保持原始来源，嵌套独立电气单元单独展示。FAM 仅以明确的名称/类型属性补充分类，保留原始行、分节及重复证据，冲突时显示分类证据冲突，不强行覆盖明确名称。PARTINDEX/DEV_SUBDEVICE 仅在同一归属下唯一配对时合并，相同 DEV 的多个真实引用仍保留不同路径。

模板等待队列使用可索引堆，入队、取消和提升为 O(log N)，普通任务按优先级及入队时刻排序，选中任务始终优先。LRU 的保护集合带成员修订号，缓存内容、预算与保护集合不变时跳过重复无效淘汰。Worker 计算槽和结果消费分别管理：未消费结果达到 64 MiB 或每 Worker 两条时，暂停派发普通编译；已启动任务可完成，单条结果上限 128 MiB。此阈值不是工程总内存硬上限，暖缓存读取、解析与 GPU 驻留分别记录。

原生设备派生缓存的并发读取在同一源身份下合并为最多 16 条的小批次。每批验证项目 SHA 一次、复用父目录创建与规范化结果，可变父目录的 reparse 检查和文件检查仍逐条执行，二进制回复沿用 GIMR envelope；每条上限 128 MiB、每批上限 512 MiB。损坏记录逐条回退，源身份或批次读取失败不作为合法缓存使用。磁盘目录布局与持久化键不变。

近景几何与源属性缓存使用 256 MiB 估算载荷预算、4096 条上限和单条 64 MiB 上限。容量元数据与几何在同一 IndexedDB 事务提交，访问会更新淘汰顺序；超预算时从旧条目开始淘汰，超大条目不持久化但仍可显示。数据库升级只清退没有容量账的旧近景/属性条目，保留远景 Fragments 与区域索引，以及独立语义和设备缓存。升级后的首次近景请求可能重新求值，此行为不等于源工程失效。

DEV 暖缓存读取、SHA 校验和 GLTF 解析与冷编译结果的消费共享 128 MiB 输入预算。缓存条目读取前大小未知，按单条上限预留，缓存未命中时先释放预留再编译；冷结果按实际字节申请消费额度。工程关闭拒绝排队申请，已完成任务只释放一次。此预算约束输入消费，不包含已启动 Worker 的产物、解析后的模板和 GPU 驻留；诊断中的预算值表示预留量。

Spatial 构建在来源是真实 Blob/File 时直接把不可变来源交给 Worker，由 Worker 读取字节、解码并报告阶段墙钟。磁盘 shim 保留授权的读取回退。两条路径仍使用同一 STEP 扫描和关系构建，逐文件隔离错误；这项改动减少主线程整文件驻留及跨线程字节转移，不代表已经消除了 Spatial 的重复扫描。

区域 Worker 在首次省略小孔时扫描一次 STEP 并保留开洞关系的字节范围，后续区域仅将新确认的小孔关系替换为空白，保留换行、记录 ID 与偏移。范围表只属于当前源 Worker，随源释放；同源逐批修改与重复全文件过滤的输入字节一致，不改变缓存键和几何策略。开洞策略变化后仍关闭并重新 OpenModel，此成本尚未消除。
