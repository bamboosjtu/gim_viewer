# 缓存域

本文件是文档中唯一的缓存契约索引。修改持久化含义时只失效受影响域；实际常量以链接源码为准，不在其他文档复制版本号。

## 存储面

| 存储 | 内容 | 生命周期 |
|---|---|---|
| SQLite `gim_cache_schema_v1.db` | 工程记录、变电/线路语义、DEV 几何引用 | 安装数据目录；按域版本和源 SHA 失效 |
| 原生文件缓存 | 解压清单、DEV GLB 模板/目录、IFC LOD 产物 | 工程数据目录；逐条原子文件 + 完成凭据 |
| IndexedDB | 浏览器/开发上下文的 DEV LOD、IFC 远景/区域/属性派生 | WebView profile；键绑定源与依赖版本 |
| localStorage | 视图偏好、自动定位、底图选择、调试开关 | 设备/会话偏好，不作为工程事实 |
| 内存会话 | 工程实体图、导航、选择、相机历史、临时预览 | 工程关闭即释放 |

型材开口截面策略以 `open-steel-section-v1` 参与 DEV 模板、DEV 目录和巡视资产的身份计算。源 SHA 和原生四字段缓存键约束保留，旧外廓盒不命中新策略。

应用内巡视页使用 IndexedDB `gim-patrol-v1` 保存场景清单和碰撞资产。物理库版本 2 在升级事务中重建 `assets`、`coverage` 两个派生存储，连同旧版缺少所有者记录的数据一并清理。清单按工程源 SHA、几何编译、坐标、角色和 BVH 策略定位，记录构件放置、来源与门扇地址、入口候选和不可用来源。碰撞资产按 DEV 模板或 IFC 对象复用，只有资产写入成功后才提交清单。进入巡视加载整站碰撞索引和已缓存的 DEV/IFC 浏览表示。暖入读取有效清单和碰撞资产，缺失资产时补建对应模板。范围未知与近似来源随清单记录。`unavailable` 只保存有来源依据的空、无效或不受支持的资产。临时读取、Worker 或内存失败在本次巡视阻挡对应范围，下次进入时只重试缺失资产，复用成功模板。持久化不可用时，同一会话保留成功资产用于定向重试。存储不可用时可使用本次会话的内存场景。工程树投影、属性和临时门姿态沿用各自的会话或缓存域。

首次正式发布前，SQLite 物理 schema 固定为 v1，不维护开发库的升级兼容。结构变更后由开发者删除旧库并重建。语义、几何与投影缓存域仍独立失效。

SQLite 共享 `gim_project`；变电表使用 `substation_*`，线路表使用 `powerline_*`。读取时按工程 ID、源 SHA 和域版本校验，不能只凭表中有行判定命中。

无 GIMPKG 头的裸 7z/ZIP 先由原生解压层按签名和配额处理，工程类型仍由内容决定；原生清单按源 SHA 绑定。裸 7z 与 GIMPKGS 使用同一通用来源 pack 保存非 IFC 条目，独立落盘的 IFC 保留缓存路径；pack 选择不决定工程或设备语义。若改走 WASM 回退，全部归档条目都要持久化后才能发布完整 SQLite 索引。工程来源图 `partial` 表示来源覆盖不完整，可能不写 Engineering Worker 的来源/实体/导航派生缓存；它不否定已通过校验的 SQLite 变电核心缓存。

已完成的原生清单在内容类型判定前批量物化有界的 CBM/DEV/FAM 文本，主线程用字节后备的 File 接口读取。进入 Engineering Worker 时按最多 256 个文件、8 MiB 合成一个 Blob，保留每个文件的字节范围；Worker 每包读取一次，按原边界分别解码，来源图消费文档后删除临时文本。超大单文件保留既有读取路径。适配对象本身不能直接结构化克隆，也不把全部独立字节视图常驻 Worker；直接传入全部字节视图曾在大来源图上触发 V8 OOM。File Map 的路径键保持不变，避免逐文件 IPC 后再次读取，来源文档由构建内的文档缓存复用。冷路径已有来源 File Map 时不再展开一份完整 FAM JSON 缓存，暖恢复的缺失属性修复仍保留。早期语义提取仍按自身完成时序读取，不为预物化等待整个归档。几何大文件保持按需读取。

共享的物理 schema、线路/变电 parser 和 DEV 几何基础版本由 `contracts/native-v1.json` 生成 TS/Rust 常量。单语言派生域及内容指纹仍由各自领域持有，保持独立失效，不合并为一个全局版本。

## 当前契约

| 域 | 当前契约 | 权威定义 | 失效/校验范围 |
|---|---|---|---|
| 线路语义 | `gim-line-parser-v1` | [db.rs](../../desktop/src-tauri/src/db.rs) | 源 SHA、完整事务、graph/属性 |
| 变电语义 | `gim-substation-parser-v1` | [db.rs](../../desktop/src-tauri/src/db.rs) | 原始属性、CBM/DEV/IFC 引用、索引 receipt |
| DEV LOD 派生 | `geometry-cache-v1-source-bound-stl` 与 `dev-spatial-catalog-v1`；浏览器使用 IndexedDB `gim-dev-lod-v1` | [DEV 目录](../../desktop/src/services/dev-geometry/devSpatialCatalog.ts)、[LOD 缓存](../../desktop/bridge/devLodCache.ts) | 源 SHA、DEV 路径、几何版本与 LOD。L0 持久化、仅热点 L1 选择性持久化、L2 默认内存。模板和目录逐条原子提交并按需检查，节点点击复用同一 L0 键。 |
| 变电 Spatial | `substation-spatial-semantic-v1` | [Spatial codec](../../desktop/src/infrastructure/cache/substationSpatialCodec.ts)、[缓存 I/O](../../desktop/src/features/substation/runtime/substationSpatialSemanticCache.ts) | 精确大小写身份、宿主链、原始 IFC Name；缺失/损坏重建 |
| IFC Spatial parser | `gim-substation-parser-v1` | [Spatial codec](../../desktop/src/infrastructure/cache/substationSpatialCodec.ts) | 独立于变电语义域 |
| 来源物理目录 | `source-geometry-v1` | [独立物理遍历](../../packages/gim-sdk/src/geometry/physicalOccurrences.ts)、[物理目录缓存](../../desktop/src/infrastructure/cache/sourceGeometryCache.ts) | 源 SHA、契约与载荷长度、实际 entry 路径及有效矩阵；字符串表复用身份/上下文/路径，按实际 UTF-8 字节判断 32 MiB 可选缓存上限；独立于分类/实体/导航，命中后不读完整语义图 |
| 工程来源 | `engineering-source-v1` + 识别字段内容指纹 | [来源契约](../../packages/gim-sdk/src/source/buildSources.ts)、[编码](../../desktop/src/infrastructure/cache/engineeringCacheCodec.ts)、[来源表](../../desktop/src/infrastructure/cache/engineeringSourceCodec.ts) | 源 SHA、条目清单、来源/IFC parser 契约、完整性；识别字段清单变化仅经头契约失效，磁盘目录名保持稳定；保留实际 FAM 归属、属性对象/Pset/实例类型范围；独立原子文件 |
| 工程实体 | `engineering-entity-v1` + `recognition-evidence-policy-v1` + 内部策略内容指纹 + 模型/部件词汇与来源兼容映射内容指纹 + 识别字段内容指纹 + `engineering-catalog-v1` | [实体编码](../../desktop/src/infrastructure/cache/engineeringCacheCodec.ts)、[识别版本](../../packages/gim-sdk/src/semantic/recognition/objectEvidenceDecision.ts)、[目录契约](../../packages/gim-sdk/src/semantic/catalog/catalog.json) | 绑定来源内容摘要、scope/sourceRevision、实体 schema、复合识别契约与词典内容指纹；单独修改识别词汇或字段清单只重建实体、导航 |
| 工程导航 | `engineering-navigation-v1` + `engineering-composition-v1` + `engineering-source-tree-v1` + `engineering-inventory-v1` + 清册展示策略内容 + 目录版本 | [三视图投影](../../packages/gim-sdk/src/projection/navigation.ts)、[组成](../../packages/gim-sdk/src/projection/composition.ts)、[来源树](../../packages/gim-sdk/src/projection/sourceProjection.ts)、[清册](../../packages/gim-sdk/src/projection/inventoryTemplate.ts)、[导航缓存](../../desktop/src/infrastructure/cache/engineeringNavigationCache.ts) | 绑定来源摘要、实体快照指纹和空间投影策略版本；实体叶子与来源到整体行的映射分别校验，待归诊断随元数据保存；校验节点可达性、完整投影标记与覆盖率；展示策略变化只重建导航，部分范围不写导航缓存 |
| IFC 浏览 LOD | `bim-lod-v1` 组合 | [features](../../desktop/src/config/features.ts)、[LOD 缓存](../../desktop/bridge/ifcLodCache.ts) | 源 SHA、条目、LOD 策略、单次解析、依赖版本；分远景/近景/属性独立失效 |
| IFC 区域模板 | `near-templates-v1`，附加于浏览 LOD 键 | [features](../../desktop/src/config/features.ts) | 模板几何与逐对象放置；不重建有效远景 |
| Android 线路语义 | `mobile-powerline-v1` | [移动存储](../../app/src-tauri/src/storage.rs)、[领域投影](../../packages/powerline-core/src/domain.ts) | 私有源 SHA/大小、对象与属性范围、FAM 分类 |
| Android HNum | `hnum-xz-v1` | [领域定义](../../packages/powerline-core/src/domain.ts) | 源 SHA、MOD 路径；跨 Body 唯一点号 |
| 视图状态 | `gim-view-state-v1`（localStorage） | [viewStateStore](../../desktop/src/services/project/viewStateStore.ts) | 工程 SHA/路径；相机、树展开、选择路径；不参与工程事实 |

暖开 catalog 命中率只要求可成功表示的来源；有原始范围或引用证据的失败来源未产出目录缓存时，报告单列其未命中集合并与全部 DEV 来源数核对。其他 miss、读取错误和无证据失败不能被样本级白名单掩盖。

仅修改裁决代码但改变持久化识别结果时，也须提升识别契约中的决策语义修订值。旧实体和导航会自动重算，来源及几何不受影响；无行为变化的拆分不提升该值。

## 发布与恢复

当前的来源完成凭据限定为已遍历的结构与识别所需来源，不代表全包所有属性均已解析。证据端口分别报告 Inventory 与条目属性覆盖，工程快照另外记录输入/已处理范围。运行时构建通过 `engineering-worker-table-pages-v1` 逐页恢复共享节点表。元数据和详情请求复用已发布构建。FAM 记录及上下文随来源域恢复，属性详情在 Worker 内复用已有解析结果。

表 JSON 按有界节点批次进行 UTF-8 编解码，避免在传输和缓存阶段同时驻留模型大小的 UTF-16 整串。缓存压缩直接消费这些分段，按原有 64 MiB 边界结束各压缩片，不拼接完整未压缩正文；编码后释放已消费的中间表行。分段结果与既有规范 JSON 逐字节一致，共享引用仍由表解码器恢复。生产解码入口取得输入所有权后释放已解析的传输正文，并在恢复对象时逐行释放中间表；可复用的通用解码入口默认保留输入。布局的摘要依赖不变；开发契约统一为 v1，SQLite 物理 schema 保持 v1。批次之间让出任务，取消后不发布部分结果。格式、记录引用与原有字节预算继续校验。

解压直接写入经过总长度校验的最终缓冲，避免解压分片与拼接结果同时驻留。JSON 批次使用可复用的 UTF-8 工作区补齐数组边界，不再复制已解码的大字符串；对象恢复复用每种字段形状的键值对工作区，再由原生对象构造器创建独立结果，保留原型同名字段的数据语义。支持 `ArrayBuffer.transfer` 的运行时在消费完成后主动释放独占字节存储；借用切片和不可分离的缓冲保留原有回收路径。该机制不触发产品 GC，也不释放原始来源或仍需查询的压缩证据检查点。

识别失败可保存有效来源域；投影失败可保存有效来源/实体域，不写完整导航。PARTINDEX 伪根不再进入新的来源域和物理目录，未引用的旧模板文件不形成新的物理 occurrence；真实引用的有效模板继续复用。完整来源压缩体可按源身份与修订恢复时，将压缩检查点和覆盖摘要转移给会话客户端，收齐测量尾消息后终止空闲证据 Worker，释放其堆容量。元数据和未驻留详情查询不重启 Worker、不解码；显式物化才恢复，同一修订的连续请求复用索引。不能重建的局部证据继续保留，解析覆盖不因释放详情而变成未解析。

桌面和 Android 打开数据库时先读取 user_version：只有空的新库可以初始化为 v1，不匹配版本或已有的无版本开发库明确拒绝，不覆写版本号、不迁移。开发者删除旧开发库/缓存后重建。

Android 导入时登记源 SHA。浏览私有工程时核对登记身份、文件大小、magic 和本进程已观测的文件状态；状态变化拒绝继续使用当前缓存。文件状态有容量上限，删除工程时释放。显式重建来源缓存时继续验证源身份。

### 先发布、后写缓存

工程实体构建完成后先提交 `engineeringSources/snapshot/navigation`，再进入 `finishBuild → saveResult`。缓存编码/写入失败只改变 `engineeringCacheStatus`，不回滚已发布模型；工程切换或取消后，迟到的缓存结果不得提交。

保存按 `sources → entities → navigation` 逐域请求 Worker 编码：

- Worker 的 `encode-cache` 绑定 `buildId`，并要求请求域等于当前 `plan[0]`；
- 编码成功才 `plan.shift()`，失败清空 plan；
- 每域写入结束后在统一清理路径释放独占传输缓冲，成功、失败及取消都释放，再编码下一域；会话为按需来源恢复保留一份有效来源压缩体（空闲时由客户端持有），不保留实体或导航压缩副本；
- 缓存存储在等待来源提交、等候同一文件写入及收到编码结果后检查会话与构建身份。已进入原生端的写入按文件顺序交接，迟到完成只结束旧请求。原生端在原子替换前复核源 SHA，失败清理本次临时文件。
- 最终导航通过组成增量返回 Worker；若主线程复制或修改了应保持不变的来源树、清册或搜索结构，投影校验失败时跳过导航域，标记 `partial` / `navigation-projection-unavailable`。保留已发布视图与已写来源、实体域；不把未完成的 Worker base 当成完整导航回退写入。实际编码或写盘失败仍标 `error`。

Engineering 输入载体限制为每批 8 MiB / 256 文件，批次数不是会话总内存上限。载体只读取一次，按请求解码条目；同批尚有未消费或失败条目时，已读取的 ArrayBuffer 仍可能驻留。物理抽取后仅保留识别所需 FAM 载体，物化后清空批次和逐文件输入，抽取失败则立即清空；取消由所属 Worker 终止释放。该边界不证明大站峰值已受控，仍需原生进程树与 Worker 堆的本地采样。

### 分片与上限

单域 JSON 超过 64 MiB 时按 64 MiB 分片独立 gzip；压缩体上限 384 MiB，解码后总 plain 上限 1 GiB。分片只在编码/恢复时存在，不改变 artifact 身份、来源 SHA 或域版本。读取时校验每片长度、顺序、总 plain 大小和 gzip 边界，任何一片缺失/损坏按整域失败处理。

### 恢复判定

- `sources`、`entities`、`navigation` 分别尝试；缺失/损坏的域按依赖重建，不删除其他有效域。
- 只有实体和导航都命中时才标 `hit`；仅来源恢复（实体/导航仍需重建）标 `partial`，并写入明确原因。
- 导航只持久化具备全部 IFC 范围且投影完成的树；部分 IFC 范围、空间投影未完成或组成覆盖率不足时不写导航缓存。
- 来源恢复后仍校验来源清单/IFC 清单与域版本；只有来源文件存在不足以证明完整命中。

### 原子性与暖恢复顺序

- **原子文件**：每个缓存文件有独立头、源 SHA 和完成凭据；先写临时文件，校验后 rename。工程来源、实体、导航各自独立，不能把部分写当成完整发布。
- **来源域**：原值/字段形状去重表保留 FAM 原行、重复字段、occurrence 地址和 IFC 空间上下文；缺条目/解析失败时不写完整来源凭据。
- **实体/导航域**：绑定来源内容摘要；来源有效而实体规则变化时，只重建实体和导航，不重解析 IFC 或重编几何。实体快照未变时导航可独立重建。
- **DEV 域**：模板和目录分别原子提交；manifest 损坏使几何域失效，但不删除有效语义域。单 DEV 坏 GLB 可局部回退原始几何。大 DEV 的装配子树部分只在 Worker 内存中存在，合并后仍写同一 DEV 模板键；部分不拥有独立持久化身份。L0 生成即持久化；L1 只在选中/显式提升或淘汰后再次请求时写入；L2、空、unsupported 与 source-invalid 终态默认不持久化。
- **DEV 派生文件耐久性**：模板与目录仍用同目录临时文件和原子 rename 替换，保留源 SHA/版本校验。它们可由原始 GIM 重建，因此不再对每个产物强制 `fsync`；断电后若某条派生文件缺失或校验失败，按该条目失效重编。语义 SQLite 的事务与原子发布契约不变。吞吐收益及断电恢复需要本地验证。
- **IFC 域**：bim-lod 远景产物、区域模板、按需属性分别缓存；远景 HIT 跳过源读取，近景 HIT 跳过源模型和对象求值；源 SHA 改变拒绝近景。
- **暖恢复顺序**：物理来源目录独立恢复并发布给几何；来源→实体→导航按依赖恢复，与几何/IFC 并行，不以识别/投影完成作为几何前置。任何一步失败只影响该域，不能回滚已合法提交的其他域。

匿名 B1-3 裸 7z 已完成一轮原生冷暖：SQLite 核心冷发布和暖恢复均通过。B1-4 的完整冷暖、重复运行内存回落与认可基线仍待验收；单组成功和 Node/Worker 候选不能替代完整矩阵，见[问题与限制](../open-issues.md)。

## 失效规则

| 变化 | 应失效 | 不应失效 |
|---|---|---|
| 源文件 SHA/大小变化 | 全部工程域 | 其他工程 |
| 分类规则/目录、标准词汇或参与识别的来源映射版本变化 | 工程实体、导航 | 来源、DEV/IFC 几何 |
| 来源适配/IFC 外露变化 | 工程来源、实体、导航 | 已完成的 DEV 几何 |
| DEV 模板/primitive 版本变化 | DEV 几何、DEV LOD 目录 | 变电语义、Spatial、IFC 域 |
| Spatial 解析/宿主规则变化 | Spatial 快照 | 变电语义、DEV 几何 |
| IFC 浏览 LOD 策略变化 | 远景/近景/属性对应键 | DEV 几何、工程实体 |
| UI 展示变化 | 视图状态或无需缓存 | 工程数据/几何 |

识别字段投影清单的内容指纹纳入变电 Spatial parser 契约；新增字段不能复用缺少这些字段的来源/Spatial 缓存。分类、部件宿主和 grain 策略只影响实体/导航指纹，物理目录与几何模板独立。协议仍为 v1。

旧格式直接失效重建，不提供迁移、旧快照读取或历史兼容分支。缓存损坏只删除受影响域；删除工程时再清理该工程全部缓存。

## 诊断

缓存状态至少区分：`none`、`miss`、`hit`、`partial`、`saving`、`saved`、`error`。诊断需包含域版本、源 SHA、条目/节点计数和失败原因，不能用一个布尔值代表全部恢复。

相关实现：[projectCacheService](../../desktop/src/services/project/projectCacheService.ts)、[engineeringCacheCodec](../../desktop/src/infrastructure/cache/engineeringCacheCodec.ts)、[substationSpatialSemanticCache](../../desktop/src/features/substation/runtime/substationSpatialSemanticCache.ts)、[devSpatialCatalog](../../desktop/src/services/dev-geometry/devSpatialCatalog.ts)。

工程组成投影只持久化路径、归属引用与推断状态，不包含 `evidence` 投影依据数组。导航 JSON 位于工程导航派生文件，SQLite 提供工程身份授权，没有独立的投影依据列；原始来源证据与实体识别字段保持各自契约。

巡视的 IndexedDB 按源 SHA、工程与几何策略隔离。冷进按距入口最近的模板安排来源组，同一 IFC 的请求完成后再切换驻留模型，组内保持距离次序，至多两条来源同时准备，Worker 继续服从共享几何调度。全覆盖完成后发布可行走场景。进入巡视时保留最近四个工程来源，替换旧来源或移除工程缓存时一并清理对应场景、范围与 BVH。每场景碰撞资产按缓冲长度和节点数估算 512 MiB 写入预算，超出后仍编译场景供本次使用。读取缓存时检查放置范围、矩阵、缓冲形状和 BVH 分支，不遍历顶点重算几何。坏条目回到来源重建。

## 相关文档

- [系统架构](../architecture.md)
- [打开与生命周期](lifecycle.md)
- [工程实体运行时](engineering-runtime.md)
- [DEV 几何运行时](dev-geometry.md)
- [IFC 运行时](ifc-runtime.md)
- [验证](../validation.md)

正式发布 1.0 前，自有缓存/传输/目录契约固定 v1，不按每轮改动递增，也不兼容旧开发布局；开发者删除旧开发库和派生缓存后重建。源 SHA 仍是来源身份，SQLite 物理 schema 保持 v1。

来源 occurrence 的关系类型随来源快照保存；中立组成证据由来源图索引派生，不另存几何地址。开发版来源结构变化后由开发者删除旧来源/实体/导航缓存并重建，域契约仍固定 v1，独立物理目录和几何模板不因该语义证据变化失效。

从缓存管理页删除工程时，SQLite 索引和巡视 IndexedDB 各自尝试清理。巡视库被其他窗口占用时，界面报告已删除的索引和剩余的巡视缓存。
