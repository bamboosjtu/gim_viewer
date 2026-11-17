# GIM SDK

此包持有 v0.2.4 桌面端的五组纯核心实现：来源、语义、物理目录/表示地址、实体绑定和只读投影。SDK 包版本与应用版本各自独立；协议、缓存和目录契约仍固定 v1。

| 出口 | 能力 |
|---|---|
| `@gim/gim-sdk/source` | 共享文档、来源图、引用实例、来源收集 |
| `@gim/gim-sdk/semantic` | 中立证据的类别、整体身份和唯一主归属 |
| `@gim/gim-sdk/geometry` | 独立物理 occurrence 目录、矩阵及表示地址索引 |
| `@gim/gim-sdk/engineering` | 工程整体与一对多表示绑定、歧义解析 |
| `@gim/gim-sdk/projection` | 清册 / 工程组成 / 来源投影和成员树查询 |
| `@gim/gim-sdk/source-adapter` | 来源证据到纯语义归一化的适配 |

根出口提供上述能力的命名空间。engineering / gim / shared 子路径用于现有精确消费者，不能通过 src 或测试私有路径绕过包出口。目录布局初期保留原内部相对结构，以控制抽取风险。

## 构建与检查

在本目录执行 `npm ci`、`npm run build`。默认 import 消费 dist ESM；类型来自随包保留的 TypeScript。构建将唯一声明的纯来源依赖 powerline-core 一并打包，并检查零运行时外部依赖。桌面与测试使用 gim-source 条件消费当前源码，避免依赖陈旧的 SDK 产物。

`npm test` 执行所属单元测试，临时目录固定在工作区 tmp。`npm run test:consumer` 将构建产物和包清单复制到独立 tmp 消费目录，在没有源码、依赖、Viewer 或 DOM 的 Node 进程中验证五个出口、来源处理、整体/部件、物理根、表示绑定、三投影与取消。

```js
import {source, sourceAdapter, geometry, projection} from '@gim/gim-sdk';

// reader supplies actual entry paths and a bounded, deduplicated readText callback.
const graph = await source.extractEngineeringSourceGraph(reader);
const inputs = source.collectEngineeringSources(graph, ifcObjects, ifcModels, ifcNodes);
const snapshot = sourceAdapter.normalizeEngineeringSources(scope, inputs);
const physical = geometry.collectSourceGeometryOccurrences(graph);
const views = projection.projectEngineeringNavigation(inputs, snapshot);
```

宿主负责容器 IO、Worker 调度、缓存持久化、会话和选择守卫、Three 场景、LOD、GPU 与 UI。IFC 文本/引擎解析器通过可移植对象类型提供证据；SDK 不启动几何引擎或模型校核器。物理目录和来源实例在语义识别前即可使用；组成规则不会重编几何模板。

源码模块测试与夹具归本包。桌面服务/渲染消费者测试留在 desktop；`npm run test:module -- ../packages/gim-sdk/src/engineering` 会选择所属测试及桌面消费者。SDK 发布准备不改变独立 Python 工具：工具持有自己的实现与资产，通过数据与契约用例对照，不导入本包或主程序。

结构/契约测试与独立消费者只证明对应软件路径，真实工程人工归属和本地冷暖性能按仓库验证规则另行记录。
