# CBM、FAM 与对象语义

CBM 提供来源骨架与引用图，FAM 提供原始属性。业务身份、图节点、IFC 对象和几何 occurrence 具有独立来源，不能只凭名称或数组下标合并。

## CBM 基础字段

常见语法为每行一个 `KEY=VALUE`，在第一个 `=` 分开。
保留原始字段，解析器归一化字段/实体用于比较，不以导出工具名称路由。

| 字段/键族 | 角色 | 约束 |
|---|---|---|
| ENTITYNAME | F1System/F2System/F3System/F4System/PARTINDEX 等 | 值存在大小写变体，归一化比较 |
| SUBSYSTEM | project 根到主系统 | 源包内解析，不作跨包唯一主键 |
| SUBSYSTEMS.NUM / SUBSYSTEMn | 变电主层级 | 计数与实际引用分别检查 |
| SECTIONS.NUM / SECTIONn | 线路 F1→F2 | 保留源顺序 |
| STRAINSECTIONS.NUM / STRAINSECTIONn | 线路 F2→F3 | 耐张段成员 |
| GROUPS.NUM / GROUPn | 线路 F3→F4 | 可共享节点，不能只按树数对象 |
| SUBDEVICES.NUM / SUBDEVICEn | 设备内部语义分组 | 不代替 F1→F4 主层级 |
| OBJECTMODELPOINTER | DEV 模板引用 | 可缺失；不假定同名 FAM |
| BASEFAMILY / BASEFAMILYPOINTER / BASEFAMILYn | FAM 来源 | 解析实际目标，不依赖 UUID 同名 |
| IFC.NUM / IFCn | IFC 文件清单 | 文件发现能力 |
| IFCFILE / IFCGUID | 来源文件及其对象 GUID | 文件与对象分别校验 |
| SUBLOGICALMODELS.NUM / SUBLOGICALMODELn | 逻辑节点清单 | 可包含无几何 LOGICALMODEL 占位 |
| SCH | 逻辑入口 | 可选 |
| TYPE | 工程原类型字段 | 不覆盖容器 magic |
| FILE.NUM / FILEi.NAME / FILEi.DEV.NUM / FILEi.DEVn | 文件—设备关系清单 | NAME 保留设计来源；设备引用单独解析 |
| TRANSFORMMATRIX | CBM 装配变换 | 16 项矩阵，与 BLHA 分开 |
| BLHA | 地理/方向来源 | 字段口径与有效性单独确认 |
| SYSCLASSIFYNAME / PARTNAME / SYSTEMNAMEn / NAME | 原始分类、名称与展示候选 | 不硬编码统一专业含义 |
| MATERIALSHEET 等 | 来源引用或原字段 | 缺省不等于 parser 失败 |

非空引用按全局 resolver 解析。引用目标、原键、所属节点和原路径应可追踪。
缺失目标和无法唯一解析分别记录。FDR/DGN 等设计来源保留文件和设备关联，即使设备列表为空也保留文件事实；它们不是 IFCGUID 对象关联。

## 变电层级

```text
project → F1System → F2System → F3System → F4System
                                                  └─ PARTINDEX/内部语义设备
```

这是常见投影，不要求所有导出包具有固定深度或所有字段。
可读名称从 SYSTEMNAMEn、FAM 和原始名称等来源建立；分类代码不强行翻译成统一专业。
保留父子源引用，分支防环；同一文件多条合法引用与意外循环区分。

PARTINDEX 的 `OBJECTMODELPOINTER` 是身份线索。
当父节点同时有 CBM SUBDEVICEn 清单与 DEV SUBDEVICEn 清单时，不能按同下标 join。
先在所属物理装配子树检索同 DEV 身份候选，支持嵌套路径；无候选或多候选保留状态。
PARTINDEX 和 DEV_SUBDEVICE 不产生新的物理根或重复 seed。

模板唯一性和 occurrence 唯一性见 [几何模型](geometry-model.md)。

## 线路层级与引用图

```text
project → F1System → F2System(线路) → F3System(耐张段) → F4System(分组)
```

F4 依据 GROUPTYPE 表达 TOWER、WIRE、CROSS。

| 类型/键族 | 作用 |
|---|---|
| TOWERS.NUM / TOWERn | 杆塔模板/部件语义引用 |
| BASES.NUM / BASEn | 基础引用 |
| STRINGS.NUM / STRINGn.STRING | 导线/地线串 |
| STRINGn.GPOINT | 串对应挂点 |
| BACKSTRING / FRONTSTRING | 前后串来源 |
| SUBDEVICES.NUM / SUBDEVICEn | WIRE/CROSS 等内部对象引用 |
| WIRETYPE | CONDUCTOR/OPGW/GROUNDWIRE 等原分类 |
| ISJUMPER | 原跳线标志，与端点关系交叉检查 |
| MODLEG | 塔腿偏移四值来源，不当作地理塔位 |
| SPLIT / KVALUE | 分裂数与曲线系数原字段，不推定已核验的工程公式 |
| POINTn.STRING / POINTn.GPOINT / POINTn.BLHA / POINTn.MATRIX0 | WIRE 端点串、挂点、地理位置及局部矩阵 |

塔位来源为有效 TOWER 分组的地理字段，不把 Tower_Device 数量或 CROSS 的点数当塔数。
边界杆塔可被多个耐张段引用；图节点按规范化路径复用、边与所属关系保留。
同塔跳线与跨塔导线分开，不构造虚假物理档。

F2/FAM 的 LINELENGTH 为源属性值；其单位/用途不能由图数量推定。
统计多 F2 时明确求和口径，不用它替代地理曲线长度。
六包原值见 [台账](sample-corpus.md)。

## FAM 原始行

```text
[基本属性]
名称=NAME=设备A
材质=材质=铝
材质=材质=制造厂家提供
[扩展属性]
=设备编码=CODE-A
```

这是合成例子。支持 `标签=内部键=值`、`标签=标签=值`、`=内部键=值` 等形式。
当前变电 parser 以最后一段作为值，前面第一个非空候选作为 label/Map key，最后一个非空候选作为 rawKey；不把厂商写法扩张为不同 domain model。
非空候选不足时记录 malformed。值中存在额外 `=` 时保留 rawLine，不能声称通用无损分隔协议。

每条来源记录保留 sourcePath、section、sourceLine、label、rawKey、rawValue 和 rawLine。
sourceLine 为源物理行的一基编号。相同节、相同键的重复行都是独立记录。
单值 Map 使用最后物理行，包括空值；它不代替原始属性集合。

线路 FAM 同样保留业务字段与来源，DEV/FAM 可以异名。
业务身份候选依次使用三维设计模型编码、电网工程标识系统编码、设备编码、调度编码、实物 ID 的非空原记录，不生成猜测编码；业务编码没有必然全包唯一性，不能替代文件/节点/occurrence 主键。

## IFC 与语义的证据等级

| 事实 | 可得结论 |
|---|---|
| 包中存在 IFC | 文件能力存在 |
| CBM 具有 IFC 文件引用 | 文件级来源链接 |
| IFCGUID 可在对应模型定位 | 对象级直接链接 |
| 名称/空间位置等推断 | 带置信度的推断候选 |
| 没有对象 GUID/无法解析 | 未关联，不能伪造确定 IFC 对象 |

IFC 空间归属、分解、host 边界与局部 placement 有独立来源。
文件发现和对象关联不能用一个布尔值代表。详情读取与缓存策略见 [架构](../architecture.md)。

## 当前实现入口

[cbmParser](../../desktop/src/gim/cbmParser.ts)、
[lineCbmParserCore](../../desktop/src/gim/lineCbmParserCore.ts)、
[famParser](../../desktop/src/gim/famParser.ts)、
[lineFamParser](../../desktop/src/gim/lineFamParser.ts)、
[substationEvidence](../../desktop/src/gim/substationEvidence.ts)。
