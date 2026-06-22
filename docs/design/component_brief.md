# GIM BIM 浏览器组件设计简报

> 本文描述统一组件及状态契约。组件使用原生 DOM + TypeScript 实现，不要求引入 UI 框架。视觉 token 见 [design_system.md](./design_system.md)。

## 1. 组件分层

| 层 | 组件 | 职责 |
| --- | --- | --- |
| 应用框架 | AppShell、ProjectBar、WorkspaceRail、StatusBar | 稳定布局与全局命令 |
| 导航 | NavigatorPanel、NavigatorSearch、BIMTree、AssetTable | 查找与组织对象 |
| 视口 | ViewportShell、ViewSwitcher、ViewportToolbar、SelectionBreadcrumb | 呈现模型/地图/图纸 |
| 控制 | LayerManager、Legend、ContextMenu、CommandPalette | 视图和对象操作 |
| 检查 | ObjectInspector、PropertyGrid、RelationList、SourcePanel | 对象信息与追溯 |
| 反馈 | TaskCenter、Toast、EmptyState、ErrorState、Skeleton | 加载与异常 |

所有组件只接收面向业务的 ViewModel，不直接解析 CBM/DEV/FAM 文件。解析、索引和业务名称归一化位于数据层。

## 2. 共享状态模型

建议建立统一 WorkspaceState：

~~~text
project
  id, name, type, capabilities
view
  mode, cameraOrMapState, activeWorkspace
selection
  primaryId, selectedIds, source
visibility
  visibleIds, hiddenIds, isolatedIds
navigator
  perspective, expandedIds, query, filters
inspector
  activeTab, pinned
tasks
  extraction, indexing, geometry, basemap
layout
  leftWidth, rightWidth, collapsedPanels
~~~

能力标记至少包括 hasIfc、hasSld、hasStd、hasSch、hasMapCoordinates、hasSpatialEntities、hasSpatialContainment、hasSpaces、hasDirectCbmIfcLinks、hasPlacementCoordinates、hasReliableSpatialHierarchy、hasReliableRouteTopology、hasMod、hasStl。`hasReliableSpatialHierarchy` 只表示 IFC 空间主树可建立，不表示 CBM 资产已经全部关联；菜单显隐只由能力和工程类型决定，不在组件内部猜测；缺失空间或拓扑能力时按导航 V3 的明确退化规则处理。

## 3. AppShell

### 目的

提供顶部、左轨、导航器、视口、检查器和状态栏的固定布局。

### 结构

- ProjectBar；
- WorkspaceRail；
- NavigatorPanel；
- ViewportShell；
- ObjectInspector；
- StatusBar；
- 全局浮层根节点。

### 状态

- no-project；
- project-loading；
- ready；
- degraded；
- fatal-error。

### 行为

- 支持左右分隔条拖动；
- 项目级记忆面板宽度和折叠状态；
- 视口尺寸变化时统一通知 Three.js 或地图执行 resize；
- 检查器折叠不得依赖硬编码 right: 332px。

### 可访问性

使用 header、nav、main、aside、footer 语义区域，并提供“跳到视口”和“跳到属性”快捷入口。

## 4. ProjectBar

### 结构

1. 产品名；
2. ProjectSwitcher；
3. ProjectTypeBadge；
4. 可选 ViewSwitcher；
5. 全局命令区。

### 关键状态

- 无工程：突出“打开 GIM”；
- 已打开：显示匿名工程名和类型；
- 有后台任务：显示小型进度点；
- 工程异常：类型徽标旁显示告警。

### 菜单

**打开**：打开 GIM、附加 IFC、最近工程。  
**项目**：关闭工程、工程信息、诊断摘要。  
**导出**：当前视图、选择对象、诊断包。  
**设置**：外观、缓存、地图、快捷键。

## 5. WorkspaceRail

### 结构

52 px 固定宽度；每项包含 20 px 图标、12 px 文本、当前项左侧 3 px 指示条。

### 变电配置

模型、系统、设备、图纸。

### 线路配置

路线、资产、图层、质量。

### 状态

- default；
- hover；
- active；
- disabled；
- hidden；
- badge。

不可用能力优先 hidden；只有用户可通过配置解决的问题才 disabled，并提供原因 tooltip。

### 键盘

上下方向键移动，<kbd>Enter</kbd> 激活，<kbd>Ctrl</kbd> + <kbd>1–4</kbd> 快速切换。

## 6. NavigatorPanel

### 结构

- 工作区标题；
- NavigatorSearch；
- 视角切换器；
- 过滤 chips；
- 主内容；
- 可选底部汇总。

### 尺寸

默认 304 px，最小 240 px，最大 480 px。标题区域 48 px，搜索区域 44 px。

### 行为

- 切换工作区保留各自滚动、展开和查询状态；
- 变电“模型”使用“空间结构 / 功能系统”同级切换器；默认选择空间主树，空间实体/包含关系缺失时显示功能系统并在标题区说明降级原因；CBM 关联覆盖率低不触发整体降级；专业和类别只作为过滤 chips；
- 搜索结果与原树共享对象 ID；
- 大型树使用虚拟滚动或按展开节点惰性生成；
- 不一次渲染全部数万 CBM 节点。

## 7. NavigatorSearch

### 结构

- 搜索图标；
- 输入框；
- 清除按钮；
- 过滤按钮；
- 结果数量。

### 状态

idle、typing、searching、results、empty、error。

### 行为

- 输入 150–250 ms 防抖；
- 支持名称、编号、类型、GUID 和来源文件；
- 结果按对象类型分组；
- 高亮命中片段，但不改变业务名称；
- <kbd>↑</kbd>/<kbd>↓</kbd> 选择结果，<kbd>Enter</kbd> 定位，<kbd>Esc</kbd> 清除。

### 可访问性

使用 combobox + listbox 语义，播报结果数。

## 8. BIMTree

### TreeNodeViewModel

| 字段 | 说明 |
| --- | --- |
| id | 稳定业务对象 ID |
| label | 业务显示名 |
| type | project、spatial-container、system-domain、system、component-group、asset、subdevice、route、section、strain-section、tower、span、wire、crossing 等；专业不是固定树节点 |
| canonicalKey | 跨视角去重键；同一对象在空间/系统/资产/路线投影中保持不变 |
| aliases | 可搜索的业务别名、塔号、型号和规范化类型 |
| sourceRefs | CBM/DEV/FAM/PHM/MOD/STL/IFC 来源引用摘要；完整内容由 SourcePanel 展示 |
| count | 子对象或实例数量 |
| visibility | visible、mixed、hidden、not-loaded |
| quality | complete、partial、warning、error |
| inferred | 名称、空间或拓扑是否由规则推断 |
| capabilities | 可定位、可显示几何、可打开图纸等能力 |
| expandable | 是否可展开 |
| selected | 当前是否选中 |

### 行结构

展开箭头、可见性、类型图标、名称、数量/质量、更多菜单。

### 交互

- 单击行：选择；
- 双击行：定位；
- 单击箭头：只展开，不改变选择；
- 单击眼睛：只改变可见性，不改变选择；
- 右键：对象菜单；
- 拖动不用于重排工程层级。

### 性能

- 节点大于 1000 时启用虚拟滚动；
- 展开后才解析或生成深层行；
- 更新选中态只修改受影响行。

### 可访问性

使用 tree/treeitem/group；左右箭头展开和折叠，上下箭头移动，Home/End 跳转。

## 9. AssetTable

### 用途

承载设备、杆塔、档距、导地线、跨越物和质量问题的批量浏览。

### 能力

- 排序、筛选、列显示；
- 固定表头；
- 多选；
- CSV 导出；
- 行与视口联动；
- 大数据虚拟滚动。

### 状态

loading、ready、empty-filter、partial-data、exporting、error。

### 规则

- 行高 32 px；
- 首列保留对象图标和业务名称；
- 状态列同时使用图标和文字；
- 数值右对齐并显示单位；
- 来源 UUID 默认隐藏。

## 10. ViewportShell

### 结构

- ViewSwitcher；
- SelectionBreadcrumb；
- ViewportToolbar；
- 主渲染容器；
- LayerManager 入口；
- Legend；
- 非阻断状态覆盖层。

### 模式

substation-3d、sld、split、route-map、asset-table，以及后续 profile；线路使用模型地图与属性来源预览，不注册独立 line-3d 工作区。

### 状态

- empty；
- skeleton；
- interactive-loading；
- ready；
- degraded；
- error。

interactive-loading 时必须允许旋转、缩放、选择已加载对象。

## 11. ViewSwitcher

### 变电

3D、单线图、分屏、资产表。

### 线路

地图、资产表；纵断面和三维线路仅在实现后注册。

### 规则

- 只展示实际可用模式；
- 切换视图不清除选择；
- 相同对象在目标视图不可见时，检查器仍保留，并提示“当前视图无对应图形”。

## 12. SelectionBreadcrumb

### 用途

保持深层对象的上下文，替代用户反复滚动树。

### 示例

- 变电站01 / 交流电气系统 / 电气一次 / 主变压器；
- 变电站01 / 来源模型 / 建筑 / 楼层 / 构件；
- 线路01 / 区段 01 / 耐张段 03 / N032。

### 行为

点击祖先时选择祖先并调整视口范围。宽度不足时折叠中间层级，但保留首尾节点。

## 13. ViewportToolbar

### ToolButton

包含 icon、label、tooltip、shortcut、pressed、disabled、disabledReason。

### 分组

视图、导航、选择、可见性、检查、输出。组之间使用 1 px 分隔线。

### 状态

default、hover、pressed、active-tool、disabled、busy。

### 规则

- 工具互斥状态由 ToolController 管理；
- active-tool 必须显示按钮高亮和状态栏说明；
- 工具切换不使用大幅动画；
- 纯图标按钮必须提供 tooltip 和 aria-label。

## 14. LayerManager

### 变电

专业、模型文件、几何来源、选择集。

### 线路

业务图层、标签和底图。

### LayerRow

可见性、颜色/线型、名称、数量、透明度或更多菜单。

### 状态

visible、mixed、hidden、loading、failed、unavailable。

### 规则

- 面板内变化立即反映到视口；
- “全部显示”只影响当前工程；
- 图层状态按项目保存；
- 在线底图状态与线路叠加层状态分离。

## 15. Legend

### 用途

解释当前视图中实际出现的符号，不复述所有可能图层。

### 行为

- 根据已开启且有数据的图层动态生成；
- 可折叠；
- 线路图例显示颜色 + 线型 + 名称；
- 质量图例显示图标 + 文字；
- 不覆盖主要对象，可拖到预设角落但不支持任意自由布局。

## 16. ObjectInspector

### 结构

1. 对象头部；
2. 操作区；
3. 页签：概览、参数、关系、来源；
4. 可滚动内容；
5. 可选固定对象状态。

### 状态

- no-selection；
- loading；
- single-selection；
- multi-selection；
- stale-selection；
- error。

### 多选

显示对象数量、共同类型、共同属性和批量操作；不拼接所有对象的完整属性。

### 固定

“固定”后视口 hover 不替换检查器；正式选择仍可通过明确操作更新。

## 17. PropertyGrid

### PropertyRow

key、displayName、value、unit、source、quality、copyable。

### 规则

- 中文名为主，原始键为辅助；
- 数值与单位分离；
- 空值默认隐藏；
- 长值采用两行截断并支持展开；
- 可复制值提供复制按钮和成功反馈；
- 变换矩阵使用等宽字体和折叠区。

### 分节

概览、设计参数、设备参数、IFC 属性、几何参数。分节标题可折叠并记忆状态。

## 18. RelationList

### RelationCard

关系类型、目标对象名称、目标类型、数量、导航动作。

### 关系类型

- parent/child；
- system membership；
- spatial containment（站区/建筑/楼层/空间）；
- spatial evidence（IFCGUID、IFC 包含、CBM/DEV 变换、推断或未关联原因）；
- IFC association；
- DEV subdevice；
- geometry source；
- adjacent tower/span；
- SLD association。

### 行为

单击卡片切换主选择；数量大于 5 时进入过滤后的 AssetTable，不在检查器内渲染超长列表。

## 19. SourcePanel

### 内容

- 业务对象 ID；
- CBM、DEV、FAM、PHM、MOD/STL、IFC 路径；
- GUID；
- 原始引用键；
- 变换矩阵；
- 解析器和缓存版本。

### 规则

- 默认折叠长技术内容；
- 文件路径可复制；
- 原始内容必须转义后显示；
- 不允许通过来源内容注入 HTML、SVG 或 CSS；
- 提供“复制诊断摘要”，不默认导出敏感绝对路径。

## 20. TaskCenter

### TaskViewModel

id、kind、label、done、total、failed、state、canCancel、canRetry。

### 任务类型

解压、索引、IFC 加载、几何编译、缓存写入、底图连接、导出。

### 表达

- 单一短任务：状态栏；
- 多任务或有失败：点击状态栏打开任务中心；
- 完成后短暂保留，可查看耗时和失败对象；
- 不用连续 Toast 覆盖视口。

### 取消

取消必须让异步 token 失效，并在所有磁盘、场景和状态写入前校验项目 ID 与 token。

## 21. StatusBar

### 左侧

项目状态、底图或模型状态。

### 中部

坐标、单位、当前工具、选择数。

### 右侧

后台任务进度、缓存状态、告警数。

### 示例

“模型已加载 · 已选 1 个 · mm · 正在构建几何 173 / 285”

状态栏高度 28 px，文字 12 px，不可承载多行错误。

## 22. ContextMenu

### 通用对象菜单

聚焦、隔离、隐藏、显示同类、清除选择、复制标识、查看来源。

### 线路扩展

设为起点、设为终点、查看相邻档距、复制坐标。

### 规则

- 打开位置保持在视口内；
- 键盘可导航；
- 不可用动作显示原因或隐藏；
- 危险动作与普通动作分组。

## 23. CommandPalette

快捷键建议 <kbd>Ctrl</kbd> + <kbd>K</kbd>。

支持：

- 打开工程；
- 切换工作区或视图；
- 聚焦、隔离、显示全部；
- 定位塔号；
- 导出当前视图；
- 打开缓存设置和诊断。

命令名称使用业务语言，并显示快捷键。命令面板不替代可发现的主菜单。

## 24. EmptyState、Skeleton、ErrorState

### EmptyState

必须说明当前为空的原因和主操作。例如“尚未打开工程”提供“打开 GIM”；“图纸未提供”不提供无效重试。

### Skeleton

只用于结构未知的短暂加载；树骨架和属性骨架分别设计，中央视口不可闪烁白屏。

### ErrorState

包含标题、影响范围、原因、可执行动作、诊断入口。部分失败不替换整个工作台。

## 25. Toast

用于复制成功、导出开始、设置已保存等短反馈。默认 3–5 秒；同类消息合并；加载进度不得使用 Toast。

## 26. 组件状态验收矩阵

| 组件 | 空 | 加载 | 成功 | 部分失败 | 完全失败 |
| --- | ---: | ---: | ---: | ---: | ---: |
| BIMTree | 必须 | 必须 | 必须 | 必须 | 必须 |
| ViewportShell | 必须 | 必须 | 必须 | 必须 | 必须 |
| ObjectInspector | 必须 | 必须 | 必须 | 必须 | 必须 |
| LayerManager | 必须 | 必须 | 必须 | 必须 | 必须 |
| AssetTable | 必须 | 必须 | 必须 | 必须 | 必须 |
| TaskCenter | 可选 | 必须 | 必须 | 必须 | 必须 |

## 27. 建议目录结构

~~~text
src/ui/
├─ shell/
│  ├─ appShell.ts
│  ├─ projectBar.ts
│  ├─ workspaceRail.ts
│  └─ statusBar.ts
├─ navigator/
│  ├─ navigatorPanel.ts
│  ├─ navigatorSearch.ts
│  ├─ bimTree.ts
│  └─ assetTable.ts
├─ viewport/
│  ├─ viewportShell.ts
│  ├─ viewportToolbar.ts
│  ├─ viewSwitcher.ts
│  ├─ layerManager.ts
│  └─ legend.ts
├─ inspector/
│  ├─ objectInspector.ts
│  ├─ propertyGrid.ts
│  ├─ relationList.ts
│  └─ sourcePanel.ts
└─ feedback/
   ├─ taskCenter.ts
   ├─ toast.ts
   └─ states.ts
~~~

先通过适配器复用当前 cbmTreeView、lineProjectView、propsDrawer 和 Viewer/Map handle，再逐步拆分。禁止在新组件中复制解析逻辑。

## 28. 组件级验收

- 1600 × 900、1366 × 768、1024 × 768 均无横向滚动。
- 树含 10,000 个可见候选节点时仍能流畅滚动。
- 所有纯图标按钮均有 tooltip、aria-label 和 focus-visible。
- 工程切换后旧任务不能更新新工程组件。
- 任一视图选择对象后，selectionId 在树、视口和检查器一致。
- 隐藏某图层不会清除对象属性或破坏来源追溯。
- 无 IFC、无 SLD、无在线底图等场景都有明确且非阻断的退化状态。

## 29. 导航 V3 的信息模型契约

### 29.1 透视与节点类型

导航器只接收业务投影，不直接接收 `CbmNode[]`。解析层输出对象图后，由工程类型适配器生成以下透视：

```text
SubstationNavigator
├─ spatial（hasReliableSpatialHierarchy 时）
├─ functional：system-domain → system → component-group/asset → subdevice
├─ disciplineFacet：确认专业 → 对象过滤（不是树父级）
└─ asset：asset-class → asset-type → instance

PowerlineNavigator
├─ route：route → section → strain-section → tower/span → wire/crossing
├─ asset：tower/span/wire/crossing → type → instance
└─ quality：issue-group → affected-object
```

同一个业务对象可以出现在多个透视中，但必须共享 `canonicalKey`、`selectionId` 和来源引用；视角不是数据复制。

### 29.2 适配器规则

| 适配器 | 输入关系 | 输出保证 |
| --- | --- | --- |
| `buildSubstationSpatialIndexFromFiles/Texts` | IFC 空间实体、`IFCRELAGGREGATES`/`IFCRELNESTS`/`IFCRELDECOMPOSES`、`IFCRELCONTAINEDINSPATIALSTRUCTURE`、`IFCRELSPACEBOUNDARY`、`IFCRELVOIDSELEMENT`、`IFCRELCONNECTSPORTTOELEMENT`、CBM IFCFILE/IFCGUID、CBM/DEV 变换矩阵 | 输出 `SubstationSpatialIndex`（`IfcSpatialNode`/`SpatialAssetLink`/`SpatialCoverage`）；区分直接包含、分解继承、宿主继承、空间边界、位置推断、已关联但无空间容器、未关联、未落位 IFC 构件；低层属性/几何/关系记录按模型资源计数，GUID 按模型隔离且保留一对多 CBM 引用 |
| `buildSubstationNavigator` | F1/F2/F3/F4、DEV SUBDEVICE、系统索引、空间索引、能力标记 | 空间与功能视图共享对象；F3 第一个有效 SYSTEMNAME 生成 2–5 个功能域，F2 专业成为过滤面；F4 区分构件/设备；PARTINDEX 与同索引子设备合并 |
| `buildPowerlineNavigator` | TOWER/WIRE/CROSS、端点、里程/坐标、DEV/FAM 属性 | 塔位和档距保持拓扑顺序；跨越物挂到档距或待关联组 |
| `buildAssetProjection` | 规范化业务对象图、别名和类型 | 分类只是投影；`OTHERS`/未知线型不冒充业务分类 |
| `buildQualityProjection` | 引用、坐标、属性、几何和底图任务状态 | 问题可筛选、定位、导出，不删除原对象 |

### 29.3 不变量（实现和测试必须守住）

1. `id` 是展示层选择 ID，`canonicalKey` 是跨透视去重键；两者都不能由当前树路径临时拼接。
2. `PARTINDEX`、`DEV_SUBDEVICE` 只允许一个可见部件节点；几何发现层不把它们当作新的全量 seed。
3. IFCFILE、MOD、STL、PHM 或 `.gl` 的出现与否不能改变业务对象的空间父级、功能系统父级或线路区段关系；专业只是对象属性和过滤面。
4. 空间实体和包含关系存在时，空间主树可以可用；CBM 关联不足时生成“坐标定位/已关联但无空间容器/未关联”节点并记录 `inferred` 与 `unlocatedReason`，未落位 IFC 构件单列且可搜索，不能整体隐藏空间树。
5. 没有可靠空间/拓扑证据时，生成“未分区/未分段/待关联”节点并设置 `inferred=false`；推导出的分组必须设置 `inferred=true` 并可追溯规则。
6. `objectCount`、`geometryTotal`、`sourceCount` 分开计算；共享资源或重复引用不得膨胀业务对象计数。
7. capability 为 false 时入口隐藏；对象本身仍可在可用透视和来源页查看。

### 29.4 组件行为补充

- `NavigatorPanel` 根据 `project.type` 注册不同 perspective，不在渲染层判断 `ENTITYNAME`。
- `BIMTree` 对大型分支执行惰性子树和分页加载；展开状态按 `perspective + projectId` 保存，点击“加载更多”不得丢弃剩余对象。
- `NavigatorSearch` 先返回业务对象，再通过 `sourceRefs` 提供 GUID/文件名命中说明；结果同时提供空间路径和功能路径，只在当前视角自动展开对应祖先链。
- `BIMTree` 行内只放业务名称和必要的短计数/状态；塔型、坐标、长度、分裂数、实体类型、来源码和路径等技术信息通过行 tooltip、搜索结果和 `ObjectInspector` 展示，不能挤占名称宽度。
- `ObjectInspector.RelationList` 可展示“空间归属、系统归属、路线相邻、模型/图纸关联”等多重关系，不把它们强行串成一条树。
- `LayerManager` 的可见性变化只影响视口，不改变导航父子关系；底图任务与线路叠加层任务分开报告。

### 29.5 变电 IFC 空间对象数据契约（运行时实现）

空间树消费 `SubstationSpatialIndex`，不直接扫描 STEP 文本。该索引目前由
`desktop/src/gim/ifcSpatialParser.ts` 构建，字段口径如下：

| 字段 | 说明 | 展示位置 |
| --- | --- | --- |
| `IfcSpatialNode` | Project/Site/Building/Storey/Space/Zone 容器、父子关系、来源模型、标高和属性集 | 空间树容器行、检查器“空间容器” |
| `directObjectKeys` | `IFCRELCONTAINEDINSPATIALSTRUCTURE` / `IFCRELREFERENCEDINSPATIALSTRUCTURE` 直接包含的构件 | 容器计数“直接” |
| `boundaryObjectKeys` | `IFCRELSPACEBOUNDARY` 关联的构件；不冒充直接包含 | 容器计数“空间边界”与关系页 |
| `decompositionObjectKeys` | 沿 `IFCRELAGGREGATES` / `IFCRELNESTS` / `IFCRELDECOMPOSES` 从已落位装配体继承的构件；按节点去重 | 容器计数“分解继承” |
| `hostObjectKeys` | 沿 `IFCRELVOIDSELEMENT` / `IFCRELCONNECTSPORTTOELEMENT` 从宿主构件继承的构件；按节点去重 | 容器计数“宿主继承” |
| `objectKeys` | 直接构件 + 沿 `IFCRELAGGREGATES` / `IFCRELNESTS` / `IFCRELDECOMPOSES` 或宿主关系继承的构件 | 容器下 IFC 构件分页列表 |
| `spatialContainment` / `spatialInheritanceKind` | `direct`、`boundary` 或 `inherited`；继承项再区分 `decomposition` 与 `host-relation`，必须在行和检查器中可见 | IFC 构件摘要、关系页 |
| `propertySets` | IFC PropertySet 与 ElementQuantity 的字段、值类型、单位 | 检查器“参数” |
| `materials` / `classifications` / `typeName` / `groupNames` | IFC 材质、分类、类型定义、组/系统关联 | 检查器“IFC 扩展信息” |
| `placement` | IFCLOCALPLACEMENT 解析后的嵌套世界坐标、矩阵和原始单位 | 检查器“概览/来源” |
| `representationRef` + `geometryStatus` | 是否存在 IFC Representation 引用；不把“无表示”误称为解析失败 | 构件摘要、质量筛选 |
| `relationshipTypes` | 关系记录按 IFCREL 类型聚合，避免只显示一个总数 | 检查器“关系” |
| `hostObjectKey` | 开洞/端口等宿主关系的宿主构件键；只沿子对象→宿主方向继承空间 | 检查器“对象关系” |
| `spatialKeys` | 一个构件被多个空间关系引用时保留完整集合；`spatialKey` 仅为主空间兼容字段 | 检查器“空间路径” |

多 IFC 文件首层必须通过稳定的 `spatial:model:<encoded-model-id>` 虚拟节点按来源模型分组，
再展开 IFC 原始空间层级。这样 `Default Project`、`Default Site` 等导出器占位名称不会相互覆盖，
同时不臆造跨模型的空间合并。搜索定位必须自动展开工程根、模型分组和空间祖先链。

Project/Site/Building 的通用占位名称（如“项目编号”“Default”“Building”“IFCBUILDING #…”）
不生成独立导航行；有业务名称的空间容器照常显示，隐藏包装层的后代会提升到最近可见父级。
该规则只作用于导航投影，索引、搜索、属性和来源链仍保留原始空间节点。

空间质量状态仍需分开：`confirmed`（IFC GUID/空间包含）、`inferred`（CBM/DEV 变换矩阵）和
`unresolved`（无 GUID、无矩阵或 GUID 未命中）。坐标证据不能覆盖 IFC 明确包含关系，也不能把
CBM/DEV 设备强行映射到没有唯一证据的 IFC 构件。
