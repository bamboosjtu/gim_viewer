# 实体目录（v0.2）

本目录是工程实体分类的书面口径，供开发与评审对照 `desktop/src/engineering/` 的现行规则。分类对象是施工、运维可整体识别、选择和查看的设备、构件与装置性材料；源文件层级与设计拆件不决定实体粒度。

## 三条底线

- **编码是项目映射码**：`E01`、`M04`、`C-B2` 是本仓库的目录键，不是国网标准编码，也不承诺与任何版次条目一一对应。
- **设备兼容 2018/2025 通用目录**，两版条目并列只为溯源；**材料与构件沿用研究目录口径**（材料 7 大类、构件 4 大类 25 子类）。
- **目录出处与最终类别分开**：2018/2025 条目、DEV `source_type`、IFC 类型、CBM 层级只作证据，写入实体类别的只有当前项目编码。

研究口径见[分类与粒度总则](../../../research/01-分类与粒度总则.md)、[设备目录与组合边界](../../../research/02-设备目录与组合边界.md)、[材料与构件目录](../../../research/03-材料与构件目录.md)；实现细节见[工程实体运行时](../../architecture/engineering-runtime.md)。

## 子目录导航

| 文档 | 回答的问题 | 对象 |
|---|---|---|
| [设备目录](equipment.md) | 设备如何成套、哪些内部件不单独成台 | E01–E19、E-T 及 E16 子类 |
| [装置性材料目录](materials.md) | 材料按“段”还是“件”、如何与支架/沟/终端区分 | M01–M07 |
| [构件清单](components.md) | 构件整体如何界定、角色如何保留 | C-A、C-B、C-C、C-D 共 25 子类 |

## 共同原则

1. **整体优先**：先判来源对象是整体、内部组成、关联独立对象还是组织包装，再判类别；一个整体可跨多条 CBM/DEV/IFC 记录和多个几何资产。
2. **目录不造实例**：粗模型不补造内部件，细模型不因零件多而增加整体数；只有明确对象或装配证据才建立实体。
3. **来源守恒**：每份来源恰好归入一个整体、一个待归集合或“仅来源”，由 `assertEngineeringPartition` 校验；别名与组件歧义另存，不重复计数。
4. **组合需身份**：共同父节点、同模板、同位置、同名、同型号均不能单独证明同一整体；成套归一还要求工程标识、带编号名称与兼容签名。
5. **角色先于词表**：包装节点、紧固件、接口对象和部件头词先被解释掉，名称分类只在对象层面生效。
6. **层级不作依据**：F2/F3/F4 只是来源层级；`ObjectEvidence` 不含层级字段，`assemblyParentId` 只表示真实装配边。

## 分类优先级

前五步命中即返回；第 6 步仍参与类别判定，但以独立功能头词覆盖名称与类型。

| 顺序 | 判定 | 触发（当前规则） | 结果 |
|---|---|---|---|
| 1 | 非物理/接口 | `traits.nonphysical`（IFC 端口、洞口、标注、轴网等特征类）或名称 `土建接口、模型文字、接线点` | `source_only` |
| 2 | 紧固件 | `traits.fastener`（`IFCMECHANICALFASTENER`、`IFCFASTENER`） | `detail` |
| 3 | 来源包装 | 名称 `Group、模型组、组、组合、Default` + 有子 + `traits.assemblyContainer` | `container` |
| 4 | 部件头词 | 名称命中 `part` 表（柜体、端子排、散热器、油枕、电动机构、在线监测仪等）且非独立头词 | `part`；带 `…模型N_` 前缀且前缀属 E 类时为 `fragment` |
| 5 | 中性点成套 | 名称含 `中性点` 且带 `成套/装置/设备`，或来源类型 `neutralpointequipment` | `neutral_set`，归 E01 宿主 |
| 6 | 独立功能 | 名称命中 `independent` 表（端子箱、汇控柜、控制柜、保护柜、屏柜、配电箱等） | 必建独立实体 |
| 7 | 类别判定 | 独立头词 > 材料类型 > 对象名称 > 类型别名 > 家族身份候选 | 写入 `category` |
| 8 | 主变强化 | 类别为 `E01`/`E-T` 时，工程中名称含 `#n主变`、`n号主变`、`主变n`，或 `E-T` 名称含“主变” | 归一 E01 |
| 9 | 兜底 | 以上均无命中 | `U-OBJECT` |

类别证据优先级与快照中的 `basis` 字段一致：

| 优先级 | `basis` | 证据来源 | 说明 |
|---|---|---|---|
| 1 | `independent_function_head` | `independent` 名称表 | 覆盖名称与类型；“主变、HGIS、监控”等前缀不改变独立功能 |
| 2 | `material_type` | DEV 类型别名属 `M*` 且 `traits.materialType` | 材料类型属性优先于对象名称 |
| 3 | `object_name` | 对象自身名称按目录顺序首个命中 | 名称先去空白，大小写不敏感 |
| 4 | `type` | `typeCategory`（DEV 别名或 IFC 类型） | 仅名称未命中时启用；`E01` 别名先降为 `E-T` |
| 5 | `family_identity_candidate` | `identityNames`（设备名称、工程中名称） | 仅名称仍为 `U-OBJECT` 时尝试，且名称不含部件头词 |
| 6 | `unknown` | 无 | 落 `U-OBJECT` |

`U-OBJECT` 是待识别状态，不是目录类别：它作为整体时照常建立边界（`outward_object_boundary_unconfirmed`）并保留原始名称、类型、来源与未知原因，但不参与设备、材料、构件的台套统计。

## 未知、冲突与待归

| 情形 | 规则输出 |
|---|---|
| 名称与类型都无目录证据 | `classificationState: unknown`，类别 `U-OBJECT` |
| 名称类别与类型别名不一致 | 保留整体，记录 `conflict`（`类型!=类别`）并累加 `classificationConflicts`，不静默改判 |
| `E-T` 与 `E01`、`E03` 之间 | 不算冲突 |
| 成套来源缺少带编号名称 | 待归集合，`reason: unnumbered_set_identity_requires_confirmation` |
| 同名同码出现多个成套签名 | 诊断 `assembly_identity_collision`，不合并 |
| 部件、拆件找不到宿主 | 待归集合，`component_whole_unresolved` 或 `peer_fragment_engineering_identity_insufficient` |
| 中性点装置宿主不明 | 待归集合，`neutral_set_main_unresolved`；随后按唯一显式主变编号重定向 |
| 组件别名跨候选 | `WholeAlias` 为 `whole_unresolved`、`whole_resolved_component_ambiguous` 或 `pending_bundle_resolved` |

待归集合在工程组成中显示为“整体归属待确认”，只用于聚合来源，不折算成已确认台套。

## 规则版本与目录稳定性

- 当前版本 `engineering-wholes-2`，定义在 [catalogRules.json](../../../desktop/src/engineering/catalogRules.json) 的 `version`，由 [classify.ts](../../../desktop/src/engineering/classify.ts) 导出为 `ENGINEERING_RULES_VERSION`，随快照写入 `rulesVersion`。
- 实体缓存契约绑定该版本；规则变化只重建实体与导航，来源有效时不重读 IFC，几何和 IFC 表示可复用。
- 版本号不参与整体 ID；ID 只由包内作用域与来源种子生成，换规则不会把同一来源改成另一台设备。

## 如何扩展目录

1. 先在研究目录确认对象是设备、材料还是构件整体，并标注 2018/2025 出处；出处不写入类别。
2. 在 `nameRules` 中按“专项先于泛化”插入条目：数组顺序即优先级，首个命中生效（如 `楼板` 先于 `板`、`电缆沟` 先于 `板`、`母线设备柜` 先于 `母线`）。
3. 新增编码时同步补 [catalogLabels.ts](../../../desktop/src/engineering/catalogLabels.ts)，否则 UI 只显示裸编码。
4. 来源类型别名写入 [sourceTypeAliases.json](../../../desktop/src/gim/engineering/sourceTypeAliases.json)：`dev` 段按小写匹配，`ifc` 段按大写 IFC 类型；IFC 特征类和紧固件只作标记，不建类别。
5. 调整 `part`、`independent`、`group`、`sourceOnly` 前先评估边界影响：它们分别把对象压成内部成员、独立实体、来源包装和仅来源。
6. 增加 [normalize.ts](../../../desktop/src/engineering/normalize.ts) 的组合与待归测试、本目录对应行，再改 UI 展示。
7. 不兼容地改变既有编码含义时提升 `version`；仅新增条目可在同版本内评审。

## 与来源图和几何表示解耦

- 分类只读中立证据：来源 ID、名称、真实装配父级、类型别名、`traits`、工程中名称、工程标识、设备名称与相数；不读 XML/键值文本、Mesh、LOD、包围盒或展示树深度。
- 表示层只按来源 ID 绑定：`EngineeringRepresentationIndex` 的解析结果为 `bound`、`ambiguous` 或 `unassociated`，不生成几何、不按邻近或同名补归属。
- 业务分组独立于类别：[compositionTemplate.ts](../../../desktop/src/engineering/compositionTemplate.ts) 只把既有整体挂到主变系统、配电装置、建筑工程等路径，不产生新对象，也不回写类别。
- 因此目录规则可独立演进：改规则只重建快照与两视图，几何可先于实体完成编译。
