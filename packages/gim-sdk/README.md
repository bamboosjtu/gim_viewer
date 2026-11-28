# GIM SDK

GIM SDK 是仓库内的核心能力包，供桌面 Viewer 处理格式解析、来源、语义、物理目录、实体绑定和模型树投影。SDK 与应用各自维护版本，域契约使用 v1。

| 出口 | 能力 |
|---|---|
| `@gim/gim-sdk/parser` | CBM/FAM/DEV/PHM/MOD/FileDevRelation/IFC STEP/SCH/STD/SLD 语法、原始值和诊断；不依赖五个 Core |
| `@gim/gim-sdk/source` | 共享文档、来源图、引用实例、来源收集 |
| `@gim/gim-sdk/semantic` | 中立证据的类别、整体身份和唯一主归属 |
| `@gim/gim-sdk/geometry` | 独立物理 occurrence 目录、矩阵、表示地址索引、局部 MeshData 编译，以及独立于网格的图元和文档范围查询 |
| `@gim/gim-sdk/engineering` | 工程整体与一对多表示绑定、歧义解析 |
| `@gim/gim-sdk/projection` | 清册 / 工程组成 / 来源投影和成员树查询 |
| `@gim/gim-sdk/source-adapter` | 来源证据到纯语义归一化的适配 |

根出口提供这些能力的命名空间，桌面与外部消费者通过根入口和七个能力子路径消费 SDK。

## 构建与检查

在本目录执行 `npm ci` 和 `npm run build`。默认 import 使用构建后的 ESM，桌面和测试通过 `gim-source` 使用当前源码。构建将 `powerline-core` 一并打包，并检查各能力入口的依赖边界。目录与识别策略按[实体目录](../../docs/engineering/catalogs/README.md)维护及同步。

`npm test` 执行包内单元测试。`npm run test:consumer` 使用工作区 `tmp/` 中的隔离 Node 消费项目验证构建产物。

```js
import {parser, source, sourceAdapter, geometry, projection} from '@gim/gim-sdk';

// reader supplies actual entry paths and a bounded, deduplicated readText callback.
const graph = await source.extractEngineeringSourceGraph(reader);
const physical = geometry.collectSourceGeometryOccurrences(graph);
const locations = geometry.sourceGeometryLocations(physical);
const inputs = source.collectEngineeringSources(graph, ifcObjects, ifcModels, ifcNodes, locations);
const snapshot = sourceAdapter.normalizeEngineeringSources(scope, inputs);
const views = projection.projectEngineeringNavigation(inputs, snapshot);
```

宿主负责容器/XML 文本读取、Worker、缓存、会话、渲染和界面。Node 消费者将 XML 文本转换为保留属性字符串的 `XmlModNode`，再经公开出口编译局部毫米网格。

```js
const raw = parser.parseXmlModRoot(rootNode, {
  sourcePath: 'MOD/unit.mod',
  matrixLayout: 'project-column-major', // A.3.21 示例使用 'a3-21-example'
});
const result = geometry.compileXmlModDocument(raw, { lod: 2 });
const range = geometry.queryXmlModBounds(raw, { purpose: 'analytical' });
for (const entity of result.entities) {
  if (entity.templateKey) {
    const mesh = result.templates.get(entity.templateKey).mesh;
    // mesh.positions / normals / indices 为共享局部缓冲，放置见 entity.source.transformMatrix。
  }
}
```

Desktop 的 DOM 与 Worker 入口均选择工程列主序布局并读取同一 Raw 文档语法。29 类标准图元使用 SDK 局部模板，宿主按需套用材质、装配和 LOD，混合 MOD 的 Boolean 与其余叶子继续使用宿主求值器。IFC 解析结果作为对象证据传入。物理目录和来源实例可先于语义识别交付，组成投影引用已建立的实体。

**兼容接口。** `@gim/gim-primitives/geometry/ir.js` 的 `XmlModGeometrySource.entities` 与 `@gim/gim-sdk/parser` 的三参数 `parseXmlModRoot(root, path, mapper)` 保留旧 DTO 调用契约。标准图元的新功能只在 Raw／Canonical 接口维护。Desktop 的旧类型消费限于 Boolean、Cable、提供方型钢和 Unsupported；其余 29 类的旧标签映射和重复网格构造已移除。独立 Blender 工具维护自身的快照。

各图元的参数、预览约定和实际样本覆盖见[逐项能力与证据](../../docs/schema/xml-primitives.md#逐项能力与证据)。包内测试与夹具随源码维护。可从 `desktop/` 运行 `npm run test:module -- ../packages/gim-sdk/src/semantic`，同时检查 SDK 模块和 Viewer 消费者。实体盘点器使用独立 Python 实现，通过配置与共享契约用例核对结果。

## MOD / STL 中立几何输出

`@gim/gim-sdk/geometry` 的 `compileGeometrySource` 接收已解析的 Raw XML MOD 或 STL 字节。输入的 `sourceVersion` 标识数据版本，例如工程源 SHA。Node 宿主可以使用 [XML 文本读取示例](node-xml-mod-consumer.mjs) 提供 Raw 文档。原有单图元、文档及 STL 编译入口继续可用。

```ts
const input = { format: 'xml-mod' as const, sourceVersion, document: raw }
const source = geometry.compileGeometrySource(input, { lod: 2 })
const batch = geometry.placeGeometrySource(source, [
  { rootOccurrence: 'CBM/A', assemblyPath: 'solid:0', localToParent: matrixA },
  { rootOccurrence: 'CBM/B', assemblyPath: 'solid:0', localToParent: matrixB },
])
const range = geometry.queryGeometryRange(input, { purpose: 'analytical' })
```

STL 输入使用 `{ format: 'stl', sourceVersion, sourcePath, bytes }`。模板包含只读使用的局部毫米网格；实例携带独立地址、ID 和列主序的外部放置乘声明矩阵。对象的范围及具名端口在对象局部空间，单独查询的范围在来源文档空间。声明的可见性、诊断和可用性与部件质量分列。STL 的网格独立于 LOD，退化面继续按浏览规则跳过。G0 输出 MOD 叶子的网格；尚无中立网格的 Boolean 根保留声明与诊断，Desktop 的组合仍沿用生产求值路径。

使用 `port.postMessage(batch, geometry.geometryTransferList(batch, 'retain'))` 可保留发送端模板，普通 ArrayBuffer 由消息通道复制。所有调用方都已放弃发送端缓冲时使用 `'move'`，每个底层 ArrayBuffer 仅出现在转移列表中一次。移交会分离发送端该来源及其他批次引用的同一缓冲。独立消费者用例见 [Node 与 Worker 验收](neutral-geometry-consumer.mjs)。
