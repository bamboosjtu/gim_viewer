# GIM SDK

GIM SDK 是仓库内的核心能力包，供桌面 Viewer 处理格式解析、来源、语义、物理目录、实体绑定和模型树投影。SDK 与应用各自维护版本，域契约使用 v1。

| 出口 | 能力 |
|---|---|
| `@gim/gim-sdk/parser` | CBM/FAM/DEV/PHM/MOD/IFC STEP/SCH 语法、原始值和诊断；不依赖五个 Core |
| `@gim/gim-sdk/source` | 共享文档、来源图、引用实例、来源收集 |
| `@gim/gim-sdk/semantic` | 中立证据的类别、整体身份和唯一主归属 |
| `@gim/gim-sdk/geometry` | 独立物理 occurrence 目录、矩阵及表示地址索引 |
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

宿主负责容器读取、Worker、缓存、会话、几何编译和界面。IFC 解析结果作为对象证据传入。物理目录和来源实例可先于语义识别交付，组成投影引用已建立的实体。

包内测试与夹具随源码维护。可从 `desktop/` 运行 `npm run test:module -- ../packages/gim-sdk/src/semantic`，同时检查 SDK 模块和 Viewer 消费者。实体盘点器使用独立 Python 实现，通过配置与共享契约用例核对结果。
