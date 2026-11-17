# 实体与来源模型

本文件定义“来源 occurrence 如何成为一个工程整体”的领域契约和归一化顺序。三视图组织见[工程组成与三视图](composition.md)，具体类别见[目录](catalogs/README.md)。

## 目录

- [身份范围](#身份范围)
- [来源图](#来源图)
- [对象证据](#对象证据)
- [工程整体](#工程整体)
- [待归集合与别名](#待归集合与别名)
- [归一化顺序](#归一化顺序)
- [质量与限制](#质量与限制)
- [相关文档](#相关文档)

## 身份范围

- 身份限定在源包版本内：`scope` 使用源 SHA（无 SHA 的会话使用 generation）。
- 工程整体 ID 形如 `entity:["<scope>","<seed>"]`；待归集合 ID 形如 `pending:["<scope>","<seed>"]`。
- seed 只来自稳定来源证据：来源 occurrence ID、显式工程编号+名称+成套签名、主变编号等。
- 不使用类别版本、展示名、F2/F3/F4、数组遍历序号、模板路径或运行时对象生成 seed。
- 规则导致拆分/合并时发布新快照；选择按来源重新绑定，不强行沿用旧实体 ID。

## 来源图

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

## 对象证据

[目录](catalogs/README.md)由独立 JSON 维护；工作簿只提供参考来源，不参与配置加载和构建。Standard Catalog 提供目录数据，Recognition Policy 定义私有用途/粒度，Source Compatibility Policy 解释格式枚举，Composition Policy 判断归属。内部角色不是标准目录编号或标准原文。

`SourceRecord` 在 gim 适配为中立 `ObjectEvidence`。优先消费当前对象 FAM/IFC 类型和角色字段，按精确标准条目、格式适配枚举、名称候选的顺序解释。自由文本型号不参与模糊类别匹配。名称只提供候选类别和候选部件，或消解已有类型词义；不能单独证明角色或整体宿主；不按“模型<n>_”前缀合并片段。

FAM 的“类型”“模型分类名称”“装置名称”参与精确类型声明；“设备名称”和“工程中名称”仍保留各自的名称/身份用途。CBM、DEV 与 FAM 按真实引用关联，不按同名文件或显示名称补配。FAM 存在但只有分节标题时，不代表已提供部件类型。

模型与部件使用独立词汇空间，按[已确认规则](catalogs/reference-gaps.md)处理语境：TerminalBox 在设备内为本体端子箱部件，独立为材料；GroundResistance 独立作为设备时为成套装置，非设备整体时为材料。优先使用当前对象的有效中文分类声明，再用英文声明；显示名称仅最后兜底，中文名优先。均压屏蔽装置默认金具，ProtectionEquipment 默认保护设备，明确细分信息仍可覆盖默认，原词汇的多条来源证据继续保留。

`categoryStatus`、`equipmentType`、`componentType`、`purpose`、`objectRole` 独立保存状态与证据。确定油浸式变压器类型不等于确定主变/站用用途；分类确认也不自动确认整体边界。跨分段/Pset/实例与类型范围的候选保留上下文，当前对象明确属性相互矛盾时保留未决。

识别只扫描一次原始属性列表，按 `recognitionFields.json` 建立字段到原始序号的临时索引。查询按字段合并并恢复来源顺序，保留原始文件/行/键，不复制其余属性。IFC 请求相同字段子集，其余详情继续 deferred/truncated；未读取字段不视为缺失。

真实装配边、部件类型、独立角色、显式宿主编码/名称分别保留证据。所有设备均可以有部件；确认的部件类型、真实装配边与设备宿主共同支持归属；明确 part 角色与实际装配也可证明组成。independent 角色保留独立整体，不能被装配边覆盖。宿主是材料/构件或宿主类型未知时部件进入待归集合，并记录原因及策略依据。构件安装和独立设备仍建整体并保存关联，不因为处于另一个设备的装配下就默认吞并。

宿主恢复使用当前对象明确宿主 ID、编码或名称，全部声明共同支持唯一宿主才确认；同名多候选、矛盾、无匹配分别诊断。对象自己的 PROJECTNAME、显示名称和名称前缀不作为宿主声明。仅有明确带编号宿主声明、兼容部件和内部策略时，可建立候选宿主。原始 parent、DEV occurrence 和物理表示地址始终保留。

PARTINDEX 的物理匹配、属性赋值和工程归属分开。无匹配的属性来源保存在 `attributeRecords`，没有 devOccurrence，不能创建几何根；其宿主关系仍是独立证据。CBM 组织上下文不向子对象提供主变编号、备用状态或宿主。

`ModelEvidenceProvider` 的元数据和有界 query 不触发 IO；显式 ensure 才物化来源。单次 Entry 范围最多 256 项、64 KiB，详情页最多 1,000 条/512 KiB；游标绑定 Provider revision。来源清单完整、属性解析完成、实体处理完成分别报告。原文读取上限 16 MiB，超限不宣称完整访问。

属性保留对象、文档、阶段、Pset、实例/类型适用范围和原始单位。冲突只在同一证据上下文比较；未知单位不猜测转换。`EngineeringSnapshot.evidenceBinding` 绑定实际消费的 scope/sourceRevision，独立于查询分页和驻留修订。

`standards/` 是只读标准元数据查询，不执行模型校核、不驱动整体身份或几何编译，也不代表标准全文覆盖。

## 工程整体

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

- `boundaryEvidence` 记录整体边界依据（对象身份、明确独立角色、主变编号+单相本体、上级边界未知等）。
- `classificationState=unknown` 对应 `U-OBJECT`；不能把未知类别写成“其他设备”。
- `compositionState` 只表示交付声明/相别完整性尚未核对，不是“物理组成已验证”。
- `phaseBodyCount` 是单相本体数，不是主变台数。
- `classificationConflicts` 统计结构化类型/角色等冲突，不自动选择一方。

独立关系：

```ts
EntityRelationship { from, to, kind: 'associated_with', evidence }
```

只连接独立整体（如端子箱→主变、基础→设备）；不是成员关系，也不改变两侧几何。

## 待归集合与别名

`PendingWhole` 用于身份/宿主不能确定的来源集合：

| reason | 含义 |
|---|---|
| `neutral_set_main_unresolved` | 中性点装置对应主变不明 |
| `component_whole_unresolved` | 组件没有明确整体宿主 |
| `component_host_incompatible` | 部件与已配置宿主范围不兼容 |
| `component_host_unconfigured` | 宿主是否为设备尚未确认 |

别名：

- `confirmed` 来源别名已进入来源图，不再重复输出。
- `ambiguous/unresolved` 输出 `WholeAlias`：整体可解析但组件歧义、待归集合可解析、整体未解析。
- 别名候选不重复计数；不把候选集合写成已确认成员。

## 归一化顺序

`normalizeEngineeringModel`：

1. 按 sourceId 稳定排序，校验唯一、非空、装配环。
2. 逐对象解释角色和类别。
3. 处理显式单相主变组：对象自身有一致的主变编号、单相属性，无设备编码或相别冲突，按 CompositionPolicy 成组并记录完整性未验证。
4. 按实际装配递归分配来源，保留独立角色；有明确部件类型时保存确认归属。已声明设备的真实装配子项缺少类型、独立角色和自身编码/工程名称时，由 CompositionPolicy 保留为候选部件；无实际装配或宿主未知时不采用此回退。
5. 恢复显式宿主关系，拒绝冲突、多候选和未知兼容性；不修改物理来源图。
6. 发布成员、关系、别名和诊断，执行已有分区守恒检查。

二次屏柜含明确属性识别的“变压器保护装置”、且没有“线路保护装置”冲突时，CompositionPolicy 将该柜细分为“主变压器保护柜”。此功能分类保留部件属性与策略证据，不改变部件的实际宿主，也不把保护装置另计为变压器。它属于产品组成策略，不是参考工作簿新增目录条目。

来源顺序、包装层和 F 层级变化不得改变工程结果；规则版本变化才改变结果。

## 质量与限制

- “整体候选/待归集合”是候选统计，不是台套数；守恒不等于分类正确。
- 名称、同模板、共同 F3、空间邻近不能单独证明同一整体；需要明确组成关系或单相主变组策略所要求的证据。
- 没有人工逐台套真值时，不宣称归属准确率；见[问题与限制](../open-issues.md) L-12。
- 来源不完整时只发布部分快照，不写完整缓存；未知类别、待归集合和未解析引用保留。

## 相关文档

- [工程组成与三视图](composition.md)
- [目录总则](catalogs/README.md)
- [工程实体运行时](../architecture/engineering-runtime.md)
- [表示与绑定](../architecture/representations.md)
- [建筑推断](building-inference.md)

模型和部件词典来源记录参考版本的 SHA、工作表及单元格；这些是追溯证据，不是工作簿依赖。词典/策略内容指纹只重建实体和导航，不失效物理目录或几何模板。

`npm run test:recognition` 独立运行分类、归一化、全量模型/部件、冲突词汇、来源上下文、字段计数与 Python DTO 一致性测试；CI 有独立识别任务，不启动几何编译或渲染，也不运行工程样本或性能矩阵。Parity 只证明实现一致，不能替代标准决策表和真实工程人工真值。逐对象人工验收仍由开发者选择变压器、GIS、断路器样本并审核。
