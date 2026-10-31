# 变电模型树“来源”选项卡实现

## 范围

本文描述变电工程模型树“来源”选项卡的当前实现：入口条件、`CbmNode` 数据契约、树渲染、搜索索引、选择与属性引用路由，以及与业务树/空间树的关系和已知边界。用户可见的导航说明以[软件规格](../software-spec.md#导航视图)为准，选择提交权以[架构](../architecture.md#选择提交权)为准；本文只补充开发中的实现细节与验证状态，不记录版本演进或验收流水。

实现以 `desktop/src/ui/cbmTreeView.ts`（模式条、来源渲染、`buildCbmSearchIndex`、`findByPath`、`selectCbmTreeRow`、`handleSubstationPropertyReference`）、`desktop/src/gim/cbmParser.ts`、`desktop/src/gim/types.ts`、`desktop/src/gim/modelIdentity.ts`、`desktop/src/shared/displayName.ts`、`desktop/src/ui/searchBox.ts`、`desktop/src/ui/deviceBoundsMarker.ts`、`desktop/src/services/nodeInteractionService.ts` 和 `desktop/src/app/state.ts` 为准。

## 选项卡入口与状态

- `AppState.substationNavMode` 默认 `business`，工程重置后也回到 `business`。模式不落盘，重新打开工程不会自动停在来源视图。
- 变电工程在 `business` 或 `source` 模式下生成“业务树 / 来源 / 空间”模式条。点击即写 `substationNavMode` 并同步调用 `buildAndRenderCbmTree`，没有独立路由或子页面；来源分支直接使用 `state.currentCbmTree`。
- “来源”是手动切换项，没有默认入口或快捷键。树尚未加载时，面板只显示“加载 GIM 文件后显示层级树”。
- “空间”按钮在 `!state.substationSpatialIndex` 时禁用；判据是空间索引是否存在，不是空间包含关系是否可用。索引存在但包含关系不足时，点击会进入功能系统视图。
- 进入空间或功能系统视图后，模式条换成“业务树 / 空间 / 功能系统”，“来源”不再出现；需先点“业务树”回到该模式条才能再次切换。该集合不一致登记为 [O-12](../open-issues.md)。
- 设备工程（`equipment`）打开时被置为 `functional`，不渲染变电模式条，直接显示原始 CBM 树，因此没有“来源”入口。

## 数据模型

`CbmNode` 是来源视图的唯一数据源。变电入口固定为 `CBM/project.cbm`（查找不区分大小写）；缺失时 `buildCbmTree` 返回 `null`。

| 字段 | 当前契约 |
|---|---|
| `path` | 节点身份。CBM 节点为引用拼接路径 `CBM/<ref>`，不保证与压缩包实际大小写一致；DEV 虚拟节点为 `<父路径>#dev:<序号>:<devPath>`。树行 `data-node-path`、搜索 `key` 和选择 `key` 都直接使用它。 |
| `name` | 解析阶段的名称，不保证等于最终显示名。 |
| `entityName` | `ENTITYNAME` 经 `normalizeEntityName` 归一化后的规范大小写；未知实体名原样保留。 |
| `children` | CBM 引用子节点和 DEV 虚拟子节点，顺序按引用解析结果。 |
| `rawProperties` | 原始键值表；虚拟节点没有。字段值不重写。 |
| `famPath` | `BASEFAMILY`/`BASEFAMILYPOINTER` 中首个非空值。 |
| `devPath` | `OBJECTMODELPOINTER`；设备入口节点使用入口 DEV 路径。 |
| `ifcFile` / `ifcGuid` | `IFCFILE`；`IFCGUID` 去掉尾部 `$` 并 trim。二者是引用字段，不是已建立的对象关联。 |
| `classifyName`、`transformMatrix`、`systemNames` | `SYSCLASSIFYNAME`/`PARTNAME`、原始变换矩阵、过滤占位符后的 `SYSTEMNAME1..N`。 |
| `devSymbolName`、`devType`、`devExpanded` | DEV `SYMBOLNAME`、`TYPE` 回填及展开标记。 |

名称在构建时按 `SYSTEMNAME1..N`（过滤 `-`、`其它/其他`、`NULLn`、`&` 前缀和空值）→ `PARTNAME` → `SYSCLASSIFYNAME` → `ENTITYNAME` → 文件名的顺序回退。F1 根可被工程类型名覆盖；设备层（F4System/PARTINDEX）在缺少 SYSTEMNAME 时才用 DEV `SYMBOLNAME`；F3 在名称偏编码或过短时可能追加子设备后缀；FAM 可提供可读名称。最终显示名由 `getNodeDisplayName` 决定：有 `rawProperties` 的来源型名称优先，其后是唯一 IFC 名称索引（跳过占位名）、DEV `SYMBOLNAME`，最后回退 `name`。

`DEV_SUBDEVICE` 虚拟节点来自节点的 `devPath`：读取 DEV 的 `SUBDEVICES.NUM`/`SUBDEVICEi` 并递归展开。路径带序号和子 DEV 路径，同一 DEV 的多个实例不会合并；名称取子 DEV 的 `SYMBOLNAME` → `TYPE` → 文件名；`transformMatrix` 保存 SUBDEVICE 局部矩阵，`famPath`/`ifcFile`/`ifcGuid`/`classifyName` 为空，`devExpanded` 为 true。展开受 DEV 访问集合、递归深度和 CBM 节点预算约束。

## 渲染

来源分支不创建业务投影，直接用 `renderCbmTreeUI` 渲染 `state.currentCbmTree`；搜索框由 `renderSearchBox` prepend 到面板顶部，模式条和 `.tree-view-host` 在其后。

每个节点生成 `.tree-node > .tree-row[role=treeitem][tabindex=0][data-node-path]`，行内依次为展开标记、图标、标题。图标按 `entityName` 映射：F1System `◎`、F2System `□`、F3System `≋`、F4System `◆`、PARTINDEX `•`、DEV_SUBDEVICE `◇`，未知实体用 `□`。叶节点的展开标记带 `leaf` 类并由 CSS 隐藏。

标题文本取 `getNodeDisplayName(node, state.ifcGuidToName, state.currentIfcEntries)`。标题的 `title` 属性逐行拼接节点路径、非空 `设备名`、`类型` 和非空 `DEV:` 路径。

子节点懒渲染：首次展开时才递归创建子行并缓存；折叠只切换 `expanded` 类，不移除 DOM。展开标记点击 `stopPropagation`，不会触发选择；行点击清除文档内旧 `.selected`、标记当前行、调用 `onNodeClick(node)`，有子节点时再切换展开。行支持 Enter/Space，等价于点击。

设备范围标记由 `markDeviceBounds` 追加：当 `state.deviceUnknownBounds` 含该 `path` 时，在行尾加“范围未确定”徽标，tooltip 说明完整范围尚未确定。DEV 目录完成后 `refreshDeviceBoundsMarkers` 扫描已渲染行补标记。

重渲染由以 `AppState` 为键的 `WeakMap` 守卫。来源模式下，根节点、`substationSpatialIndex`、`ifcGuidToName`（身份和 size）、`cachedFamSourceProperties`（身份和 size）、模式、宿主是否仍在面板内任一变化都会重建；否则直接返回。重建前保存滚动位置和搜索框当前值，重建后恢复搜索值并触发 `input` 重新过滤。

展开状态恢复对带 `aria-expanded` 的行有效：`renderCbmTreeUI` 在行上维护该属性，重建前收集 `.tree-row[aria-expanded="true"]`，重建后与 `businessExpandedRows` 合并，对仍为 `aria-expanded="false"` 的行点击其展开标记。来源树重建后恢复已渲染的展开行；未渲染过的深节点仍只恢复到其已知祖先。选中行由 `syncSelectedTreeRow` 按当前 `selectionRequest.target` 重新标出，未渲染的深节点静默跳过。

## 搜索索引

`buildCbmSearchIndex` 在每次渲染时同步遍历整棵 `CbmNode` 树，生成扁平 `SearchItem[]`：

- 先序遍历，按 `path` 去重，同一路径只保留第一次出现。
- `key` 为 `path`，`title` 为 `getNodeDisplayName(...)`，`subtitle` 为 `entityName` 与 `devType` 以 ` · ` 连接的字符串。
- 最多收集 100000 项。达到上限后不再插入，后续递归直接返回；超大树得到的是截断索引，不是分页结果。

`renderSearchBox` 对 `title`、`subtitle`、`key` 做大小写不敏感子串匹配，边输入边同步过滤；最多展示 50 条，超过时显示总数和“仅显示前 50 条”的提示。Esc 清空并收起，方向键移动选中项，Enter 触发，失焦延迟收起。

来源视图的命中处理是：用 `findByPath` 按 `path` 精确 BFS 找到节点，调用 `onNodeClick(node)`。它不展开祖先；目标行已渲染时由选择同步标记并滚入视野，深节点可能已选中但树上不可见。

## 选择与属性引用

行点击和搜索命中都调用创建时注入的 `onNodeClick`。变电入口使用 `createNodeClickHandler`：先校验工程会话，再 `beginSelection({kind:'cbm', key: node.path})`，随后动态导入 `handleNodeClick`。`beginSelection` 中止上一请求、清除业务/设备/IFC 的选中与过滤状态，并写入新的 `selectionRequest`；视觉高亮由后续 `clearSelectionHighlight` 清理。属性、导航同步、IFC 懒加载、MOD/STL 加载和高亮提交都校验该请求与工程会话，旧结果不能覆盖新选择。

属性面板的“来源”按钮通过 `gim:file-reference-click` 事件路由。`desktop/src/app/bootstrap.ts` 对 `substation`/`equipment` 注册 `handleSubstationPropertyReference`；该函数把 `detail.path` 的反斜杠转成 `/` 并转小写，同时保留文件名，用于全路径或基名比较。

| `detail.kind` | 匹配方式 |
|---|---|
| `cbm` | 节点 `path` 全路径或基名匹配。 |
| `dev` | 节点 `devPath` 全路径或基名匹配；也接受节点 `path` 以该文件名结尾。 |
| `fam` | 节点 `famPath` 全路径或基名匹配。 |
| `ifc` | 先匹配节点 `ifcFile`；未命中时按 `IfcEntry` 的路径/名称找到 `modelId`，再回查 `resolveIfcModelId` 相等的节点。 |
| `phm` `mod` `gl` `stl` | 在 `loadedXmlModGroups`、`loadedStlGroups` 的 key 和 `userData.modPath/stlPath/phmPath` 中找第一个匹配实例，取其 `userData.devPath`，再按 DEV 路径匹配节点。 |

命中后先 `selectCbmTreeRow(target.path)`，再发起 `{kind:'cbm'}` 选择并复用 `handleNodeClick`，返回 `true`。未命中时显示“该来源文件未映射到可见变电节点”，仍返回 `true`，避免事件继续冒泡到其它工程路由。`sld`/`file` 没有对应分支，同样落到未映射提示。

路由按 BFS 顺序取首个匹配节点，不构造候选集合，也不因多个同名来源而拒绝。按 `IfcEntry` 回查模型身份时例外：目录精确匹配优先，只有基名唯一时才用基名，重复基名返回 `null`，避免名称和高亮串到错误模型。PHM/MOD/GL/STL 只查已加载几何实例；对应几何尚未加载时无法从这些来源回查节点。命中行的祖先不会自动展开，深节点的可见定位因此不保证。

## 与业务树、空间树的关系

- 业务树和来源共用同一面板、同一模式条和同一选择入口；业务树使用 `businessTree` 投影，来源直接使用原始 CBM 树。来源分支不调用 `getBusinessTree`，不等待 `businessTreePending`，也不因业务投影缺失或失败而降级；已在进行的业务构建不会被切到来源所取消。
- 来源保留原始身份：`path`、`rawProperties`、`famPath`、`devPath`、`ifcFile`、`ifcGuid` 和 DEV 元数据都不被业务分类改写；显示名优先使用来源型名称。它不按专业、间隔或建筑做业务分类，不生成业务对象、业务区域或业务计数。
- 来源和空间视图互不替代：来源不使用 `substationSpatialIndex` 的包含关系，也不把 IFC 对象挂到 CBM 行下；空间视图按 IFC 空间节点/对象组织。来源选中一个 CBM 节点时，仍复用既有的属性检查器和几何选择流程。
- 来源层级本身不改变物理几何：节点仍是同一批 `CbmNode`，不新增几何 seed、不重算放置、不改变可见性规则；选中节点时仍走既有的按需 IFC/DEV 几何管线，不把 PARTINDEX/DEV_SUBDEVICE 当作独立加载入口。

## 边界与限制

- **只显示源层级**：树中是 CBM 引用层级和 DEV SUBDEVICES 虚拟节点；IFC 模型与构件不是树行。`ifcFile` 存在不等于对象级关联，只有 `ifcFile` 与 `ifcGuid` 同时存在才进入 IFC 引用收集；无 GUID 的节点可能只有文件来源或无法定位几何。
- **路径大小写**：`node.path` 保留引用写法，节点查找、行键和搜索 key 按精确字符串比较；包内文件读取大小写和分隔符不敏感，IFC 模型身份也做小写规范化。属性引用路由额外把两侧转小写，因此同一文件的不同写法在该入口可匹配。
- **未知与歧义**：未知实体名原样保留并用默认图标；名称逐级回退；重复 DEV 实例用不同虚拟路径保留。IFC 模型身份在重复基名时解析为 `null`，不跨模型猜测；但属性引用路由的节点匹配仍是首个 BFS 匹配，不提供歧义候选，同名的 DEV/FAM/IFC 引用由遍历顺序决定。
- **搜索**：100000 项上限、50 条展示上限、每次渲染重建全量索引、每次输入同步线性扫描。这是同步实现，不代表持续输入的性能 SLO，也没有增量更新或后台 Worker。
- **展开**：来源行维护 `aria-expanded`，重建后恢复已渲染的展开行；从未展开过的深节点没有可恢复的行。搜索和属性引用不展开祖先，未渲染行不会被选中高亮。模式选择也不持久化。
- **入口**：来源只在变电工程的“业务树/来源/空间”模式条中；空间按钮只按索引是否存在禁用，索引存在但包含关系不足时会落到功能系统视图，需经“业务树”返回。
- **来源回查**：PHM/MOD/GL/STL 依赖已加载几何实例；未加载、实例 key 或 `userData.devPath` 缺失时无法定位。

## 验证状态

现有自动化覆盖（仓库相对路径）：

- `desktop/src/gim/__tests__/cbmParser.test.ts`：无入口/空集合返回 `null`；名称回退与占位符过滤；`SUBSYSTEM`/`SUBSYSTEMS.NUM`/`SUBDEVICES.NUM` 引用、循环与缺失引用；DEV `SYMBOLNAME`/`TYPE` 回填；F3 名称后缀；IFC/FAM/矩阵字段；`DEV_SUBDEVICE` 虚拟路径唯一性、局部矩阵和名称回退；`buildCbmNodeIndex` 与 `collectIfcRefs`。
- `desktop/src/gim/__tests__/substationEvidence.test.ts`：来源型 `SYSTEMNAME` 优先于 DEV 通用名、FAM 可读名称、缓存恢复后 `rawProperties`/`systemNames`/DEV 元数据一致；直接断言 `getNodeDisplayName`。
- `desktop/src/gim/__tests__/modelIdentity.test.ts`：路径规范化和稳定 `modelId`；重复基名不静默选择。
- `desktop/src/ui/__tests__/searchBox.test.ts`：大小写不敏感过滤、点击回传 key、清空收起；覆盖通用搜索框，不覆盖 CBM 索引构建。
- `desktop/src/ui/__tests__/propertyDictionary.test.ts`、`desktop/src/ui/__tests__/propsDrawerInteractions.test.ts`：引用按钮文本/HTML、事件分发、IFC 模型唯一身份反查及重复基名不生成链接；不覆盖 `handleSubstationPropertyReference` 的节点路由。
- `desktop/src/services/__tests__/selectionInteraction.test.ts`：`buildAndRenderCbmTree` 在功能系统/空间模式下的模式切换、选择请求和重渲染后选择保持；未覆盖来源模式。

未覆盖或未验收：来源模式的图标/tooltip/设备范围标记、模式条切换、来源搜索的命中定位，以及 `handleSubstationPropertyReference` 的 CBM/DEV/FAM/IFC/PHM/MOD/GL/STL 各分支。`substationFunctionalTreeView.test.ts` 新增一项回归，覆盖来源行的 `aria-expanded` 与首次懒展开；它不覆盖搜索、选择或完整重渲染恢复。未对来源视图做原生性能验收，也没有针对 100000 节点索引或连续输入延迟的 SLO 证据。
