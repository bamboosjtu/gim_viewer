# 实体与来源模型

本文件定义“来源 occurrence 如何成为一个工程整体”的领域契约和归一化顺序。三视图组织见[工程组成与三视图](composition.md)，具体类别见[目录](catalogs/README.md)。

## 1. 身份范围

- 身份限定在源包版本内：`scope` 使用源 SHA（无 SHA 的会话使用 generation）。
- 工程整体 ID 形如 `entity:["<scope>","<seed>"]`；待归集合 ID 形如 `pending:["<scope>","<seed>"]`。
- seed 只来自稳定来源证据：来源 occurrence ID、显式工程编号+名称+成套签名、主变编号等。
- 不使用类别版本、展示名、F2/F3/F4、数组遍历序号、模板路径或运行时对象生成 seed。
- 规则导致拆分/合并时发布新快照；选择按来源重新绑定，不强行沿用旧实体 ID。

## 2. 来源图

`EngineeringSourceGraph` 是格式适配后的中立事实：

| 字段 | 内容 |
|---|---|
| `documents` | 真实文件路径、原始行、字段（键、值、行号、原文） |
| `cbmOccurrences` | CBM 引用节点：路径、父节点、经由字段 |
| `records` | DEV/IFC 来源记录；保留父装配、属性、上下文、GUID、occurrence 地址 |
| `aliases` | CBM GUID/OBJECTMODELPOINTER 等来源别名及候选 |
| `references` | 字段引用解析结果：resolved/missing/ambiguous |
| `ifcPaths` | 实际 IFC 文件发现，独立于 IFCGUID 挂接 |
| `diagnostics` | 装配循环、缺对象模型等来源级异常 |

`SourceRecord` 关键字段：

- `id`：包内 occurrence 身份，不等同模板或显示名。
- `track`：`dev` 或 `ifc`。
- `parent`：真实 DEV 装配或 IFC 对象分解边；CBM 展示祖先不是装配父。
- `properties`：原始字段/行/节，保留重复。
- `nameEvidence`：当前 occurrence 的对象名、工程中名称、设备名称及明确关联 CBM 名称，逐项保存证据地址。根 CBM 的字段不下传所有子 DEV；只有唯一的实际装配别名可以补充对应子件证据。
- `devOccurrence`：`rootSourceId`、`cbmOccurrenceId`、`assemblyPath`。
- `ifcOccurrence`：`modelId`、`expressId`、`globalId`。
- `relations`：宿住/空间关系是证据，不自动变成装配成员。

来源引用解析规则：

- 先按 owner 相对路径，再按全局路径，最后按唯一 basename；只有唯一候选才 resolved。
- 多候选保留 ambiguous，不选第一个；缺失保留 missing。
- 同一文件被不同路径引用是不同 occurrence；同一模板多处引用不合并。
- 装配环按分支截断并记录；不删除合法重复路径。

## 3. 对象证据

适配层把 `SourceRecord` 转成 `ObjectEvidence`：

| 字段 | 用途 |
|---|---|
| `sourceId` | 包内 occurrence 身份 |
| `name` | 当前对象名称；前缀“主变模型1_”等作为组成片段处理 |
| `assemblyParentId` | 真实装配父 |
| `typeCategory` | 设备/IFC 类型枚举的目录映射 |
| `propertyCategories` | 已解释为当前对象类别的有效属性，带证据地址；服务对象/用途上下文不无条件成为自身类别 |
| `objectRoles` | 明确内部组成或独立角色属性；桩身等基础组件保留角色 |
| `subtypeNames` / `phaseLabels` | 当前对象的子类声明/类型细类、相别，用于细分与成组冲突检查 |
| `traits` | fastener / assemblyContainer / materialType / nonphysical |
| `names` | 当前对象的名称通道及证据地址；原值与显示名称分别保留 |
| `designations` | 当前对象自身的工程中名称、PROJECTNAME 等明确声明 |
| `inheritedContextDesignations` | 组织上下文，仅供审计；不能确定主变编号、备用状态、成组或中性点宿主 |
| `identityCodes` | 电网工程标识/设备编码 |
| `identityNames` | 设备名称等别名 |
| `phases` | 相数 |

证据值都带 `evidenceId`（来源 ID + 文件/行/键），可追溯到原始字段。

CBM 祖先或当前组织节点的 SYSTEMNAME/NAME/PARTNAME 保留为上下文，不因含“主变系统”而成为对象声明。主变编号与备用状态只使用对象自身声明；缺少明确宿主的中性点保留待归。组织改名不改变 occurrence ID 或实体成员；插入引用包装层会改变路径型 occurrence ID，验收按对应来源验证整体边界等价，不承诺引用路径改变后的 ID 原样不变。

当前对象的类型、明确角色和有效类别属性优先；只有缺少这些证据时，才由部件/整体名称兜底。通用二次柜类型可相容细分，不能被“主变”服务前缀覆盖；具体开关柜类型也不被控制柜名称直接改判。有效属性互相矛盾时进入待归，名称冲突保留类型并记录候选状态：

| 角色 | 判定要点 | 归属 |
|---|---|---|
| `source_only` | 非物理/接口/文字/接线点 | 归上级或仅来源 |
| `container` | 明确的“组/模型组/Default”容器且有子对象 | 归上级容器 |
| `detail` | 紧固件/内部设计件 | 归上级整体或来源 |
| `part` | 按钮、柜体、端子排、机构、散热器等组件头 | 有宿主则归宿主，否则待归 |
| `fragment` | 名称前缀“<装配类别>模型<n>_<自身名>”的分散片段 | 需要同类整体/成套签名；否则待归 |
| `neutral_set` | 中性点成套装置 | 优先归对应主变整体；宿主不明则待归 |
| `object` | 外露、可独立识别的对象 | 按目录类别建整体或归上级 |

端子箱按真实 DEV 装配边决定边界：只要嵌在设备装配内，不论宿主是主变、GIS、电容器装置还是其他设备，都作为宿主组成来源；源上的 `independent` 角色不能把真实装配边改回独立整体。没有这类装配边的独立端子箱保留 E16.terminal_box，预制舱（E18）作为建筑边界不因舱内安装吞并独立柜/箱；宿主无法确定时进入待归集合。测控柜、控制柜、保护柜/屏、配电箱等按独立功能保留；SecondaryCabinet 不能因名称带“主变”变成本体。独立的 `C-B1/C-B2`（支架/基础）与设备整体是安装关联，不并成本体成员；`E09` 开关柜在 `E18` 预制舱内仍保留柜级整体。

### 3.1 三种对象边界

| 对象 | 建模方式 | 示例 |
|---|---|---|
| 工程整体 | 独立工程实体，有统一类别、身份和整体成员范围 | 一台/组主变、一套 GIS、一面柜、一套支架、一根梁、一串绝缘子 |
| 整体的内部组成 | 有真实 DEV 装配边时作为来源/表示成员，默认不建独立实体 | 单相本体、散热器、柜体、端子排、螺栓、绝缘子串内金具球 |
| 与整体关联的独立对象 | 没有真实装配边、独立安装时另建整体并保存关联 | 独立端子箱、设备基础、独立控制柜 |

“整体”由对象性质决定，不等于整个系统或建筑；门、梁、盖板本身可以是构件整体。无法证明边界的内容进入待归整体集合或未知整体候选。设计拆件可跨平级 CBM 归入一个整体，但必须有共同工程标识、带编号的工程名称或兼容成套签名；共同目录、父节点、同名、同模板、同位置不能单独证明同一整体。

IFC 只处理 GIM 交付的外露产品接口：Type、属性、材质、截面、几何表示、布尔体等内部定义不建立工程实体；洞口、端口、图示保留为特征证据。外露产品仍要做整体边界判断；未知 Proxy/Shape 保留未知整体候选，不因名称缺失丢弃，也不推断真实专业。

## 4. 工程整体

```ts
EngineeringEntity {
  id, category, name,
  kind: 'whole' | 'set' | 'transformer_bank',
  boundaryEvidence,
  classificationState: 'identified' | 'unknown',
  sourceIds, classificationConflicts,
  phaseBodyCount?, compositionState?
}
```

- `boundaryEvidence` 记录整体边界依据（对象身份、独立功能、工程编码+名称+成套签名、主变编号+单相本体、上级边界未知等）。
- `classificationState=unknown` 对应 `U-OBJECT`；不能把未知类别写成“其他设备”。
- `compositionState` 只表示交付声明/相别完整性尚未核对，不是“物理组成已验证”。
- `phaseBodyCount` 是单相本体数，不是主变台数。
- `classificationConflicts` 统计名称/类型等冲突，不自动选择一方。

独立关系：

```ts
EntityRelationship { from, to, kind: 'associated_with', evidence }
```

只连接独立整体（如端子箱→主变、基础→设备）；不是成员关系，也不改变两侧几何。

## 5. 待归集合与别名

`PendingWhole` 用于身份/宿主不能确定的来源集合：

| reason | 含义 |
|---|---|
| `neutral_set_main_unresolved` | 中性点装置对应主变不明 |
| `component_whole_unresolved` | 组件没有明确整体宿主 |
| `unnumbered_set_identity_requires_confirmation` | 缺少明确编号，不能确认同一套 |
| `peer_fragment_engineering_identity_insufficient` | 分散片段缺少整体身份/兼容签名 |

别名：

- `confirmed` 来源别名已进入来源图，不再重复输出。
- `ambiguous/unresolved` 输出 `WholeAlias`：整体可解析但组件歧义、待归集合可解析、整体未解析。
- 别名候选不重复计数；不把候选集合写成已确认成员。

## 6. 归一化顺序

`normalizeEngineeringModel`：

1. 按 sourceId 稳定排序，校验唯一、非空、装配环。
2. 逐对象解释角色和类别。
3. 处理平级分散片段：要求相同装配类别、工程编码/名称和成套签名；至少两份；无编号进入待归集合。
4. 处理主变组：多个单相 `E01` 本体，且有唯一显式主变编号；建立 `transformer_bank`，记录本体数。
5. 递归分配来源：
   - 中性点先等待主变整体；
   - source_only/container/detail/part 归宿主；
   - fragment 仅在宿主类别匹配时归宿主；
   - 独立对象建整体并关联宿主；
   - 宿主未知或边界不明时建整体/待归；
   - 支架/基础与设备、舱内柜与舱体按独立安装关系处理。
6. 中性点重定向：显式主变编号只对应一个主变整体时，把待归集合归入该主变；否则保留待归。
7. 生成成员、关系、别名和诊断。
8. `assertEngineeringPartition` 校验：每份来源恰好一个主归属，成员/整体/待归一致，独立对象不丢失整体。

来源顺序、包装层和 F 层级变化不得改变工程结果；规则版本变化才改变结果。

## 7. 质量与限制

- “整体候选/待归集合”是候选统计，不是台套数；守恒不等于分类正确。
- 名称、同模板、共同 F3、空间邻近不能单独证明同一整体；需要工程编号、名称和成套签名等共同证据。
- 没有人工逐台套真值时，不宣称归属准确率；见[问题与限制](../open-issues.md) L-12。
- 来源不完整时只发布部分快照，不写完整缓存；未知类别、待归集合和未解析引用保留。
