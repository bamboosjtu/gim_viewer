# 变电模型树“空间”选项卡实现

## 范围

本文描述变电模型树“空间”选项卡的当前实现，包括入口条件、IFC 数据来源、索引与覆盖率、树渲染、搜索定位、选择属性、缓存和已明确的使用边界。稳定的用户行为以[软件规格](../software-spec.md#变电工程)和[架构](../architecture.md#变电语义与-ifc)为准；本文只记录开发中的实现契约和验证状态，不作为新的产品承诺。

实现以 `desktop/src/gim/ifcSpatialParser.ts`、`desktop/src/ui/substationSpatialTreeView.ts`、`desktop/src/ui/cbmTreeView.ts`、`desktop/src/services/substationSpatialSemanticCache.ts`、`desktop/src/services/substationRuntime.ts` 和 `desktop/src/app/state.ts` 为准。

## 入口与可用条件

- 变电导航模式由 `AppState.substationNavMode` 控制，取值为 `business`、`source`、`spatial` 或 `functional`；默认 `business`。业务树/来源视图的模式条提供“业务树 / 来源 / 空间”，空间与功能系统视图的模式条提供“业务树 / 空间 / 功能系统”；集合不一致见 [O-12](../open-issues.md)。
- 空间选项卡依赖已提交的 `state.substationSpatialIndex`。真正的可用条件是 `coverage.hasSpatialEntities && coverage.hasSpatialContainment`：前者要求空间节点 `kind` 去重后至少两种，后者要求至少一个 IFC 构件拥有非空 `spatialKeys`（直接包含、空间边界或继承均计入）。
- 业务树/来源条只检查空间索引对象是否为空，因此索引存在但空间关系不足时，点击“空间”会在重渲染后自动降级到功能系统；空间/功能系统条直接禁用“空间”按钮，并提示“当前 IFC 未提供可用空间包含关系”。
- 空间/功能系统模式条右侧另有覆盖率质量条：索引存在且有关系时显示“空间关联 N%”，悬停同时列出未落位 IFC、坐标对象、原点矩阵、无容器和未关联对象；无关系时显示“空间关系不可用”，索引为空时显示“空间索引不可用”。
- 索引构建失败或尚未提交时不伪造空树；当前模式为 `spatial` 时降级到功能系统，否则保持现有业务树/来源/功能系统视图。缓存恢复只读取派生快照，不要求重新读取 IFC。

## 数据来源

- IFC 模型清单来自当前工程的 `IfcEntry` 列表。`modelId` 是逻辑模型身份，由 `resolveIfcModelId` 从 CBM 的 `ifcFile` 绑定（已带 `ifc_` 前缀的引用也按其自身作为模型键）；空间节点和构件都保存 `modelId`、`sourcePath` 和 IFC 原生标识。模型显示名优先取 `IfcEntry.name`，恢复缓存时退回 `entryPath` 的文件名（去掉 `.ifc`），不把内部 `modelId` 当导航标题。
- 空间实体来自 IFC 类型映射：`IFCPROJECT`、`IFCSITE`、`IFCBUILDING`、`IFCBUILDINGSTOREY`、`IFCSPACE` 分别对应 project/site/building/storey/space；`IFCZONE` 和 `IFCSPATIALZONE` 对应 zone。空间层级按 IFC 实际关系生成，缺少站区、建筑或楼层时不补造。
- 层级和归属关系包括 `IFCRELAGGREGATES`、`IFCRELNESTS`、`IFCRELDECOMPOSES`（空间容器父子关系）、`IFCRELCONTAINEDINSPATIALSTRUCTURE`/`IFCRELREFERENCEDINSPATIALSTRUCTURE`（直接包含构件）、`IFCRELSPACEBOUNDARY`（空间边界关联，不冒充直接包含）、`IFCRELVOIDSELEMENT`、`IFCRELFILLSELEMENT`、`IFCRELCONNECTSPORTTOELEMENT`（开洞、填充和端口宿主链）。
- IFC 构件按产品类型白名单和前缀识别，并纳入被 IFC 空间包含关系明确引用的记录；`*TYPE` 不进入构件图。属性集、工程量、材料、分类、类型和组记录只进入资源计数，不作为导航对象。端口和洞口保留在对象图中并参与宿主继承，但被排除在 CBM 身份匹配之外。
- CBM 关联只在同一 IFC 模型内按大小写敏感的 `GlobalId`（包括合法的尾部 `$`）精确匹配。匹配成功且对象有空间时为 `confirmed`，证据为 `ifc-contained` 或 `ifc-boundary`；匹配成功但无空间容器时为 `confirmed` + `unlocatedReason: no-spatial-container`，证据为 `ifc-guid`；未命中为 `unresolved` + `ifc-guid-not-found`。
- 没有 IFC GUID 但有 DEV 路径和有效 4×4 矩阵的 CBM 节点生成 `inferred` + `cbm-transform` 链接；没有有效矩阵时为 `unresolved` + `no-transform`。`F4System`、`PARTINDEX`、`DEV_SUBDEVICE` 即使没有任何 IFC/DEV 引用也保留为 `unresolved` + `no-ifc-guid`，不从导航消失。
- CBM 变换使用与几何加载一致的累积规则：`F4System` 自带的矩阵被视为父链累积值，`PARTINDEX` 无矩阵时继承父级，`DEV_SUBDEVICE` 的矩阵按相对父设备相乘。来源图纸名称和来源 IFC 文件来自 `FileDevRelation`，按规范化路径优先、文件名兜底匹配，歧义时保留全部候选。

## 索引与覆盖率

`SubstationSpatialIndex` 由 `models`、`nodes`、`objects`、`links`、`rootNodeKeys`、`coverage`、`placementGroups`、`identityPlacementLinks` 以及运行时索引 Map 组成。`linksByCbmPath` 保证一个 CBM 路径一条主链接；`linksByIfcObjectKey` 保留一个 IFC 构件被多个 CBM 节点引用的一对多关系。

覆盖率字段按以下口径解释：

| 字段 | 当前含义 |
|---|---|
| `hasSpatialEntities` | 空间节点 `kind` 去重后的种类数 ≥ 2，不是“存在任意空间节点”。 |
| `hasSpatialContainment` | 至少一个 IFC 构件拥有非空 `spatialKeys`；直接、边界和继承关系都会使该值为 true。 |
| `hasSpaces` | 索引中存在 `kind === 'space'` 的节点。 |
| `spatiallyContainedCbmCoverage` | 同模型精确 GUID 命中且对象有空间的 CBM 候选数 / 直接 GUID 候选数；没有直接候选时，分母改用带 DEV 或 IFC 引用的 CBM 节点数，此时推断链接不进入分子。 |
| `uncontainedIfcObjects` | 全部 IFC 构件中 `spatialKeys` 为空的个数，`objects.length - containedObjectCount`。 |
| `positionedAssets` | `confidence: inferred`、`placementKind: translated` 且带坐标的链接数。 |
| `identityPlacementAssets` | `confidence: inferred` 且 `placementKind` 为 `identity` 或 `rotated` 的链接数，即矩阵没有有效平移。 |
| `confirmedWithoutSpatialContainer` | 精确 GUID 命中、但对应 IFC 对象没有空间容器的 CBM 候选数，按候选链接计。 |
| `unlocatedAssets` | `confidence: unresolved` 的链接数，涵盖无 IFC GUID、无有效矩阵和 GUID 未命中。 |

索引不能从坐标、几何或名称推断 IFC 空间归属。对象没有 `spatialKeys` 就是未落位；CBM 矩阵本身只能提供 `inferred` 资产证据，不能写入 `spatialKey`。GUID 在模型内重复时对象身份不参与匹配，CBM 链接保留为未关联；CBM 指向端口/洞口或引用跨模型时同样不猜第一个对象。覆盖率百分比只描述 CBM 候选命中 IFC 空间的比例，不代表全站对象都被空间覆盖，也不代表对象归属准确率。

不能由该索引推断的事实包括：

- 构件在几何上是否真实位于某空间；空间归属只来自 IFC 包含、边界或继承关系。
- 除同一模型精确 GUID 之外的 CBM↔IFC 对应；名称相似、坐标邻近或列表顺序都不参与。
- 未关联设备的具体楼层或房间；原点矩阵和坐标网格不提供房间级归属。
- 全站对象等价；未落位、未关联和仅有坐标的对象仍分别留在质量分组。

## 树层级与渲染

- 首行是工程空间根（`spatial:project-root`），摘要包含模型数、空间节点数和构件数；存在未落位构件时追加其数量，存在模型资源时追加资源数，含 IFC 空间时追加“含空间区域”。根行默认展开，其他分组默认折叠，首屏不会生成大型 IFC 的完整行集。
- 根下第一组是“IFC 空间模型”，按来源模型分组；每个模型组显示模型名和空间根、构件、CBM 关联与资源摘要。即使模型解析失败或没有 Project/Site 根，也保留该模型行，便于从稳定的能力入口查看原因。
- 模型组下按 IFC 实际层级显示站区、建筑、楼层、空间等容器；同一模型有多个并列根时共用去重集合，避免扁平化后的楼层/空间重复绘制。
- 通用包装层不生成导航行：名称为“项目编号/项目/工程/默认/缺省/站区/建筑/楼层”、`Default`、`Project`/`Site`/`Building`/`Storey`、`IFCProject #...` 等或空名称的节点被视为导出器包装；其有意义的后代、直接构件组和关联设备组提升到当前宿主，原始节点仍保留在索引、搜索父链和来源证据中。有业务名称的同类型节点不会被扁平化。
- 容器行的副标题包含 IFC 类型、模型显示名、子树 IFC 构件数、子树 CBM 关联数、直接/空间边界/分解继承/宿主继承计数、标高和“空间几何已提供/未提供”。子树构件/关联数是累计行计数，直接/边界/继承计数只统计当前节点；两者都不是全站去重对象数。
- 每个容器下有“IFC 构件 · N”组，列出直接包含、空间边界、分解继承和宿主继承的构件；“关联设备 · M”组只列出 CBM 已确认并落入该空间的资产。构件行显示 IFC 类型、ExpressId、GUID、ObjectType/Tag、几何状态、空间归属方式和单条 CBM 关联；属性集/材料等计数只在对象数据提供时追加。多条 CBM 关联显示数量，避免误选其中一个。
- 关联设备行以 CBM 路径为行键，显示 CBM 实体名、来源 GUID 和“已确认”；来源图纸/来源 IFC 作为副标题追加。
- 容器、构件组和关联设备组都是首次展开才生成子行；直接容器子节点随展开生成，构件列表、关联设备列表和质量/网格列表不超过 500 项时按 200 行分页，剩余部分显示“加载更多（剩余 N 个）”，点击后继续生成下一页并移除旧的分页行，对象不会静默丢失。
- 同一分组超过 500 项时改用固定行高虚拟窗口：每屏窗口 80 行、上下额外 12 行 overscan、行高 27px，用上下占位块维持滚动高度。窗口内的方向键、Home/End 在完整源数组中移动，`__gimRevealVirtual` 可按稳定键把屏幕外目标物化并滚入视野；列表移除时清理滚动监听、动画帧和 reveal 钩子。
- “关联状态”质量组收拢四类问题：`inferred` 对象（有平移的再按坐标网格分组，网格只用于定位检索；无平移的进入“无平移坐标”组）、`confirmed` 但无空间容器、`unresolved` 未关联对象、以及没有空间容器的 IFC 构件。另有“模型资源”组按模型显示资源计数和前几类资源类型；模型解析失败时显示“IFC 模型未解析”行。
- 空间树中的模型名称、构件名称和来源信息都来自索引与当前 CBM 树/IFC 清单；`modelId` 只用于索引、Fragments 和缓存寻址，不出现在导航标题中。

## 搜索与定位

- 空间模式的搜索索引包含三类目标：全部空间节点、全部 IFC 构件、以及当前 CBM 树中真实存在的、被空间索引链接引用的 CBM 资产。空间节点副标题带 IFC 类型、模型名、构件数和几何状态；构件副标题带空间归属状态、CBM 关联数和来源图纸/来源 IFC；CBM 资产副标题带实体名、确认状态（已确认、已关联但无空间容器、位置推断或未关联）和来源 GUID。
- 搜索命中空间节点时，展开从模型分组到该节点的可见祖先链（跳过通用包装层）并发出 `spatial-node` 选择请求；有对应 DOM 行的容器会被选中，被扁平化的包装层本身没有树行。容器本身没有 CBM 选择目标，不会因为其下有设备而误选第一台设备。
- 搜索命中 IFC 构件时，展开其空间祖先链及“IFC 构件”组；若构件未落位，则展开“关联状态”和对应的无容器/未落位分组。随后按分页键消费“加载更多”或物化虚拟窗口（最多尝试 100 次）；分组中存在该构件行时选中它，随后发出 `ifc-object` 请求（未落位且只以 CBM 链接展示时不强行选中某个 CBM，仍打开 IFC 检查器）。
- 搜索命中 CBM 资产时，先展开其空间祖先链和“关联设备”组，或展开坐标网格/原点/无容器/未关联质量分组；分页显露目标行后，走普通 CBM 节点选择路径。若该键在当前 CBM 树中找不到节点，则不再凭名称或顺序补选第一个 CBM 节点。
- `resolveSpatialSearchCbmPath` 对空间节点返回 `null`；对 IFC 构件返回首个关联 CBM 路径；对 CBM 键返回对应链接的路径。该结果只用于搜索回退，不改变空间节点与 CBM 节点的身份边界。

## 选择与属性

- 点击空间容器时，先核对节点仍是当前 `SubstationSpatialIndex` 中的同一对象，再调用 `beginSelection({kind:'spatial-node', key})`。`handleSpatialSelection` 打开属性抽屉，显示空间容器概览、空间关系、来源引用和技术标识；参数页提示 IFC 属性需选中具体构件后按需读取。该路径没有隐式三维取景或几何加载。
- 点击 IFC 构件时，核对对象身份后调用 `beginSelection({kind:'ifc-object', key})`，优先打开 IFC 检查器，显示 IFC 原生字段、空间路径、对象关系、CBM 关联和来源。属性集/工程量/材质通过 `getLocalIdsByGuids` + `getItemsData` 按需读取；模型未加载或读取失败时保留基础信息并明确提示。
- 搜索命中 IFC 构件时同样优先 IFC 检查器，避免把 PropertySet、材质和 Representation 信息覆盖成 CBM 摘要；已关联的 CBM 仍在“对象关系”的 CBM 关联中可追踪，对象落入空间时还会出现在该空间的“关联设备”组。
- 点击关联设备或质量组中的 CBM 资产时，调用普通 `onNodeClick`，使用 CBM 检查器和既有几何/属性按需加载路径，不改写空间索引。
- 两种空间选择都带 `SelectionRequest` 身份和工程会话守卫；旧请求或旧工程的结果不提交。空间选择只清除旧高亮并同步树/SLD 导航，不自动请求 L2，也不自动移动相机；明确的 L2 仍只能由属性面板的用户操作发起。

## 缓存与失效

- 当前空间语义快照契约为 `substation-spatial-semantic-v3`，派生文件为 `__derived__/substation-spatial-semantic-v3.json`；解析器域版本为 `gim-substation-parser-v24`，缓存域归属见[架构](../architecture.md#当前缓存域)。两者与 CBM 语义、DEV 几何和 Fragments 域独立，CBM/FAM/几何版本升级不会自动使空间快照失效。
- 快照保存 `cacheVersion`、`sourceSha256`、`parserVersion`、`models`、`nodes`、`objects`、`links`、`rootNodeKeys`、`coverage`、`placementGroups` 和 `identityPlacementLinks`，不保存 Map；读取时重新建立 `nodeByKey`、`objectByKey`、`linksBySpatialKey`、`linksByCbmPath` 和 `linksByIfcObjectKey`。
- 快照不保存 CBM 树或 IFC 几何网格；CBM 以 `cbmPath`、IFC 以 `modelId` 和 GUID 引用，渲染时再绑定当前恢复的 CBM 节点名称。
- 写入前先以源 SHA 和解析器版本做完整校验，并检查重复键、模型归属、父子互引、根节点父键为空、对象父/宿主引用、对象的 `spatialKey` 必须属于 `spatialKeys`、链接引用存在、网格/原点链接与主链接指纹一致，以及模型计数和覆盖率计数一致。任何结构缺失、引用断裂或截断都判为无效，不 hydrate 部分索引。
- 快照上限为 128 MiB；读取还要求有效的 `projectId` 和源 SHA。版本、源 SHA、解析器版本不匹配，JSON 损坏、大小为 0/超限、校验失败或 hydrate 失败都按缓存未命中处理，由完整 IFC 重建。
- 缓存恢复是只读路径：不访问 IFC 文件，校验通过后直接提交索引并重渲染导航。无法恢复时在后台上报未命中原因并重建，不把损坏快照标记为可用缓存。
- 运行时先登记缓存恢复任务（交互后、阻塞重任务），命中则提交；恢复提交失败或未命中才排队空间重建。后台协调器调度的重建在 `allIfcReady` 门后启动，使用独立 Spatial Worker（宿主不支持 Worker 时同线程执行），结果仍按当前工程会话校验；构建失败将 `state.substationSpatialIndex` 置空并保留功能系统视图。
- 构建成功先提交内存索引；存在 `projectId` 和源 SHA 时再尝试原子写入快照。写入失败只记录警告，当前运行继续使用完整内存投影，但本次写入不产生新的可用快照，下次打开按现有快照的校验结果决定恢复或重建。单个 IFC 的读取/解析失败被隔离为模型级 `parseError` 并由 UI 显示，不阻断其它模型；整个索引构建抛错时不提交索引，也不写出可被当作完整投影的快照。

## 边界与限制

- 空间树只在有效 IFC 空间关系内工作。没有包含、边界或可继承宿主关系的对象不能被分配空间；通用包装层只是隐藏显示，不删除原始索引节点，也不把包装层名称改写成正式站区/建筑。
- 未落位、原点矩阵、仅旋转矩阵和无容器的对象不伪造空间。坐标网格只是导航分组，`spatialKey` 保持为空；`unlocatedReason` 保留具体原因，不把“无坐标”和“无空间容器”混为一谈。
- 覆盖率不是全站对象等价证明，也不是归属正确率。主树仍保留全部解析到的 IFC 构件，质量组保留未关联对象；构件总数不是设备台数或工程量。跨模型同名 GUID 不合并，模型内重复 GUID 使对象身份不可匹配，对应 CBM 链接保留为未关联。
- 推断链接保留证据强度：`evidence`、`confidence`、`placementKind`、`unlocatedReason` 和来源字段一起保存；UI 明确显示“位置推断”“已关联但无空间容器”“未关联”，不升级为已确认空间关系。
- 端口和洞口可以进入对象图并沿宿主链继承空间，但不得作为 CBM 资产身份；开洞/填充链也不会把宿主空间反向推给无关对象。
- 解析是选择性 STEP 扫描：启动阶段不物化属性值、材料、分类、类型和组资源，只保留计数；属性在选中构件后按需读取。原始 IFC 文本不长期驻留，单模型错误不影响其它模型。
- 空间语义缓存绑定源 SHA、空间快照版本和空间解析器契约；它不是 IFC 几何缓存，也不替代变电语义缓存。快照是完整派生投影，不支持在单个模型上增量更新。
- 空间选择不触发 L2、不隐式定位相机；空间树也不能据三维网格或相机范围推导包含关系。

## 验证状态

- `desktop/src/gim/__tests__/ifcSpatialParser.test.ts` 覆盖：同模型精确 GUID（大小写与尾部 `$`）和重复身份拒绝、空间聚合/包含与 CBM 链接、位置推断、`PARTINDEX`/`DEV_SUBDEVICE` 父级矩阵、父×子矩阵顺序、选择性 STEP 扫描与 placement 闭包（含超过 32 层深链）、分解继承、宿主继承、空间边界、工程量/Representation 边界、`FileDevRelation` 来源、逐 IFC profile 和单文件失败隔离。
- `desktop/src/ui/__tests__/substationSpatialTreeView.test.ts` 覆盖：包装层扁平化、容器不误选 CBM、搜索展开祖先链、未落位分页（205 项按 200+5 加载）、超过 500 项时的虚拟窗口与按目标键物化、坐标网格推断分组、多个 IFC 模型分组。
- `desktop/src/services/__tests__/substationSpatialSemanticCache.test.ts` 覆盖：规范数组序列化与全部运行时 Map 恢复、版本/源/重复节点/父引用/对象链接/覆盖率/嵌套网格链接不一致时失败关闭、损坏或截断 payload 视为未命中、无 IFC 输入的合法缓存恢复和原子桥写入。
- `desktop/src/services/__tests__/substationSpatialWorker.test.ts` 覆盖：Worker 传输保留完整空间图、Map、直接链接和逐文件错误隔离；宿主不支持 Worker 时保持原解析契约；工程清理终止待处理任务。
- 自动测试主要使用合成 IFC 文本和受控缓存/Worker 夹具，验证索引、快照和 DOM 语义；不覆盖真实大模型上的行布局、耗时和人工归属准确率。
- 已有验证不代表逐对象人工真值。`substation01`–`substation04` 样本上的覆盖率、计数和原生耗时只能说明这些样本及测量条件，不能换算为对象归属准确率或通用性能承诺；样本口径见[样本台账](../schema/sample-corpus.md#变电覆盖)。
