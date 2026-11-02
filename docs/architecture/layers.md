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
| `desktop/src/ui/` | DOM shell、两视图、属性、搜索、地图、工具栏 | services 暴露的结果、纯类型 | 数据库、原生 IPC |
| `desktop/src/services/` | 打开、缓存、Worker、后台任务、选择与生命周期编排 | gim、viewer、bridge、ui 回调 | 把领域规则塞回 UI |
| `desktop/src/config/` | 功能与调试开关 | 无 | 业务状态 |
| `desktop/bridge/` | Tauri IPC DTO/命令封装 | `@tauri-apps/api` | UI、Viewer |
| `desktop/src-tauri/src/` | SQLite、SHA、解压、文件校验 | Rust crates | 前端状态 |

## 依赖规则

1. `engineering/` 是无格式领域层。它不读取 XML/键值文本、不生成 Mesh、不访问数据库，也不接收 `CbmNode`、F2/F3/F4 标签、展示树深度或包围盒作为分类条件。新增分类规则应先落到这里和[目录](../engineering/catalogs/README.md)。
2. `gim/engineering/` 是适配层。它只把来源事实转成 `ObjectEvidence`、`SourceRecord`、`SourceGraph` 和空间上下文；`SourceRecord` 可保留原始字段，但领域层不解析格式。
3. `services/engineering*` 只做 Worker 调度、快照发布、缓存、表示绑定和取消；不重新判断工程类别。
4. `viewer/` 只消费 `SourceGeometryOccurrence`、模板和 IFC 对象。几何编译器不接收工程组成分组，也不按实体名称选择 LOD。
5. `ui/` 不直接访问数据库或原生 IPC；最近工程、缓存管理和工程打开均通过 `services/projectCacheService`、`services/gimOpenCore` 等入口。`engineeringTreeView` 只渲染投影结果并回调选择服务。
6. 重依赖按需动态 import：入口和 `openGimService` 不静态引入 Three.js、web-ifc、MapLibre；IFC、几何、地图和工程实体 Worker 各自分包。
7. 读取语义和提交状态必须由会话/请求守卫控制；UI 不能直接改写缓存版本、解析器结果或场景所有权。

### 已知边界例外

当前选择/表示绑定仍有少量跨层引用，属于待收敛项，不是实体分类依赖：

- `viewer/devRepresentationIdentity.ts`、`devInstanceBatches.ts`、`selection.ts` 只 import `DevRepresentationHint` 类型；
- `viewer/ifcRepresentationHighlight.ts` 读取 `state.engineeringSelection`，用于判断当前 IFC 对象是否在整体选择范围内；
- `services/devLodRuntime.ts` 应用 `engineeringSelection.devRoots` 和 `engineeringGeometryFilter` 实现隔离/显隐。

这些引用让“表示绑定/可见性”与实体选择共享状态；收敛方向是引入中立的 `SelectionScope`/可见性谓词，而不是让 Viewer 判断工程类别。实体识别、两视图投影和几何编译本身不读取这些字段。

## 入口与接线

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

`AppState` 只持有会话、请求和已发布结果；工程实体、导航、几何目录的构建由服务层启动，UI 通过订阅/回调刷新。工程切换后，旧 Worker、旧请求和旧投影必须释放或拒绝提交。

## 边界检查

改动后至少确认：

- `engineering/` 没有 import `gim/`、`viewer/`、`ui/`、`services/` 或 `@desktop/database`；
- `gim/` 没有 import `services/`、`viewer/`、`ui/`；
- `ui/` 没有 import `@desktop/database` 或 `@tauri-apps/api`；
- 新增缓存/协议常量只在对应域服务中定义，并由[缓存域](caches.md)登记；
- 分类规则变化先改目录/领域测试，再改 UI 展示。
