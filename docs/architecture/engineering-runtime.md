# 工程实体运行时

本文件描述 v0.2 的工程实体构建、缓存和三视图发布。领域契约、分类规则和目录分别见[工程实体模型](../engineering/README.md)与[目录](../engineering/catalogs/README.md)；本文件不重复分类表。

## 目录

- [目标与边界](#目标与边界)
- [组成](#组成)
- [构建流程](#构建流程)
- [缓存与恢复](#缓存与恢复)
- [状态](#状态)
- [验证边界](#验证边界)
- [几何完成后的组成细化](#几何完成后的组成细化)
- [相关文档](#相关文档)

## 目标与边界

工程实体回答“施工、运维识别的一个整体是什么”，不回答“它在当前树里属于哪个 F 层级”或“它由哪个 Mesh 表示”。因此：

- 来源图从实际文件、CBM 引用和 DEV 装配建立，不接收旧展示树节点。
- 分类只使用中立对象证据（名称、类型、材料类型、独立功能、真实装配边）；F2/F3/F4、目录深度、空间邻近不作为类别依据。
- 几何 occurrence 由来源图独立生成；实体完成后只做成员绑定，不重新三角化。
- 视图节点引用实体 ID，不生成新实体；一个实体可有多个视图引用，计数按实体去重。

## 组成

| 模块 | 职责 |
|---|---|
| [gim/engineering](../../desktop/src/gim/engineering/) | 来源图、DEV/FAM/IFC 证据适配、来源到中立对象证据、三视图投影 |
| [engineering](../../desktop/src/engineering/) | 纯领域：分类、整体归一化、成员分区、关系、组成模板、目录 |
| [engineeringWorker](../../desktop/src/services/engineeringWorker.ts) | 在 Worker 内执行抽取/归一化/投影/编解码 |
| [engineeringService](../../desktop/src/services/engineeringService.ts) | 会话、Worker 生命周期、缓存恢复/发布、IFC Spatial 补建 |
| [engineeringSelection](../../desktop/src/services/engineeringSelection.ts) | 整体/分组/来源选择与表示绑定 |
| [engineeringTreeView](../../desktop/src/ui/engineeringTreeView.ts) | “清册 / 工程 / 来源”三页、搜索、虚拟列表、选择同步 |

## 构建流程

```text
打开工程
  → 读取 source/entity/navigation 缓存
      ├─ 来源有效：restore
      │    ├─ 实体有效：restore（不重分类）
      │    └─ 实体无效：normalize（不重读 IFC）
      └─ 来源缺失：Worker 接收来源文件
           → extractEngineeringSourceGraph（物理来源图，延迟 FAM）
           → 返回 IFC 路径 + SourceGeometryOccurrence 目录
           → 请求识别所需 FAM，再 assemble（Spatial 可用时一并传入）
           → normalize + projectEngineeringNavigation
           → 发布 sources/snapshot/navigation
           → 分域写缓存
```

### 来源抽取

0.2.3 在缓存恢复/抽取前初始化证据端口，Inventory 不等待识别。冷建先传入 CBM/DEV；`extract` 延迟 FAM，返回物理目录及识别需要的 familyPaths，随后才物化这些 FAM。未参与识别的 FAM 在显式属性查询时读取。Worker 的 snapshot/query/ensure/read 命令分别承担元数据、已物化分页、显式解析和原文字节读取；详情页同时受记录数与字节预算限制。缓存版本、源身份和修订与查询结果一起校验。

来源事实由 `collectEngineeringSources` 独立汇总。`assembleEngineeringView` 捕获识别错误，保留来源和物理目录，工程快照标记未处理；来源、组成和清册投影分别隔离错误。投影错误不撤销已发布语义或几何，不写完整导航缓存。来源和有效实体域仍可独立保存。

Worker 运行时解码只对带明确 projectionErrors 的失败投影允许覆盖不完整，仍校验保留节点的引用、边和可达性；完整投影与持久化导航继续执行严格覆盖校验。DEV 的 FAM/标准上下文查询通过来源详情入口执行，与“查看所属整体”独立；详情查询在每次异步操作后核对当前选择。

构建/缓存结束释放完整结果载荷，工程会话内保留证据 Worker，切换/关闭时终止。已解析文档、属性和索引复用；补齐与识别相关的失败 FAM 时显式重新识别，更新绑定/投影而不重新编译物理模板。该生命周期变化的真实内存/速度代价需要开发者本地复核，单元或浏览器功能测试不代表性能通过。

原始 FAM 属性解析与带类型/单位的详情物化分开：初始识别不构造全包 `SourceAttribute` 详情。显式详情物化复用原始记录，单视图上限 20,000 条/16 MiB、详情缓存合计 32 MiB，页上限 1,000 条/512 KiB；超预算明确提示原文访问。未挂入工程图的详情淘汰后可重新读取，解析历史与当前物化状态分别报告。原文字节读取受 16 MiB 预算，文本物化另限 200,000 行；这些配额不是性能通过条件。

完整 Inventory 仅在显式清单请求时返回；逐属性/文档请求按 entryRange 查已有 Map，返回范围元数据和全局计数，不重新枚举整个包。读取状态、属性解析状态和详情物化状态独立；范围响应的 inventoryComplete 表示底层清单枚举已完成，entries 仍只覆盖显式 entryRange。32 MiB 仅是详情缓存预算，不代表整个工程图/会话内存上限。

属性赋值索引按 FAM 路径及所属来源/引用 occurrence ID 去重，候选向量只读共享；共享文档的 FAM 目标路径在建索引时只枚举一次。启动不将完整候选数组序列化成 Set 键，避免大量长键插入拖住物理目录发布；候选内容在显式有界证据查询时才序列化。

生产 Worker 协商使用来源图引用帧：同 scope、同 graph revision 的后续模型结果复用主线程已有来源图，不再发送未变化的整包原文/DEV 属性；图修订变化发送完整图。客户端顺序解码，服务按 buildId 拒绝旧发布/缓存结果，释放旧构建载荷不能清除新构建。证据查询只发送有界页面，运行时 evidenceRevision 与持久化来源内容摘要分别承担会话修订和冷暖身份绑定。

`extractEngineeringSourceGraph` 从真实文件清单和 `project.cbm` 开始：

- 解析 CBM 引用/SUBSYSTEM/SUBDEVICE、DEV 的 `SUBDEVICE` 与 `SOLIDMODEL`、FAM 原始行和 IFC 文件引用。
- 保留文档、原始行、字段来源、引用状态（resolved/missing/ambiguous）、真实装配边和 DEV occurrence 地址。
- `OBJECTMODELPOINTER` 只在真实物理装配子树内找候选；不把 CBM 展示祖先当装配边。
- IFC 文件发现与 IFCGUID 对象挂接分开；IFC 外露对象由空间解析结果补充。
- 返回 `SourceGeometryOccurrence` 目录（来源 occurrence ID、模板路径、真实装配路径、累计矩阵），供几何管线立即使用。该目录在实体 `assemble` 之前已 resolve；几何可先启动，归一化不读取目录内容。

来源图有上限（默认 500,000 个 occurrence、深度 128）并响应取消；超限/循环/缺对象模型进入诊断，不用空来源冒充完整。

桌面来源输入按文件数和字节数打包为有界 Blob，Worker 一次读取整包，只在请求文件时按其字节范围解码；未引用文件的编码错误不会影响同包其他文件。包字节保留到条目消费或抽取结束，避免为未引用文件分配文本。抽取循环按已有文件数/时间预算让出；读取阶段按实际批次统计，不能与旧单文件读取分位数混合比较。实际大小超出估算时回退到单文件通道。

来源几何目录在抽取结束后立即发布。生产入口的 IFC starter 分开提供索引就绪与后台完成两个边界；实体装配只等待内存索引，来源物化屏障、缓存写入及后续展示由后台完成边界跟踪。这样避免重复装配，同时不将缓存 I/O 串到实体浏览。它不等待 Viewer/LOD；解析失败仍发布可用 DEV 部分并记录原因，切换工程拒绝旧提交。未提供 starter 的调用保留增量装配路径。

### 实体归一化

`buildEngineeringSources` 把来源记录和 IFC 外露记录转成 `ObjectEvidence`，调用 `normalizeEngineeringModel`：

- 按来源 ID 稳定排序，校验唯一性和装配环。
- 先判对象角色（source_only/container/detail/part/fragment/neutral/object），再判目录类别。
- 建立整体、待归集合、成员关系、独立对象关系和别名。
- 分区校验：每份来源恰有一个主归属，成员 disposition 与 owner 一致，独立对象不丢失整体。
- 对象自身声明和继承组织上下文分开；祖先系统名不能提供确定性主变编号、备用状态、成组或宿主关系。FAM/CBM 名称只补充其明确对应 occurrence，不跨装配下传。

详细规则见[实体与来源模型](../engineering/entities.md)。

### 三视图投影

- **工程组成**：`assignEngineeringComposition` 读取声明的系统名、空间建筑/楼层、真实宿主关系，按内置模板分配到建筑工程/安装工程；没有可靠归属的整体进入“未分类”的 DEV/IFC 轨道和类别桶。`projectEngineeringComposition` 生成树、分组计数、待归集合和已声明但无成员的分组。
- **来源**：`projectEngineeringNavigation` 按 CBM 的 F1/F2/F3/F4 与 DEV 装配生成 DEV 轨道，按每个 IFC 文件及其空间容器/外露记录生成 IFC 轨道；来源行可跳转所属整体。
- **设备材料清册**：按设备、装置性材料、构件及目录类别列整体，并展示实际组成来源。
- 三个模板独立：组成使用领域组成模板，来源由 `sourceProjection` 仅按来源组织投影，清册由 `inventoryTemplate` 按目录及子类投影。导航模块只组合结果，三者分别记录版本并建立各自搜索索引；[清册模型树契约](../engineering/inventory-template.md)定义分组、计数与选择。
- 三页共用搜索、选择、属性路由和虚拟列表；搜索只是投影索引，不是新实体。
- 视图节点 ID 与实体 ID 分离；分组计数按实体去重，不冒充台套。
- `compositionProjectionService` 将运行时范围作为显式输入交给 `services/projections/compositionSpatial`，自动细化组成路径并标注推断。此插件不修改快照/来源/表示索引；重复细化从语义视图计算，失效分组撤销选择，旧轮次和旧会话拒绝提交。

### 发布与补建

- 来源不完整时 `engineeringStatus=partial`，仍可浏览已解析部分；不写完整来源凭据。
- Spatial 尚未就绪时先在内部建立不含建筑楼层的来源和实体；模型树显示加载中；Spatial 到达后 `notifyEngineeringIfcEvidence` 触发重新 assemble，补充空间容器和外露 IFC 对象。这里等待的是 IFC 空间/外露语义，不是 Mesh、LOD 或相机。
- `engineeringBuildPending` 从来源构建开始持续到最终 enrichment 解码、发布和缓存任务结束；初次无 Spatial 的 partial 投影不能冒充最终语义。工程 Worker 的 index/traverse/sort 进度只在实际推进时续期，长时间无进展以明确错误结束。相同物理 scope 的来源记录与别名子树复用索引，避免大型工程按节点重复扫描。
- IFC 语义失败只影响 IFC 来源部分，不把已有 DEV 实体回滚。
- 工程来源 Worker 或传输本身失败时可以保留已发布的部分导航供查看，但 `engineeringFailureCode` 为终端故障，Benchmark 不把它归为样本来源缺口的 PARTIAL。
- `engineeringGeometryReady` 在来源图返回 occurrence 目录时解析；DEV 编译可早于实体完成。
- 工程切换/关闭取消 Worker、请求和缓存写槽；迟到结果按会话守卫拒绝。

## 缓存与恢复

| 缓存 | 恢复行为 |
|---|---|
| 来源快照 | 校验源 SHA、条目清单、parser 契约和完整性；命中则不重读 CBM/DEV/FAM/IFC |
| 实体快照 | 绑定来源内容摘要、实体 schema、规则版本；命中不重分类 |
| 导航快照 | 绑定来源摘要和实体指纹；校验节点可达、成员引用和覆盖；命中不重投影 |

实体/导航缺失时可只重建该域：来源有效时 `normalizeEngineeringSources` 不重读 IFC；导航可从实体和来源重建。缓存写入按来源→实体→导航独立原子文件；部分写入不发布完整标记。

导航缓存仍等待几何组成投影完成。主线程仅回传组成树、完整性标记以及按实体 ID 关联的副标题/搜索文本增量；来源树、清册和原始搜索文本复用 Engineering Worker 持有的构建结果。回传前核对未变的导航基础字段与搜索前缀，Worker 按 ID 合并后由编码入口执行完整引用、覆盖和可达性校验。请求继续绑定构建 ID、域顺序和会话；持久化正文与依赖摘要契约不变。

## 状态

| 状态 | 含义 |
|---|---|
| `loading` | 正在读取来源/建立实体 |
| `ready` | 来源完整，实体和三视图已发布 |
| `partial` | 来源有缺失/IFC 失败/空间不完整；已有部分结果可浏览 |
| `error` | 来源图或 Worker 失败，当前没有可用实体结果 |

界面质量提示同时显示“整体候选 N · 待归集合 M”和来源未完成原因；这些是候选数量，不是已确认台套数。

## 验证边界

- 纯领域单测覆盖分类、归一化、分区、组成模板和三视图投影；九工程严格样本检查来源去向和成员覆盖。
- Worker 真实浏览器检查覆盖 Blob/共享缓冲区传输、缓存恢复与取消；不替代原生 IPC、真实渲染和性能验收。
- 当前不证明逐台套人工归属准确率、所有样本的原生冷暖性能或完整持续交互；见[问题与限制](../open-issues.md) O-11 与 L-12。

## 几何完成后的组成细化

工程来源/实体快照先独立发布。已加载的 IFC RegionalIndex 提供绝对源坐标包围盒，`compositionProjectionService` 在独立 Worker 中细化建筑范围；不读取可见性，不合并实体，不增加几何 seed。楼层名、文件建筑名、系统声明与推断依据继续保留。全部 IFC 范围可用时，最终细化树写入工程导航缓存；缓存契约绑定空间投影策略版本。任一 IFC 跳过或加载失败时发布带范围缺失提示的部分树，来源/实体仍可浏览，导航不写完整缓存。关闭/切换工程终止 Worker，旧投影不能提交；重新绑定分组选择时不自动定位。

## 相关文档

- [工程实体模型](../engineering/README.md)
- [实体与来源模型](../engineering/entities.md)
- [表示与绑定](representations.md)
- [缓存域](caches.md)
- [DEV 几何运行时](dev-geometry.md)
- [验证](../validation.md)
