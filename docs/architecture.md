# 系统架构

当前实现包含 Tauri 2 桌面应用和 Android 线路应用，前端使用 TypeScript/Vite，后端使用 Rust。解析输入、业务编排、视图和持久化有独立职责。桌面变电、线路与独立设备共享容器与生命周期；设备复用 DEV 浏览运行时，Android 仍只面向线路。

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

[打开核心](../desktop/src/services/gimOpenCore.ts) 建立源 SHA、大小、magic 和工程会话。源 magic 决定类型族，GIMPKGS 根据实际 CBM 或无 CBM 时的合法 DEV 装配入口细分独立设备；裸归档必须先验证内容。缓存记录不能覆盖源事实。读取期间源发生改变时拒绝继续提交，避免用不同源版本组合索引与几何。

[设备运行时](../desktop/src/services/equipmentRuntime.ts) 读取唯一 Device CBM；没有 CBM 时校验唯一、全部 DEV 可达且无环的 DEV 装配根及实际几何引用。沿原 DEV 装配建立树，DEV 根投影为 Device，但不伪造 CBM 文件或原始字段。复用 DEV LOD、选择、属性、相机和释放逻辑。设备语义文本在本次输入中兼容解码，源文件不重写；MOD/STL 仍由既有工作集按需读取。不等待不存在的 IFC 锚点，直接采用 Z-up→Y-up 旋转；毫米到米转换仍由原几何编译器负责。重复打开复用已验证的源解压清单及版本化 DEV 派生缓存，设备树重新解析，不发布完整变电语义缓存标记。无 IFC 的合法工程层级也复用该几何启动器。

```text
选择源文件 → 身份校验 → 清理前工程 → 校验缓存
                              ├─ 合法：分域恢复
                              └─ 无效：解压 → 语义解析 → 持久化 → 渲染
```

桌面原生提取优先，WASM 用于回退或浏览器开发。条目解析统一路径分隔符、大小写和唯一文件名候选；不能固定 IFC 在某物理目录。解压执行路径与资源配额检查，不能把文件可读取等同于引用完整。

工程会话持有 generation、projectId、sourceSha256 与 geometry token。异步任务在提交状态、场景或派生缓存前验证会话，切换/关闭取消 worker 和后台队列。释放几何、材质、模型、地图和索引的所有权归当前运行时，重复清理不得产生双重释放。

Viewer 与 IFC 引擎有独立的就绪条件。`AppState.initialized` 表示视图可交互，DEV-only 设备不启动 IFC WASM 或 Fragments worker。`ifcLoader` 按持久 ViewerContext 共享 IFC 初始化 Promise；第一次需要 IFC 时才初始化，并发调用复用同一任务，失败允许下次打开重试。工程清理释放模型而保留引擎及一次注册的监听，设备与变电连续切换不会跳过 IFC 初始化或重复创建 worker。Fragments 未初始化时，清理与资源统计不访问依赖 core 的模型列表，仍释放 MOD/STL 场景与高亮。

## 选择提交权

SelectionRequest 使用请求 ID 和取消信号，覆盖属性读取、几何准备、高亮及相机动作。只有最新选择可以提交可见状态。A 的慢结果不能覆盖 B 的属性、树选择或定位。同一工程中合法的资源任务可继续复用，不能把一次选择变化当作工程失效。Fragments reset/apply 高亮通过短串行队列提交；后台 fit 不覆盖用户已经建立的选择。

IFC 的远景、区域 L1 与显式 L2 共用源对象身份；表示提交时沿同一高亮队列迁移当前选择。`addModHighlightGroup` 增量加入替换表示并只克隆替换网格的材质，`removeModHighlightGroup` 只恢复被释放组的原材质，不重置其他已选来源。实例化 L1 仅为当前选中对象准备一次高亮覆盖网格。返回浏览表示复用已有远景高亮；区域拾取没有可复用的远景高亮时，只补对应 LocalId。异步提交同时检查选择请求、工程及表示所有权，取消或旧结果不得覆盖新表示；精化提交的前置步骤成功前保留旧浏览表示。高亮迁移不读取属性、不触发几何求值、不移动相机，也不改变缓存域。

## 变电语义与 IFC

原始 CBM 属性、FAM 物理行和设计文档来源分别保存。[substationEvidence](../desktop/src/gim/substationEvidence.ts) 生成文件能力摘要、IFC 证据、PARTINDEX identity alias 与 GL sidecar 投影。摘要不决定厂商 parser 分支。语义格式与身份规则见 [语义模型](schema/semantic-model.md)。

IFC 文件发现与 IFCGUID 对象挂接独立。全局 entry resolver 解析 CBM 引用及 IFC 清单。转换在 IFC Worker 中执行，主线程仍负责 Fragments `core.load`、模型提交与交互。首个 IFC 的插入顺序是坐标锚点契约；缓存恢复保留持久化顺序，不能按文件名重新排序。

空间语义使用两遍选择性 STEP 扫描，位于独立 Spatial Worker。长期索引保留空间节点、对象、placement 闭包及关联证据；属性集、材料、类型、数量和分类按需获取。推断空间链接与直接链接保留来源和置信度，不填造确定归属。

[Spatial snapshot 服务](../desktop/src/services/substationSpatialSemanticCache.ts) 校验源、域和版本后 hydrate Map。缺失、损坏或不匹配的快照在全部 IFC 尝试完成后重建。它不替代 IFC 几何，也不覆盖变电语义缓存。

### IFC 浏览 LOD（bim-lod）

生产默认 `bim-lod`：首个可用 IFC 建立坐标锚点；其余 IFC 按源大小排序，单个超过 64 MB 的排到队尾。每个文件在 Worker 内读取单位、上下文与递归 LocalPlacement，先提交 LOD0，再提交 LOD1；对象 LOD2 由属性面板按需交给独立对象精化 Worker。普通选择和相机近距只驱动 L1 区域表示，不打开 L2。分级原因、调度边界与取舍见本文件。

属性面板中的 LOD2 请求按逻辑模型 ID 去重，并进入当前工程的用户精化优先队列，排在尚未启动的普通重任务之前。已运行的 DEV 管线在完成单个 DEV 的解析、缓存写入和全部 placement 提交后，调用协调器安全检查点；暖路径还在有界 GLB 批读完成后检查。每个检查点最多执行一个用户精化请求，保留 DEV 的重任务调度权，精化完成或失败后继续下一工作单元，不与其他受协调器管理的重任务并行。定向 raw 回退和单 DEV 缓存修复也记录安全边界；完整 manifest/version 仍在管线原有结束位置提交。单个 DEV 内部序列化和已运行的 Spatial/转换不能中途让权。工程关闭或选择切换会取消排队请求，并由原 ProjectLoadSession 释放活动 Worker。精细转换失败后可重试。按需属性查询重新读取单个 IFC，并在一次性 Worker 结束或工程关闭后释放。不同文件的 LOD2 与一次性属性读取仍可能短暂并行，不保证全工程只有一个 WASM heap。资源事件和进程内存采样用于观测生命周期，Fragments 转换 WASM heap 的精确值仍不由当前公开 API 暴露。

| 级别 | 当前表示与边界 |
|---|---|
| LOD0 | 显式 IfcBoundingBox 或支持拉伸体的局部包围盒，保留放置方向；开孔等 subtractive feature 不生成正向代理 |
| LOD1 | IfcExtrudedAreaSolid 的矩形/闭合折线轮廓棱柱；IfcBooleanClippingResult 递归取 FirstOperand，明确省略裁剪；凹轮廓采用 earcut 封口；无法提供棱柱的对象仍标 LOD0 |
| LOD2 | 属性面板显式请求的单对象 `web-ifc` 精化；独立 Worker 读取原 IFC，成功后替换该对象的 L1 区域表示 |

源坐标使用 IfcProject 长度单位、representation context、递归 LocalPlacement（含 Site 父链）及 solid/profile 放置；矩阵为列主序，先源放置、再单位缩放、再现有工程 source-to-viewer 锚点。metadata-derived 原点仅用于 Float32 精度，根矩阵抵消该平移。禁止使用研究 benchmark 的真值拟合 T；MapConversion、mapped/BRep 主体和其他未覆盖轮廓保留诊断，由 LOD2 处理，不推断空间含义。

LOD0/L1 当前沿用带原始 ExpressId、GlobalId、来源路径和放置矩阵的逐对象/分批表示；不把尚未经过固定路线 draw-call 验收的 InstancedMesh 作为默认产品路径。实例化只允许在具备可靠模板、材质和 occurrence 身份映射的受控试点中使用，镜像、特殊材质或身份无法核对时回退现有路径；只有固定路线 draw calls 至少下降 30% 且帧耗时不回退，试点才可进入默认配置。常规 LOD1 保留分批合并网格和三角面 → ExpressId 映射，高亮使用独立覆盖层。同一 SelectionRequest 沿用至精细表示；属性异步结果和精细高亮提交均检查最新选择/工程会话。精细模型可用后移除预览并释放 metadata Worker；metadata 的释放独立于旧 SelectionRequest 的提交资格。按原 GlobalId 查询精细 LocalId 时，使用 Fragments 公开的 item/GUID 反向查询核对唯一性，避免单值 GUID Map 掩盖重复对象；仅唯一候选可以提升，坐标诊断采用相同约束。无唯一关联时保留原语义选择和未关联/歧义状态，不猜第一个对象。工程切换立即释放 Worker、网格和材质。LOD2 替换诊断对同一 GlobalId 记录首个 IFC 锚点、实际协调矩阵、工程变换、预览世界矩阵、Fragments 世界矩阵/位置/包围盒差值；诊断不拟合或修改矩阵，必须由真实桌面样本验收确认空间等价。预览不持久化，不改变现有缓存域版本。

IFC 的显式 LOD2 由属性面板调度隔离的 `IfcObjectFineRuntime`，在其 Worker 内打开原 IFC 并提取单个对象；它只替换当前对象的 L1 区域表示，旧表示在精化成功前保留。屏幕空间自动切换仍只负责 L1 区域浏览，不能隐式进入 L2。局部对象计时和坐标核验不能替代完整工程的实际拾取、后台资源竞争与持续交互验收。

IFC 转换的进度、连接线批次、连接线完成及最终产物消费回调属于同一任务的结算边界；同步消费异常立即结束所属 Worker 并释放计算 gate，不能让后续 IFC 等待无进度超时。结算后的迟到消息不再消费，成功、失败或会话取消均只释放一次；不在主线程自动重试同步转换。导航 DOM 就绪、首个有效三维画面及各基础表示完成分别记录，导航 DOM 时间点不充当输入响应验收。

DEV GPU 批次与源网格由独立 WeakSet 区分；整站总览范围只消费原 occurrence 网格，避免将批次的模板局部范围再次计入场景并改变中位尺寸过滤和相机目标。该标记不依赖源 userData，也不更改几何或持久化契约。

## DEV 编译、模板与 occurrence

[MOD 编排服务](../desktop/src/services/modAutoLoadService.ts) 从物理根建立独立 occurrence，模板身份使用规范化 DEV 路径；实例身份包括 CBM 物理根与装配/引用路径。PARTINDEX 和 DEV_SUBDEVICE 是语义投影，不生成第二套 seed。

PHM 根据引用扩展名递归，逐边累积矩阵，按当前分支防环。相同模板在不同路径的合法重复出现保留；不能使用全局 visited 集合删除实例。父语义节点的 alias 只在其物理装配子树内查候选，身份优先，歧义保留。

设备模板只包含 Entity、DEV/SUBDEVICE、PHM 逐边变换及毫米到米转换；放置根统一应用 `projectSourceToViewer × CBM累积矩阵（平移转米）`，每项各应用一次。冷编译和暖恢复消费同一物理 occurrence 及放置函数，不通过整体偏移或独立居中校准。首个 IFC 锚点由 [公开坐标读取器](../desktop/src/viewer/ifcCoordinateAnchor.ts) 等待 `model.getCoordinates()` 的实际结果构造，避免 Fragments 在异步查询完成前缓存并返回的占位单位矩阵。合法单位矩阵仍被接受，工程切换后旧查询不能提交。区域 IFC 查询和设备放置保持同一工程基准。

同一 DEV、源 SHA 和 LOD 在会话内共享不可变 geometry/material，每个 occurrence 保留独立节点层级和变换；placement 不烘焙回模板。DEV 默认仍采用普通 Mesh，模板校验拒绝带动画、实例化网格或非法几何的 GLB。独立的 `DevInstanceBatches` 试点在放置后组合相同几何、材质及绘制属性的至少三个 L0/L1 网格，保留原 occurrence 层级、包围盒和身份，仅管理实例缓冲；显式 L2 保持普通网格。镜像、剪切、透明、特殊材质与渲染钩子回退普通绘制。实例矩阵使用原网格相对批次根的实际变换，不更改源坐标或模板；显隐和锚点变化时同步，选中网格临时退出批次并使用原高亮路径。拾取将 instanceId 映射回原 occurrence/instanceKey；模型树关联不唯一时展示候选，不自动选取第一个节点。实例化关闭时，普通 DEV placement 使用已提交表示的包围盒先筛选射线候选，直接遍历 occurrence 行并保留原身份；LOD 提交或坐标锚点变化时更新范围，未知范围继续参与精确拾取。隐藏祖先和子组在网格射线前排除，不为每次点击构建全量网格及归属数组。缓冲构建失败恢复原网格并停止重试该批次，释放不销毁共享模板几何或材质。试点默认关闭，原生固定路线和绘制收益未验收，不改变缓存格式或版本。IFC 浏览 LOD 的近景紧固件实例化保持原路径。

所有物理设备默认自动生成实际参数描述的基础表示，视野外和小投影使用 LOD0，不以点树作为显示前提。范围未确定的设备也自动编译可支持几何，保留范围诊断，不用虚构包围盒剔除或替代实体。原始来源为空、不支持或失败时明确记录状态，不能伪造设备。

可见设备按包围盒距离和投影像素在 L0/L1 之间切换：选中对象只提高当前基础表示的优先级，不强制 L2；距离和投影满足 L1 条件时进入 L1，视野外回到 L0。自动策略只返回 L0/L1：不可见对象一律 L0；可见对象按投影包围盒宽高较大值判断，首次进入 L1 需 ≥40 px，已是 L1 时 ≥30 px 保持、低于 30 px 回 L0；像素值上限为视口较大边的 2 倍。选中、搜索定位与相机靠近只提高当前基础表示优先级，不改变自动策略的 L0/L1 上限。L2 由属性面板的显式精化请求进入，取消精化或离开选择后释放。相机停稳 200 ms 后更新，选择立即排队。新表示完成前保留旧表示，所有档位使用同一身份、属性和高亮。

设备目录通过参数和源装配矩阵构建，不依赖三角化或 GLB；STL 扫描顶点范围，Boolean 使用保守范围，未知类型保留 unknown。目录按 DEV 记录包围盒质量（保守 / 未知 / 空）、图元类型计数与去重后的未支持类型清单，并分别统计拉伸解释模式分布与绝对半径圆台的实例数。STL 只在符合标准二进制或 ASCII 布局时给出范围；私有方言与无法校验的布局显式记为范围未知，仍参与自动基础表示而不被剔除。以上计数只描述源内解释结果，不代表场景已渲染或条目终态。目录增量提交，按唯一 DEV 复用。模板以 `DEV_GEOMETRY_VERSION|源身份|DEV 路径(小写)|lodN` 为键，目录以 `DEV_SPATIAL_CATALOG_VERSION|DEV_GEOMETRY_VERSION|源身份|DEV 路径(小写)` 为键；两者都包含几何版本，语义、Spatial、Fragments 与 IFC 域独立失效。模板逐条原子落盘；部分合法缓存可直接恢复，不写旧的全站完整几何标记。128 MiB 模板 LRU 按实际顶点/索引缓冲区计量，正在显示和选中的模板受保护，可使驻留值超过软预算；未使用模板被淘汰并释放。

Viewer 创建后即启动设备编译，编译与 IFC 锚点无关，场景提交等待真实锚点。DEV Worker 池按逻辑核数约 60% 取 2–8 个；IFC 未完成时最多同时运行两个 DEV 编译，首个 IFC 完成后释放到整个池上限。全局仍只允许一个 IFC WASM 工作单元。Worker 返回结果后释放计算槽，未消费 GLB 由独立结果计数/字节预算约束，消费确认后再释放结果额度。每个 Worker 的来源字节、解码文本、XML IR、DEV/PHM IR 缓存分别受 64、32、48、12 MiB 有界预算约束；每份驻留文档复用校验和解析结果，几何临时资源在导出后释放。选择、当前视图缺少的基础表示、可见细节、全站其余基础表示依次调度；轻量范围构建优先于普通几何任务，等待任务逐步提升优先级，防止后台基础表示饥饿。工程会话、请求 ID 和模板键共同拒绝旧结果。

内存中的不可变 File 通过结构化克隆交给 Worker 直接读取，保留共享的 Blob 后备存储，避免逐文件经过主线程。磁盘惰性 File 仍使用受源身份和路径校验保护的 IPC。模板读取/解析也受有界队列限制，正在创建 placement 的模板受 LRU 保护。原生索引提交、缓存校验及设备派生产物 I/O 在后台线程执行，保持原有事务、源校验、路径防护和原子替换条件。

状态栏独立显示已处理几何实例、实际显示与失败数，以及当前视图、基础表示和精化阶段，不被并行 IFC 提示覆盖；悬停查看设备范围索引、模板编译、缓存、淘汰、部分表示、活动设备、Worker 等待快照和可用 JS heap 压力。计数以 occurrence 为单位并按状态去重，模板任务数量另计。currentViewSettled/baseRepresentationsSettled 包含已结束失败，currentViewReady/baseRepresentationsReady 保留成功语义，allStationReady 仍只描述全部 occurrence 都达到 L2 或合法空终态，不作为普通浏览总览完成条件；失败结束不能永久显示准备中，也不计作成功。设备失败原因码包括 `empty-device-xml`、`assembly-node-without-own-geometry`、`dev-no-solidmodel`、`phm-no-solidmodel`、`parser-unsupported`、`missing-dependency`、`source-invalid` 与 `parse-failed`；未知 primitive 计入 unsupported，不并入 empty。临时失败可通过明确选择重试，确定性 source-invalid 按源证据隔离并缓存，旧档位失败不能污染新请求。阶段耗时包含读取/RPC、解码、校验、解析、primitive、Boolean、合并、导出与提交；Worker elapsed 是墙钟时间。

GLB 恢复校验 manifest、源身份、条目状态和文件完整性。单 DEV 文件失败可局部回退原始几何；manifest 无效使几何域失效，不要求删除有效语义域。完成标记只在所有目标条目形成确定状态后提交，瞬时失败不能写为完整版本。确定性 source-invalid 可与其他确定结果共同发布结构有效的缓存，暖恢复不读取其 GLB 或重试 raw；结构有效不等于所有几何显示，fullModelReady 诊断明确记录拒绝数及 geometryFullyRendered。

source-invalid 的普通选择提示仅解释已跳过渲染、属性与来源仍可查看。完整 diagnostic/detail 保持原样，属性面板提供折叠技术详情和诊断复制，不把原始 Entity 矩阵送到视口消息。相同 SelectionRequest 的属性刷新保留用户当前页签与技术详情展开状态，新对象选择仍重置展示；这属于 UI 展示状态，不改变选择提交权或缓存语义。

选择消息由 `selectionMessage` 校验当前 SelectionRequest 后写入选择状态栏，不复用工程打开的 `showLoading` 回调，不创建加载浮层、进度计时或 project busy 项。`loadModStlForNode` 只接受会话与请求身份，不再接受加载消息回调；DEV 无关联/多义来源提示同样只更新选择状态。来源异常仍显示真实原因，旧请求的迟到消息不得改写新选择。

已知 DEV occurrence 的选择查询通过运行时 row 取得当前已加载根，仅遍历该装配子树并保留来源与装配路径筛选；无运行时、根尚未加载或无 scope 时沿用原始几何集合查询。根查询不新增索引、不触发精化，LOD 替换与会话结束由原 row 所有权处理。选择的导航、属性摘要/参数、几何收集、高亮提交及相机定位沿现有有界性能 span 关联请求；子段为 `selection.navigation.imports`、`selection.navigation.tree`、`selection.navigation.sldLookup`、`selection.navigation.sldCommit`，其中导入段是墙钟等待，外层跨度还包含调用方恢复等间隙，各阶段可能重叠，不相加作为 CPU 或 GPU 时间。

选择导航的动态 UI/单线图模块按页面复用首次成功的导入 Promise，不缓存工程或选择数据；导入失败释放该 Promise，每次恢复执行后仍检查当前请求。导航诊断细分为依赖 Promise 完成、树同步、单线图索引查询与高亮提交，外层跨度还包含调用方恢复等间隙，不能把内层计时当作完整输入延迟。

上一视角最多保留 20 个会话内相机目的地/可见性快照。普通相机更新按 220 ms 防抖记录，主动返回先结算待记录移动，恢复成功后才消耗历史并恢复筛选；失败保留重试入口。取消返回时先按实际位置/目标做一次非动画定位再 `stop()`，因为 CameraControls 3.1.2 的 `stop()` 会跳回旧目的地；历史仍受抑制时用 `update(0)` 消费控制器末次更新。重复返回不并发弹栈，手动控制、工程清空和释放取消所属运动，代次守卫阻止旧完成；新目的地或新筛选覆盖旧返回时保留新动作。菜单失败只写普通状态，工程或选择改变后拒绝旧反馈。四站定向对照记录在 [性能](performance.md)。

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

桌面 `gim-debug-substation-early-semantic=1` 启用默认关闭的 7z 单遍 job；默认路径仍完整解压后解析。job 先处理无 stream 条目和独立的 core-only folder，不改变同一个 solid folder 内的解码顺序，也不重复解码其前缀。core 输入为 CBM/FAM/DEV，含 FileDevRelation.cbm。该路径仅保留用于调试，不再作为默认发布策略；常规冷启动解压由内嵌 7-Zip 流式路径承担（见“安全与发布”）。

early 请求先调用 Native `inspect_substation_early_eligibility`：能力结果包含 archive/folder、core stream/empty 数、core-only folders 和预计 checkpoint 字节/物理位置。只有 GS 7z 且 checkpoint 后仍保留超过总 decoded bytes 1% 的来源才进入 early job；这个保守收益界限不是耗时预测。明确的非 GS 7z、无 core、无 checkpoint 收益返回 capability absence，使用原完整 native extraction。路径/重复条目、配额、CRC/decode、来源 SHA/工程身份、staging/publication 错误仍是错误，不能以字符串匹配降级为能力缺失或转用 WASM。完整 native fallback 同样校验来源绑定，并在 commit 前复核 SHA。未知的 negative capability 也拒绝 fallback。正式 default policy 尚未通过跨样本及关闭门禁，保持关闭；debug override 只请求实验，不决定 eligibility。


`start_substation_extraction → semanticReady → complete / failed / cancelled` 与正式缓存发布分开。早期 File 输入来自同次解码的原字节副本，只能在本次工程会话内使用；其余文件必须等实际 materialize 后读取。首个完整 IFC 的坐标锚点契约保持。准备期间可查看语义与属性，设备定位会明确提示源几何尚在准备。

job 的 staging 只有全部条目通过路径、配额、大小和解码校验、源 SHA 保持、任务未取消后才由现有原子 commit 发布。v26 索引持久化还须等待 source completion。关闭和新 job 会撤销旧任务的发布权；实验读取按最多 64 KiB 的解码单元检查取消。Source completion 后采用既有有界 batch hydration 准备引用文本，避免逐条 job IPC。

独立的 `gim-debug-substation-parse-copy=1` 为完整解压路径生成连续小文件加速副本；原文件仍独立落盘，副本不是权威源、不进入 v26 必需来源。副本校验包括本次提取 receipt 的大小与 SHA、路径/长度/区间及完整覆盖；失败退回 batch hydration。early job 的可选副本失败则等待完整 materialization 后使用原批量路径。`gim-debug-substation-extraction-trace=1` 仅记录完整解压的逐条时序和虚拟 checkpoint，不提前返回 command。

变电原生解压把非 IFC 条目连续写入 `.gim-substation-source.pack` 并生成 `.gim-substation-source.index`（path → offset/size），IFC 仍逐条落盘，因为缓存校验、尺寸比对和 web-ifc 读取依赖独立路径。读取时 `read_cached_entry`/`batch_read_cached_files` 先按索引区间懒取，命中 pack 就跳过逐条路径解析与 reparse 检查。3.6 万条目的样本因此只需创建 13 个文件：写入阶段从约 40 s 的逐条 create/open 降到 0.5 s，暖校验也不再逐条 open。首次解析前的 hydration 只物化 CBM/DEV/FAM 语义文本（每批 2048 条），PHM/MOD/STL 由几何管线按需从 pack 读取；发布凭据把 pack 成员作为合法已缓存来源，缺失的 IFC 或未打包文件仍按原规则处理。

### DEV 派生缺失时的源准备

会话从现有语义 entries 恢复源大小，工程释放时清空。正常目录首批（最多 64 键）全部明确 miss 时，异步准备已知大小的 DEV/PHM/MOD/STL/GL File 工作集，不额外探测目录、不占计算 gate。单源最多 8 MiB，普通批次最多 4 MiB / 4096 源，总额度 128 MiB；高/临界压力停止，可选源准备 10 秒超时后保留受权懒读，原生在途读取不宣称已取消。catalog 批读的明确 miss/invalid/read-error 交回原有分支复用，不为同一 miss 重读；`deferred` 仍按需重读。沿用最多 8 秒 IFC 让步，Worker/基础任务不等待最后一个 IFC。

暖恢复只有个别模板明确 miss/invalid 时，沿该 DEV 的实际引用批量准备可达源，不扩大为整站预取。该补偿路径每源最多 8 MiB、批次目标 4 MiB、会话累计准入 32 MiB；高/临界压力停止，每批 5 秒超时回到原懒读。DEV/PHM 从已读取字节直接解码供引用遍历，MOD/STL 不在主线程解析；不可变 File 交给 Worker。健康模板命中不走此路径，工程和当前请求有效性在准备后复核，不宣称取消已发出的原生读取。

目录完整而至少 min(32, DEV 源数) 个不同 L0 键明确 miss、并记录至少 32 次源 RPC 时，仅对全部已知且总量不超过 32 MiB 的来源尝试一次运行中升级。不可变 File 补发到现有池，不终止健康活动任务、不清空解析缓存；旧会话不安装迟到结果。未知、过大、损坏或失败来源仍走真实诊断及懒读。此机制不改变坐标链、模板身份、持久化格式和缓存版本。性能边界及未达目标见 [问题与限制](open-issues.md) O-02。

## 当前缓存域

下表是文档中唯一的版本定义表。修改持久化含义时只失效受影响域，实际常量以链接源码为准。

| 域 | 当前契约 | 权威定义 | 校验与失效范围 |
|---|---|---|---|
| 线路语义 | `gim-line-parser-v1` | [db.rs](../desktop/src-tauri/src/db.rs) | 源 SHA、完整事务、graph/属性 |
| 变电语义 | `gim-substation-parser-v26` | [db.rs](../desktop/src-tauri/src/db.rs) | 原始属性、语义引用及索引发布凭据 |
| DEV 几何 | `geometry-cache-v16-phm-solids` | [db.rs](../desktop/src-tauri/src/db.rs)、[DEV 目录](../desktop/src/services/devSpatialCatalog.ts) | occurrence 引用、manifest 和 GLB |
| 设备 LOD 派生 | `geometry-cache-v16-phm-solids` 组合 `dev-spatial-catalog-v2`；有源 SHA 的浏览器上下文使用 IndexedDB `gim-dev-lod-v1` | [DEV 目录](../desktop/src/services/devSpatialCatalog.ts)、[LOD 缓存](../desktop/bridge/devLodCache.ts)、[db.rs](../desktop/src-tauri/src/db.rs) | 源 SHA、DEV 路径、几何版本与 LOD；`templates`/`catalog` 逐条原子提交，局部命中有效，不写整工程完整几何标记；合法语义和 IFC 缓存独立保留 |
| Spatial snapshot | `substation-spatial-semantic-v3` | [快照服务](../desktop/src/services/substationSpatialSemanticCache.ts) | 精确大小写身份与洞口/填充宿主链 |
| IFC Spatial parser contract | `gim-substation-parser-v24` | [快照服务](../desktop/src/services/substationSpatialSemanticCache.ts) | 独立于变电语义域 |
| 业务树派生快照 | `business-snapshot-v3` / `business-tree-v5` | [业务缓存](../desktop/src/services/businessTreeCache.ts)、[领域模型](../desktop/src/gim/businessTree.ts) | 源 SHA、原生返回的当前变电语义契约、Spatial 契约、IFC 模型清单摘要、完整标记、压缩/展开长度及内容 SHA；只重建业务域，不新增 SQLite 表 |
| Fragments | `fragments-cache-v6` | [db.rs](../desktop/src-tauri/src/db.rs)、[features](../desktop/src/config/features.ts) | 源/IFC 身份及实际安装的 fragments/web-ifc 版本 |
| IFC 浏览 LOD 派生 | `bim-lod-v8` 与安装依赖组合；浏览器上下文固定使用 IndexedDB `gim-ifc-lod-v1` | [features](../desktop/src/config/features.ts)、[LOD 缓存](../desktop/bridge/ifcLodCache.ts) | 源 SHA、条目、浏览精度、单次解析及源属性策略；独立失效远景、索引、近景和属性 |
| IFC 区域模板几何 | `near-templates-v1`，附加于浏览 LOD 键 | [features](../desktop/src/config/features.ts) | 模板几何 ID 与逐对象放置；仅更新近景产物，不重建有效远景与源属性 |
| Android 线路语义 | `mobile-powerline-v3` | [移动存储](../app/src-tauri/src/storage.rs)、[领域投影](../packages/powerline-core/src/domain.ts) | 私有源 SHA/大小、业务属性范围、唯一对象、自身 FAM 跨越分类和语义表校验 |
| Android HNum 预览 | `hnum-xz-v2` | [领域定义](../packages/powerline-core/src/domain.ts) | 源 SHA、MOD 路径；文件全局唯一点号可跨 Body 连接尾部杆件，重复点号仅在当前 Body 解析 |

SQLite 共享 `gim_project`，变电表使用 `substation_*`、线路表使用 `powerline_*`。 FAM 来源记录使用 `(project_id, source_path, source_line)` 区分物理行，不用归一化键覆盖重复原文。

变电原生解压完成后返回全部已落盘条目的缓存路径。首个可用 IFC 后，剩余 IFC 按源大小排序；单个超过 64 MB 的 IFC 默认排到队尾并完整加载，避免小模型被超大文件的冷转换拖住；设置项 `ifc.skipLargeFiles` 开启后跳过非关键超大文件，规则见“配置与加载状态”。DEV 模板编译使用独立 Worker 池，按 CPU 核数自动选择 2–8 个（`gim-dev-workers` 可覆盖），冷路径的几何源预取在剩余 IFC 未结束前最多等待 8 秒，之后与 IFC 并行。核心语义就绪且完整源文件可读时，按两阶段发布索引，不等待 DEV 编译、Spatial 或 Fragments：第一阶段只使用内存中的 CBM 树、IFC 清单和 FileDevRelation 写入 entries/树/IFC/关系，并用空的引用链提交版本与 receipt（本机交互后约 2–5 s 完成，暖启动立即可用）；第二阶段在后台解析 FAM/DEV 属性，在单事务中替换两张属性表、重算 receipt 并置 `substation_properties_complete=1`。几何引用链（DEV→SOLIDMODEL→PHM/MOD）第二阶段暂不重解析：它与属性解析重复读取同一批 DEV/PHM，暖启动几何按源文件回退解析仍是正确路径，只少一层 SQL 加速。若第二阶段被中断（关闭或切换工程），第一阶段缓存仍有效，下次暖启动检测到标记为 0 时用已解压源补写。状态栏显示“索引发布中 → 暖启动已就绪 · 属性补写中 → 索引已发布”，失败保留原因供悬停查看。发布过程只准备有界批次的小文本，不再次通过 IPC 读取 IFC 字节；WASM 回退必须先完成源文件写入，并沿用重任务协调器以免与用户精化并行争用大量资源。

`save_gim_index` 清空变电域版本、发布凭据与 `substation_properties_complete`；核心阶段用 `save_geometry_refs` 的空引用提交版本和 `substation_index_receipt_json`；第二阶段 `save_substation_semantic_rest` 在同一事务内补写属性（可同时写引用，当前传空）并刷新凭据。凭据记录源 SHA、语义版本及九张语义/引用表行数；恢复时校验凭据、IFC 清单、必需缓存路径、文件大小与可读性。源改变、未完成写入、删行或缺源均不能作为合法语义 HIT。空 FAM 的零字节文件有效。凭据用于完整发布与截断检测，不是逐行内容签名，也不代表 GLB、Spatial 或 Fragments 完成；变电语义旧版本独立失效，不清除其他域。

变电来源文件 validation 使用单次调用内的 `CacheValidationContext`：只规范化可信工程 root 一次，同时接受其 lexical 与 MSIX redirected canonical 两种精确路径形式；不规范化数据库 candidate 来证明归属。Windows root handle 在该调用内禁止 delete sharing，逐 entry 仍检查相对路径、工程身份、两种 root 和所有目录/文件组件的 symlink/reparse 状态，不缓存目录安全结论。路径检查通过后实际打开文件，在同一 handle 上检查 regular-file 和准确大小；Windows 最终文件以 OPEN_REPARSE_POINT 打开，拒绝检查后替换的文件链接。上下文不会跨调用或工程复用，不改变 receipt、版本或缓存发布契约。

### IFC 浏览 LOD

桌面变电 GIM 和独立 IFC 默认使用 `bim-lod`，首次加载直接转换远景 Fragments：在 Worker 拥有的输入中留空 `IFCRELVOIDSELEMENT` 记录，按 IFC 类型排除 `IFCMECHANICALFASTENER` / `IFCFASTENER`。实体 ID、字节位置、原始磁盘输入和语义身份保留；字符串与注释不参与识别。已有轮廓内洞、BRep 内洞及其他 BooleanClipping 保持原有求值。策略依据结构与类型，不依据厂商或文件名。

冷转换只初始化一个 web-ifc API，并打开一次派生模型。STEP 扫描在省略开洞关系时保留宿主与开洞的引用，单位从派生模型读取。Fragments 的几何和属性处理在同一转换 Worker 内借用这个模型，完成或异常退出后恢复 API 方法并由所有者释放。复用适配器依赖当前安装库的 API 状态布局；升级依赖时须复核初始化、坐标、模型 ID 和释放契约。

区域索引在 importer 的几何流中收集包围盒，读取共享几何模板一次；随后只补充尚未观察到的对象，包括远景排除的紧固件。web-ifc 若启用原点归一化，索引先用实际协调矩阵的逆变换还原绝对 Y-up 米坐标，再应用工程锚点，避免重复平移。

远景 Fragments 保留有几何对象的身份、名称及直接属性，并保留空间层级与包含关系。属性集、类型、材料等不在冷加载时整批序列化；远景及近景选择都通过源 IFC 按需读取并缓存这些内容。属性读取期间先显示已就绪的基础属性，读取失败明确提示，不把未加载内容当作源属性缺失。空间语义图仍由原始 IFC 构建。

顶部“IFC细节”在“自动（近景30m）”与“远景”之间即时切换，默认自动。自动模式查询当前相机视锥及 30m 范围相交的构件包围盒，包含跨区域的长构件及范围内的紧固件。只对这些宿主分析开洞；可识别的孔截面最大尺寸 ≤50mm 时省略关系，较大或无法识别的开洞保留，然后逐对象 `GetFlatMesh`。几何生成仍需首次读入并 OpenModel 整个源文件，不等于 IFC 可以按区域直接解析。

区域对象按原 GlobalId/ExpressId 拾取和读取源属性；只有唯一 GlobalId 对应的远景对象才隐藏，歧义不猜测。离开区域或切到远景时释放局部网格、恢复远景可见性。区域工作在各 IFC 间串行，最多驻留一个源 Worker；连续请求复用源模型，切换源、工程释放或空闲 30 秒后销毁；工程会话及相机请求版本拒绝过期提交。此队列仅约束区域任务，不保证与 DEV、Spatial 或远景转换全局互斥。

“仅看选中”由服务层 `selectionVisibility` 从当前请求已提交的高亮身份生成范围，统一限制 IFC 远景、区域/L2、紧固件实例和连接线增量预览；不通过空间邻近补关联，多义 GlobalId 不自动选择某一区域对象。`IfcModelVisibility` 将源图层开关、选择掩码和 L1/L2 替换掩码组合，经同一队列调用公开 Fragments 可见性 API；恢复全站保留原先隐藏的图层和对象，区域淘汰或精化取消不得重新显示范围外对象。后台新增模型与后续连接线批次沿用当前范围，定时同步不能恢复无关来源。空选择在隔离模式中保持空画面，用户可恢复全站。普通非隔离浏览跳过对象可见性枚举与额外的强制刷新；IFC 拾取始终通过公开 `getVisible` 核对命中条目，自动 L1 也会隐藏被替换的远景对象，不能仅以选择隔离或 L2 状态判断是否需要核对；隐藏源不参与拾取。工程关闭清空范围与快照。该机制不启动 L2，也不修改几何缓存域。选择保留现有的 `selection.navigation`、`selection.highlightCommit` 和 `selection.frame` 埋点，用于区分导航、高亮提交与下一帧反馈。

近景紧固件在同一次源模型会话中共享几何模板，回复按模板复制和转移一次缓冲区，避免多个对象重复复制顶点。渲染按模板和颜色合并为 InstancedMesh（仅此 IFC 浏览 LOD 近景路径使用，DEV 生产路径不采用），每个实例槽保存原 ExpressId。拾取和高亮仍对应单个源对象；选中时创建独立高亮覆盖层，不改动其他实例。镜像放置保留普通网格路径。离开区域释放未使用的 GPU 模板、材料和实例，逐对象缓存仍保留独立身份与放置。

包围盒使用 web-ifc 的绝对 Y-up 米坐标，归一化几何流的索引先逆变换恢复绝对坐标，再在查询和提交时应用首个 IFC 的真实工程协调矩阵。该矩阵通过公开坐标读取器等待完成并在会话内固定；缓存 HIT 沿用同一方法，占位单位矩阵不得覆盖真实基准。不重复轴转换或拟合研究矩阵。IFC 远景转换、区域求值和源属性读取共享一个 WASM 工作槽，DEV 模板编译可在独立 Worker 内并行。

远景 Fragments/区域索引、逐对象近景网格与属性使用独立 IndexedDB 派生缓存，键绑定源 SHA、条目路径、LOD 策略及实际安装依赖版本。远景 HIT 跳过源读取及转换；近景 HIT 跳过源模型和对象求值。原完整 Fragments 缓存域不与近似表示混用。缓存不可用回退读取源；损坏远景产物删除后重建，源 SHA 改变拒绝近景求值。该路径明确标为近似浏览表示，不能用 `allIfcReady` 证明完整开洞几何。

## 配置与加载状态

下表描述桌面配置与加载阶段。移动端默认天地图影像，Canvas 工程覆盖层先就绪，底图加载独立进行；移动生命周期与存储见 [移动端规格](mobile-spec.md)。

| 配置/状态 | 当前行为 |
|---|---|
| MapLibre | 启用；OSM 官方瓦片异常时保留地图并用 CARTO 同源栅格垫底，不整块空白/回退 Canvas |
| 默认底图 | OSM online；天地图为可配置能力 |
| PMTiles | 不支持离线瓦片；底图仅使用在线服务与 Canvas 兜底 |
| 线路弧垂 | 启用视觉示意 |
| 完整 Fragments 缓存 | 默认关闭；且当前默认策略下不可达——`ifcEntryLoader` 在 `bim-lod` 下提前返回，`canUseCache` 又要求 `openingPolicy === 'full'`，而 `readIfcOpeningPolicy()` 固定返回 `bim-lod`，因此 `gim-debug-fragments-cache=1` 当前不改变实际路径 |
| IFC 浏览 LOD 派生缓存 | 默认使用；键绑定源、LOD 策略及安装依赖版本 |
| 超大 IFC 跳过 | 设置项 `ifc.skipLargeFiles` 默认关闭；开启后超过 64 MiB 的非关键 IFC 不转换，状态栏追加“已跳过 N 个超大 IFC”，来源、连接线源和诊断仍保留；未开启时只按源大小排序到队尾 |

完整 Fragments 缓存关闭时不读写该域的 `.frag`，不影响浏览 LOD 的独立派生缓存。该域只在完整路径被显式选中时才会使用；在默认 `bim-lod` 路径下开关不改变行为，不能与默认路径合并比较。

| 就绪状态 | 定义 |
|---|---|
| coreSemanticReady | 核心语义可供 UI 使用 |
| firstUsable / interactive | 首个可用 IFC 与基本交互，不代表全模型 |
| devGeometryReady | 默认 DEV 基础表示在无失败时收敛的兼容产品时刻；路径 `device-lod` |
| devCurrentViewReady | 默认 DEV 当前视图所需档位完成且无失败，不等待全站目录完成 |
| devBaseRepresentationsSettled | 默认 DEV 每个 occurrence 均已显示基础表示、明确 empty/unsupported 或失败终态 |
| devAllStationReady | 默认 DEV 全部可渲染设备完成 LOD2 |
| catalogReady | 设备空间目录就绪；按 DEV 增量提交，不等待全部源解析完成 |
| currentViewReady | 锚点就绪，当前已获得目录范围的视锥内 occurrence 均已提交所需档位且无失败；未获得范围的设备仍后台补 LOD0 |
| baseRepresentationsReady | 锚点与目录就绪，且全部 occurrence 已提交表示或为 empty/unsupported 终态；基础与 partial 表示不计作完整几何 |
| allStationReady | 在基础表示就绪之上，全部 occurrence 为 empty 终态或已达到 LOD2 完整几何 |
| currentViewSettled | 相机已停稳且锚点就绪，已获得目录范围的视锥内 occurrence 均已提交所需档位或已确定失败；目录可继续增量 |
| baseRepresentationsSettled | 锚点与目录就绪，全部 occurrence 已提交表示、为 empty/unsupported 或已确定失败 |
| selectedFineReady | 当前有效选择已唯一关联 LOD2，精细高亮及属性完成提交；另记录每次选择事件 |
| allIfcReady | 全部 IFC 加载尝试结束，失败数另列 |
| fullModelReady | DEV 管线结束，unsupported/partial 仍单独记录 |

## 安全与发布

SLD 使用白名单净化与 img 沙箱；删除脚本、事件、foreignObject 和外部资源引用，图形选择数据与原 SVG 执行环境分离。支持标签、样式和局部引用的实际规则以[sldParser](../desktop/src/gim/sldParser.ts) 为准。

解压限制路径与资源消耗；parser 数量和几何实例有上限，循环引用按分支截断并保留诊断。桌面发布包只带 `GIM-Reader.exe`，`7z.exe`/`7z.dll` 以字节资源内嵌；首次使用时释放到 `%TEMP%\gim-viewer-7zip/<exe-hash16>-<dll-hash16>/`，目录按嵌入二进制的 SHA-256 命名，释放后重算 SHA-256 一致才执行，写入采用临时文件、校验、rename。EXE 同目录 sidecar 只有在两个文件 SHA-256 都与随包版本一致时才使用，否则拒绝并回退内嵌副本。

每个归档条目在写入前依次检查路径规范化与目录穿越、重复路径（大小写不敏感）、声明/累计/归档大小配额、输出路径安全（符号链接/reparse point、staging 根边界）；任一失败终止整次解压，不能留下“部分有效”的缓存。解压先写 staging，完成后原子提交正式缓存；中断发布保留已提交的第一阶段索引，下次补齐。

桌面 npm 命令在 `desktop/` 执行，移动命令在 `app/` 执行。
`npm run build` 完成各端 TypeScript 和 Vite 构建；
`npm run tauri:build` 运行 Tauri 构建并通过 post 脚本生成 portable ZIP。
固定 WebView2 与 WASM 资产由构建脚本准备，产物类型以 Tauri 配置和脚本为准。`desktop/public/worker-bundle.js`、`libarchive.wasm`、`wasm/web-ifc*.wasm` 是随项目维护的运行时资产。 验证命令见 [验证](validation.md)，性能方法见 [性能](performance.md)。

### 设备场景提交与地图会话

DEV/PHM 累积矩阵烘焙到模板顶点时，负行列式同时修正三角形绕序。保留为 Object3D 矩阵的 occurrence 放置继续交给渲染器处理，避免重复反转。XML 材质按来源保留，不通过全局双面渲染掩盖方向错误。

设备模板缓存局部保守包围盒，实例使用放置矩阵变换包围盒；相机单轮评估复用视锥与投影临时对象。相机更新独立防抖 200 ms，目录与提交重新评估采用合并调度，不因持续提交而重置计时。场景提交按 16 ms 间隔调度，单批使用 4 ms 软预算，单个任务不能中断。相机交互期间暂缓普通提交，选中设备优先；旧表示保持到替换完成。同一 occurrence 同档请求合并，会话释放会拒绝等待中的提交。状态统计最多每 100 ms 合并刷新，完成、失败、空源和视图等待计数由行状态转移增量维护；诊断模式可按固定间隔全量复算并报告计数遗漏。

Scene 与 MOD/STL 图层是固定局部坐标容器：[staticContainer](../desktop/src/viewer/staticContainer.ts) 的 `freezeContainerLocalMatrix` 在场景创建及两处图层创建入口调用，关闭容器局部矩阵自动重算。Three.js 0.184.0 的 `Object3D.updateMatrixWorld()` 会在父节点需要更新时把 force 传给全部后代；固定这些容器可避免默认 Scene 每帧触发整棵静态子树重算。只固定这些容器：不递归冻结其他对象、不关闭 `matrixWorldAutoUpdate`，已有手动仿射矩阵不被 TRS 分解覆盖；世界矩阵更新机制及动态子节点保持启用。锚点更新继续显式强制刷新。若以后修改这些容器的局部 TRS，需显式 `updateMatrix()`；直接写矩阵需标脏或强制刷新。四站局部 CPU、像素及拾取对照见 [性能](performance.md)。

线路地图创建接收 AbortSignal，覆盖动态依赖加载、挂载前检查和等待 load 阶段。等待 load 有 5 秒上限：raster 瓦片请求卡住时先激活 overlay，让瓦片到达后可见，而不是让不透明 Canvas-only 永久遮住 MapLibre。在线底图瓦片错误只记录状态并保留已加载地图，不再因少量瓦片错误销毁 MapLibre；用户底图选择持久化，重新打开线路工程沿用。工程清理与底图切换取消初始化中的地图，并移除遗留的 MapLibre mount/线路 canvas；变电 Three.js canvas 使用不透明 clear（WebView2 复合层可能保留上一底图），切换后不会被旧地图透视。

变电暖启动的缓存校验分两级。语义级先校验 parser/domain 版本、索引 receipt 和逐条 IFC 源可读性；通过后进入逐 entry fast path，不再在打开关键路径上逐个 stat/open 全部 CBM/FAM/DEV/PHM/MOD/STL 源文件（大工程可达 3.6 万条，逐条 reparse 与路径包含检查约 9 s，比空索引的冷校验还慢）。GLB manifest 结构与几何域版本只决定几何 domain 能否复用，不阻塞语义 HIT：语义索引可以在 DEV GLB 尚未生成时先发布，缺失/截断的单个源文件由 DEV 批量读取按 entry 隔离。只有版本、receipt、IFC 清单或 count 不一致时才执行完整源文件扫描。状态栏把“登记工程记录”“检查本地缓存”“恢复索引”“加载 IFC/DEV”分开显示，不用一个“核对工程记录”覆盖解压和索引恢复。

查看器壳层默认折叠属性抽屉，打开期显示阶段进度条和 elapsed 秒数（进度按读取/登记/检查/解压/索引/IFC 分段单调推进）；`#main` 的末列使用 `auto` 轨道，折叠后视口获得全部释放宽度；顶栏低频操作进入“更多”菜单。空态提供骨架、打开、继续上次工程和最近工程列表；最近工程打开前由 Rust 从 `gim_project` 读取路径并登记授权，页面不能提交任意路径。变电按源 SHA 保存相机位置/目标、选中路径与展开树节点，首个 IFC 可用后恢复；恢复失败回退 fit。缓存管理逐工程调用 `validate_gim_cache`，只展示 valid/miss reason，不隐式重建。

项目登记在阻塞任务中执行，兼容旧路径的规范化在数据库锁外处理，重新加锁后复核记录。日志分列源路径规范化、锁等待、兼容候选数及兼容路径处理耗时。IFC 转换的补充范围收集只流式处理未观察到的紧固件，不重放全部几何。区域查询按固定工程矩阵缓存包围盒树，区域缓存按批次事务读写。DEV 来源统一经过 File.text 解码入口，Worker 保留有界解析缓存及 16 MiB primitive 缓存；计算结果移交后释放计算槽，结果消费独立计数。IFC 结束前最多两个 DEV 编译，结束后使用配置的池容量；模板读取和解析受独立输入预算约束。

DEV 池在活动、排队和未消费结果均为空且持续至少 30 秒时，沿现有 10 秒 watchdog 检查回收：保留最近完成任务的健康 Worker，没有记录时保留一个，其余释放。普通空闲缩容后的可执行请求按实际排队需求逐线程恢复，最高为原配置容量；暂停的自动细节和结果背压不触发增线程。主线程模板、实例与来源继续保留，重新计算可能因 Worker 解析缓存变冷而变慢。普通空闲缩容不降低暖模板消费容量，high/critical 仍收紧消费；已有 critical 恢复策略不变。`workerCount` 为实际线程数，`workerScheduling.targetWorkers` 为配置容量，另记录空闲时长和缩容次数。四站局部对照及边界见 [性能](performance.md)。

变电默认业务导航由纯领域 `businessTree` 生成对象、区域、功能单元及归属证据，`businessOwnership` 处理安装材料，`businessBuildings` 处理建筑及系统归属，服务层编排冷构建与暖恢复，UI 只渲染投影。顶层为安装工程/建筑工程，配电区域内的母线整体构成一个母线设备间隔，母联、分段及进出线保留各自来源身份。安装区域按主变、配电装置（电压降序）、无功补偿、站用电、电缆及接地、二次排列；间隔按出线、进线、母线设备、母联、分段及自然数字顺序排列。设备直接位于单元下，主变本体先于中性点装置，后者按电压降序；材料及建筑构件保留类型折叠组。归属状态是属性，不产生待确认层级。原始来源树、既有功能系统视图和 IFC 空间关系仍可查看；分类不参与物理 occurrence 收集或几何剔除。

业务快照使用现有受源身份约束的文件读写桥，存于工程提取根的 `__derived__/business-tree-v5/<source-sha>.bin`，正文契约为 `business-snapshot-v3`，不修改 SQLite 表或其他缓存契约。首次构建复用已解析 CBM、后台语义发布的 FAM 原行以及 Spatial 对象，不重复解析 IFC 或触发 L2；完整 IFC 清单、FAM 就绪后才允许原子发布。快照只保存对象/区域/单元事实及原始来源、归属证据和 IFC 精确身份，不重复保存 CBM 图或几何。正文采用固定列、共享字符串表和 gzip，减少重复字段、来源路径及证据的展开与 I/O 搬运，压缩和展开均限制为 64 MiB；解压逐块核对声明长度，列结构、字符串/对象引用或摘要校验失败都只使业务缓存未命中。

暖路径在原生源/语义缓存校验通过后，并行读取业务快照和核心语义索引，提前解压与反序列化。核心 CBM 恢复后才校验最终 IFC 模型清单，按完整 occurrence 路径绑定原节点，重建成员及来源查找映射；该过程没有分类或推断，预读不能提前安装投影。完整投影在只读工程会话内保持不变，迟到的 FAM/Spatial 发布不再重建业务树。缓存的模型身份、区分大小写的 GlobalId 和 ExpressId 允许 IFC 叶子在完整 Spatial 恢复前选择高亮及近景；几何和属性仍走原有按需服务。选择和异步提交核对工程代次及请求身份，工程切换释放 Worker、延时任务和 UI 引用。源 SHA 进入文件路径和快照头，旧会话写入不能覆盖新源产物。

Spatial 的对象级关联只使用来源模型内精确 GlobalId，保留大小写和合法的尾部 `$`；实际产品重复身份视为歧义，端口及洞口不参与产品身份竞争。`IfcRelFillsElement` 与 `IfcRelVoidsElement` 保留门窗→洞口→墙的宿主链。业务 IFC 叶子优先用 RegionalIndex 的逐对象范围定位，避免 Fragments 批次合并范围拉远相机；超过 30 m 且长宽比超过 10 的构件先显示中心 12 m 局部，并提供“定位整件”，高亮身份仍为完整对象。

建筑专业实体建立固定平面连通范围，按网格筛选跨专业候选；紧固件、室外构架和基础不扩大建筑范围。门窗可继承宿主建筑；基础单独展示，并保留相关主变单元。DEV 的 L0 实际模板范围在首次放置时保存为源坐标米制范围，目录缺少可靠范围时仍可复用，不遍历场景、不额外解析模板。材料候选按功能单元去重，母线的多个段仍只算一个候选。

建筑公用设备的具体用途优先于“箱/柜”通用词。照明箱及空调柜机按浏览业务口径进入所属建筑或站区的照明系统，原始空调类型、暖通来源及楼层信息保留。电缆沟、构架、道路、围墙等明确站区设施的类型优先于建筑平面包含，不因位于楼下而进入楼层；普通支架仍可遵循建筑宿主。基础统一为“基础”区域，按设备基础、建筑基础及用途尚未明确的其他基础归组；明确建筑基础名称不被附近主变的距离推断覆盖。

显式连接关系之后、中心距离比较之前，对平面跨度不超过 12 m 的未确定导线核查是否只与一个兼容主设备单元的平面范围相交。母线整体候选不参与该主设备竞争，因此不会仅凭母线更靠近导线中心而覆盖主设备接引证据。多个主设备、超长或端点冲突仍不能由此单归属，结果始终标为推断；推断导线不扩大主设备或母线边界。候选属性统一显示对象中心到候选范围的平面距离，拒绝对象不再反向计算距离。

唯一对象级 IFC 关联才合并来源，IFC 模型身份及 GUID 大小写保持；多候选不任选第一个。装配子部件来源随物理根保留，不作为第二个 seed。CBM 祖先关系与叶子 SYSTEMNAME 合并，保留所有 BASEFAMILY 引用；优先采用有效的工程中名称。明确二次系统先于名称电压分类；AC12kV 额定值不能建立 12kV 区域，有效的 10kV 工程名称可确定标称电压。建筑使用真实建筑名称、命名楼层与范围证据跨专业归组，IFC 文件或匿名 IfcBuilding 不是物理建筑。缺少名称时，建筑专业的连通范围只能产生标为推断的编号建筑；缺少楼层依据不补造楼层。消防、照明、给排水与楼层并列，歧义构件留在站区。

CBM 基础投影先可用，Spatial 到达时复用已有 CBM 投影；IFC 和基础几何结算后，将必要身份、名称、关系及已有表示范围交给独立 Worker，几何加载不等待业务补充。`businessGeometryEvidence` 将 IFC 的绝对米制 Y-up 范围转换为 Z-up；DEV 本地范围已为米，仅放置平移从毫米转米。端点 GUID 按模型隔离并排除重复身份与端口。完整投影持久化，算法变动只使业务域失效。材料仅在唯一兼容设备包围、受约束范围相交或完整端点集合支持时标为推断；端点冲突优先于几何，跨间隔连接保留共享和关联间隔。表示范围相交不等于实体接触。按材料类别限制源 XY 平面距离、候选区分度和跨度，可产生标为推断的归属；长跨间隔导线保留共享，歧义材料保留区域归属。阈值没有人工真值准确率保证，距离不升级为明确工程事实。推断对象不扩大主设备区域边界。工程释放清理投影、延后任务、Worker 和 UI 投影引用，准备结果和选择提交均检查会话；只查看来源层级不额外启动业务补充。

业务聚合选择使用成员路径和 IFC 身份集合，不通过 DOM 反查几何。普通设备复用原选择路径，IFC 叶子高亮并定位后由既有近景调度管理 L1，精细 L2 继续显式请求。DEV 隔离支持多根成员，IFC 实例化近景高亮覆盖层按 ExpressId 分别持有，表示切换沿用选择提交队列和旧请求守卫。

模板等待队列使用可索引堆，入队、取消和提升为 O(log N)，普通任务按优先级及入队时刻排序，选中任务始终优先。LRU 的保护集合带成员修订号，缓存内容、预算与保护集合不变时跳过重复无效淘汰。Worker 计算槽和结果消费分别管理：未消费结果达到 64 MiB 或每 Worker 两条时，暂停派发后台编译；已启动任务可完成，单条结果上限 128 MiB。用户可暂停自动 L1 细化，L0 与范围目录继续运行，显式 L2 请求仍可提升。此阈值不是工程总内存硬上限，暖缓存读取、解析与 GPU 驻留分别记录。

变电工程在 IFC 或纯 DEV 运行时就绪后启动会话所有的内存监控：一次原生查询结束后等待 5 秒再采样，不重叠请求；切换、关闭工程时停止，迟到结果不得更新新工程。Windows 使用进程树 `PrivateUsage` 的合计（私有提交量）反馈压力，RSS 继续独立记录，不替代私有内存指标；不可测时标为 unknown。6 GiB 的 80% 阈值暂停 DEV 源预取和自动 L1，90% 阈值回收未保护模板及空闲 DEV Worker（保留至少一个），IFC 回收离屏且非选中的细节并恢复远景、关闭空闲源 Worker；可见或选中表示及正在运行的基础任务受到保护。压力恢复后按新任务需求恢复 Worker 数量。显式新精化在临界压力时返回可理解的失败原因，已有画面继续可浏览。这些反馈不能保证控制 WebView/WASM/GPU 的全部内部驻留。

诊断 `memory`/`memorySamples` 最多保留 512 次内存采样；`processTreePrivatePeakBytes` 单独保留整个性能会话观测到的最大私有提交量，不随采样窗口淘汰，未知时为 null。周期采样不遍历全场景；场景资源所有权仍在加载与清理检查点统计。此峰值来自离散采样，不代表已经捕获采样间隔中的瞬时峰值。

DEV 的运行时包围盒索引只负责视锥候选筛选：目录范围到达及坐标锚点改变时更新，在查询时按需重建；候选才计算投影角点和屏幕占用。索引保留长构件跨视锥的相交语义，选中对象仍提高优先级，未知范围对象仍请求基础表示。调度对 occurrence 的遍历继续保留，不将此改动描述为完全消除了全目录扫描。索引不持久化，不改变缓存版本。

功能系统树按需展开；单次展开的直接子行超过 500 项时使用逻辑轮廓虚拟窗口，窗口内展开的子树按稳定行键平铺，DOM 回收后保留展开状态。搜索逐层显示祖先并显露目标，方向键及 Home/End 在完整逻辑行集合中移动。空间树的同类叶分支使用独立虚拟窗口。两种窗口移除时清理滚动监听及待执行动画帧，工程切换不保留旧行身份。

DEV 模板任务在现有 perfTimings 内使用会话内 taskId 关联模板队列、派生缓存读取/校验、Worker 队列与内部阶段、反序列化、模板构建、实例放置及异步缓存写入。Worker 保留独立池会话与任务序号，多个 occurrence 共享模板任务并用 instanceKey 区分提交；缓存身份和持久化结构不包含这些诊断 ID。默认记录最多 128 种阶段聚合及 32 条慢阶段/失败样本，不能据默认样本反推全部任务顺序。GIM_PERF_TASK_TRACE=1 在工程性能会话开始时启用逐阶段 span，沿用最多 8192 条的 span 窗口，并报告淘汰数。Worker 上报的阶段位置是收到结果时按持续时间反推的近似位置，内部阶段与外层墙钟可能重叠，不能相加推算工程耗时；CPU 时间不可测时明确报告不可用。IFC 继续沿用读取/转换/源模型 profile，其与 DEV 的完整统一任务关联仍未完成。

DEV 缓存写入采用四个并发槽及 129 MiB 缓冲区准入预算，覆盖一个最大 128 MiB GLB 加至多 1 MiB 元数据。metadata 只准备一次，二进制不进入 JSON；待准入模板继续持有原输入额度，准入后转由写预算持有，写完或失败后单次释放。目录生产者在应用范围并驱动浏览调度后等待写入准入，空/无效源的元数据生产者也受既有生产并发限制。普通几何提交不等待已生成 GLB 的缓存写入准入或落盘。工程释放时取消预算与写槽等待者，已开始的原生写入持有真实额度直至返回。诊断 cacheWriteReservedBytes/cacheWriteWaitingBytes/cacheWritePendingCount 与 cacheWritesSettled/cacheWritesReady 分别报告额度、队列与保存状态；waiting 中的模板字节与输入额度重叠，不能相加冒充进程私有内存。预算不覆盖浏览器、IPC 与原生临时副本，6 GiB 与切换稳定性仍须实际测量。

原生设备派生缓存的并发读取在同一源身份下合并为最多 64 条的批次。每批验证项目 SHA 一次、复用父目录创建与规范化结果，可变父目录的 reparse 检查和文件检查仍逐条执行，二进制回复沿用 GIMR envelope；每条上限 128 MiB、原生入口每批上限 512 MiB，调用方可传入更小上限。桥接层传入字节上限的逻辑批读请求在所有分批及失败拆分之间共享剩余字节额度，耗尽后返回 deferred，不重新取得完整额度。损坏记录逐条回退，源身份或批次读取失败不作为合法缓存使用。磁盘目录布局与持久化键不变。

近景几何与源属性缓存使用 256 MiB 估算载荷预算、4096 条上限和单条 64 MiB 上限。容量元数据与几何在同一 IndexedDB 事务提交，访问会更新淘汰顺序；超预算时从旧条目开始淘汰，超大条目不持久化但仍可显示。数据库升级只清退没有容量账的旧近景/属性条目，保留远景 Fragments 与区域索引，以及独立语义和设备缓存。升级后的首次近景请求可能重新求值，此行为不等于源工程失效。

DEV 暖缓存读取、SHA 校验和 GLTF 解析与冷编译结果的消费共享 128 MiB 输入预算。同批模板请求共用一份预算预留，最后一个消费者完成才释放；原生批读最多 64 条且接受调用方字节上限，剩余空间不足的条目延后处理，不冒充缓存缺失。模板消费槽至少 8 个，通常为配置 Worker 容量×8；普通空闲缩容保留这项暖读容量，high/critical 压力下按当前 Worker 数量×8 收紧。暖恢复可合并这些槽位的请求；目录仍独立分批读取。浏览器未知大小记录逐条接纳。缓存未命中时先释放该消费者的份额再编译，冷结果按实际字节申请消费额度。工程关闭拒绝排队申请，已完成任务只释放一次。此预算约束输入消费，不包含封装/IPC 临时副本、已启动 Worker 的产物、解析后的模板和 GPU 驻留；诊断中的预算值表示预留量。

原生 DEV 批读在同步解包时借用 GIMR 记录视图：`parseBatchCachePayload` 默认仍产出独立条目，只有 DEV 原生批读内部传 `copyBytes:false`；该视图只在同一次同步解包内有效，`unpackDevArtifact` 始终产出偏移 0 的独立 GLB，JSON 元数据不持有视图。返回的 GLB 仍持有独立、完整的缓冲区，不引用批次或相邻模板。普通源文件批读保留默认复制，以支持逐文件转移。该调整不改变持久化格式、预算或缓存版本。

Spatial 构建在来源是真实 Blob/File 时直接把不可变来源交给 Worker，由 Worker 读取字节、解码并报告阶段墙钟。磁盘 shim 保留授权的读取回退。两条路径仍使用同一 STEP 扫描和关系构建，逐文件隔离错误；这项改动减少主线程整文件驻留及跨线程字节转移，不代表已经消除了 Spatial 的重复扫描。

区域源 Worker 首次读取、校验并 OpenModel 后保持驻留。当前区域仅含 IFCPLATE、IFCMEMBER、IFCMECHANICALFASTENER、IFCFASTENER 时，从源模型复制所需的项目单位、放置、表示、保留开洞和反向外观/类型依赖，建立私有求值模型；后续区域不因新识别小孔而重新解析整份源。源属性仍从源模型读取。子集按原 ExpressId、GlobalId、矩阵和单位写入，不居中或拟合偏移；多对象关系只保留请求对象，避免意外引入全站。写入采用 schema 序列化恢复派生字段，并探测当前 WASM 的数值桥接形式；提交前复核单位。依赖闭包最多 10 万条记录、200 万个参数值；外观与类型反向索引按类型限制条数，并总计最多 50 万条反向边。子集要求唯一 IfcProject，任一上限超限、单位不可用或两条数值写入路径都不可用时直接失败，不静默截断。子集模型只在源 Worker 内驻留，不构成新的持久化缓存域。

IFC 连接构件增量表示是独立的会话资源：完整源在同一次 OpenModel 后，按源实体类型或代理实体名称识别连接构件，先于普通 Fragments 导入提取其真实三角网格。分类包含管线及接头，不能把对象总数等同于电气导线条数。传输保留顶点、法线、颜色、源对象身份和放置矩阵；不由包围盒推导中心线，不改变管径。每块最多 3072 个三角形（约 217 KiB，协议上限 128 对象或 4 MiB），Worker 等待主线程消费确认后继续；主线程每块提交后让出一轮事件循环。局部源对象失败记录在 coldPipeline.connectionFailedObjects，其余对象与普通导入继续，完整凭据不发布。批次必须连续、去重且源身份一致，最终消息与完整对象数相符才计作连接表示完成。网格为绝对 Y-up 米，先用源协调矩阵逆变换恢复原始位置，再在显示时抵消工程矩阵中的 Z-up 转换，工程锚点与偏移只应用一次。Fragments 模型就绪后释放临时网格，工程关闭释放所有会话资源。

连接提前显示的可选路径沿现有性能会话记录 `coldPipeline.earlyPreparationMs` / `earlyIndexMs` / `earlyClosureMs`、`earlyIndexBytes` / `earlySubsetBytes` / `earlyIndexedRecords` / `earlySubsetRecords`、`earlyWasmInitMs` / `earlyOpenModelMs` / `earlyParsedModels` / `earlyMeshBytes`，以及阶段 `source-hash` / `early-connection` / `source-open`。端点证据读取时间与局部不可用分别记为 `connectionEvidenceMs` 和 `connectionEvidenceUnavailable`；小 GL 证据索引记录 `Connection sidecar evidence ready` / `unavailable`。这些阶段可能包含或重叠，不能相加为整源耗时；`parsedModels` 计入真实打开过的临时子集，不能仍记为一次解析。

对于 64–512 MiB 且前 4 MiB 出现受支持连接实体的来源，Worker 可先按原 STEP 字节提取 ExpressId 最小的单个对象闭包，在完整源 OpenModel 前提供第一份表示。索引最多 64 MiB、闭包最多 10 万条 / 8 MiB、首对象网格最多 4 MiB；保留项目单位、放置及外观引用。临时 API 释放后完整源使用新 API，满足当前 Fragments 导入要求的模型编号 0。完整源跳过已发布对象并延续批次序号；临时子集不发布整源完成，不充当工程坐标锚点。索引同时复用既有派生开孔忽略策略的字节范围；不支持语法、缺失引用或超出预算时继续原完整源路径。计算/消费失败和会话取消仍按原任务结算。较高内存压力下不启用可选首对象路径。来源队列保留原首个坐标锚点，其后提高有引用证据的连接源优先级；文件名只可作为调度提示，不决定解析分支。`OpenModelFromCallback` 是回调供给字节的接口，仍返回完整打开后的模型 ID；不能据其名称认定可在 OpenModel 前取得可渲染对象，当前没有流式或可中断的 OpenModel。

队列在首个坐标锚点之后，先处理不超过 64 MiB 的连接源与普通源，再处理超大连接源和普通源，避免一个超大接线源阻挡建筑等有界来源。状态展示真实转换阶段、源大小及该来源等待秒数；前一来源异步写缓存不能覆盖当前来源。等待秒数仅说明墙钟，不能重置 Worker 的无进度看门狗。

连接网格使用独立可选派生键 `${farKey}|near-templates-vconnection-mesh-v1|0`，不更改远景、语义、Spatial 或 DEV 几何版本。完整、连续且通过结构校验的流才写入一个原子记录，沿用近景缓存总量/单项/LRU预算；会话收集的网格字节超过 48 MiB 时停止保留缓存副本，显示仍继续。暖命中在远景成功反序列化后按原序列重放真实网格，模型发布后释放临时网格；旧远景缓存缺少连接凭据仍可使用，不冒充连接网格缓存命中。`readyModels` 与对象数可由已就绪的正式远景索引恢复，`completeModels` 只计完整预览凭据，空最终批次不计作首个几何批次。当前完整凭据不含持久化逐字节摘要；验收边界见 [问题与限制](open-issues.md) O-01/O-03。

连接对象的来源身份、DEV 装配归属和设备端点是不同证据。对象 IFCGUID 只在同一 IFC 来源内精确关联 CBM，重复引用保留候选。支持的端点元数据来自标准 IFC 连接/端口关系，或明确接线点 GUID 属性的实际值；后者通过 GL ConnectGuid、同 UUID DEV 和既有 occurrence 图核对，GL 不加入几何主链。小 GL 元数据按已知大小批读（单项 ≤1 MiB、总量 ≤4 MiB），等待上限 5 秒，不阻挡几何。`RegionalObject.connectionEndpoints` 为可选兼容元数据：undefined 是未收集/旧缓存，空数组才是当前支持规则扫描后没有引用。多实例保留候选，空间邻近不变成已确认电气连接；端点证据读取失败不使已可用几何失败。工程切换拒绝迟到结果并释放端点索引。

不支持的产品类型、来源能力、预算超限或几何提取失败回退到完整源求值。子集构建在同一源 Worker 内一旦失败即不再重试，后续区域请求直接使用完整源；单个对象在子集内求值异常时，在同一请求内回退整源并重试该对象，不静默丢弃。回退时累计应用已由子集区域识别的小孔关系，不能遗漏这些孔。相机变化触发的区域更新在固定防抖窗口结束后执行，该等待不计入区域墙钟。关系首次修改扫描 STEP 并保存字节范围，后续只修改新增范围；需要更新完整源策略时仍关闭并重新 OpenModel。子集与完整源回退共享现有串行调度和工程会话，切换源、关闭或空闲释放时一起销毁；缓存几何含义与版本不变。

功能树将同一来源语义路径上的系统前缀与间隔父组显示为一行，保留 1PT、1EM PT、1S 等字母数字间隔名。主变系统在前，电压配电系统按电压降序，控制及直流/二次系统独立归组，接地归属优先于名称中的保护词；间隔按类别和自然数字顺序排列。缺少间隔证据的对象保留在现有归属，不制造间隔。独立设备的 PARTINDEX/DEV_SUBDEVICE 也遵循同一归属下唯一配对的别名规则，保留全部来源路径和冲突证据，不合并真实重复实例。业务设备计数来自分类投影，物理几何实例数继续来自渲染目录，两者分别显示。

编号主变的功能组先按主变号排序，同号本体在中性点设备之前，“备用”不改变编号优先级。状态栏称“设备节点”以说明其包含装配内部独立单元；几何实例统计整机装配根，一个根可以展示多个设备节点。IFC 冷转换/暖恢复与 DEV 冷编译/暖恢复分别按实际缓存消费记录，不从工程语义命中推断几何命中。

Worker 协议拒绝未知或忙时的任务并返回错误，清理异常不保留 running 状态。单 Worker 崩溃仅失败当前任务并有限替换，健康 Worker 继续工作；替换耗尽时错误明确传至请求方。目录任务失败保留未知范围，不释放整个设备域。仍被需要的取消请求重新驱动；就绪诊断记录待完成实例、等待原因及有限样本。IFC 区域运行时替换会释放旧实例，退出近景或释放时恢复其隐藏的远景对象。


DEV XML MOD 的 L0/L1 采用轮廓表示，CSG 仅在 L2 执行。模板诊断携带 `representationPolicy`、按运算类型计数的 `approximatedBooleans` 和小构件省略统计；正常的轮廓简化不作为 partial，来源缺失、循环和不支持图元仍保留降级诊断。小构件在实体与装配变换之后按外形尺寸过滤，DEV 全部被过滤时只保留最大有效源轮廓，不生成虚构代理体。源级 raw 回退采用同一 L0 轮廓，在 DEV 局部装配坐标过滤小构件，场景放置仍累积完整 CBM 变换；整台 DEV 无 MOD/STL 表示时补回最大有效源轮廓，独立 MOD 调用保留局部小构件回退，不执行 L2 CSG；L2 仍只由显式精化请求进入。几何缓存版本由 TS `DEV_GEOMETRY_VERSION` 和 Rust `GEOMETRY_CACHE_VERSION` 同步维护；catalog 键绑定同一几何版本，语义、Spatial、Fragments 域独立。
