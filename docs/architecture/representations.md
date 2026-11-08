# 表示与绑定

本文件描述工程整体、物理 occurrence 与可渲染表示之间的关系。实体分类见[工程实体模型](../engineering/README.md)，DEV/IFC 编译细节分别见[DEV 几何](dev-geometry.md)和[IFC 运行时](ifc-runtime.md)。

## 目录

- [三层身份](#三层身份)
- [物理 occurrence](#物理-occurrence)
- [表示索引](#表示索引)
- [绑定规则](#绑定规则)
- [选择后的表示](#选择后的表示)
- [状态](#状态)
- [边界](#边界)
- [相关文档](#相关文档)

## 三层身份

| 层 | 身份 | 来源 | 不负责 |
|---|---|---|---|
| 工程整体 | `EngineeringEntity.id` | 包内 occurrence + 工程证据/规则 | 不生成 Mesh、不决定 LOD |
| 来源 occurrence | `SourceRecord.id` / `SourceGeometryOccurrence.id` | CBM 引用 + DEV 实际装配路径 | 不决定工程类别 |
| 运行时表示 | DEV root occurrence + assemblyPath / IFC modelId+ExpressId | 几何编译器、Fragments、区域索引 | 不生成工程整体 |

三层通过来源 ID 连接，不使用显示名、F 层级、CBM 树路径或空间距离连接。

## 物理 occurrence

`SourceGeometryOccurrence` 由完整来源图产生：

```text
rootOccurrence  物理根 DEV occurrence
sourcePath      模板 DEV 路径
assemblyPath    真实 SUBDEVICE 路径
matrix          列主序累计矩阵（含 CBM/装配变换，平移按单位换算）
```

规则：

- 同一模板被不同路径引用时保留不同 occurrence；不使用全局 visited 删除合法重复。
- PARTINDEX/DEV 的 `OBJECTMODELPOINTER` 只按实际 DEV 身份挂接，不产生第二个物理根。
- 几何编译按模板复用、按 occurrence 放置；放置不烘焙回共享模板。
- 矩阵无效时保留原文和“位置待确认”诊断，不自动居中或拟合。

同一 occurrence 的 DEV LOD、GLB、raw 回退、选择高亮都使用同一身份；LOD 替换不改变选择目标。

## 表示索引

`EngineeringRepresentationIndex` 接收：

- `EngineeringSnapshot` 的成员关系；
- DEV/IFC 绑定：
  - DEV：`sourceId`、`rootOccurrence`、`assemblyPath`、`devPath`；
  - IFC：`sourceId`、`modelId`、`expressId`、`globalId`、`nonphysical`。

它维护：

| 索引 | 用途 |
|---|---|
| `ownerBySource` / `sourcesByOwner` | 来源与整体互查；整体选择取来源成员并集 |
| `bySource` | 来源到 DEV/IFC 地址 |
| `devRoots` / `devAssembly` / `devFiles` | DEV 根、装配路径、文件路径到来源 |
| `ifcObjects` | `(modelId, expressId)` 到来源 |

解析结果只有三种：`bound`（唯一整体）、`ambiguous`（跨多个整体）、`unassociated`（没有整体归属）。不自动选择第一个候选。

## 绑定规则

- 整体选择：`sourcesForOwners(ownerIds)` 得到全部来源，再取 DEV/IFC 表示；选择范围可跨多个 DEV 根和 IFC 模型。
- 分组选择：遍历组成节点下所有实体，按实体 ID 去重；计数不是设备台数。
- 来源选择：只取该来源的表示；允许查看原始记录、属性和精细模型，不把来源提升为整体。
- 独立对象：没有真实设备装配边的端子箱、独立基础、支架通过关联关系保留独立整体；真实装配内的端子箱属于宿主组成，不在独立对象之列。
- 粗表示跨多个整体时，`resolveDev`/`resolveIfc` 返回 `ambiguous`，界面展示候选，不把整块网格同时算作任一整体。
- 未绑定来源返回 `unassociated`，提示“当前表示的来源尚未可靠关联，请在来源视图查看”。

IFC 的 `globalId` 是否唯一由 `(modelId, globalId)` 计数决定；重复 GUID 不用于单值反向查询。DEV 的 mesh hint 可能带 PHM/MOD 后缀，解析时沿真实装配路径向上回退到最近的 DEV occurrence，不扫描全部兄弟。

## 选择后的表示

1. 解析整体/分组/来源，生成选择 scope（ownerIds、sourceIds、devRoots、ifc refs）。
2. 按来源成员取 DEV 根和 IFC 对象；未加载的 DEV 只准备基础表示，不自动进入 L2。
3. 高亮只对解析为同一整体的可见网格/对象提交；跨整体粗表示保留歧义。
4. 显式“查看精细模型”才调用 DEV refine/IFC L2；替换表示后原选择身份不变。
5. 快照更新后按当前成员重新绑定；原整体拆分/合并导致目标不唯一时撤销旧范围，提示候选。

## 状态

`selectionGeometry.status` 区分：

| 状态 | 含义 |
|---|---|
| `available` | 至少一个来源成员有可见表示 |
| `partial` | 部分成员缺失，或粗表示包含多个整体 |
| `ambiguous` | 表示跨多个整体，范围未分离 |
| `not-loaded` | 逻辑选择存在但表示未加载 |
| `unassociated` | 来源没有可靠整体归属 |
| `unlinked` / `file-only` | 仅有来源/文件，没有可渲染表示 |

这些状态描述“当前选择能否定位/高亮”，不等同于工程实体是否存在。整体和来源仍可在属性/来源视图查看。

## 边界

- 不按包围盒邻近、同名、同模板或 F 层级补造归属。
- 不把粗模型拆分结果当作精确对象几何；不可分离时明确降级。
- 不保证所有来源都有表示；空源、unsupported、failed 分别显示。
- 不证明 GPU 已呈现；高亮集合非空只说明提交完成。

## 相关文档

- [工程实体运行时](engineering-runtime.md)
- [DEV 几何运行时](dev-geometry.md)
- [IFC 运行时](ifc-runtime.md)
- [选择与交互](selection.md)
- [几何资产与表示索引](geometry-assets.md)
- [工程实体模型](../engineering/README.md)
