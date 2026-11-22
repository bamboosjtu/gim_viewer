# 分层与依赖

本文件回答“代码放在哪里、允许依赖谁”。具体流程见[打开与生命周期](lifecycle.md)，工程实体契约见[工程实体](../engineering/README.md)。

## 运行面

| 运行面 | 入口 | 说明 |
|---|---|---|
| 桌面 Tauri | `desktop/` | 变电、线路、独立设备；Rust 负责 SQLite、SHA、解压和受权读取 |
| Android | `app/` | 仅线路；独立 npm、私有 SQLite、SAF 导入 |
| 共享线路 core | `packages/powerline-core/` | 纯 parser、图、领域投影、HNum 预览；无平台 UI/DB |
| 共享原生容器 | `crates/gim-native-core/` | 有界解压、路径与资源配额 |
| Android 导入插件 | `crates/tauri-plugin-gim-import/` | SAF 流式复制与 SHA |
| 测量核心 | `packages/measurement-core/` | 无 DOM、Tauri、Three 依赖的事件、阶段、Trace 上下文、统计与内存契约 |
| 插件接口 | `packages/plugin-api/` | 跨端插件类型与边界 |

## 桌面目录

| 目录 | 职责 | 允许依赖 | 不应依赖 |
|---|---|---|---|
| `desktop/src/app/` | 启动、`AppState` 状态聚合 | 会话与组合入口 | 具体 parser 内部 |
| `desktop/src/app/session/` | 工程身份、打开/切换/关闭、选择与释放 | 服务端口、Viewer 清理、共享会话契约 | 跨 Feature 分派与 DOM |
| `desktop/src/app/composition/` | Feature 分派、最近工程与 UI/服务端口接线 | Feature 入口、UI、工程会话 | 格式解析和几何计算 |
| `packages/gim-sdk/` | 五组纯核心；来源、语义、物理目录、表示绑定与投影 | 包内纯模块、powerline-core | desktop/app 宿主、DOM、Tauri、Three/Viewer、DB |
| `desktop/src/engineering/` | 现有消费者的 SDK 出口转发 | 声明的 SDK exports | 核心算法和配置副本 |
| `desktop/src/gim/engineering/` | 现有来源消费者的 SDK 转发入口；来源适配实现与测试归 SDK | SDK exports | 规则副本、Viewer、UI、DB |
| `desktop/src/gim/` | 宿主文件发现、CBM Tree Builder、来源树/索引、IFC 空间语义与平台适配；纯格式解析在 `packages/gim-sdk/src/parser/` | SDK parser/source 类型、共享纯库 | services、viewer、ui；不新增纯 Parser |
| `desktop/src/viewer/` | Three.js、Fragments、web-ifc、MOD/STL 编译与渲染 | three、geometry 纯函数、类型 | services、ui、DB |
| `desktop/src/ui/` | DOM shell、三视图、属性、搜索、地图、工具栏 | services 暴露的结果、纯类型、白名单展示选择器 | 数据库、原生 IPC |
| `desktop/src/features/substation/` | 变电打开工作流：application 编排、runtime 冷/暖/IFC/DEV/Spatial/遥测、presentation 导航与选择；专用 Spatial Worker 由变电会话持有 | gim、viewer、bridge、注入的展示端口、services 端口 | 把共享缓存/Worker 协议复制成第二份实现 |
| `desktop/src/features/powerline/` | 线路冷暖打开、解析 Worker 的会话归属、地图与导航投影、视图句柄释放 | 共享线路 core、宿主来源/缓存端口、注入的 UI 端口 | Viewer、直接操作 DOM |
| `desktop/src/features/equipment/` | 独立设备来源准备、导航、节点选择与会话发布 | gim 来源能力、共享 DEV 启动、注入的展示端口 | 其他 Feature 的内部模块、直接操作 DOM |
| `desktop/src/infrastructure/workers/` | 工程 Worker 入口、协议、传输与请求释放；共享请求队列供变电 Spatial 与线路 Worker 使用 | Worker 安全的编解码、工程计算处理器和测量端口 | Feature、应用组合或渲染 |
| `desktop/src/infrastructure/cache/` | 工程来源、实体、导航与物理目录的 v1 编解码及会话持久化 | 领域投影契约、原生缓存端口 | Worker 客户端、Feature、应用组合或渲染 |
| `desktop/src/infrastructure/native/` | 工程路径授权、源文件与缓存条目读写、原生解压载体、v1 错误映射及会话守卫 | 生成契约、Tauri invoke、宿主路径解析和测量 | UI、Viewer、Worker 客户端、业务 Feature |
| `desktop/src/services/` | 跨域缓存、Worker、后台任务、选择、生命周期与未迁移能力的端口 | gim、viewer、bridge、注入的展示端口 | 把领域规则塞回 UI |
| `desktop/src/config/` | 功能与调试开关 | 无 | 业务状态 |
| `desktop/src/measurement/` | 宿主与 Worker 探针、产品证据、Trace/Profile/GPU 采样适配 | measurement-core、只读运行时快照 | 把测量状态变成产品业务状态 |
| `desktop/bridge/` | 生成契约出口、SQLite 索引/设置、文件选择与专用缓存封装 | `@tauri-apps/api` | UI、Viewer |
| `desktop/src-tauri/src/` | SQLite、SHA、解压、文件校验 | Rust crates | 前端状态 |

Benchmark 注册表位于根目录 `benchmarks/l0|l1|l2/`，CLI、Trace/Profile 与无样本协议测试位于 `desktop/scripts/benchmarks/`，本地功能夹具位于 `desktop/tests/`；权威报告在 `tmp/`，`output/` 默认只保存匿名派生视图（非匿名 survey 例外）。这些目录不承担应用运行时业务逻辑。

## 依赖规则

UI 可消费只读的稳定来源 ID 查找、路径格式化、空值判断及几何诊断文案等展示选择器；允许的模块/符号逐项登记在 `check-engineering-boundaries.mjs`。原始文本解析、FAM 来源与连接归属由 SDK 核心、services 和 gim 按各自契约提供。Powerline Feature 负责线路地图及导航投影。新增纯函数不自动获得 UI 导入权限，不能用“纯函数”放宽整个 parser 或 Viewer 模块。

1. `engineering/` 是无格式领域层。它不读取 XML/键值文本、不生成 Mesh、不访问数据库，也不接收 `CbmNode`、F2/F3/F4 标签、展示树深度或包围盒作为分类条件。新增分类规则应先落到这里和[目录](../engineering/catalogs/README.md)。
2. `gim/engineering/` 是适配层。它只把来源事实转成 `ObjectEvidence`、`SourceRecord`、`SourceGraph` 和空间上下文；`SourceRecord` 可保留原始字段，但领域层不解析格式。
3. `services/engineering*` 编排工程计算、快照发布、缓存和表示绑定；Worker 通信与请求释放由 `infrastructure/workers/` 管理。工程类别继续由 SDK 判断。
4. `viewer/` 只消费 `SourceGeometryOccurrence`、模板和 IFC 对象。几何编译器不接收工程组成分组，也不按实体名称选择 LOD。
5. `ui/` 不直接访问数据库或原生 IPC；最近工程、缓存管理和工程打开均通过 `services/projectCacheService`、`services/gimOpenCore` 等入口。`engineeringTreeView` 只渲染投影结果并回调选择服务。
6. 重依赖按需动态 import：入口和 `openProject` 不静态引入 Three.js、web-ifc、MapLibre；IFC、几何、地图和工程实体 Worker 各自分包。Vite 生产构建从 HTML 入口检查生成块的静态依赖闭包，发现 Three.js、web-ifc 或 MapLibre 即失败。
7. 读取语义和提交状态必须由会话/请求守卫控制；UI 不能直接改写缓存版本、解析器结果或场景所有权。

### 已知边界例外

`DevRepresentationHint` 已是纯类型，Viewer 可以共享地址契约。services 将整体成员转换为 `shared/representationSelection.ts` 的渲染范围：DEV root、IFC model/expressId、请求 ID 与有效性守卫；Viewer 不读取实体快照或 `engineeringSelection`，DEV LOD 的根显隐也消费此中立范围。细部可见性由 services 计算并通过回调应用。

自动空间细化放在 `services/projections/`，只接收显式范围与投影证据，输出路径与推断标记；不属于实体归一化。

既有 IFC loader/runtime 仍直接使用 bridge 的缓存/运行时适配器；`ifcBimLoader.ts` 的 `ifcLodCache`、`ifcRegionalRuntime.ts` 的 `ifcLodCache` 是边界检查中的精确例外，不放宽为整个目录通行。

## 入口与接线

大型服务和数据库入口的内部职责、资源所有权与兼容导出见[运行时与数据库模块](runtime-modules.md)。

```text
bootstrap
  ├─ viewerShell（空态、最近工程、菜单、属性抽屉）
  ├─ selectionToolbar（自动定位、清除选择）
  ├─ app/session/openProject + app/composition/projectRuntimes（文件打开与 Feature 分派）
  │    ├─ features/substation（语义、IFC、DEV、Spatial）
  │    │    └─ engineeringService（来源/实体/导航 Worker）
  │    ├─ features/equipment（设备来源与导航）
  │    │    └─ geometryOnlyRuntime（与纯 DEV 变电共用）
  │    └─ features/powerline（线路冷暖打开、导航投影、地图会话）
  └─ viewerUIBinding（选择/高亮/相机/属性路由）
```

`app/composition/presentationBindings` 是展示端口的组合根。`ProjectPresentation` 管理树渲染、面板清理、展开状态、选择反馈和候选交互；`SourceInspectorPresentation` 接收来源文档/空间上下文与回调，UI 持有分页与 DOM 监听；`ViewerPresentation` 提供属性/模型展示及绑定释放器；加载遮罩与计时由 `LoadingPresentation` 的 UI 实现持有。状态栏端口仅声明状态命令，不从 UI 模块推导接口。services 不直接值导入 ui，不查询或修改 DOM。Viewer 使用 `shared/viewerState`、会话和选择契约，不引用 AppState。CBM/GUID 与 IFC 名称补充属于 services；Viewer 高亮只接收已解析的 runtime model/local ID 集合。几何纯函数按符号白名单导入，不能借此引入 CBM 业务语义。

通用 UI 模块 loader 已删除。`SelectionPresentation` 接收选择意图、只读属性模型与有效性回调；`DiagramPresentation` 返回绑定释放器；`LinePresentation` 返回视图句柄并由 SessionScope 持有；`ProjectOpenPresentation` 管理浏览器选择器、按钮与输入框。惰性 UI import 留在 UI 实现，services 不请求 UI 模块或操作 DOM。边界脚本拒绝旧 loader 的直接调用、显式别名和字符串属性访问，传入非字面量键同样会被拒绝。门禁同时检查 DOM 写入及未声明共享包导入。

独立设备打开使用显式 `EquipmentPresentationPort`：服务提交工程身份、导航树、选择回调与会话 signal，UI 的 `equipmentProjectView` 负责工程栏、导航 DOM、搜索、空态及设备状态栏；端口返回仅属于该视图实例的释放器。旧释放器不能移除新导航。设备运行时不访问 DOM 或 `loadPresentation`，边界脚本单独禁止其退回通用 UI 模块加载器和旧 DOM 适配器。通用加载遮罩保留 `gimOpenCore` 公开入口，内部只转发加载展示端口；DOM、进度格式和计时器均属于 UI。

`AppState.engineering` 持有工程事实与构建状态。`viewState` 持有导航、展开、相机意图和历史，并负责工程导航释放和全站视角命令。`sourceGeometry` 独立持有物理目录、就绪 Promise 与缓存状态，读取由所有者统一做会话前后校验，不等待语义。`ifcLoading` 持有 IFC 尾部 pending 与明确跳过清单，`properties` 直接持有属性 Map 并负责 reset。选择请求、取消、相机意图快照、反馈、IFC 与 MOD/STL 高亮索引均由 `selection` 持有。Viewer 通过窄端口清理高亮并释放材质副本，工程重置清空选择索引。AppState 根字段由工程边界检查核对所有者与释放登记。IFC 会话地址、模型与区域运行时由 `ifc` 注册表持有，登记和迟到删除在注册表内统一校验。新所有者通过窄运行时端口接线。应用组合根仍保留工程源数据与运行面协调状态。工程实体、导航、几何目录的构建由服务层启动，UI 通过订阅和回调刷新。工程切换后，旧 Worker、旧请求和旧投影必须释放或拒绝提交。

共享包通过 package.json 声明依赖和 package exports 访问。纯名称、KV、跨越、线路属性/图类型、资源限制及线路 MOD parser 直接引用包出口，测试属于共享实现。桌面仅保留有实际责任的入口：`lineCbmParserCore` / `lineMapData` 初始化桌面日志 sink，`geometry/ir` / `sourceDocument` 是当前来源与编译契约入口；`powerline-core` 逐项声明共享入口。`@gim/measurement-core/source` 是测量核心的唯一包出口；GIM SDK 的默认入口为构建后的 dist。桌面生产代码仅使用公开能力入口，纯领域转发模块从 projection 具名转发对应领域模块的符号。生产代码不允许用深相对路径绕过包边界。

## 五组能力入口

桌面应用通过 `@gim/gim-sdk` 的 source / semantic / geometry / engineering / projection 五个能力出口、source-adapter 接线以及 parser 基础入口。现有目录仅保留有生产消费者的转发入口：`gim/engineering/source.ts` 提供来源收集，`gim/engineering/semanticAdapter.ts` 将来源传入领域归一化，`gim/engineering/geometry.ts` 提供独立物理目录，`engineering/fusion.ts` 提供实体/表示绑定，`gim/engineering/projection.ts` 提供现有三视图投影。宿主 Worker 和工程装配通过这些入口接线；SDK 内部按八个顶层目录组织——格式语法、原始值与诊断位于 `parser/`，来源图和原始事实位于 `source/`，候选解释和归属位于 `semantic/`（词典在 `semantic/catalog/`），几何地址位于 `geometry/`，绑定在 `engineering/`，只读投影在 `projection/`，来源适配在 `adapters/`，中立契约在 `shared/`；位置提示由几何能力显式提供。SDK 发布构建检验各入口的运行时依赖闭包。

[Source Core](source.md) 定义文档、FAM 索引和两类 occurrence 遍历的所有权及会话边界。

SDK 的实现及模块测试归 `packages/gim-sdk/src/`，IFC 运行时解析器仍在桌面；其共享对象/空间类型由 SDK 的 ifcSpatialTypes 提供。桌面与 Vitest 使用 gim-source 条件读取当前源码，默认包 import 消费构建后的 ESM。

构建按八个顶层目录为模块分配能力角色（`semantic/catalog/` 为词典角色），未知路径直接失败；运行时和类型依赖闭包都只能包含该入口允许的角色。SDK 包清单仅公开根入口与七个能力子路径。桌面分层门禁直接拒绝内部路径，隔离消费门禁核对包清单的完整出口集合。

`core-boundaries.mjs` 补充职责检查：投影和绑定不得导入分类器/归一化运行值，几何入口和目录不得消费语义主归属。中立类型允许共享；SDK 的裸包出口和能力别名同样参与依赖检查，UI/Viewer 的 SDK 运行值调用经服务端口接线，展示格式器保持精确登记入口。负向用例纳入 `test:presentation-boundaries`。入口不意味着五个独立进程或串行执行，几何仍可先于实体完成。

## 宿主业务域收敛

`desktop/src/services/` 仍承载跨域打开、缓存、选择和展示端口，以及尚未迁移的 Worker。后续按业务能力逐步收敛，不在一次性搬迁中改变运行结果：

```text
desktop/src/
├── app/                 # 启动 / session / composition
├── features/
│   ├── substation/      # application / runtime / presentation
│   ├── powerline/       # application / runtime / presentation
│   └── equipment/       # application / runtime
├── viewer/              # scene / geometry / selection / rendering
├── infrastructure/      # workers / cache / native
├── ui/
└── measurement/
```

约束：

- 变电打开工作流已迁入 `features/substation/{application,runtime,presentation}`；专用 Spatial Worker 由变电持有，并复用基础设施请求队列。Spatial 编码器和资源遥测端口留在 `services/`。
- 每次只迁一个纵向工作流，先固定其输入、输出、会话守卫和资源释放器，再移动文件。
- `packages/powerline-core/` 是独立可复用线路能力包，不并入 `features/powerline`；桌面 feature 只保留应用编排、宿主状态和展示接线。
- `services/` 中的跨域入口先保留转发，迁移完成后删除；测试跟随被测模块移动，不复制到新目录。
- 工程 Worker 入口、通信契约和共享请求队列位于 `infrastructure/workers/`。工程派生缓存的共享编解码和读写归 `infrastructure/cache/`，工程文件传输由 `infrastructure/native/` 提供。SQLite 索引和设置命令由 bridge 接线。

## 边界检查

改动后至少确认：

执行 `desktop/` 下的 `npm run check:engineering-boundaries` 自动检查纯领域、来源和 Viewer 边界；Windows CI 同步执行。

- `engineering/` 没有 import `gim/`、`viewer/`、`ui/`、`services/` 或 `@desktop/database`；
- `gim/` 没有 import `services/`、`viewer/`、`ui/`；
- `ui/` 没有 import `@desktop/database` 或 `@tauri-apps/api`；
- 新增缓存/协议常量只在对应域服务中定义，并由[缓存域](caches.md)登记；
- 分类规则变化先改目录/领域测试，再改 UI 展示。

线路导航的数据装配位于 `features/powerline/presentation/lineNavigationProjection.ts`，不依赖 DOM、AppState 或平台 IO；搜索 DTO 位于 `shared/searchTypes.ts`。`ui/lineNavigationTreeView` 负责按需渲染、展开和交互，返回幂等 destroy 句柄。工程会话持有地图与树的展示句柄，释放只作用于对应视图代次。

线路属性分桶、来源关系与 HNum 预览格式化由 `services/lineInspectorProjection.ts` 提供；字典与纯字符串格式化在 `services/propertyPresentation.ts`，DOM 引用事件桥保留于 UI。地图唯一坐标工作集、Mercator 计算与导线样式语义由 `services/lineMapGeometry.ts` 提供。三者无 DOM、AppState、平台 IO 依赖。线路工程视图返回有代次保护的 `destroy()` 句柄，并由会话登记释放地图、导航、搜索及设置监听；旧句柄不得销毁新视图。

属性抽屉的页签、FAM、IFC 与概览 HTML 位于 `services/inspectorMarkup.ts`；线路地图的导线路径、命中距离和塔位分类位于 `services/lineMapGeometry.ts`，分帧预算位于 `services/lineMapStages.ts`。UI 持有 DOM、Canvas 句柄和取消代次，纯模块只接收值与回调。
`ui/lineMapView.ts` 负责线路地图的 DOM、相机和实例释放。`ui/lineMapRenderer.ts` 持有分帧任务和相机投影缓存，`ui/lineMapPainter.ts` 绘制工程覆盖层并保留 Canvas 模式的塔位屏幕快照。`ui/lineMapPointer.ts` 负责选择、光标与塔位提示，Canvas 手势监听仍由 `ui/lineMapCanvasInput.ts` 持有。塔位和导线命中计算位于 `services/lineMapHitTesting.ts`，与绘制使用同一条导线屏幕路径。销毁实例后，迟到的绘制、定位和交互回调均被拒绝。
线路底图按钮和配置状态由 `ui/lineBasemapControls.ts` 渲染；`lineProjectView` 只连接当前地图实例、切换回调和清理代次。

## 相关文档

- [系统架构](../architecture.md)
- [打开与生命周期](lifecycle.md)
- [缓存域](caches.md)
- [运行时与数据库模块](runtime-modules.md)
- [开发指南](../development.md)
- [工程实体模型](../engineering/README.md)
