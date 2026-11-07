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

## 桌面目录

| 目录 | 职责 | 允许依赖 | 不应依赖 |
|---|---|---|---|
| `desktop/src/app/` | 启动、`AppState`、工程/选择会话、模块接线 | services、ui 入口 | 具体 parser 内部 |
| `desktop/src/engineering/` | 工程整体、成员、关系、组成模板与目录；纯领域 | 仅类型和纯函数 | GIM parser、UI、Viewer、DB、平台 IO |
| `desktop/src/gim/engineering/` | 把 CBM/DEV/FAM/IFC 来源适配成中立证据和来源图 | gim 纯 parser、engineering 契约 | Viewer、UI、DB |
| `desktop/src/gim/` | 容器、CBM/DEV/PHM/MOD/IFC 纯解析、索引和地图数据 | 共享纯库 | services、viewer、ui |
| `desktop/src/viewer/` | Three.js、Fragments、web-ifc、MOD/STL 编译与渲染 | three、geometry 纯函数、类型 | services、ui、DB |
| `desktop/src/ui/` | DOM shell、三视图、属性、搜索、地图、工具栏 | services 暴露的结果、纯类型、白名单展示选择器 | 数据库、原生 IPC |
| `desktop/src/services/` | 打开、缓存、Worker、后台任务、选择与生命周期编排 | gim、viewer、bridge、注入的展示端口 | 把领域规则塞回 UI |
| `desktop/src/config/` | 功能与调试开关 | 无 | 业务状态 |
| `desktop/bridge/` | Tauri IPC DTO/命令封装 | `@tauri-apps/api` | UI、Viewer |
| `desktop/src-tauri/src/` | SQLite、SHA、解压、文件校验 | Rust crates | 前端状态 |

## 依赖规则

UI 可消费只读的稳定来源 ID 查找、路径格式化、空值判断及几何诊断文案等展示选择器；允许的模块/符号逐项登记在 `check-engineering-boundaries.mjs`。原始文本解析、FAM 来源组合与业务身份、连接归属、线路地图及导航投影由 services/gim 负责。新增纯函数不自动获得 UI 导入权限，不能用“纯函数”放宽整个 parser 或 Viewer 模块。

1. `engineering/` 是无格式领域层。它不读取 XML/键值文本、不生成 Mesh、不访问数据库，也不接收 `CbmNode`、F2/F3/F4 标签、展示树深度或包围盒作为分类条件。新增分类规则应先落到这里和[目录](../engineering/catalogs/README.md)。
2. `gim/engineering/` 是适配层。它只把来源事实转成 `ObjectEvidence`、`SourceRecord`、`SourceGraph` 和空间上下文；`SourceRecord` 可保留原始字段，但领域层不解析格式。
3. `services/engineering*` 只做 Worker 调度、快照发布、缓存、表示绑定和取消；不重新判断工程类别。
4. `viewer/` 只消费 `SourceGeometryOccurrence`、模板和 IFC 对象。几何编译器不接收工程组成分组，也不按实体名称选择 LOD。
5. `ui/` 不直接访问数据库或原生 IPC；最近工程、缓存管理和工程打开均通过 `services/projectCacheService`、`services/gimOpenCore` 等入口。`engineeringTreeView` 只渲染投影结果并回调选择服务。
6. 重依赖按需动态 import：入口和 `openGimService` 不静态引入 Three.js、web-ifc、MapLibre；IFC、几何、地图和工程实体 Worker 各自分包。
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
  ├─ openGimService（文件入口、解压、类型分派）
  │    ├─ substationRuntime（语义、IFC、DEV、Spatial）
  │    │    └─ engineeringService（来源/实体/导航 Worker）
  │    ├─ equipmentRuntime（DEV-only 设备）
  │    └─ line runtime（线路图/地图）
  └─ viewerUIBinding（选择/高亮/相机/属性路由）
```

`app/presentationBindings` 将 DOM 句柄、展示回调和惰性视图加载器注入 services；services 不直接值导入 ui。Viewer 使用 `shared/viewerState`、会话和选择契约，不引用 AppState。

`AppState` 只持有会话、请求和已发布结果；工程实体、导航、几何目录的构建由服务层启动，UI 通过订阅/回调刷新。工程切换后，旧 Worker、旧请求和旧投影必须释放或拒绝提交。

## 边界检查

改动后至少确认：

执行 `desktop/` 下的 `npm run check:engineering-boundaries` 自动检查纯领域、来源和 Viewer 边界；Windows CI 同步执行。

- `engineering/` 没有 import `gim/`、`viewer/`、`ui/`、`services/` 或 `@desktop/database`；
- `gim/` 没有 import `services/`、`viewer/`、`ui/`；
- `ui/` 没有 import `@desktop/database` 或 `@tauri-apps/api`；
- 新增缓存/协议常量只在对应域服务中定义，并由[缓存域](caches.md)登记；
- 分类规则变化先改目录/领域测试，再改 UI 展示。

线路导航的数据装配位于 `services/lineNavigationProjection.ts`，不依赖 DOM、AppState 或平台 IO；搜索 DTO 位于 `shared/searchTypes.ts`。`ui/lineNavigationTreeView` 只负责按需渲染、展开和交互，返回幂等 destroy 句柄；替换或关闭线路工程会撤销监听并释放树，旧句柄不能清除新树。地图绘制/交互/渐进调度仍由现有地图 handle 管理。
