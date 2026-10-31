# 变电模型树“业务树”选项卡实现

## 范围

本文描述变电模型树三个选项卡中“业务树”的当前实现：输入身份、构建流水线、层级与排序、归属证据、选择与聚合、缓存契约及验证边界。规则版本为 `business-tree-v5`，快照正文契约为 `business-snapshot-v3`。用户可见的导航说明、项目结构与通用交互以[软件规格](../software-spec.md#导航视图)为准，缓存域总表、打开生命周期和选择提交权以[架构](../architecture.md)为准；本文只补充开发中的实现细节与数据契约，不重复这些内容。

业务投影是只读派生事实，不是物理模型、设备台账或工程量。它不生成几何、不修改 DEV/IFC 物理种子，业务树本身也不请求 L2 精化。

## 入口与三个选项卡

- 工程打开后 `AppState.substationNavMode` 默认 `'business'`；`currentCbmTree` 就绪即显示业务树，空间索引不可用时不影响业务树。`desktop/src/app/state.ts` 的 `businessTree`、`businessTreePending`、`businessTreeInputsReady`、`businessTreeCacheStatus` 等字段驱动渲染与质量标签。
- `desktop/src/ui/cbmTreeView.ts` 在业务/来源模式下渲染“业务树 / 来源 / 空间”模式条：业务树取 `getBusinessTree`，来源模式显示原始 CBM 树，空间模式需要 `substationSpatialIndex`，否则按钮禁用。
- 进入空间模式后模式条变为“业务树 / 空间 / 功能系统”；“功能系统”是缺少有效空间包含关系时的既有降级视图，不属于本文的业务投影。该模式条集合变化是已登记的导航一致性限制，见 [O-12](../open-issues.md)。
- 三个视图都通过 `beginSelection` 和选择守卫提交结果，共用属性抽屉；业务树的搜索命中和选中行显露由 `desktop/src/ui/businessTreeView.ts` 的 `revealBusinessTarget` 展开祖先、类别组和虚拟窗口。
- 冷构建首次渲染先安装 CBM 基础投影，FAM 与 IFC/Spatial 就绪后在后台补全；暖路径直接安装已校验快照。完整投影在同一只读工程会话内保持不变。

## 数据来源与身份

| 来源 | 输入 | 在投影中的作用 |
|---|---|---|
| CBM | `CbmNode`、完整 occurrence 路径、`systemNames`、`devPath`、`ifcFile`/`ifcGuid` | 对象骨架、工程上下文、DEV 物理根、直接 IFC 关联 |
| FAM | 语义发布后的 `FamSourceProperty` 原行，按 `famPath` 与 `BASEFAMILY*` 引用匹配 | 工程中名称、类型标签、系统/运行电压 |
| Spatial | `SubstationSpatialIndex` 的对象、空间节点、`linksByIfcObjectKey` | IFC 对象合并、建筑/楼层、宿主与分解关系、几何范围 |
| DEV | `PARTINDEX` / `DEV_SUBDEVICE` 子节点 | 物理根的对象别名，不产生第二个几何 seed |
| 几何证据 | 已显示 IFC 表示的包围盒、DEV occurrence 范围 | 材料/构件归属的推断输入，不重新解析 IFC |

身份规则：

- 业务对象键为 `business:cbm:<encodeURIComponent(path)>` 或 `business:ifc:<encodeURIComponent(key)>`；区域和单元使用独立键，成员按单元/区域/域/根聚合。
- `objectBySource` 把 CBM 路径、IFC 对象键、宿主特征键映射到唯一业务对象；合并只依据来源事实，不按数组序号、名称相似或邻近坐标猜测。
- IFC 对象只通过 `linksByIfcObjectKey` 的 `cbmPath` 与 CBM 合并，且仅当候选集合大小为 1；多个候选保留为独立 IFC 对象并记录“IFC 对象存在多个 CBM 候选”，不取第一个。
- `ifcRefs` 保存 `modelId`、大小写敏感的 `globalId` 和 `expressId`，顺序与 `ifcKeys` 一一对应；快照编解码会校验该顺序与模型清单成员关系。
- `IFCDISTRIBUTIONPORT` 不进入业务对象；`IFCOPENINGELEMENT`、`IFCVOIDINGFEATURE` 等开洞/特征不独立成资产，作为宿主的 `featureKeys`。无独立几何的门窗仍保留为对象。
- CBM 叶子名称优先取非占位的“工程中名称/设备名称”，其次 DEV 符号名、CBM 名称、FAM 名称标签、路径；“备用/预留”作为括注保留。

## 构建流水线

1. **CBM 基础投影**：`desktop/src/gim/businessTree.ts` 的 `buildBusinessTree(root, fam, null)` 同步遍历 CBM。具备 `devPath` 或 `ifcFile`+`ifcGuid` 且非装配子节点的节点成为对象；显式系统上下文、FAM 名称与标称电压生成区域/单元和“明确/未确定”状态。此阶段不读 IFC 对象、不计算空间归属。
2. **FAM 发布**：语义缓存已完成 FAM 发布时调用 `businessFamiliesPublished`，复用 `raw_property_json`，不二次扫描源文件；若已有完整投影，只标记输入就绪，否则丢弃旧投影与 Worker 并允许重建。
3. **后台补全调度**：`desktop/src/services/businessTreeService.ts` 仅在 `businessTreeInputsReady`、IFC 后台不 pending、DEV 基础表示结算后启动 Worker，未满足时每 100 ms 重试。传送给 Worker 的 CBM 已裁剪为仅保留 `BASEFAMILY*` 原始字段；FAM 只保留名称/类型/电压列；Spatial 传对象、节点、链接与几何证据。
4. **完整投影**：`desktop/src/services/businessTreeWorker.ts` 在 Worker 内调用同一领域函数，构造临时 `objectByKey`/`nodeByKey`/`linksByIfcObjectKey`，返回时清空 `cbmByPath`；成员映射重建和空区域/单元整理也在该领域构建中完成。主线程在会话与缓存身份仍有效时重新绑定原始 CBM 节点引用并提交 `businessTree`。
5. **不重解析 IFC、不触发 L2**：Worker 输入来自既有 Spatial 索引、已显示表示和 DEV LOD 目录；`desktop/src/services/businessGeometryEvidence.ts` 的 `collectBusinessGeometry` 只读取现有包围盒、连接端点和模型单位，不做三角化、场景遍历或新 IFC 解析。

失败与竞态：Worker 出错只清 pending 并记录错误；工程切换会使旧结果失效，迟到消息和异步高亮均以会话代次与选择请求身份拒绝。Spatial 模型清单不完整（解析错误、模型数不符、缺少模型身份）时保留可见投影但不写完整缓存。

## 层级、排序与虚拟窗口

树根为工程名（`business:root`），下分“安装工程 / 建筑工程 / 其他对象”三个域；域下为区域、功能单元、对象叶或按类别折叠的组。

安装工程区域顺序由 `compareBusinessRegions` 固定：主变压器系统 → 电压区域（电压从高到低）→ 无功补偿 → 站用电 → 电缆及接地 → 二次系统 → 其余；同电压按名称自然排序。区域键包含显式配电区域名时保留该名称，否则显示“N千伏配电装置区域”。

安装单元顺序由 `compareBusinessUnits` 决定：出线 → 进线 → 母线设备间隔 → 母联 → 分段 → 其他，同类按数字自然顺序。母线各段在同一电压区域内合为一个“母线设备间隔”；母联、分段独立保留；缺少区域电压证据的母线组显示“待确认母线归属”，柜内母排保留其设备单元而不并入母线间隔。主变单元按“N号主变及其附件”命名，源内无编号时使用“主变单元（源未编号）”，不与邻近编号单元合并。

对象顺序由 `compareBusinessObjects` 决定：主变/变压器本体优先，中性点设备按电压降序，设备/附件次之，其他对象最后；再按名称和键自然排序。UI 直接展示设备、附件和 `other` 对象，其余类别按“构筑物及设施 / 基础 / 给排水 / 照明 / 消防 / 建筑构件”等折叠组展示；若单元标题本身就是该类别（基础按“...基础”匹配），不再加一层组。

建筑工程区域按实际建筑名或站区设施组织。建筑内按楼层（`X m 标高层`）、给排水、照明、消防并列；明确站区设施（电缆沟、构架、道路、围墙、大门、事故油池等）使用独立区域，不因位于楼下被收进楼层；基础按设备基础、建筑基础、其他基础分组，无建筑或主变归属的基础落在“基础”站区区域。无名称的匿名建筑只能生成编号占位或留在站区，不能恢复缺失名称。

无法确定间隔的对象保留在有依据的区域或“安装区域待确认 / 待分类”；“待确认”是归属状态，不形成独立树层。三个域的空区域、空单元在构建结束时删除。

大分支复用 `desktop/src/ui/virtualOutline.ts`：某层超过 500 个逻辑行才启用虚拟窗口，行高 30 px，渲染 100 行并前后各预取 10 行；展开状态与嵌套层级在逻辑行中保留，滚动时按帧回收 DOM，支持方向键、Home/End 与搜索显露。小分支仍直接懒渲染。

## 归属状态与证据

| 状态 | 含义 | 产生方式 |
|---|---|---|
| 明确 `confirmed` | 有工程名称、显式系统/间隔上下文或明确建筑名称/宿主 | CBM/FAM 事实直接成立，或唯一主变本体建立独立单元 |
| 推断 `inferred` | 依据唯一几何范围、端点集合或受限平面规则 | 材料/构件/基础/匿名建筑的唯一范围归属 |
| 共享 `shared` | 明确属于站区共用系统或跨间隔连接 | 共享接地系统、电缆敷设系统、区域连接材料 |
| 待确认 `unresolved` | 只能确定区域或专业，间隔所有权证据不足 | 保留区域、候选和原因，不强行挂接 |

每个对象的 `assignment` 保存状态、单元键、证据数组、原因，以及可选候选（平面距离）和关联单元。证据标记直接说明事实类型，例如 `source-xy-metres`、`unique-bounds-overlap`、`unique-geometric-enclosure`、`IFC connection endpoints`、`architectural-footprint`、`named-building-or-storey`、`source-main-transformer-type`、`unnumbered-primary-unit`、`foundation-type`。候选距离是“对象中心到候选范围”的源 XY 平面距离，不代表准确率。

规则要点：

- **电压**：从 FAM/CBM/名称提取标称值，只接受唯一且属于常用电压集合的值；范围写法（`≥`/`≤`）不作为等级证据；设备额定 12 kV 不建立 12 kV 配电区域；多值冲突置 `voltageConflict`，阻止“明确”。
- **二次系统**：保护、测控、通信、直流、计量、录波、辅控、UPS 等上下文或名称优先于电压，柜内对象不因名称含 220kV 被并入配电装置。
- **主变**：从“N号主变”及上下文识别编号，排除进线/出线/母联与测控保护柜；独立 IFC 主变本体可在与既有主变单元平面范围相差不超过 1 m 且与次近候选相差至少 2 m 时复用该单元，否则建立“源未编号”单元。
- **建筑**：只接受真实建筑名或明确建筑/楼层宿主；导出器的 `IFC*#`、`Default*`、`Building`、总平面等匿名容器不作为建筑身份。建筑体按 XY 范围连通（0.2 m 重叠容差）合并跨文件楼层；无名称但成员 ≥10、包络面积 ≥20 m²、高度 ≥2.5 m 的连通体才生成编号建筑物或唯一电压的配电楼占位；仅当电压配电楼可由 GIS 布置区分时才按电压拆名。
- **站区设施**：电缆沟、构架、道路、围墙、大门等设施类型优先于空间包含；普通“支架”仍可归建筑，泛化的“所有支架均为站区设施”规则未采用。
- **材料**：显式归属永不被覆盖。唯一完整包含 → 推断；唯一兼容范围相交（导线/电缆还须细长）→ 推断；绝缘子与唯一母线范围相交 → 跟随母线；导线短接引（平面跨度 ≤12 m 且仅与一个兼容主设备范围相交）→ 推断；长导线跨越同一区域多个间隔 → 共享并保留关联单元；连接端点全部属于同一单元 → 推断，跨区域端点 → 待确认并保留关联单元；只有区域包络 → 待确认。
- **固定平面规则**（range / margin / maxSpan，米）：导线 8/2/12、绝缘子 6/2/12、金具与套管 4/1.5/8、设备 3/1.5/20、构件 8/3/20。这些是保守推断边界，不是标定后的准确率。
- 建筑归属由 `desktop/src/gim/businessBuildings.ts` 在有 Spatial 时覆盖初步结果；材料与设备由 `desktop/src/gim/businessOwnership.ts` 在建筑之后执行，避免基础在建筑与主变之间被错误吸收。范围合法性、平面距离、包含/相交与并集谓词由 `desktop/src/gim/businessGeometry.ts` 提供，所有距离均为源 XY 平面米制。

`ownerKey` 允许对象沿 IFC 分解向宿主继承归属，最多 64 层，且只继承明确/推断状态；电压冲突或多 CBM 候选不继承。宿主特征只登记在宿主对象上。

## 选择、搜索与聚合操作

- `desktop/src/services/businessTreeSelection.ts` 以成员身份集合驱动选择：区域/单元/域/根点击取出 `members`，对象点击取自身。选择前先校验投影身份与工程代次，再发 `beginSelection({kind:'business',key})` 并清除上一次 DEV/IFC 高亮。
- 选中集合收集 DEV 物理根（非装配子节点）、快照 `ifcRefs`、CBM 上的 IFC 文件/GUID、Spatial 精确 `globalId`。IFC 精确身份使叶子对象在完整 Spatial 恢复前也能高亮和近景。
- 单个被选对象有 CBM 路径但无 IFC 引用时，走既有 CBM 节点检查器，再把“业务归属”段插入关系页；其余情况打开业务检查器，显示对象数、设备实例数、IFC 引用数、四种状态计数、归属依据、原始上下文和候选距离。
- 聚合按钮为“定位 / 仅显示此组 / 恢复显示”。定位合并 Fragment、Regional 及已加载 DEV/MOD 组的包围盒；选中单个长构件时（最大边 >30 m 且超过次边 10 倍）默认只取中心 ±6 m 的近景，按钮改为“定位整件”。隔离通过 `onlySelected` 和 `selectionVisibility.sync` 生效，不使用伪造 CBM 节点或 DOM 遍历。
- 搜索索引来自 `businessSearchItems`：排除未确定区域/单元，对象副标题包含类别、状态、工程上下文、CBM 路径和 IFC 键。命中后逐级展开祖先、类别组，并在虚拟窗口中显露目标行。
- 所有高亮、相机移动和属性写入在提交前检查 `guard.isCurrent()`；工程切换、重新选择或请求过期都不会提交旧结果。

## 缓存与失效

快照是业务域唯一的派生产物，不新增 SQLite 表，不复制 CBM 图或几何：

- 路径为 `__derived__/business-tree-v5/<source-sha>.bin`，由 `desktop/src/services/businessTreeCache.ts` 通过既有原子文件桥读写。
- 正文只含对象、区域、单元：固定列 + 共享字符串表，对象含来源路径、IFC 精确引用、宿主特征、`ownerKey`、电压、上下文和完整归属证据；`members`、`objectBySource`、`cbmByPath` 在加载时重建。
- 头部为 4 字节长度前缀加 JSON：`contract`（快照版本 + 规则版本 + Spatial 语义版本 + Spatial 解析版本）、源 SHA、语义版本、模型清单摘要、`complete`、`encoding:'gzip'`、展开/压缩字节数和正文 SHA；头部不超过 4096 B。
- 正文和展开体积上限均为 64 MiB；解压逐块累计并在超过声明长度或上限时取消。列数、字符串引用、区域/单元引用、对象来源、IFC 身份、重复来源、候选/关联单元和跨表引用均在反序列化时校验，失败只视为业务缓存未命中。
- 发布条件：投影完整、FAM 已发布、Spatial 模型清单无解析错误且与当前 IFC 条目一致；否则不写快照并在质量标签显示未完成原因。写入失败只影响业务缓存状态。
- 暖路径：原生源/语义校验通过后，`prefetchBusinessTree` 先并行读取并解压快照；`restoreBusinessTree` 在核心 CBM 恢复后按完整 occurrence 路径绑定原节点，校验会话与最终模型清单后才安装。该过程不做分类、不启动业务 Worker。
- 完整投影在只读会话内不可变；迟到的 FAM/Spatial 发布不会重算成员或搜索投影。快照缺失、损坏、源 SHA/语义/模型清单/契约变化时只重建业务域，其他合法语义、几何、Spatial 和 Fragments 缓存保持。
- 质量标签只显示当前业务缓存状态（准备中、未完成、对象数、命中/保存中/保存失败），错误详情放在 tooltip。

## 边界与限制

- 没有人工审定真值集。推断、共享与待确认数量不能当作准确率，也不能用“待确认减少”证明归属改善；材料与匿名建筑的未决项由 [L-12](../open-issues.md) 跟踪。
- 性能未达完整门槛：默认业务树的当前视图回退由 [O-11](../open-issues.md) 跟踪，业务树构建与恢复数据只是本主机暖路径观测，不能替代四站冷开、低配或端到端 SLO。
- 业务投影不改变物理几何 seed、可见性、IFC 空间关系或源文件；树内归组不写回 CBM/DEV/FAM。
- 业务对象数不是设备台数：DEV 装配子件是别名，IFC 端口与开洞特征不独立计数，IFC 产品也不等价于工程量。
- 运行时不调用纯空间距离推断入口，只使用有界平面规则、连接端点和显式归属；未标定候选保持待确认。
- 匿名导出器名称无法还原真实建筑名；站区设施、共享接地和电缆敷设系统按用途保留，不强行拆成独立间隔。
- 暖恢复不重新分类，因此升级规则后必须重建业务快照；已有快照只保证当时的事实一致，不保证与更新后的规则一致。

## 验证状态

当前四站（`substation01`–`substation04`）的桌面暖路径记录为 `output/business-tree/review-v5/native-verification.json`，汇总 `passed=true`：

| 样本 | 业务对象/根成员 | 应保留 IFC 产品缺失 | 交互目标 | 业务快照 |
|---|---:|---:|---:|---|
| substation01 | 4711 / 4711 | 0 | 9 | saved→hit，摘要一致 |
| substation02 | 55131 / 55131 | 0 | 3 | saved→hit，摘要一致 |
| substation03 | 9734 / 9734 | 0 | 3 | saved→hit，摘要一致 |
| substation04 | 7758 / 7758 | 0 | 3 | saved→hit，摘要一致 |

口径与局限：

- 这是同一台开发主机、已具备合法核心语义、L0 与 IFC 缓存时的暖路径与业务补建记录（所需 L1 仍可能局部计算）；不是全冷打开，不是四站三轮性能矩阵，也不是准确率或端到端 SLO。s02 仍有 561 个空源与 34 个 DEV 失败，业务树照实保留，不当作成功几何。
- 交互目标合计 18 个，均验证搜索显露、当前请求的非空高亮、相机定位、隔离与恢复；非空高亮集合不等于 GPU 已呈现，也不证明对象归属全部正确。
- 业务对象数不等于 IFC 主对象数：CBM 与 IFC 的唯一关联会合并为同一对象，端口与开洞特征不计数；核对项是“应保留 IFC 产品缺失为 0”，该列不证明归属正确。
- 快照体积与绑定阶段剩余等待只在更早的对象集上测过（约 0.25–1.9 MB、14–97 ms 量级），当前修订未逐站重测，故不与上表对象数配对，也不能当作完整打开或缓存读取开销。
- 快速测试 130 个文件、1169 项通过、3 项既有跳过；`desktop/src/ui/__tests__/substationFunctionalTreeView.test.ts` 的 26 项测试覆盖业务与功能树，其中业务部分包括 600 成员虚拟窗口、平面 XY 归属、母线合并、匿名建筑拒绝、短接引、精确 IFC 身份；快照往返与校验、业务 Worker 时序另见 `desktop/src/services/__tests__/substationSpatialSemanticCache.test.ts` 与 `desktop/src/services/__tests__/substationSpatialWorker.test.ts`。
- 四站离线领域计算约 0.2–4.3 s，仅为开发主机复用证据输入的领域耗时，不是产品打开耗时；逐站对象/根成员与 IFC 缺失核对见 `output/business-tree/review-v5/audit.json` 与 `output/business-tree/review-v5/native-verification.json`。
