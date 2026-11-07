# v0.2 SDK 设计评审

日期：2026-11-05。范围：工程实体识别、变电 DEV/PHM/MOD 几何编译、可复用测试契约。本文是**设计建议**，不表示这些包已实现、已通过独立发布验收，也不改变现有桌面运行路径。

## 结论

建议划分三个**独立版本、独立测试**的模块，但分阶段抽取：

1. `@gim/engineering-core`：无 GIM 格式和图形依赖的工程整体、成员归属及来源表示绑定。最先具备独立使用条件。
2. `@gim/geometry-sdk`：先提供有界解析、几何引用发现和中立编译结果；Three.js 编译实现通过单独的 `/three` 子入口提供。当前不能把整个 Viewer 当作几何 SDK 搬出。
3. `@gim/sdk-conformance`：开发依赖，接收内存合成文件和预期断言，检查前两个 SDK 的契约。现有九工程 harness 只作为可选的项目集成回归适配器。

三者共享的是**来源地址、版本化输入/输出和诊断字段**，不是桌面 `AppState`、Mesh、SQLite 表或缓存文件。`packages/plugin-api` 是外部数据提供者契约，不承担本次 SDK 核心；`packages/powerline-core` 已有跨端纯解析的组织经验，但不能证明变电几何运行时可以直接在 Android 共享。

## 源码依赖核查

| 部分 | 当前证据 | 抽取判断 |
|---|---|---|
| 领域模型 | [`types.ts`](../../desktop/src/engineering/types.ts)、[`normalize.ts`](../../desktop/src/engineering/normalize.ts)、[`classify.ts`](../../desktop/src/engineering/classify.ts)、[`validate.ts`](../../desktop/src/engineering/validate.ts) 只引用同层类型、规则和校验；`normalizeEngineeringModel(scope, ObjectEvidence[], aliases)` 产出 `EngineeringSnapshot`，按 `sourceId` 排序并校验环和主归属。 | **可先抽取核心**。目录与规则 JSON 必须随包版本一起发布。 |
| 表示地址 | [`representations.ts`](../../desktop/src/engineering/representations.ts) 使用 `sourceId`、DEV root/assemblyPath、IFC modelId/expressId 解析归属；遇到多整体可返回 `ambiguous`，不创建 Mesh。 | **可直接纳入实体核心**；接口应输出歧义与证据，不替调用方猜宿主。 |
| GIM 来源适配 | [`sourceGraph.ts`](../../desktop/src/gim/engineering/sourceGraph.ts) 接受 `paths + readText`，保留 CBM/FAM 原行与引用诊断；[`sourceEvidence.ts`](../../desktop/src/gim/engineering/sourceEvidence.ts)、[`ifcSourceRecords.ts`](../../desktop/src/gim/engineering/ifcSourceRecords.ts)、[`engineeringModel.ts`](../../desktop/src/gim/engineering/engineeringModel.ts) 把格式记录变为领域证据。 | **纯逻辑可迁移，不能只复制文件**：还引用 `famParser`、IFC Spatial 类型、入口 resolver 和规则 JSON。先作为桌面适配器消费实体 SDK，再将有界 GIM parser 闭包放进可选 `/gim` 子入口。 |
| 几何解析与 IR | [`devParser.ts`](../../desktop/src/gim/geometry/devParser.ts)、[`phmParser.ts`](../../desktop/src/gim/geometry/phmParser.ts)、[`xmlModParser.ts`](../../desktop/src/gim/geometry/xmlModParser.ts)、[`affineMatrix.ts`](../../desktop/src/gim/geometry/affineMatrix.ts) 位于纯解析层；[`geometryOccurrences.ts`](../../desktop/src/gim/engineering/geometryOccurrences.ts) 以真实 DEV 根和累计 CBM 矩阵形成物理 occurrence。`gim/geometry/ir.ts` 当前从 `powerline-core` 重导出。 | **解析和物理地址可先抽取**。`xmlModParser` 的 `fast-xml-parser` 须显式登记并跨 Node/WebView 验证；不要把 IR 复制成两份。初期沿单向依赖复用现有 IR，若未来线路反向依赖几何包，再迁移 IR 所有权并保留兼容重导出。 |
| 几何发现与编译 | [`modGeometryDiscovery.ts`](../../desktop/src/services/modGeometryDiscovery.ts) 有递归 DEV/PHM、严格依赖和 entry resolver，但还使用 `File`、`CbmNode`、Three 矩阵及 `console`；[`devSpatialCatalog.ts`](../../desktop/src/services/devSpatialCatalog.ts) 虽作分析性 bounds，仍返回 `THREE.Box3`；[`xmlModGeometry.ts`](../../desktop/src/viewer/xmlModGeometry.ts) 使用 Three、CSG；[`glbCacheService.ts`](../../desktop/src/services/glbCacheService.ts) 使用 Three、GLTFExporter/Loader。 | **需拆开**纯发现、数值 bounds、后端编译、GLB 序列化。第一版公开编译结果与可选 Three 后端，不直接公开这些运行时服务函数。 |
| IFC 与浏览器运行时 | [`ifcSpatialParser.ts`](../../desktop/src/gim/ifcSpatialParser.ts) 是来源语义输入；[`ifcConversionWorker.ts`](../../desktop/src/viewer/ifcConversionWorker.ts)、`ifcRegionalRuntime`、Fragments/LOD 与 `viewerEngine` 紧连 WebView、缓存和相机。 | IFC **语义对象适配**可入 `/gim`；IFC Mesh 导入和区域 LOD 暂留桌面。 |
| Worker、缓存、测试 | [`engineeringService.ts`](../../desktop/src/services/engineeringService.ts) 持会话、Worker、Tauri IO 与导航缓存；[`engineeringCacheCodec.ts`](../../desktop/src/services/engineeringCacheCodec.ts) 绑定来源、实体、空间策略版本。旧九样本 runner 已退役；当前本地测试入口以私有注册表驱动 Worker、缓存与真实样本。 | **留在应用或适配层**。测试包应提取断言和规范化比较器，不移植桌面脚本及其硬编码路径。 |

仓库的 [`layers.md`](../../docs/architecture/layers.md) 与 `npm run check:engineering-boundaries` 当前检查通过，证明现有**源代码分层**，不等于 package 的发布边界已闭合。例如 `modGeometryDiscovery` 在 services 且导入 Three；`powerline-core` 和 `plugin-api` 当前均为 `private: true`、直接导出 TS 源码，不能以此推断打包产物已能独立安装。

## 推荐依赖图与包入口

```mermaid
flowchart LR
  D[桌面 Worker / 缓存 / Viewer] --> G[应用 GIM 适配器]
  D --> E[@gim/engineering-core]
  D --> T[@gim/geometry-sdk/three 可选]
  G --> E
  G --> S[@gim/geometry-sdk/source]
  T --> S
  S --> P[@gim/powerline-core IR 暂时单向依赖]
  C[@gim/sdk-conformance 开发依赖] -.-> E
  C -.-> S
  C -.-> T
```

实线表示“调用方依赖被调用方”，虚线表示**测试时依赖**。运行时实体核心不依赖几何包，几何包不依赖实体快照：两者通过 `sourceId` 对齐。`geometry-sdk/source` 初期可单向引用现有 `powerline-core` IR；不可让 `powerline-core` 同时反向引用它。桌面服务继续拥有 Worker、缓存、选择和投影完成时机。

```text
packages/
  engineering-core/       # types, normalize, classify, validate, representations
    src/index.ts           # 纯核心、规则和结构化诊断
    src/gim/              # 第二阶段可选来源适配入口；不进入根入口
  geometry-sdk/
    src/source.ts          # IR、DEV/PHM/MOD 解析、引用发现、矩阵与边界
    src/three.ts           # 可选 Three 编译后端，peer dependency: three
    src/index.ts           # 中立 DTO 和 source 入口；不静态 import Three
  sdk-conformance/
    src/index.ts           # fixture 运行器、规范化断言、诊断校验
    bin/gim-sdk-check.mjs  # 可选 CLI；不内置 demo 路径
```

建议三包首先在 monorepo 内 `private` 验证，再产出 `.js`、`.d.ts`、明确的 `exports` 子路径及依赖清单；独立安装消费通过后再决定公开发布。`/three` 只在显式导入时加载 Three/CSG，Android 可以只使用来源解析、矩阵和诊断，也可以不依赖变电 SDK。不要把桌面现有的 `File`、`Blob`、DOM、`AppState`、Fragments 类型出现在根入口中。

## 稳定 API 草案

以下是**拟议契约**，不是现存导出。先固定地址、状态和诊断，再讨论便利函数：

```ts
type SourceId = string;      // 同一源包内的 occurrence，不能使用模板名或显示名
type EntityId = string;      // 由 scope + 规范化来源身份决定
type ModelId = string;       // IFC entry 的稳定身份；expressId 在该 model 内有效
type EvidenceRef = { sourceId?: SourceId; path?: string; field?: string; line?: number; expressId?: number };
type Finding = { code: string; severity: 'info'|'warning'|'error'; evidence: EvidenceRef[]; message?: string };

normalizeEngineering(input: {
  scope: string; objects: readonly ObjectEvidence[]; aliases?: readonly SourceAlias[]
}): { snapshot: EngineeringSnapshot; findings: Finding[] };
validateEngineering(snapshot: EngineeringSnapshot, sourceIds: readonly SourceId[]): Finding[];
bindRepresentations(snapshot: EngineeringSnapshot, addresses: readonly SourceRepresentation[]): RepresentationIndex;
// 第二阶段 /gim：readText 由调用方提供，不传入桌面 File 或数据库句柄。
extractGimEvidence(reader: { paths: readonly string[]; readText(path: string): Promise<string> },
  options?: { signal?: AbortSignal; limits?: { maxOccurrences?: number; maxDepth?: number } }): Promise<SourceEvidenceBundle>;
```

几何包公开的第一层是**物理引用**，第二层才是可选编译后端：

```ts
type GeometryOccurrence = {
  sourceId: SourceId; rootOccurrence: SourceId; assemblyPath: string;
  devPath: string; placement: { elements: readonly number[]; layout: 'column-major'; unit: 'mm'; axis: 'z-up' };
};
type GeometryFinding = Finding & { geometryStatus?: 'complete'|'partial'|'empty'|'unsupported'|'failed' };
type MeshBuffer = {
  sourcePath: string; primitiveId?: string; materialKey: string;
  positions: Float32Array; indices: Uint32Array; normals?: Float32Array; colors?: Float32Array;
};
interface GeometryBackend {
  id: string; version: string;
  compileMod(document: XmlModDocument, options: { lod: 0|1|2; signal?: AbortSignal }): Promise<{
    meshes: readonly MeshBuffer[]; findings: GeometryFinding[]
  }>;
  compileStl(bytes: Uint8Array, options: { signal?: AbortSignal }): Promise<{
    meshes: readonly MeshBuffer[]; findings: GeometryFinding[]
  }>;
}
discoverDevGeometry(reader: { paths: readonly string[]; readBytes(path: string): Promise<Uint8Array> },
  roots: readonly GeometryOccurrence[], options: { strictDependencies: boolean; signal?: AbortSignal }): Promise<GeometryDiscovery>;
compileDevTemplate(discovery: GeometryDiscovery, options: { lod: 0|1|2; backend: GeometryBackend }): Promise<{
  status: 'complete'|'partial'|'empty'|'unsupported'|'failed';
  templates: readonly MeshBuffer[]; placements: readonly GeometryOccurrence[];
  bounds?: { xyzxyz: readonly number[]; unit: 'm'; axis: 'z-up'; quality: 'exact'|'conservative' };
  findings: GeometryFinding[];
}>;
```

`MeshBuffer` 建议只含顶点、索引、法线、颜色和材质键的 typed arrays；`/three` 适配器可把内部 `BufferGeometry` 转成该 DTO。GLB 是另一种导出/缓存格式，不能取代规范的 `sourceId`、`placement`、`status`、`findings`。`compileDevTemplate` 的默认实现和结构化诊断要先经合成样本验证才能成为稳定 API。

来源绑定流程固定为：

```text
包 SHA / caller scope
  → CBM/DEV/FAM/IFC 来源 occurrence + 原字段证据
  → ObjectEvidence(sourceId, 真实装配 parent, 类型/用途/名称证据)
  → EngineeringSnapshot(entityId, membership: sourceId → ownerId|null)
  → SourceRepresentation(sourceId → DEV root+assemblyPath 或 IFC modelId+expressId)
  → GeometryOccurrence / MeshBuffer / 诊断
  → 桌面工程组成、来源、清册及选择（仅投影）
```

`IFCGUID` 只在**已解析且唯一的文件+对象**下作为关联证据；不能用 GUID、同名、邻近或数组下标自动合并 DEV 与 IFC。缺失/歧义/无几何均返回明确状态。`SourceRepresentation` 地址必须保持 `rootOccurrence + assemblyPath` 的真实引用链；PHM/MOD 后缀可按最近 DEV occurrence 回退，不能跨兄弟 DEV。一个粗网格覆盖多个整体时，绑定返回 `ambiguous`，不能把该网格全部挂给任一整体。

## 最小合成测试契约

使用内存文件表，不依赖 `demo/`、Tauri、浏览器或网络。一个主夹具包含 `project.cbm`、`unit.cbm`、`root.dev`、`child.dev`、`part.fam`、`frame.phm`、`shape.mod`、`building.ifc`：CBM 显式引用 DEV 和 IFC；DEV 的真实 `SUBDEVICE` 指向 child，并由 `SOLIDMODEL` 到 PHM→MOD；IFC 使用两个不同 `expressId` 的外露产品，一个有文件+GUID 明确关联、一个未关联。MOD 用 Cuboid 等已支持 primitive，所有矩阵和单位显式写在 fixture 中。各输入包都有固定 scope、内容摘要和条目清单。夹具数据只是可执行输入，不把示意文件名当通用目录规则。

主夹具的最小闭环应明确预期：`root.dev` 与其真实 `child.dev` 各有一个来源 occurrence，只有来源证据允许时才同属一个工程整体；`frame.phm` 对 `shape.mod` 施加一个非单位平移矩阵，Cuboid 的边长设为已知毫米数，编译后的包围盒应在**一次**毫米→米、Z-up 坐标转换后落入容差。`building.ifc` 的两个 expressId 即使共用或缺失 GUID，也保留两个来源地址；只有文件+GUID 唯一匹配的一项取得 CBM 关联。另造一个“CBM 声称子件、DEV 没有真实 `SUBDEVICE` 边”的反例，必须输出未证实组件关系，不得为了完成工程树强行挂入主设备。

| 断言层 | 必验内容 | 负例 |
|---|---|---|
| 来源与身份 | 改变输入顺序、目录大小写和分隔符后，规范化 occurrence/实体 ID 与成员主归属稳定；物理 child 只由真实引用挂接；每份来源恰有一个处置。 | 缺引用、同名不同 occurrence、重复 GUID、跨文件同 GUID、DEV 环、重复身份与超配额，分别给确定诊断；不强行连实体。 |
| 分类与整体 | 明确类型/本体、内部件、独立柜、未知对象各维持正确粒度；`classificationEvidence` 能指向原字段。 | 祖先 F2/F3/F4、额定电压、同名 FAM、相邻 IFC Mesh 不得改变整体类别或主归属。 |
| 几何 | DEV→PHM→MOD 叶子可达，矩阵按列主序逐边相乘；毫米、Z-up 到目标坐标只转换一次；编译产物非空且 bounds/顶点数在容差内；冷/热结果的规范化缓冲与诊断相同。 | 缺 MOD、PHM 环、非仿射矩阵、未知 primitive 分别得到 `partial/unsupported/failed` 与来源地址；不能写 `complete`。 |
| 表示绑定 | 每个可渲染来源地址可以回查原 `sourceId` 和所属 `entityId`；IFC modelId+expressId 与 DEV root+assemblyPath 保持独立。 | 重复 GUID、粗网格覆盖两个整体、缺表示时返回 `ambiguous/unassociated`，不通过选择范围“补配”。 |
| 发布契约 | 含 `schemaVersion`、`rulesVersion`、`compilerVersion`、输入摘要和完成状态；候选输出与正式基线分开。 | 版本或输入 SHA 改变拒绝旧快照；部分/失败产物不得作为完整缓存命中。 |

`@gim/sdk-conformance` 应导出 `runFixture(fixture, implementation)`、`assertSourcePartition`、`assertRepresentationBinding`、`assertGeometryResult` 和规范化序列化器；CLI 只做输入/输出目录、报告格式和退出码。黄金文件覆盖**身份、归属、证据地址、几何状态与可量化结果**；不含排序无关的 Map 遍历、Mesh UUID、调度时间、内存峰值或图形驱动输出。候选基线须人工审阅后提升，不能运行一次就把当前实现写成真值。规范化行和人工审阅后提升候选黄金文件的思想可用于 SDK 验收；项目验收层使用开发者本地注册表，固定九样本 corpus 和旧 runner 已退役。“引用可达”与“已编译渲染”必须保持两个断言，不合并成一个通过标记。

每次失败先按 `sourceId` 给出可机读的层级码：`SOURCE_REFERENCE_MISSING`（来源链）、`OWNER_AMBIGUOUS`（整体判定）、`REPRESENTATION_UNASSOCIATED`（地址绑定）、`GEOMETRY_UNSUPPORTED`（图元编译）。同一来源可同时有归属和几何诊断，但几何成功不能抹掉归属歧义；测试包对每类码至少有一个正例和一个反例。

## 迁移顺序与门槛

1. **契约先行**：从现有 `engineering/` 提取只读 DTO、ID 规范、规则版本、`normalize`、`validate`、`RepresentationIndex`；桌面先经兼容重导出调用。合成 fixture 和现有领域单测必须一致。这个阶段就能把“组件未挂入”区分为来源引用缺失、整体归属歧义、表示地址缺失三种诊断。
2. **来源适配**：把 `gim/engineering/` 中的纯转换和必需 parser 闭包逐个移到 `/gim`，用 `readText` 注入读取；保留 IFC 文件发现与对象 GUID 关联两项独立能力。桌面 Worker 仅负责批量读、取消和缓存。桌面前后快照按 `sourceId` 对照，不能只看实体数量。
3. **几何来源与编译**：先移 parser、IR 和矩阵校验；把 `modGeometryDiscovery` 的 `CbmNode`/`File`/Three/console 拆成 `GeometryOccurrence`、Reader 与 Finding。再在 `/three` 实现 MOD/STL 编译并输出中立缓冲；桌面继续持有相机、LOD 调度、GLB/Fragments/IndexedDB。与现有 `serializeDevToGlbDetailed` 比对相同来源的状态、bounds、可达叶子和实例矩阵。
4. **测试工具独立化**：移合成 fixture runner 与断言，包内 CI 在 Node 无 DOM 环境运行。桌面保留真实样本、原生 SQLite、Headless Edge 和视觉验收，作为包消费后的集成检查。只补与新边界相关的测试，不把现有九工程大包搬进测试 npm 包。
5. **发布门槛**：分别用 Node 项目和桌面项目安装构建产物；确认根入口不加载 Three、无跨包相对路径、`exports`/`.d.ts` 完整、冷暖身份一致、缓存失效受控、Android 只导入选定纯入口可构建。三包可分别发版；任何输出契约或规则变更必须声明对应版本。

这些步骤给 GIM Viewer 的直接收益是：分类/装配错误可用很小的来源夹具复现，几何错误可在无 Viewer 环境定位到引用边或 primitive，测试结果能明确告诉接手者“格式读取、实体归属、表示绑定、渲染”哪层失败。桌面仍能渐进加载，不必因 SDK 设计让 Android 承担 Three.js、Fragments 或变电 LOD 的成本。
