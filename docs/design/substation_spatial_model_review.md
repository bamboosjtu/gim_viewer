# 变电工程空间信息模型审查与补齐方案

> 状态：M0/M1 已完成；M2 已补齐 IFC 详情、分解/宿主关系继承、空间边界、多模型分组和来源图纸关联；本文同时保留未完成能力边界  
> 日期：2026-08-29  
> 范围：四个匿名变电样本的 IFC/CBM 静态结构，以及当前桌面端的导航实现

## 1. 审查结论

变电样本并不是“没有空间信息”。四个样本都提供了不同程度的 IFC 空间实体和空间包含关系；本次已将这些关系解析为统一空间索引并投影到左侧导航。导出工具未提供 IFCGUID 的对象仍按坐标证据或未关联分组显示；没有 IFC 空间容器的 IFC 构件也进入独立质量分组，不再从空间搜索中消失。

需要把“空间层级存在”和“CBM 资产能否关联到空间”拆成两个质量维度：

1. IFC 的 `IFCPROJECT → IFCSITE → IFCBUILDING → IFCBUILDINGSTOREY → IFCSPACE`（如存在）及 `IFCRELAGGREGATES`、`IFCRELNESTS`、`IFCRELCONTAINEDINSPATIALSTRUCTURE` 负责建立**已确认的空间主树**；`IFCRELSPACEBOUNDARY` 作为独立的空间边界证据保留。
2. IFC 的 `IFCRELAGGREGATES/IFCRELNESTS/IFCRELDECOMPOSES` 负责把装配体子构件继承到父空间；`IFCRELVOIDSELEMENT`（开洞）与 `IFCRELCONNECTSPORTTOELEMENT`（端口）负责把宿主关系子对象继承到宿主空间。两类继承均标注证据，不冒充直接包含。
3. CBM 的 `IFCFILE + IFCGUID` 负责建立**直接资产关联**；导出工具没有写出 GUID 时，CBM/DEV 的 `TRANSFORMMATRIX` 只能作为**位置证据**，不得伪装成已确认的 IFC 归属。
4. 所有不能关联的对象仍保留在“未关联/未定位”分组，并显示原因、来源和坐标状态；不能因为缺一条关系就从导航删除对象。

因此，变电采用“空间—功能双轴联合导航”：空间结构在关系可靠时默认，功能系统作为同级可切换投影保证 CBM 设备完整可达；不能因为部分资产缺少 GUID 就整体隐藏空间视图，也不能把功能视图塞成空间树的子节点。

## 2. 四个样本的空间证据

数字只用于验证设计压力，产品运行时必须动态计算。样本名称已匿名化为“变电站01–04”。

| 样本 | IFC 文件 | Site | Building | BuildingStorey | Space | 聚合关系 | 空间包含关系 | 直接包含对象 | 分解关系继承对象 | 宿主关系继承对象 | 被空间关系覆盖的 IFC 对象 | F4 节点 | F4 有 IFCGUID | F4 有 DEV | F4 有变换矩阵 | F4 非单位矩阵 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 变电站01 | 12 | 12 | 12 | 34 | 0 | 73 | 34 | 3,111 | 74 | 1,529 | 4,714 | 4,645 | 4,360 | 285 | 4,645 | 285 |
| 变电站02 | 17 | 14 | 17 | 14 | 0 | 52 | 17 | 51,767 | 38 | 10,371 | 62,176 | 3,326 | 0 | 3,326 | 3,326 | 2,436 |
| 变电站03 | 8 | 8 | 8 | 8 | 0 | 24 | 8 | 9,572 | 0 | 0 | 9,572 | 162 | 0 | 162 | 162 | 150 |
| 变电站04 | 19 | 19 | 19 | 29 | 5 | 67 | 29 | 7,182 | 44 | 494 | 7,720 | 532 | 0 | 532 | 532 | 428 |

### 2.1 这组数字说明什么

- **空间容器是普遍存在的**：四个样本均有 Site/Building，且均有 BuildingStorey；变电站04另有 5 个 `IFCSPACE`。
- **空间包含关系可直接用于 IFC 构件树**：每个样本都有 `IFCRELCONTAINEDINSPATIALSTRUCTURE`，直接包含对象数分别为 3,111、51,767、9,572、7,182；对象分解关系再补齐 74、38、0、44 个，开洞/端口等宿主关系再补齐 1,529、10,371、0、494 个空间归属。
- **直接 CBM→IFC 的覆盖率随导出工具变化**：按当前解析器口径，变电站01的 4,360 个 F4 节点带 IFCGUID，其中 3,244 个 GUID 能在 IFC 中命中，2,253 个能沿空间关系到达楼层/空间；变电站02–04 的 F4 全部走 DEV，未提供 F4 IFCGUID。
- **坐标证据并不缺失**：变电站02–04 的所有 F4 都有 16 元素变换矩阵，非单位矩阵分别为 2,436、150、428 个；这些矩阵可用于定位设备，但不能单凭坐标断言“属于某个 IFC 构件”。
- **“缺失信息”应被分层展示**：同一工程可能同时存在“空间已确认、资产已关联”“空间已确认、资产仅有坐标”“空间已确认、资产未关联”和“系统属性完整但没有几何”四种状态。

以变电站01为例，IFC 原始实体还包含大量属性值、几何拓扑和关系记录。当前解析器将 4,714 个可识别产品/构件与 1,469,778 个低层资源分开：3,111 个产品由 IFC 直接包含，74 个通过对象分解关系继承，1,529 个开洞/端口通过宿主关系继承，合计 4,714 个空间可达；“未落入空间的 IFC 构件”为 0。资源只按模型/类型统计，不生成伪构件行。

### 2.2 实现前的投影缺口与本次补齐

当前代码的职责边界造成了明确的投影缺口：

| 位置 | 实现前行为 | 本次补齐 |
| --- | --- | --- |
| `desktop/src/gim/gimIndexer.ts` | 只扫描 IFC 文件入口并建立文件/GUID 索引 | `desktop/src/gim/ifcSpatialParser.ts` 解析 Site、Building、Storey、Space、Zone 及 `IFCREL*SPATIAL*` 关系 |
| `desktop/src/viewer/ifcNameIndex.ts` | 只读取 IFC Name | 空间索引保存父子关系、楼层标高、来源模型和空间包含对象集合；属性/几何/关系记录计入资源统计但不伪装成构件 |
| `desktop/src/gim/types.ts` 的 `CbmNode` | 保存单节点 `transformMatrix`、`ifcFile`、`ifcGuid` | `SpatialAssetLink` 记录 `confirmed/inferred/unresolved` 证据、来源、坐标和原因 |
| `desktop/src/ui/cbmTreeView.ts` | 直接递归渲染 `CbmNode.children` | 变电模型视角增加“空间/系统”切换；空间容器、IFC 构件、未落位构件和质量分组懒加载，并支持分页加载全部行 |
| 缓存索引 | 主要缓存 CBM/FAM/DEV 和几何引用 | 缓存命中时读取已落盘 IFC 文本重建空间索引，不重新解压 GIM |

这解释了原先“样本信息很多但界面仍显得缺失”的原因：信息在 IFC/CBM 中，但此前没有经过空间语义投影；现在空间主树、未落位 IFC 构件和模型资源统计均显式呈现，只有低层资源记录不展开为业务对象行。

## 3. 目标空间对象图

空间树、系统树和设备清单必须共享同一对象图，不复制三份设备数据。本次实现使用以下纯数据结构；它们不绑定 Three.js、DOM 或 SQLite 具体实现。

```ts
type SpatialKind = 'project' | 'site' | 'building' | 'storey' | 'space' | 'zone' | 'container';
type SpatialEvidence = 'ifc-contained' | 'ifc-boundary' | 'ifc-guid' | 'cbm-transform' | 'unresolved';
type IfcSpatialContainment = 'direct' | 'inherited' | 'boundary';

interface IfcSpatialObject {
  key: string;
  modelId: string;
  expressId: number;
  ifcType: string;
  globalId: string;
  name: string;
  description?: string;
  objectType?: string;
  tag?: string;
  predefinedType?: string;
  placement?: { placementRef: string; matrix: number[]; position: [number, number, number]; unit?: string };
  representationRef?: string;
  geometryStatus: 'represented' | 'unrepresented';
  propertySets?: IfcPropertyGroup[];
  materials?: string[];
  classifications?: string[];
  typeName?: string;
  groupNames?: string[];
  parentObjectKey: string | null;
  childObjectKeys: string[];
  relationshipCount: number;
  relationshipTypes?: Record<string, number>;
  hostObjectKey: string | null;
  spatialKey: string | null;
  spatialKeys: string[];
  spatialContainment: IfcSpatialContainment | null;
  spatialRelation?: 'containment' | 'space-boundary' | 'decomposition' | 'host-relation';
  spatialInheritanceKind?: 'decomposition' | 'host-relation';
}

interface IfcSpatialNode {
  key: string;
  kind: SpatialKind;
  parentKey: string | null;
  childKeys: string[];
  directObjectKeys: string[];
  boundaryObjectKeys: string[];
  objectKeys: string[];
}

interface SpatialCoverage {
  hasSpatialEntities: boolean;
  hasSpatialContainment: boolean;
  directContainedIfcObjects: number;
  decompositionInheritedIfcObjects: number;
  hostInheritedIfcObjects: number;
  boundaryContainedIfcObjects: number;
  /** 分解关系 + 宿主关系的继承总数；对象级字段拆分两类。 */
  inheritedContainedIfcObjects: number;
  uncontainedIfcObjects: number;
  directCbmIfcLinks: number;
  spatiallyContainedCbmLinks: number;
  placementOnlyAssets: number;
  unlocatedAssets: number;
  confirmedWithoutSpatialContainer: number;
  hasPlacementCoordinates: boolean;
  confidence: 'confirmed' | 'partial' | 'inferred' | 'none';
}
```

### 3.1 关联优先级

空间归属必须按以下顺序计算，并记录命中的证据：

1. `IFCFILE + IFCGUID` 精确命中 IFC 实体，并沿 `IFCRELCONTAINEDINSPATIALSTRUCTURE` 找到楼层/空间：`confirmed`。
2. IFC 实体自身沿 `IFCRELAGGREGATES`、`IFCRELNESTS`、`IFCRELDECOMPOSES` 继承空间，或通过 `IFCRELSPACEBOUNDARY`、`IFCRELVOIDSELEMENT`、`IFCRELCONNECTSPORTTOELEMENT` 关联/继承宿主空间：`confirmed`，并分别记录边界、分解和宿主证据。
3. CBM/DEV/PHM/MOD 的变换链能算出工程坐标，但没有 IFCGUID：放入“坐标定位对象”，`cbm-transform`，`inferred`。
4. 只有在明确存在楼层标高、对象包围盒和唯一候选楼层时，才可生成“楼层推断”链接；必须带“推断”徽标并保留候选范围。
5. 任何无法唯一判断的对象进入“未关联/未定位”，并设置 `unlocatedReason`；不得依据文件名或专业码猜造空间。

### 3.2 规范化和去重

- IFC 构件键：`ifc:<modelId>:<ifcGuid>`；`modelId` 取规范化后的 IFC 文件标识，GUID 不能跨模型裸合并。
- CBM 资产键：`cbm:<normalized-cbm-path>`；虚拟 `DEV_SUBDEVICE` 使用父 DEV 键加稳定索引，不使用显示路径临时拼接。
- 空间容器键：`<kind>:<normalized-name>:<model-group>`。名称是 `Default`、`$` 或空值时，必须保留来源模型分组，不能把不同 IFC 的默认建筑误合并。
- 多个 IFC 文件的同名 Site/Building/Storey 只有在来源、父容器和几何范围均一致时才合并；否则并列显示并在来源徽标标出模型。

## 4. 左侧空间主树

当 `hasSpatialEntities && hasSpatialContainment` 为真时，空间结构默认可用；资产关联覆盖率低只影响行徽标和未关联分组，不再整体隐藏空间视图。

```text
变电工程
├─ IFC 模型 · n
│  ├─ 电气一次模型
│  │  └─ 站区 / 建筑 / 楼层（已确认）
│  │     ├─ 建筑或构筑物 A
│  │     │  ├─ 楼层 / 标高 +0000
│  │     │  │  ├─ 空间 / 区域（IFCSPACE，如存在）
│  │     │  │  ├─ IFC 构件（直接 + 分解继承）
│  │     │  │  └─ 关联设备
│  │     │  └─ 未命名楼层
│  │  └─ 其他来源模型 · …
├─ 关联状态（折叠）
│  ├─ 坐标定位对象（位置推断） · n
│  ├─ 已关联 IFC · 无空间容器 · n
│  ├─ 未关联 IFC 对象 · n
│  └─ 未落入空间的 IFC 构件 · n
└─ 模型资源 · n（折叠）
   └─ 按 IFC 模型显示属性集、几何拓扑和关系记录数量
```

空间索引的数量必须分别计算；树行只显示紧凑对象数，完整值在 tooltip、检查器和质量分组中查看：

- `IFC 构件`：空间树可达的 IFC 实体数（直接包含 + 分解继承 + 宿主关系继承；空间边界对象仍保留边界证据）；
- `直接包含` / `分解继承` / `宿主继承`：分别对应 `directObjectKeys`、`spatialInheritanceKind=decomposition` 和 `spatialInheritanceKind=host-relation`，不把继承证据伪装成直接 IFC 关系；
- `CBM 关联`：通过 IFCGUID 直接关联的 CBM 业务对象数；
- `位置推断`：只有 CBM/DEV 变换矩阵，没有确认 IFC 容器的对象数；
- `已关联但无空间容器`：IFC GUID 已命中，但 IFC 没有提供空间父容器，不能伪造楼层；
- `未关联`：没有可用关联或空间证据的对象数；
- `未落入空间的 IFC 构件`：IFC 产品已被识别，但没有任何空间包含关系；
- `模型资源`：属性值、几何拓扑、关系记录等低层 IFC 实体，只显示按模型/类型统计，不计入业务构件数。

示例中的数字仅用于说明行结构，运行时必须由 `SpatialCoverage` 动态计算。

## 5. 缺失数据的可见化规则

| 缺失或冲突 | 空间树行为 | 行徽标与检查器 |
| --- | --- | --- |
| 没有 Site/Building/Storey | 不注册空间主树，默认打开功能系统 | “空间层级未提供”，来源页列出检测结果 |
| 有空间实体但没有包含关系 | 注册“空间容器”诊断节点，不把对象强行挂到楼层 | “容器存在 / 包含关系缺失” |
| 有 IFC 包含关系但 CBM 无 IFCGUID | IFC 构件照常进入楼层；CBM 对象进入“坐标定位对象”或“未关联 IFC 对象” | “位置推断”或“未关联”，显示矩阵和原因 |
| IFCGUID 存在但文本未命中 | 原 CBM 节点保留，不从空间/功能视图删除 | “IFC GUID 未命中”并支持复制原始值 |
| IFCGUID 命中但无空间容器 | 进入“已关联 IFC · 无空间容器”质量分组 | 显示已命中的 GUID，不伪造楼层归属 |
| 变换矩阵缺失/非法 | 对象仍在系统树和设备表 | “无法定位”，保留 DEV/FAM/几何来源 |
| 多个 IFC 都叫 Default | 按来源模型分组，禁止合并成一个假建筑 | “来源模型 n”徽标 |
| IFC 只有楼层没有 IFCSPACE | 楼层下直接显示 IFC 构件，不创建“空间/区域”占位节点 | “未提供 IFCSPACE” |
| 空间对象无几何 | 保留空间节点和属性 | “无几何”，不影响子对象选择 |
| 系统归属和空间归属冲突 | 两个视图各自保留事实 | 检查器关系页并列显示“空间归属 / 系统归属”，不擅自移动 |

质量颜色不能作为唯一表达；每个状态都同时使用文字、图标和可筛选计数。

## 6. 能力标记和展示计算

不要只使用一个 `hasReliableSpatialHierarchy` 布尔值。运行时索引拆成以下能力和覆盖指标：

| 能力 | 计算条件 | 作用 |
| --- | --- | --- |
| `hasSpatialEntities` | 至少存在 Project/Site/Building/Storey 中两级 | 可显示空间容器摘要 |
| `hasSpatialContainment` | 至少一条 `IFCRELCONTAINEDINSPATIALSTRUCTURE` 且覆盖对象数大于 0 | 可显示 IFC 空间主树 |
| `hasSpaces` | 存在 `IFCSPACE` | 楼层下显示空间/区域层 |
| `hasDirectCbmIfcLinks` | CBM 的 IFCFILE+IFCGUID 命中率大于 0 | 允许“关联设备”节点 |
| `hasPlacementCoordinates` | CBM/DEV 有合法 16 元素矩阵或 IFC placement | 允许“坐标定位对象”节点 |
| `directContainedIfcObjects` | IFCREL*SPATIAL* 直接包含的 IFC 构件数 | 作为空间关系的原始证据 |
| `decompositionInheritedIfcObjects` / `hostInheritedIfcObjects` | 分别沿对象分解关系、开洞/端口宿主关系继承到空间的构件数 | 在空间树中显示“分解继承/宿主继承” |
| `boundaryContainedIfcObjects` | 通过 IFCRELSPACEBOUNDARY 关联到空间的构件数 | 在空间树中显示“空间边界” |
| `inheritedContainedIfcObjects` | 分解关系 + 宿主关系继承总数；对象级再拆分分解/宿主 | 兼容旧调用方的总计 |
| `spatialObjectCount` | 直接 + 分解继承 + 宿主关系继承（含空间边界关联）的空间可达构件数 | 作为空间树构件总数，不与资源数混用 |
| `confirmedWithoutSpatialContainer` | IFCGUID 命中但对象没有空间父容器的 CBM 链接数 | 显示“已关联 IFC · 无空间容器”质量分组 |
| `uncontainedIfcObjects` | IFC 产品/构件数 - 有空间容器的 IFC 产品/构件数 | 显示“未落入空间的 IFC 构件”质量分组 |
| `hasReliableSpatialHierarchy` | `hasSpatialEntities && hasSpatialContainment` | 决定空间主树是否成为默认视角，不代表所有资产均已关联 |

覆盖率口径：

```text
directCbmIfcLinkCoverage
  = IFCGUID 在同一 IFC 文件中命中的 F4 数 / 带 IFCGUID 的 F4 数

spatiallyContainedCbmCoverage
  = 同时命中 IFCGUID 且能沿空间包含关系到达 Storey/Space 的 F4 数
    / 带 IFCGUID 的 F4 数

placementCoverage
  = 有合法变换矩阵的 F4 数 / F4 总数
```

四个样本的验收快照：

| 样本 | 空间主树 | 直接 GUID 关联 | 楼层空间关联 | 坐标定位 |
| --- | --- | ---: | ---: | ---: |
| 变电站01 | 可用 | 3,244 / 4,360（74.4%） | 2,253 / 4,360（51.7%） | 285 个 DEV F4 |
| 变电站02 | 可用 | 0（导出未提供 IFCGUID） | 0 个 CBM 直接链接 | 3,326 / 3,326 |
| 变电站03 | 可用 | 0（导出未提供 IFCGUID） | 0 个 CBM 直接链接 | 162 / 162 |
| 变电站04 | 可用 | 0（导出未提供 IFCGUID） | 0 个 CBM 直接链接 | 532 / 532 |

这里的“可用”只表示 IFC 空间主树可建立；变电站02–04 必须同时显示资产关联缺失的质量状态。直接包含快照保持原始 IFC 关系口径；空间树总量还会加上分解继承和宿主关系继承项（变电站01/02/03/04 分别为 4,714 / 62,176 / 9,572 / 7,720）。

## 7. 实施顺序与验收

### M0：纯解析和对象图（已完成）

1. 新增 `ifcSpatialParser`，扫描 IFC 记录，解析空间实体、名称、标高、聚合关系和包含关系；按 IFC 产品类型过滤低层资源，资源类型只计数不展开。
2. 新增 `SubstationSpatialIndex`，按模型隔离 GUID，输出 `IfcSpatialNode[] + SpatialAssetLink[] + SpatialCoverage`。
3. 从 CBM 的 `IFCFILE/IFCGUID` 和 `TRANSFORMMATRIX` 生成链接，区分 `confirmed`、`inferred`、`unresolved`；同一 IFC 构件的多个 CBM 引用保留为一对多关系。
4. 在系统树、空间树和设备表之间复用同一个 `canonicalKey/selectionId`。

### M1：缓存与界面（已完成）

1. 缓存命中时恢复空间索引；不能只恢复 CBM 原始树。
2. `BIMTree` 的空间/系统切换统一命名为“空间/功能系统”；空间视图显示楼层、空间、构件计数和关联覆盖率，功能视图已按 F3 功能域组织，并保留 F2 专业作为徽标/筛选上下文。
3. 右侧检查器增加“空间关系”卡片：空间路径、楼层标高、关联证据、置信度、未定位原因和来源模型；未直接关联或未落位的 IFC 构件也可以打开基础属性。
4. 空间树和系统树的选择、高亮、定位共用现有选择链；切换视角不能创建第二个几何实例。

### M2：IFC 详情、关系继承和多模型导航（已完成）

1. 解析 IFC PropertySet/ElementQuantity、材质、分类、类型定义、组/系统、Representation、原生放置坐标和关系类型；低层资源按模型/类型统计，不生成伪构件。
2. 沿 IFC 对象分解关系把子构件继承到父空间，并用 `directObjectKeys` 与 `objectKeys` 区分直接包含和继承项。
3. 多个 IFC 来源模型在空间根下增加“IFC 模型”分组，避免 `Default Project/Site` 重复占满首层；搜索会自动展开模型分组和空间祖先链。
4. 四个样本的直接包含数保持 3,111 / 51,767 / 9,572 / 7,182；新增分解继承项为 74 / 38 / 0 / 44，宿主关系继承项为 1,529 / 10,371 / 0 / 494，并纳入空间树总量 4,714 / 62,176 / 9,572 / 7,720。
5. `FileDevRelation.cbm` 兼容 `FILE.NUM/FILES.NUM`、`DEV.NUM/DEVS.NUM`、JinQu 奇偶配对和 BIMBase 同条目 IFC；来源图纸名称/真实 IFC 文件挂到 `SpatialAssetLink`，DGN 不再被误当作 IFC 模型。

### M3：质量治理与保守推断（待实施）

1. 仅在标高、包围盒和坐标基准经过验证时提供“楼层推断”，默认关闭自动合并；当前 CBM/DEV 坐标仍只显示为位置证据。
2. 对空间覆盖率、GUID 未命中、无矩阵、Representation 缺失、多模型默认容器等问题提供质量筛选和 CSV/诊断包导出。
3. 继续以四个样本做回归；导出工具差异只能改变结果，不能使解析器崩溃或静默丢对象。

## 8. 与既有文档的关系

- 左侧树总原则和变电/线路分工：[navigation_information_architecture.md](./navigation_information_architecture.md)。
- 变电候选方案评分与空间—功能双轴决策：[substation_navigation_strategy_analysis.md](./substation_navigation_strategy_analysis.md)。
- 变电页面编排与菜单行为：[substation_menu_brief.md](./substation_menu_brief.md)。
- 展示数量和首屏压力：[navigation_display_calculation.md](./navigation_display_calculation.md)。
- 组件契约、能力标记和共享选择：[component_brief.md](./component_brief.md)。
- IFC/CBM 原始证据：[../schema/22-ten-sample-verification-0824.md](../schema/22-ten-sample-verification-0824.md)。

本文件新增的“空间主树可用但资产关联可能缺失”规则优先于旧的“一旦空间关系不完整就隐藏空间视图”表述；后者会把样本中已经存在的空间信息再次丢给用户。
